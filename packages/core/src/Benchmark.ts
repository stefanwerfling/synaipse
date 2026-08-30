/**
 * Per-project benchmark model. A benchmark set is a flat list of measured
 * results (speed numbers, mostly) tagged with an open set of dimensions
 * (e.g. `{machine, backend, technique}` for an inference-engine project, or
 * `{language, algorithm, input_size}` for another) so the shape isn't tied to
 * any one project's vocabulary. Persisted vault-natively as one markdown note
 * per project (`Memory/<project>/_benchmarks.md`): entries are the source of
 * truth in frontmatter under `benchmarks:`, the body is an auto-rendered
 * table + per-metric leaderboard regenerated on every write.
 *
 * This module is pure (no I/O) so it is unit-testable in isolation and safe
 * to import into the browser bundle. Filesystem access lives in
 * `@synaipse/service`'s Benchmark module.
 */

export interface BenchmarkEntry {
    /** Generated id, e.g. "b_1a2b3c4d" — see {@link generateEntryId}. */
    id: string;
    /**
     * Open dimension bag, e.g. `{machine: "GB10", backend: "vLLM", technique:
     * "NVFP4"}`. Keys are free text — a project picks its own vocabulary and
     * should stay consistent within itself (callers are expected to check
     * existing entries before inventing a new key name).
     */
    dimensions: Record<string, string>;
    /** Free text, e.g. "decode_tok_s", "prefill_ms" — the one universal axis. */
    metric: string;
    value: number;
    /** Free text, e.g. "tok/s", "ms". */
    unit: string;
    /** Required — never inferred from the metric name, that's a foot-gun. */
    higherIsBetter: boolean;
    /** Free text context, e.g. "single-user, 2316-tok prompt". */
    context?: string;
    /** Wikilink targets to the narrative research note this entry came from. */
    noteLinks?: string[];
    /** ISO timestamp. Defaults to "now" when an entry is added. */
    recordedAt?: string;
    /**
     * Soft-delete marker. A deleted entry is never removed from the list: kept
     * in frontmatter (nothing lost), excluded from the rendered body and
     * winner computation, hidden in the UI unless "show deleted" is on.
     */
    deleted?: boolean;
}

export interface BenchmarkSet {
    project: string;
    /** ISO timestamp of the last mutation. */
    updatedAt: string;
    entries: BenchmarkEntry[];
}

// ---------------------------------------------------------------------------
// Id generation
// ---------------------------------------------------------------------------

/** Short random id — no natural human-legible scheme exists here (unlike roadmap's dotted step ids). */
export const generateEntryId = (): string => `b_${crypto.randomUUID().slice(0, 8)}`;

// ---------------------------------------------------------------------------
// List operations
// ---------------------------------------------------------------------------

/** Find an entry by id, or null. */
export const findEntry = (entries: readonly BenchmarkEntry[], id: string): BenchmarkEntry | null =>
    entries.find((e) => e.id === id) ?? null;

/** Replace an entry in place by id (shallow-merged), or append if the id is new. Returns a new array. */
export const upsertEntry = (entries: readonly BenchmarkEntry[], entry: BenchmarkEntry): BenchmarkEntry[] => {
    let found = false;
    const next = entries.map((existing) => {
        if (existing.id !== entry.id) {
            return existing;
        }
        found = true;
        return {...existing, ...entry};
    });
    return found ? next : [...entries, entry];
};

/**
 * Soft-delete (or restore) an entry by id. Never removed from the list — only
 * its `deleted` flag flips. Returns a new array; a missing id is a no-op.
 */
export const setEntryDeleted = (
    entries: readonly BenchmarkEntry[],
    id: string,
    deleted: boolean
): BenchmarkEntry[] =>
    entries.map((entry) => {
        if (entry.id !== id) {
            return entry;
        }
        const next = {...entry};
        if (deleted) {
            next.deleted = true;
        } else {
            delete next.deleted;
        }
        return next;
    });

/** New array with every soft-deleted entry pruned. For display/rendering/winners. */
export const withoutDeletedEntries = (entries: readonly BenchmarkEntry[]): BenchmarkEntry[] =>
    entries.filter((e) => e.deleted !== true);

/**
 * Union of every `dimensions` key present across entries, in first-seen
 * order. Drives the UI's dynamic filter list and the render table's columns
 * — this is what makes the feature project-agnostic instead of hardcoding
 * field names like "machine"/"backend".
 */
export const dimensionKeys = (entries: readonly BenchmarkEntry[]): string[] => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const entry of entries) {
        for (const key of Object.keys(entry.dimensions)) {
            if (!seen.has(key)) {
                seen.add(key);
                out.push(key);
            }
        }
    }
    return out;
};

