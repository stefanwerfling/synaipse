import type {Repo} from 'ngit';
import type {Vault} from './Vault.js';

/**
 * Port for git-style history queries (log, show, diff, snapshot walk).
 * Two implementations come into play:
 * - VaultHistory wraps the Vault's ngit repo (Local-Mode default,
 *   synchronous read-path through the filesystem .ngit/ directory).
 * - NoopHistory (planned, @synaipse/server-storage) returns null from
 *   getRepo() so Service falls into the "history disabled" branches —
 *   used while Server-Mode boots without the async commit worker.
 *
 * Phase-3 of the server-mode refactor replaces NoopHistory with a
 * commit-worker-backed implementation that reads from MariaDB +
 * pending_commits and surfaces snapshots through the same port.
 * See Memory/synaipse/decisions/2026-06-23-server-mode-architecture.md.
 */
export interface History {
    /**
     * True when the history feature is configured for the vault —
     * irrespective of whether a first commit has been made yet. The UI
     * uses this to decide whether to surface the History button at all.
     */
    isConfigured(): boolean;

    /**
     * Returns the ngit Repo for read-only ops (history, show, diff).
     * Null when history is disabled or the repo has not been
     * initialised yet (no Synaipse commit has happened).
     */
    getRepo(): Promise<Repo | null>;
}

/** History impl backed by the Vault's filesystem .ngit/ directory. */
export class VaultHistory implements History {
    public constructor(private readonly vault: Vault) {}

    public isConfigured(): boolean {
        return this.vault.isHistoryConfigured();
    }

    public getRepo(): Promise<Repo | null> {
        return this.vault.getRepo();
    }
}

/**
 * History impl that returns null/false everywhere — used by Server-Mode
 * boot until the Phase-3 commit-worker-backed implementation lands.
 * Lives here (rather than in @synaipse/server-storage) so the noop
 * doesn't drag the ngit type dependency into the server-storage
 * package: the Repo return type stays internal to @synaipse/vault.
 */
export class NoopHistory implements History {
    public isConfigured(): boolean {
        return false;
    }

    public getRepo(): Promise<Repo | null> {
        return Promise.resolve(null);
    }
}