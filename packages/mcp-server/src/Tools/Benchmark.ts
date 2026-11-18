import type {BenchmarkEntry} from '@synaipse/core';
import {
    computeWinners,
    dimensionKeys,
    findEntry,
    generateEntryId,
    setEntryDeleted,
    summarizeBenchmarks,
    upsertEntry,
    withoutDeletedEntries
} from '@synaipse/core';
import type {SynaipseService} from '@synaipse/service';
import {asString, ok, type ToolContext, type ToolHandler} from './Shared.js';

/** Resolve the active project or throw a helpful error for benchmark tools. */
const requireBenchmarkProject = (service: SynaipseService, ctx?: ToolContext): string => {
    const project = service.getProject(ctx?.project);
    if (project === null) {
        throw new Error(
            'No project context set. Benchmark tools operate per project — set one via the /mcp/<project> URL segment or the x-synaipse-project header.'
        );
    }
    return project;
};

const asDimensions = (value: unknown, field: string): Record<string, string> => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`Missing object argument: ${field}`);
    }
    const out: Record<string, string> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
        if (typeof v === 'string' && v.length > 0) {
            out[key] = v;
        }
    }
    if (Object.keys(out).length === 0) {
        throw new Error(`${field} must have at least one key.`);
    }
    return out;
};

const asRequiredNumber = (value: unknown, field: string): number => {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(`Missing number argument: ${field}`);
    }
    return value;
};

const asRequiredBoolean = (value: unknown, field: string): boolean => {
    if (typeof value !== 'boolean') {
        throw new Error(`Missing boolean argument: ${field}`);
    }
    return value;
};

/** Apply a benchmark_update field patch to an entry, returning a new entry. */
const patchBenchmarkEntry = (entry: BenchmarkEntry, args: Record<string, unknown>): BenchmarkEntry => {
    const next: BenchmarkEntry = {...entry};
    if (args.dimensions !== undefined) next.dimensions = asDimensions(args.dimensions, 'dimensions');
    if (typeof args.metric === 'string' && args.metric.length > 0) next.metric = args.metric;
    if (typeof args.value === 'number' && Number.isFinite(args.value)) next.value = args.value;
    if (typeof args.unit === 'string' && args.unit.length > 0) next.unit = args.unit;
    if (typeof args.higherIsBetter === 'boolean') next.higherIsBetter = args.higherIsBetter;
    if (typeof args.context === 'string') next.context = args.context;
    if (Array.isArray(args.noteLinks)) {
        next.noteLinks = args.noteLinks.filter((n): n is string => typeof n === 'string');
    }
    if (typeof args.recordedAt === 'string' && args.recordedAt.length > 0) next.recordedAt = args.recordedAt;
    return next;
};

