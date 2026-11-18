import {parseBenchmarkSet, parseCanvas, parseRoadmap} from '@synaipse/core';
import {jsonGzip} from '../cached-json.js';
import {HttpError, json, requiredParam, type Router} from '../router.js';
import {errorMessage, readJson, type RouteDeps} from './shared.js';

/** Path-escape attempts are the caller's fault, everything else `fallback`. */
const escapeOr = (error: unknown, fallback: number): HttpError => {
    const message = errorMessage(error);
    return new HttpError(message.includes('escape') ? 400 : fallback, message);
};

const invalidProjectOr500 = (error: unknown): HttpError => {
    const message = errorMessage(error);
    return new HttpError(message.includes('invalid project') ? 400 : 500, message);
};

/** Canvases, roadmaps and benchmark sets: per-project documents in the vault. */
export const registerProjectRoutes = (router: Router, {service}: RouteDeps): void => {
    router.get('/api/canvases', async ({res}) => {
        json(res, 200, {canvases: await service.listCanvases()});
    });

    router.get('/api/canvas', async ({req, res, url}) => {
        const id = requiredParam(url, 'path');
        try {
            await jsonGzip(req, res, 200, await service.readCanvas(id));
        } catch (error) {
            throw escapeOr(error, 404);
        }
    });

    router.put('/api/canvas', async ({req, res, url}) => {
        const id = requiredParam(url, 'path');
        const body = await readJson<unknown>(req);
        try {
            // Re-parse via the same defensive path as reads: malformed
            // nodes/edges get dropped instead of persisted, so a buggy
            // client can't poison a `.canvas` file.
            await service.writeCanvas(id, parseCanvas(JSON.stringify(body)));
            json(res, 200, {ok: true});
        } catch (error) {
            throw escapeOr(error, 500);
        }
    });

    router.delete('/api/canvas', async ({res, url}) => {
        const id = requiredParam(url, 'path');
        try {
            await service.deleteCanvas(id);
            res.writeHead(204).end();
        } catch (error) {
            throw escapeOr(error, 404);
        }
    });

    router.get('/api/roadmaps', ({res}) => {
        json(res, 200, {roadmaps: service.listRoadmaps()});
    });

    router.get('/api/roadmap', async ({req, res, url}) => {
        const project = requiredParam(url, 'project');
        let roadmap;
        try {
            roadmap = service.readRoadmap(project);
        } catch (error) {
            throw new HttpError(400, errorMessage(error));
        }
        await jsonGzip(req, res, 200, roadmap);
    });

    router.put('/api/roadmap', async ({req, res, url}) => {
        const project = requiredParam(url, 'project');
        const body = await readJson<{steps?: unknown; active?: unknown}>(req);
        try {
            // Re-parse through the defensive core parser so a malformed
            // client payload drops bad steps instead of persisting them.
            const roadmap = parseRoadmap(project, {roadmap: body}) ?? {project, updatedAt: '', active: null, steps: []};
            await jsonGzip(req, res, 200, await service.writeRoadmap({...roadmap, project}));
        } catch (error) {
            throw invalidProjectOr500(error);
        }
    });

    router.get('/api/benchmarks', ({res}) => {
        json(res, 200, {benchmarks: service.listBenchmarks()});
    });

    router.get('/api/benchmark', async ({req, res, url}) => {
        const project = requiredParam(url, 'project');
        let set;
        try {
            set = service.readBenchmarks(project);
        } catch (error) {
            throw new HttpError(400, errorMessage(error));
        }
        await jsonGzip(req, res, 200, set);
    });

    router.put('/api/benchmark', async ({req, res, url}) => {
        const project = requiredParam(url, 'project');
        const body = await readJson<{entries?: unknown}>(req);
        try {
            // Re-parse through the defensive core parser so a malformed
            // client payload drops bad entries instead of persisting them.
            const set = parseBenchmarkSet(project, {benchmarks: body}) ?? {project, updatedAt: '', entries: []};
            await jsonGzip(req, res, 200, await service.writeBenchmarks({...set, project}));
        } catch (error) {
            throw invalidProjectOr500(error);
        }
    });
};
