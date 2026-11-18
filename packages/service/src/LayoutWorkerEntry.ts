import {parentPort} from 'node:worker_threads';
import {computeLayout, type GraphInput} from './Layout.js';

/**
 * worker_threads entry for {@link LayoutComputer} (plan P4 / A3): Louvain
 * plus tile layout run here, so a 50k-note graph no longer stalls the
 * event loop of the web/MCP server for seconds.
 */
interface LayoutRequest {
    id: number;
    input: GraphInput;
}

parentPort?.on('message', (request: LayoutRequest) => {
    try {
        parentPort?.postMessage({id: request.id, layout: computeLayout(request.input)});
    } catch (error) {
        parentPort?.postMessage({id: request.id, error: error instanceof Error ? error.stack ?? error.message : String(error)});
    }
});
