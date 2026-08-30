import {
    parseBenchmarkSet,
    renderBenchmarkMarkdown,
    serializeBenchmarkSet,
    summarizeBenchmarks,
    type BenchmarkSet,
    type BenchmarkSummary,
    type Note
} from '@synaipse/core';

/** Filename of the per-project benchmark note inside `Memory/<project>/`. */
export const BENCHMARK_FILENAME = '_benchmarks.md';

/** Same project-name grammar the MCP Project resolver enforces. */
const PROJECT_RE = /^[A-Za-z0-9_.-]+$/;

/** Vault-relative note id for a project's benchmark set. Throws on bad names. */
export const benchmarkPathFor = (project: string): string => {
    if (!PROJECT_RE.test(project)) {
        throw new Error(`invalid project name: ${project}`);
    }
    return `Memory/${project}/${BENCHMARK_FILENAME}`;
};

/** Extract the project name from a benchmark note id, or null if it isn't one. */
export const projectFromBenchmarkPath = (id: string): string | null => {
    const match = id.match(/^Memory\/([^/]+)\/_benchmarks\.md$/);
    return match?.[1] ?? null;
};

export const emptyBenchmarkSet = (project: string, at: string): BenchmarkSet => ({
    project,
    updatedAt: at,
    entries: []
});

/** Parse a benchmark note into a BenchmarkSet, or an empty set when absent. */
export const benchmarkSetFromNote = (project: string, note: Note | undefined, at: string): BenchmarkSet => {
    if (note === undefined) {
        return emptyBenchmarkSet(project, at);
    }
    return parseBenchmarkSet(project, note.frontmatter as Record<string, unknown>) ?? emptyBenchmarkSet(project, at);
};

/** Scan a note collection for benchmark files and return their summaries. */
export const listBenchmarkSummaries = (notes: Iterable<Note>): BenchmarkSummary[] => {
    const out: BenchmarkSummary[] = [];
    for (const note of notes) {
        const project = projectFromBenchmarkPath(note.id);
        if (project === null) {
            continue;
        }
        const set = parseBenchmarkSet(project, note.frontmatter as Record<string, unknown>);
        if (set !== null) {
            out.push(summarizeBenchmarks(set));
        }
    }
    out.sort((a, b) => a.project.localeCompare(b.project));
    return out;
};

/** Normalize a benchmark set before persisting: just stamps `updatedAt` — no roll-up/gating to run. */
export const normalizeBenchmarks = (set: BenchmarkSet, at: string): BenchmarkSet => ({
    ...set,
    updatedAt: at
});

/**
 * Build the note write input (frontmatter carrying the entry list + an
 * auto-rendered markdown body) for a benchmark set. The path is
 * `Memory/<project>/_benchmarks.md`, so it lands in the project folder, is
 * tagged `benchmarks` + `project/<name>`, and is picked up by search/graph/
 * backlinks.
 */
export const benchmarkWriteInput = (
    set: BenchmarkSet
): {path: string; content: string; frontmatter: Record<string, unknown>} => ({
    path: benchmarkPathFor(set.project),
    content: renderBenchmarkMarkdown(set),
    frontmatter: {
        title: `Benchmarks: ${set.project}`,
        type: 'note',
        project: set.project,
        tags: ['benchmarks', `project/${set.project}`],
        updated: set.updatedAt,
        benchmarks: serializeBenchmarkSet(set)
    }
});
