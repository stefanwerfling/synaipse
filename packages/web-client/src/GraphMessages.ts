import {defineMessages} from './I18n.js';

/** Status texts shared by the graph tab and its 2D and 3D views (plan P7 / C3). */
export const tg = defineMessages('graph', {
    fetching: 'fetching graph…',
    fetched: 'fetched {nodes} nodes / {edges} edges in {ms}ms',
    computing: 'computing layout for {nodes} nodes / {edges} edges…',
    layoutFailed: 'layout failed: {cause}',
    nodes: '{count} node|{count} nodes',
    edges: '{count} edge|{count} edges',
    communities: '{count} community|{count} communities',
    overview: 'overview · {count} communities',
    modularity: 'mod {value}',
    zoomClick: 'zoom {zoom}× (click a community)',
    zoom: 'zoom {zoom}×',
    layoutMs: 'layout {ms}ms',
    updating: 'updating…',
    community: 'community {id}',
    clusterTitle: '{name} · {count} note · click to zoom in|{name} · {count} notes · click to zoom in'
});
