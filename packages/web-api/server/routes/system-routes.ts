import type {SynaipseEvent} from '../events.js';
import type {JobParams} from '../jobs.js';
import {ALLOWED_JOB_TYPES, isJobType, validateJobParams} from '../job-validation.js';
import {badRequest, json, notFoundError, type Router} from '../router.js';
import {readJson, type RouteDeps} from './shared.js';

/** Live events, server info and background jobs. */
export const registerSystemRoutes = (router: Router, {service, broadcaster, jobs}: RouteDeps): void => {
    router.get('/api/events/stream', ({res}) => {
        broadcaster.addClient(res);
    });

    router.post('/api/events', async ({req, res}) => {
        broadcaster.publish(await readJson<SynaipseEvent>(req));
        json(res, 200, {ok: true, clients: broadcaster.clientCount()});
    });

    router.get('/api/info', async ({res}) => {
        json(res, 200, {
            semanticEnabled: service.hasSemanticIndex(),
            notesCount: service.listNotes().length,
            project: service.getProject(),
            historyEnabled: await service.historyEnabled(),
            chatEnabled: service.chatEnabled(),
            chatModel: service.getChatModel(),
            chatProvider: service.getChatProviderKind(),
            chatProviderIsLocal: service.getChatProviderIsLocal(),
            researchEnabled: service.researchEnabled(),
            researchProvider: service.getResearchProviderKind()
        });
    });

    router.get('/api/jobs', ({res}) => {
        json(res, 200, jobs.listJobs());
    });

    router.post('/api/jobs', async ({req, res}) => {
        const body = await readJson<{type?: unknown; params?: unknown}>(req);

        if (!isJobType(body.type)) {
            throw badRequest(`field 'type' must be one of ${ALLOWED_JOB_TYPES.join(', ')}`);
        }

        if (typeof body.params !== 'object' || body.params === null) {
            throw badRequest("field 'params' must be object");
        }

        const paramError = validateJobParams(body.type, body.params as Record<string, unknown>);
        if (paramError !== null) throw badRequest(paramError);

        json(res, 200, jobs.startJob(body.type, body.params as JobParams));
    });

    router.get('/api/jobs/:id/stream', ({req, res, params}) => {
        const jobId = params.id as string;
        const job = jobs.getJob(jobId);
        if (job === undefined) throw notFoundError();

        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive'
        });

        // Replay current state so the client doesn't need a separate GET first.
        res.write(`data: ${JSON.stringify({kind: 'snapshot', job})}\n\n`);

        const unsubscribe = jobs.subscribe(jobId, (event) => {
            res.write(`data: ${JSON.stringify(event)}\n\n`);

            if (event.kind === 'done' || event.kind === 'failed' || event.kind === 'stopped') {
                res.end();
            }
        });

        req.on('close', unsubscribe);
    });

    router.post('/api/jobs/:id/stop', ({res, params}) => {
        const ok = jobs.stopJob(params.id as string);
        json(res, ok ? 200 : 404, {ok});
    });

    router.get('/api/jobs/:id', ({res, params}) => {
        const job = jobs.getJob(params.id as string);
        if (job === undefined) throw notFoundError();
        json(res, 200, job);
    });
};
