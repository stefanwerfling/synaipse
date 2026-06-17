import {readFile} from 'node:fs/promises';
import path from 'node:path';
import type {Frontmatter} from '@synaipse/core';
import type {Vault} from '@synaipse/vault';
import {parseCodeFile, type CodeImport, type ParsedCodeFile} from './CodeParser.js';
import {walkRepo, type WalkResult} from './CodeWalker.js';

/**
 * Code crawler — turns a TypeScript / JavaScript repo into vault notes.
 *
 *   Crawler/code/<repoName>/<relativePath>.md
 *
 * Each note carries frontmatter (language, exports, imports, file metadata)
 * plus a markdown body that lists imports as `[[wikilinks]]` to other code
 * notes when the import resolves to a file inside the same repo. External
 * imports stay as inline code.
 *
 * Per-file granularity is the MVP — symbol-level would explode a 500-line
 * file into 30 separate notes.
 */

export interface CodeCrawlerOptions {
    repoPath: string;
    /** Override the folder name under `Crawler/code/`. Defaults to repo basename. */
    repoName?: string;
    /** Adds to the built-in skip list (node_modules/, dist/, .git/, …). */
    excludePatterns?: readonly string[];
    /** Include the full source in a fenced code block at the end of each note. */
    withSource?: boolean;
}

export interface CrawlContext {
    vault: Vault;
    log: (line: string) => void;
}

export interface CodeReport {
    elapsedMs: number;
    walked: number;
    written: number;
    unchanged: number;
    skipped: number;
    errors: Array<{item: string; error: string}>;
}

const stripExtension = (id: string): string => id.replace(/\.(tsx?|jsx?|mjs|cjs)$/, '');

const guessExtensions = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
const indexBaseNames = ['index.ts', 'index.tsx', 'index.js', 'index.jsx', 'index.mjs', 'index.cjs'];

/**
 * Resolve a relative import (`./foo`, `../bar`) against the file's directory
 * and the repo's file index. Returns the resolved repo-relative path if
 * found, otherwise null (= unresolved, render as plain code in the body).
 */
const resolveRelativeImport = (
    fileRel: string,
    spec: string,
    fileIndex: ReadonlySet<string>
): string | null => {
    const dir = path.posix.dirname(fileRel);
    const joined = path.posix.normalize(path.posix.join(dir, spec));

    // Strip any explicit `.js` written for ESM compatibility — we resolve
    // to the source file the project actually checks in.
    const candidates: string[] = [];
    const noJs = joined.replace(/\.js$/, '');

    if (joined !== noJs) {
        candidates.push(`${noJs}.ts`, `${noJs}.tsx`);
    }

    if (/\.\w+$/.test(joined)) {
        candidates.push(joined);
    } else {
        for (const ext of guessExtensions) candidates.push(`${joined}${ext}`);
        for (const idx of indexBaseNames) candidates.push(`${joined}/${idx}`);
    }

    for (const c of candidates) {
        if (fileIndex.has(c)) return c;
    }

    return null;
};

const sanitizeFrontmatter = (input: Record<string, unknown>): Frontmatter => {
    const out: Frontmatter = {};

    for (const [k, v] of Object.entries(input)) {
        if (v === undefined) continue;
        (out as Record<string, unknown>)[k] = v;
    }

    return out;
};

const renderImports = (
    fileRel: string,
    imports: readonly CodeImport[],
    fileIndex: ReadonlySet<string>,
    repoName: string
): {markdown: string; resolvedCount: number; wikilinks: string[]} => {
    if (imports.length === 0) {
        return {markdown: '', resolvedCount: 0, wikilinks: []};
    }

    const internal: string[] = [];
    const external: string[] = [];
    const wikilinks: string[] = [];
    let resolvedCount = 0;

    for (const imp of imports) {
        if (!imp.isRelative) {
            external.push(imp.moduleSpecifier);
            continue;
        }

        const target = resolveRelativeImport(fileRel, imp.moduleSpecifier, fileIndex);

        if (target === null) {
            internal.push(`- ${imp.moduleSpecifier} *(unresolved)*`);
            continue;
        }

        resolvedCount += 1;
        const notePath = `Crawler/code/${repoName}/${stripExtension(target)}`;
        wikilinks.push(notePath);
        const namesPart = imp.names.length > 0 ? `imports: ${imp.names.map((n) => `\`${n}\``).join(', ')}` : 'side-effect import';
        internal.push(`- [[${notePath}]] — ${namesPart}`);
    }

    const lines: string[] = ['## Imports', ''];

    if (internal.length > 0) {
        lines.push('### Internal', '', ...internal, '');
    }

    if (external.length > 0) {
        lines.push('### External', '');
        for (const e of external) {
            lines.push(`- \`${e}\``);
        }
        lines.push('');
    }

    return {markdown: lines.join('\n'), resolvedCount, wikilinks};
};

