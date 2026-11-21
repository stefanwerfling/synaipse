import {mkdir} from 'node:fs/promises';
import {createLogger, type Frontmatter} from '@synaipse/core';
import {ConcurrentUpdateError, Repo} from 'ngit';
import type {History} from './History.js';
import {stringifyFrontMatter} from './FrontMatter.js';

const log = createLogger('repo-history');

/** Attempts per commit when another process moved HEAD in between. */
const COMMIT_ATTEMPTS = 8;

/** A note as its markdown file: frontmatter block only when there is any (same as the vault writes it). */
export const toMarkdownFile = (content: string, frontmatter?: Frontmatter): string =>
    frontmatter === undefined || Object.keys(frontmatter).length === 0
        ? content
        : stringifyFrontMatter(content, frontmatter);

export interface RepoCommit {
    adds: ReadonlyArray<{path: string; content: string}>;
    deletes: readonly string[];
    message: string;
    author?: {name: string; email: string};
}

/**
 * History in a standalone ngit repository (server mode, plan A6). There is
 * no working tree: notes live in MariaDB and are committed from memory as
 * the markdown file local mode would have on disk, so every history read
 * (log, show, diff, snapshots, activity, roadmap rollback) works unchanged.
 *
 * Several processes may share the directory: ngit updates the branch under
 * a lock and only if HEAD is still the parent it read, otherwise it throws
 * ConcurrentUpdateError and the commit is rebuilt on the new HEAD.
 */
export class RepoHistory implements History {
    private repo: Promise<Repo> | null = null;

    public constructor(
        private readonly dir: string,
        private readonly defaultAuthor: {name: string; email: string} = {name: 'Synaipse', email: 'synaipse@local'}
    ) {}

    public isConfigured(): boolean {
        return true;
    }

    public getRepo(): Promise<Repo | null> {
        return this.open();
    }

    private open(): Promise<Repo> {
        this.repo ??= mkdir(this.dir, {recursive: true})
            .then(() => Repo.openOrInit(this.dir, {defaultAuthor: this.defaultAuthor}))
            .catch((err: unknown) => {
                this.repo = null;
                throw err;
            });
        return this.repo;
    }

    /**
     * One commit with all adds and deletes. Deletes of paths that are not
     * in HEAD (created and removed inside one batch) are dropped. Returns
     * the new HEAD, or null when nothing changed.
     */
    public async commit(change: RepoCommit): Promise<string | null> {
        const repo = await this.open();
        const adds = change.adds.map((a) => ({path: a.path, content: Buffer.from(a.content, 'utf8')}));
        const author = change.author ?? this.defaultAuthor;

        for (let attempt = 1; ; attempt++) {
            const head = await repo.head();
            const deletes: string[] = [];
            for (const path of change.deletes) {
                if (head !== null && await RepoHistory.has(repo, head, path)) deletes.push(path);
            }
            if (adds.length === 0 && deletes.length === 0) return null;

            try {
                const sha = await repo.commitFiles({adds, deletes, message: change.message, author, expectedHead: head});
                return sha === head ? null : sha;
            } catch (err) {
                if (!(err instanceof ConcurrentUpdateError) || attempt >= COMMIT_ATTEMPTS) throw err;
                log.debug('history HEAD moved under us; rebuilding the commit', {attempt});
            }
        }
    }

    private static async has(repo: Repo, sha: string, path: string): Promise<boolean> {
        try {
            await repo.show(sha, path);
            return true;
        } catch {
            return false;
        }
    }
}
