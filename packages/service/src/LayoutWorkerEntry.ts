import {serveWorkerRpc} from '@synaipse/core/worker-rpc';
import {computeLayout} from './Layout.js';

/**
 * worker_threads entry for {@link LayoutComputer} (plan P4 / A3): Louvain
 * plus tile layout run here, so a 50k-note graph no longer stalls the
 * event loop of the web/MCP server for seconds.
 */
serveWorkerRpc({computeLayout});
