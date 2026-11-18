import type {SynaipseService} from '@synaipse/service';
import {applyAcl} from './Tools/Acl.js';
import {adminTools} from './Tools/Admin.js';
import {benchmarkTools} from './Tools/Benchmark.js';
import {graphTools} from './Tools/Graph.js';
import {noteTools} from './Tools/Notes.js';
import {roadmapTools} from './Tools/Roadmap.js';
import {searchTools} from './Tools/Search.js';
import type {ToolHandler} from './Tools/Shared.js';

export {EMPTY_CTX} from './Tools/Shared.js';
export type {ToolContext, ToolEventInfo, ToolHandler, ToolOutcome, ToolResponse} from './Tools/Shared.js';

/** Every MCP tool, ACL-classified. One module per tool group under Tools/. */
export const buildTools = (service: SynaipseService): ToolHandler[] => applyAcl([
    ...noteTools(service),
    ...searchTools(service),
    ...graphTools(service),
    ...roadmapTools(service),
    ...benchmarkTools(service),
    ...adminTools(service)
]);
