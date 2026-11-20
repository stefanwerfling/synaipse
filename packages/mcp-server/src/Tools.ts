import type {SynaipseService} from '@synaipse/service';
import {applyAcl} from './Tools/Acl.js';
import {adminTools} from './Tools/Admin.js';
import {benchmarkTools} from './Tools/Benchmark.js';
import {graphTools} from './Tools/Graph.js';
import {noteTools} from './Tools/Notes.js';
import {roadmapTools} from './Tools/Roadmap.js';
import {searchTools} from './Tools/Search.js';
import type {ToolHandler} from './Tools/Shared.js';
import {createLogger} from '@synaipse/core';

export {EMPTY_CTX} from './Tools/Shared.js';
export {REMOVED_TOOLS} from './Tools/Acl.js';
export type {ToolCall, ToolContext, ToolEventInfo, ToolHandler, ToolOutcome, ToolResponse} from './Tools/Shared.js';

/**
 * Tool groups. Only enabled toolsets are registered at all (not listed,
 * not callable), so a client that never plans roadmaps doesn't pay for
 * their schemas in every turn.
 */
export const TOOLSETS = ['core', 'roadmap', 'benchmark', 'admin'] as const;
export type Toolset = typeof TOOLSETS[number];

export const DEFAULT_TOOLSETS: readonly Toolset[] = ['core', 'roadmap', 'benchmark'];

/**
 * `SYNAIPSE_MCP_TOOLSETS=core,roadmap,admin` (or `all`). Unknown names are
 * ignored with a warning; `core` is always on.
 */
export const resolveToolsets = (raw: string | undefined = process.env.SYNAIPSE_MCP_TOOLSETS): readonly Toolset[] => {
    if (raw === undefined || raw.trim() === '') return DEFAULT_TOOLSETS;
    const names = raw.split(',').map((n) => n.trim().toLowerCase()).filter((n) => n.length > 0);
    if (names.includes('all')) return TOOLSETS;
    const known = names.filter((n): n is Toolset => (TOOLSETS as readonly string[]).includes(n));
    const unknown = names.filter((n) => !(TOOLSETS as readonly string[]).includes(n));
    if (unknown.length > 0) {
        createLogger('mcp').warn('unknown toolset(s) in SYNAIPSE_MCP_TOOLSETS', {unknown, known: [...TOOLSETS, 'all']});
    }
    return [...new Set<Toolset>(['core', ...known])];
};

export interface BuildToolsOptions {
    /** Default: {@link resolveToolsets} (env `SYNAIPSE_MCP_TOOLSETS`). */
    toolsets?: readonly Toolset[];
}

/** Every MCP tool of the enabled toolsets, ACL-classified. One module per group under Tools/. */
export const buildTools = (service: SynaipseService, options: BuildToolsOptions = {}): ToolHandler[] => {
    const enabled = new Set(options.toolsets ?? resolveToolsets());
    const groups: Array<[Toolset, ToolHandler[]]> = [
        ['core', [...noteTools(service), ...searchTools(service), ...graphTools(service)]],
        ['roadmap', roadmapTools(service)],
        ['benchmark', benchmarkTools(service)],
        ['admin', adminTools(service)]
    ];
    return applyAcl(groups.filter(([set]) => enabled.has(set)).flatMap(([, tools]) => tools));
};
