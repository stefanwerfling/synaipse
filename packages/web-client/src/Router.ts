import {TABS, type Tab} from './Tabs.js';

/**
 * URL routes (plan P7 / C1). One route is one view the user can link to,
 * bookmark or reach with Back:
 *
 *   #/notes                     Notes tab
 *   #/notes/Memory/x/note.md    a note (each path segment URI-encoded)
 *   #/graph?focus=<note id>     graph, centred on a note
 *   #/roadmap/<project>         a project's roadmap
 *   #/<tab>                     any other tab
 *
 * Pure: parsing and formatting only. The app decides whether routes go to
 * location.hash (standalone) or only to the host (embedded).
 */
export interface Route {
    tab: Tab;
    note?: string;
    project?: string;
    focus?: string;
}

const isTab = (value: string): value is Tab => (TABS as readonly string[]).includes(value);

const decode = (part: string): string => {
    try {
        return decodeURIComponent(part);
    } catch {
        return part;
    }
};

/**
 * A hash (`#/notes/a.md`), a bare route (`graph`) or, for hosts that used
 * navigate() before routes existed, a note id (`Memory/a.md`). Null for
 * an empty input.
 */
export const parseRoute = (input: string): Route | null => {
    const raw = input.replace(/^#/, '').replace(/^\/+/, '');
    if (raw.length === 0) return null;

    const q = raw.indexOf('?');
    const path = q === -1 ? raw : raw.slice(0, q);
    const query = new URLSearchParams(q === -1 ? '' : raw.slice(q + 1));
    const segments = path.split('/').filter((s) => s.length > 0).map(decode);
    const head = segments[0] ?? '';

    if (!isTab(head)) {
        // Legacy navigate('Memory/a.md'): anything that is not a tab is a note.
        return {tab: 'notes', note: segments.join('/')};
    }

    const rest = segments.slice(1).join('/');
    const route: Route = {tab: head};
    if (head === 'notes' && rest.length > 0) route.note = rest;
    if (head === 'roadmap' && rest.length > 0) route.project = rest;
    const focus = query.get('focus');
    if (head === 'graph' && focus !== null && focus.length > 0) route.focus = focus;
    return route;
};

const encodePath = (path: string): string => path.split('/').map(encodeURIComponent).join('/');

/** The canonical hash for a route, e.g. `#/notes/Memory/a%20b.md`. */
export const formatRoute = (route: Route): string => {
    let out = `#/${route.tab}`;
    if (route.tab === 'notes' && route.note !== undefined && route.note.length > 0) out += `/${encodePath(route.note)}`;
    if (route.tab === 'roadmap' && route.project !== undefined && route.project.length > 0) out += `/${encodeURIComponent(route.project)}`;
    if (route.tab === 'graph' && route.focus !== undefined && route.focus.length > 0) {
        out += `?${new URLSearchParams({focus: route.focus}).toString()}`;
    }
    return out;
};