// ---------------------------------------------------------------------------
// Winner computation
// ---------------------------------------------------------------------------

export interface BenchmarkWinnerGroup {
    /** Stable string key for the group, e.g. "metric=decode_tok_s|machine=GB10". */
    key: string;
    /** The metric/dimension key-value pairs that define this group. */
    groupBy: Record<string, string>;
    /** Ranked entries, best first (respecting each entry's own `higherIsBetter`). */
    entries: BenchmarkEntry[];
}

/**
 * Group entries by `metric` plus whichever `dimensions` keys are listed in
 * `groupBy` (e.g. `['metric', 'machine']` to rank per machine — only
 * meaningful if the project actually uses a `machine` dimension), rank each
 * group by `value` respecting `higherIsBetter`. Default (`['metric']`) is a
 * pure per-metric leaderboard across everything — always well-defined
 * regardless of which dimension names a given project happens to use.
 *
 * An entry that lacks any of the requested `groupBy` dimension keys is
 * excluded from grouping (comparing across a missing axis isn't meaningful).
 * A `groupBy` key that doesn't exist on ANY entry yields no groups at all —
 * not an error, just nothing to rank.
 */
export const computeWinners = (
    entries: readonly BenchmarkEntry[],
    groupBy: readonly string[] = ['metric']
): BenchmarkWinnerGroup[] => {
    const visible = withoutDeletedEntries(entries);
    const groups = new Map<string, BenchmarkEntry[]>();
    const groupValues = new Map<string, Record<string, string>>();

    for (const entry of visible) {
        const kv: Record<string, string> = {};
        for (const key of groupBy) {
            const value = key === 'metric' ? entry.metric : entry.dimensions[key];
            if (value === undefined) {
                continue;
            }
            kv[key] = value;
        }
        if (Object.keys(kv).length !== groupBy.length) {
            continue;
        }
        const groupKey = groupBy.map((key) => `${key}=${kv[key]}`).join('|');
        const list = groups.get(groupKey) ?? [];
        list.push(entry);
        groups.set(groupKey, list);
        groupValues.set(groupKey, kv);
    }

    const out: BenchmarkWinnerGroup[] = [];
    for (const [key, list] of groups) {
        const higherIsBetter = list[0]?.higherIsBetter ?? true;
        const ranked = [...list].sort((a, b) =>
            higherIsBetter ? b.value - a.value : a.value - b.value);
        out.push({key, groupBy: groupValues.get(key) ?? {}, entries: ranked});
    }
    out.sort((a, b) => a.key.localeCompare(b.key));
    return out;
};

// ---------------------------------------------------------------------------
// Aggregate summary (for KPI tiles / project-picker list)
// ---------------------------------------------------------------------------

export interface BenchmarkSummary {
    project: string;
    totalEntries: number;
    dimensionKeys: string[];
    metrics: string[];
    updatedAt: string;
}

export const summarizeBenchmarks = (set: BenchmarkSet): BenchmarkSummary => {
    const visible = withoutDeletedEntries(set.entries);
    return {
        project: set.project,
        totalEntries: visible.length,
        dimensionKeys: dimensionKeys(visible),
        metrics: [...new Set(visible.map((e) => e.metric))].sort(),
        updatedAt: set.updatedAt
    };
};

// ---------------------------------------------------------------------------
// Parsing (frontmatter → BenchmarkSet), defensive like parseRoadmap
// ---------------------------------------------------------------------------

const asStr = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);
const asNum = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const asBool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);
const asStrArr = (v: unknown): string[] | undefined =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined;

const asDimensions = (v: unknown): Record<string, string> | undefined => {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) {
        return undefined;
    }
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(v as Record<string, unknown>)) {
        if (typeof value === 'string' && value.length > 0) {
            out[key] = value;
        }
    }
    return Object.keys(out).length > 0 ? out : undefined;
};

const parseEntry = (raw: unknown): BenchmarkEntry | null => {
    if (raw === null || typeof raw !== 'object') {
        return null;
    }
    const c = raw as Record<string, unknown>;

    const id = asStr(c.id);
    const dimensions = asDimensions(c.dimensions);
    const metric = asStr(c.metric);
    const value = asNum(c.value);
    const unit = asStr(c.unit);
    const higherIsBetter = asBool(c.higherIsBetter);

    if (!id || !dimensions || !metric || value === undefined || !unit || higherIsBetter === undefined) {
        return null;
    }

    const entry: BenchmarkEntry = {id, dimensions, metric, value, unit, higherIsBetter};

    const context = asStr(c.context);
    if (context) entry.context = context;
    const noteLinks = asStrArr(c.noteLinks);
    if (noteLinks) entry.noteLinks = noteLinks;
    const recordedAt = asStr(c.recordedAt);
    if (recordedAt) entry.recordedAt = recordedAt;
    if (c.deleted === true) entry.deleted = true;

    return entry;
};

