import {
    applyDependencies,
    parseRoadmap,
    renderRoadmapMarkdown,
    rollup,
    serializeRoadmap,
    summarize,
    type Note,
    type Roadmap,
    type RoadmapSummary
} from '@synaipse/core';

/** Filename of the per-project roadmap note inside `Memory/<project>/`. */
export const ROADMAP_FILENAME = '_roadmap.md';

/** Same project-name grammar the MCP Project resolver enforces. */
const PROJECT_RE = /^[A-Za-z0-9_.-]+$/;

/** Vault-relative note id for a project's roadmap. Throws on bad names. */
export const roadmapPathFor = (project: string): string => {
    if (!PROJECT_RE.test(project)) {
        throw new Error(`invalid project name: ${project}`);
    }
    return `Memory/${project}/${ROADMAP_FILENAME}`;
};

/** Extract the project name from a roadmap note id, or null if it isn't one. */
export const projectFromRoadmapPath = (id: string): string | null => {
    const match = id.match(/^Memory\/([^/]+)\/_roadmap\.md$/);
    return match?.[1] ?? null;
};

export const emptyRoadmap = (project: string, at: string): Roadmap => ({
    project,
    updatedAt: at,
    active: null,
    steps: []
});

/** Parse a roadmap note into a Roadmap, or an empty roadmap when absent. */
export const roadmapFromNote = (project: string, note: Note | undefined, at: string): Roadmap => {
    if (note === undefined) {
        return emptyRoadmap(project, at);
    }
    return parseRoadmap(project, note.frontmatter as Record<string, unknown>) ?? emptyRoadmap(project, at);
};

/** Scan a note collection for roadmap files and return their summaries. */
export const listRoadmapSummaries = (notes: Iterable<Note>): RoadmapSummary[] => {
    const out: RoadmapSummary[] = [];
    for (const note of notes) {
        const project = projectFromRoadmapPath(note.id);
        if (project === null) {
            continue;
        }
        const roadmap = parseRoadmap(project, note.frontmatter as Record<string, unknown>);
        if (roadmap !== null) {
            out.push(summarize(roadmap));
        }
    }
    out.sort((a, b) => a.project.localeCompare(b.project));
    return out;
};

/**
 * Normalize a roadmap before persisting: apply dependency gating (open deps →
 * blocked), roll leaf hours/progress up into parents, and stamp `updatedAt`.
 */
export const normalizeRoadmap = (roadmap: Roadmap, at: string): Roadmap => {
    const gated = applyDependencies(roadmap);
    return {...gated, steps: rollup(gated.steps), updatedAt: at};
};

/**
 * Build the note write input (frontmatter carrying the step tree + an
 * auto-rendered markdown body) for a roadmap. The path is
 * `Memory/<project>/_roadmap.md`, so it lands in the project folder, is tagged
 * `roadmap` + `project/<name>`, and is picked up by search/graph/backlinks.
 */
export const roadmapWriteInput = (
    roadmap: Roadmap
): {path: string; content: string; frontmatter: Record<string, unknown>} => ({
    path: roadmapPathFor(roadmap.project),
    content: renderRoadmapMarkdown(roadmap),
    frontmatter: {
        title: `Roadmap: ${roadmap.project}`,
        type: 'note',
        project: roadmap.project,
        tags: ['roadmap', `project/${roadmap.project}`],
        updated: roadmap.updatedAt,
        roadmap: serializeRoadmap(roadmap)
    }
});