/** Per-project benchmark results (Memory/<project>/_benchmarks.md). */
export const benchmarkTools = (service: SynaipseService): ToolHandler[] => [
    {
        definition: {
            name: 'synaipse_benchmark_add',
            description: 'Log a benchmark result for the active project: metric, value and unit, tagged with open dimensions (e.g. {machine, backend, technique}). Call synaipse_benchmark_list first and reuse its dimension keys; link the research note via noteLinks.',
            inputSchema: {
                type: 'object',
                properties: {
                    dimensions: {
                        type: 'object',
                        additionalProperties: {type: 'string'},
                        description: 'e.g. {"machine":"GB10","backend":"vLLM"}; at least one key'
                    },
                    metric: {type: 'string', description: 'e.g. "decode_tok_s"'},
                    value: {type: 'number'},
                    unit: {type: 'string', description: 'e.g. "tok/s"'},
                    higherIsBetter: {type: 'boolean', description: 'Required, never inferred'},
                    context: {type: 'string'},
                    noteLinks: {type: 'array', items: {type: 'string'}},
                    recordedAt: {type: 'string', description: 'ISO, default now'}
                },
                required: ['dimensions', 'metric', 'value', 'unit', 'higherIsBetter']
            }
        },
        handle: async (args, ctx) => {
            const project = requireBenchmarkProject(service, ctx);
            const current = service.readBenchmarks(project);

            const entry: BenchmarkEntry = {
                id: generateEntryId(),
                dimensions: asDimensions(args.dimensions, 'dimensions'),
                metric: asString(args.metric, 'metric'),
                value: asRequiredNumber(args.value, 'value'),
                unit: asString(args.unit, 'unit'),
                higherIsBetter: asRequiredBoolean(args.higherIsBetter, 'higherIsBetter'),
                recordedAt: typeof args.recordedAt === 'string' && args.recordedAt.length > 0
                    ? args.recordedAt
                    : new Date().toISOString()
            };
            if (typeof args.context === 'string' && args.context.length > 0) entry.context = args.context;
            if (Array.isArray(args.noteLinks)) {
                const noteLinks = args.noteLinks.filter((n): n is string => typeof n === 'string');
                if (noteLinks.length > 0) entry.noteLinks = noteLinks;
            }

            const saved = await service.writeBenchmarks({...current, entries: upsertEntry(current.entries, entry)});
            return {
                response: ok({project, entry, summary: summarizeBenchmarks(saved)}),
                event: {kind: 'write', touched: [`Memory/${project}/_benchmarks.md`]}
            };
        }
    },
    {
        definition: {
            name: 'synaipse_benchmark_list',
            description: 'Benchmark results of the active project, filtered by metric and/or dimensions, with a leaderboard (per metric, or within groupBy keys), the dimension keys in use and a summary. Call before benchmark_add.',
            inputSchema: {
                type: 'object',
                properties: {
                    metric: {type: 'string'},
                    dimensions: {
                        type: 'object',
                        additionalProperties: {type: 'string'},
                        description: 'Match all pairs'
                    },
                    includeDeleted: {type: 'boolean'},
                    groupBy: {
                        type: 'array',
                        items: {type: 'string'},
                        description: 'Default ["metric"]'
                    }
                }
            }
        },
        handle: async (args, ctx) => {
            const project = requireBenchmarkProject(service, ctx);
            const current = service.readBenchmarks(project);
            const includeDeleted = args.includeDeleted === true;

            let entries = includeDeleted ? current.entries : withoutDeletedEntries(current.entries);

            if (typeof args.metric === 'string' && args.metric.length > 0) {
                entries = entries.filter((e) => e.metric === args.metric);
            }
            if (args.dimensions !== null && typeof args.dimensions === 'object' && !Array.isArray(args.dimensions)) {
                const filter = Object.entries(args.dimensions as Record<string, unknown>)
                    .filter((pair): pair is [string, string] => typeof pair[1] === 'string');
                entries = entries.filter((e) => filter.every(([key, value]) => e.dimensions[key] === value));
            }

            const groupBy = Array.isArray(args.groupBy)
                ? args.groupBy.filter((g): g is string => typeof g === 'string')
                : [];

            return {
                response: ok({
                    project,
                    entries,
                    winners: computeWinners(entries, groupBy.length > 0 ? groupBy : ['metric']),
                    dimensionKeys: dimensionKeys(entries),
                    summary: summarizeBenchmarks({...current, entries})
                }),
                event: {kind: 'list', touched: []}
            };
        }
    },
    {
        definition: {
            name: 'synaipse_benchmark_update',
            description: 'Patch one benchmark entry; only passed fields change. deleted:true hides it (reversible).',
            inputSchema: {
                type: 'object',
                properties: {
                    id: {type: 'string'},
                    dimensions: {type: 'object', additionalProperties: {type: 'string'}, description: 'Replaces all dimensions'},
                    metric: {type: 'string'},
                    value: {type: 'number'},
                    unit: {type: 'string'},
                    higherIsBetter: {type: 'boolean'},
                    context: {type: 'string'},
                    noteLinks: {type: 'array', items: {type: 'string'}},
                    recordedAt: {type: 'string'},
                    deleted: {type: 'boolean'}
                },
                required: ['id']
            }
        },
        handle: async (args, ctx) => {
            const project = requireBenchmarkProject(service, ctx);
            const id = asString(args.id, 'id');
            const current = service.readBenchmarks(project);
            const existing = findEntry(current.entries, id);
            if (existing === null) {
                throw new Error(`Benchmark entry "${id}" not found in the ${project} benchmark set.`);
            }
            const patched = patchBenchmarkEntry(existing, args);
            let nextEntries = upsertEntry(current.entries, patched);
            if (typeof args.deleted === 'boolean') {
                nextEntries = setEntryDeleted(nextEntries, id, args.deleted);
            }
            const saved = await service.writeBenchmarks({...current, entries: nextEntries});
            return {
                response: ok({project, entry: findEntry(saved.entries, id), summary: summarizeBenchmarks(saved)}),
                event: {kind: 'write', touched: [`Memory/${project}/_benchmarks.md`]}
            };
        }
    }
];