/**
 * Build a BenchmarkSet from a note's frontmatter `benchmarks` payload.
 * Malformed entries are silently skipped (mirrors {@link parseRoadmap}).
 * Returns null when there is no benchmarks payload at all.
 */
export const parseBenchmarkSet = (
    project: string,
    frontmatter: Record<string, unknown>
): BenchmarkSet | null => {
    const raw = frontmatter.benchmarks;
    if (raw === null || typeof raw !== 'object') {
        return null;
    }
    const c = raw as Record<string, unknown>;
    const entries = Array.isArray(c.entries)
        ? c.entries.map(parseEntry).filter((e): e is BenchmarkEntry => e !== null)
        : [];

    return {
        project,
        updatedAt: asStr(c.updatedAt) ?? asStr(frontmatter.updated) ?? '',
        entries
    };
};

/**
 * Serialize a BenchmarkSet into a plain object suitable for frontmatter under
 * the `benchmarks:` key.
 */
export const serializeBenchmarkSet = (set: BenchmarkSet): Record<string, unknown> => ({
    updatedAt: set.updatedAt,
    entries: set.entries
});

// ---------------------------------------------------------------------------
// Body rendering (human-readable table + per-metric leaderboard)
// ---------------------------------------------------------------------------

const AUTOGEN_MARKER =
    '<!-- ⚠ Auto-generiert aus dem `benchmarks:`-Frontmatter durch Synaipse. Nicht von Hand editieren — Änderungen werden beim nächsten Benchmark-Write überschrieben. -->';

const formatDimensions = (dimensions: Record<string, string>, keys: readonly string[]): string =>
    keys.map((key) => dimensions[key] ?? '—').join(' | ');

const formatValue = (value: number, unit: string): string => `${value.toLocaleString('de-DE')} ${unit}`;

/**
 * Render the human-readable body of `_benchmarks.md`: one flat table (columns
 * = the union of dimension keys actually used, since we don't assume any
 * project's vocabulary) followed by a per-metric leaderboard. Regenerated on
 * every write.
 */
export const renderBenchmarkMarkdown = (set: BenchmarkSet): string => {
    const visible = withoutDeletedEntries(set.entries);
    const deletedCount = set.entries.length - visible.length;
    const keys = dimensionKeys(visible);

    const lines: string[] = [];
    lines.push(AUTOGEN_MARKER);
    lines.push('');
    lines.push(`# Benchmarks: ${set.project}`);
    lines.push('');
    lines.push(
        `> **${visible.length}** Einträge` +
            (deletedCount > 0 ? ` · 🗑 ${deletedCount} gelöscht (ausgeblendet)` : '')
    );
    lines.push('');

    if (visible.length === 0) {
        lines.push('_Noch keine Benchmark-Einträge._');
        lines.push('');
        return lines.join('\n');
    }

    lines.push(`| ${keys.join(' | ')} | Metrik | Wert | Kontext |`);
    lines.push(`|${keys.map(() => '---').join('|')}|---|--:|---|`);
    for (const entry of visible) {
        const notes = (entry.noteLinks ?? []).map((n) => `[[${n}]]`).join(' ');
        const context = [entry.context, notes].filter((s) => s !== undefined && s.length > 0).join(' — ');
        lines.push(
            `| ${formatDimensions(entry.dimensions, keys)} | ${entry.metric} | ` +
                `${formatValue(entry.value, entry.unit)} | ${context} |`
        );
    }
    lines.push('');

    lines.push('## Leaderboard (pro Metrik)');
    lines.push('');
    for (const group of computeWinners(visible, ['metric'])) {
        const metric = group.groupBy.metric ?? group.key;
        lines.push(`### ${metric}`);
        lines.push('');
        lines.push('| # | Dimensionen | Wert |');
        lines.push('|--:|---|--:|');
        group.entries.forEach((entry, i) => {
            const label = keys.map((key) => `${key}=${entry.dimensions[key] ?? '—'}`).join(', ');
            const medal = i === 0 ? '🏆 ' : '';
            lines.push(`| ${i + 1} | ${medal}${label} | ${formatValue(entry.value, entry.unit)} |`);
        });
        lines.push('');
    }

    return lines.join('\n');
};
