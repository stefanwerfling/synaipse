import {intParam, jsonCached} from '../cached-json.js';
import {json, notFoundError, type Router} from '../router.js';
import type {RouteDeps} from './shared.js';

const SEARCH_MODES = new Set(['fulltext', 'semantic', 'hybrid']);

/** Whole graph, Atlas layout, local graph and search. */
export const registerGraphRoutes = (router: Router, {service}: RouteDeps): void => {
    router.get('/api/graph', async ({req, res}) => {
        await jsonCached(req, res, service.graph());
    });

    router.get('/api/graph/local', ({res, url}) => {
        const id = url.searchParams.get('id') ?? '';
        const local = service.localGraph(id, {
            depth: intParam(url, 'depth', 1, 1, 3),
            limit: intParam(url, 'limit', 60, 1, 300)
        });

        if (local === null) throw notFoundError(`note not found: ${id}`);
        json(res, 200, local);
    });

    router.get('/api/graph/layout', async ({req, res}) => {
        const layout = await service.graphLayout();
        await jsonCached(req, res, layout, layout.stale === true ? `${layout.hash}-stale` : layout.hash);
    });

    router.get('/api/search', async ({res, url}) => {
        const q = url.searchParams.get('q') ?? '';
        const rawMode = url.searchParams.get('mode') ?? 'hybrid';
        const mode = (SEARCH_MODES.has(rawMode) ? rawMode : 'hybrid') as 'fulltext' | 'semantic' | 'hybrid';
        json(res, 200, await service.search(q, mode, intParam(url, 'limit', 20, 1, 200)));
    });
};
