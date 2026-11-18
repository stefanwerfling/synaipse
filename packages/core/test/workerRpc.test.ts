import {describe, expect, it} from 'vitest';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import {WorkerRpc} from '../src/WorkerRpc.js';

const fixture = pathToFileURL(path.resolve(__dirname, 'fixtures/rpc-worker.mjs'));

describe('WorkerRpc', () => {
    it('calls handlers in the worker, passes workerData, keeps order', async () => {
        const rpc = new WorkerRpc(fixture, 'test', {hello: 'world'});
        expect(rpc.available).toBe(true);

        const [slow, fast] = await Promise.all([rpc.call<string>('slow', 30, 'first'), rpc.call<number>('add', 2, 3)]);
        expect(slow).toBe('first');
        expect(fast).toBe(5);
        expect(await rpc.call('data')).toEqual({hello: 'world'});
        await rpc.close();
    });

    it('rejects handler errors without killing the worker', async () => {
        const rpc = new WorkerRpc(fixture, 'test');
        await expect(rpc.call('fail')).rejects.toThrow(/boom/);
        await expect(rpc.call('missing')).rejects.toThrow(/unknown worker method/);
        expect(await rpc.call('add', 1, 1)).toBe(2);
        await rpc.close();
    });

    it('rejects in-flight calls when the worker dies and restarts on the next call', async () => {
        const rpc = new WorkerRpc(fixture, 'test');
        const pending = rpc.call('slow', 500, 'never');
        await expect(rpc.call('crash')).rejects.toThrow(/exited with code 3/);
        await expect(pending).rejects.toThrow(/exited with code 3/);
        expect(await rpc.call('add', 4, 4)).toBe(8);
        await rpc.close();
    });

    it('is unavailable when the entry file does not exist, and closed after close()', async () => {
        expect(new WorkerRpc(pathToFileURL('/nonexistent/worker.js'), 'x').available).toBe(false);

        const rpc = new WorkerRpc(fixture, 'test');
        await rpc.close();
        expect(rpc.available).toBe(false);
        await expect(rpc.call('add', 1, 2)).rejects.toThrow(/closed/);
    });
});
