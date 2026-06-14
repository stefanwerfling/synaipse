import type {Vault} from '@synaipse/vault';

export interface CrawlerContext {
    vault: Vault;
    log: (line: string) => void;
}

export interface CrawlerReport {
    fetched: number;
    written: number;
    unchanged: number;
    errors: Array<{item: string; error: string}>;
    elapsedMs: number;
}

export interface Crawler {
    readonly name: string;
    run(ctx: CrawlerContext): Promise<CrawlerReport>;
}