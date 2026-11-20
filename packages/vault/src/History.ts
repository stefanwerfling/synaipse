import type {Repo} from 'ngit';
import type {Vault} from './Vault.js';

/**
 * Port for git-style history queries (log, show, diff, snapshot walk).
 * Three implementations:
 * - VaultHistory wraps the Vault's ngit repo (local mode, the
 *   filesystem .ngit/ directory next to the notes).
 * - RepoHistory (RepoHistory.ts): server mode with SYNAIPSE_HISTORY_DIR.
 *   A standalone ngit repo that VersionedNoteAdapter commits MariaDB
 *   writes into (plan A6).
 * - NoopHistory: server mode without a history directory; getRepo()
 *   returns null so the Service takes its "history disabled" branches.
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
 * History impl that returns null/false everywhere — used by server mode
 * when no history directory is configured. Lives here (rather than in @synaipse/server-storage) so the noop
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