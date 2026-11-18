/* global setTimeout, process */
// Test fixture for WorkerRpc: echo, failure and crash handlers.
import {serveWorkerRpc} from '@synaipse/core/worker-rpc';
import {workerData} from 'node:worker_threads';

serveWorkerRpc({
    add: (a, b) => a + b,
    data: () => workerData,
    slow: (ms, value) => new Promise((resolve) => setTimeout(() => resolve(value), ms)),
    fail: () => {
        throw new Error('boom');
    },
    crash: () => {
        process.exit(3);
    }
});