const renderExports = (parsed: ParsedCodeFile): string => {
    if (parsed.exports.length === 0) {
        return '';
    }

    const lines: string[] = ['## Exports', ''];

    for (const ex of parsed.exports) {
        lines.push(`### \`${ex.signature}\``);
        if (ex.docstring !== null && ex.docstring.length > 0) {
            lines.push('', ex.docstring);
        }
        lines.push('');
    }

    return lines.join('\n');
};

const renderNote = (input: {
    repoName: string;
    fileRel: string;
    parsed: ParsedCodeFile;
    content: string;
    importsMd: string;
    withSource: boolean;
}): string => {
    const {repoName, fileRel, parsed, content, importsMd, withSource} = input;
    const lines: string[] = [];

    lines.push(`# \`${fileRel}\``, '');
    lines.push(`> ${parsed.language} · ${parsed.lines} lines · ${parsed.exports.length} exports · in repo \`${repoName}\``, '');

    if (parsed.fileDoc !== null && parsed.fileDoc.length > 0) {
        lines.push(parsed.fileDoc, '');
    }

    if (importsMd.length > 0) lines.push(importsMd);

    const exportsMd = renderExports(parsed);
    if (exportsMd.length > 0) lines.push(exportsMd);

    if (withSource) {
        lines.push('## Source', '');
        lines.push(`\`\`\`${parsed.language}`);
        lines.push(content.trim());
        lines.push('```', '');
    }

    return lines.join('\n');
};

const buildFrontmatter = (
    repoName: string,
    fileRel: string,
    parsed: ParsedCodeFile,
    extras: {importCount: number; internalImports: number}
): Frontmatter => {
    const today = new Date().toISOString().slice(0, 10);
    const langTag = parsed.language;
    const exportNames = parsed.exports.map((e) => e.name).slice(0, 20);

    return sanitizeFrontmatter({
        title: fileRel,
        type: 'external',
        tags: ['crawler', 'code', langTag],
        source: 'code',
        sourceRepo: repoName,
        sourcePath: fileRel,
        language: parsed.language,
        lines: parsed.lines,
        exports: exportNames,
        importCount: extras.importCount,
        internalImports: extras.internalImports,
        crawledAt: today
    });
};

export class CodeCrawler {
    public readonly name = 'code';

    public constructor(private readonly opts: CodeCrawlerOptions) {}

    public async run(ctx: CrawlContext): Promise<CodeReport> {
        const started = Date.now();
        const report: CodeReport = {
            elapsedMs: 0,
            walked: 0,
            written: 0,
            unchanged: 0,
            skipped: 0,
            errors: []
        };

        const repoRoot = path.resolve(this.opts.repoPath);
        const repoName = this.opts.repoName ?? path.basename(repoRoot);

        let walk: WalkResult;

        try {
            walk = await walkRepo(repoRoot, this.opts.excludePatterns ?? []);
        } catch (cause) {
            report.errors.push({item: repoRoot, error: String(cause)});
            report.elapsedMs = Date.now() - started;
            return report;
        }

        report.walked = walk.files.length;
        const fileIndex = new Set(walk.files);
        ctx.log(`[code] ${walk.files.length} files in ${repoName}`);

        for (const rel of walk.files) {
            try {
                const abs = path.join(repoRoot, rel);
                const content = await readFile(abs, 'utf8');
                const parsed = parseCodeFile(abs, content);

                const {markdown: importsMd, resolvedCount, wikilinks} = renderImports(rel, parsed.imports, fileIndex, repoName);
                const noteContent = renderNote({
                    repoName,
                    fileRel: rel,
                    parsed,
                    content,
                    importsMd,
                    withSource: this.opts.withSource === true
                });

                const notePath = `Crawler/code/${repoName}/${stripExtension(rel)}.md`;
                const frontmatter = buildFrontmatter(repoName, rel, parsed, {
                    importCount: parsed.imports.length,
                    internalImports: resolvedCount
                });

                void wikilinks; // already included via [[...]] in body — vault parser picks them up

                const existing = ctx.vault.tryGet(notePath);

                if (existing !== undefined
                    && existing.content === noteContent
                    && JSON.stringify(existing.frontmatter) === JSON.stringify(frontmatter)) {
                    report.unchanged += 1;
                    continue;
                }

                await ctx.vault.write(
                    {path: notePath, content: noteContent, frontmatter},
                    {message: `synaipse: crawl_code ${notePath}`}
                );

                report.written += 1;
            } catch (cause) {
                report.errors.push({item: rel, error: cause instanceof Error ? cause.message : String(cause)});
            }
        }

        report.skipped = walk.skipped;
        report.elapsedMs = Date.now() - started;
        return report;
    }
}