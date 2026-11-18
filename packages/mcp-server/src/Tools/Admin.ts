import type {SynaipseService} from '@synaipse/service';
import {asString, ok, type ToolHandler} from './Shared.js';

/** History forensics over the whole vault (verify, browse past snapshots). */
export const adminTools = (service: SynaipseService): ToolHandler[] => [
    {
        definition: {
            name: 'synaipse_verify_history',
            description: 'Health-check the ngit history store inside the vault. Re-hashes every stored object and reports whether the on-disk content still matches. Returns {enabled: false} when versioning is disabled.',
            inputSchema: {type: 'object', properties: {}}
        },
        handle: async () => {
            const report = await service.verifyHistory();

            if (report === null) {
                return {response: ok({enabled: false}), event: {kind: 'list', touched: []}};
            }

            return {
                response: ok({enabled: true, ...report}),
                event: {kind: 'list', touched: []}
            };
        }
    },
    {
        definition: {
            name: 'synaipse_snapshot_list',
            description: 'List entries (files + sub-trees) of the vault as they existed at a past commit. Use to browse the vault state historically, or to compare folder contents across two points in time. Returns an empty list when versioning is disabled.',
            inputSchema: {
                type: 'object',
                properties: {
                    sha: {type: 'string', description: '40-char commit sha to view'},
                    path: {type: 'string', description: 'Optional folder inside the snapshot, e.g. "Memory/decisions/"'}
                },
                required: ['sha']
            }
        },
        handle: async (args) => {
            const sha = asString(args.sha, 'sha');
            const treePath = typeof args.path === 'string' ? args.path : undefined;
            const entries = await service.snapshotList(sha, treePath);
            return {
                response: ok({sha, path: treePath ?? '', entries}),
                event: {kind: 'list', touched: []}
            };
        }
    }
];
