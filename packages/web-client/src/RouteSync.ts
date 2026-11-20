import {formatRoute, type Route} from './Router.js';

/**
 * Records the current view (plan P7 / C1, split out in D2): in the URL
 * hash when the app runs standalone, and for the host via onRouteChange.
 * While a navigation is in progress (begin/end) intermediate steps stay
 * out of the history; the view that results is recorded once at the end.
 */

export interface RouteSyncOptions {
    routing?: 'hash' | 'none';
    onRouteChange?: (route: string) => void;
}

export class RouteSync {
    private navigating = 0;
    private lastRoute: string | null = null;

    public constructor(private readonly opts: RouteSyncOptions, private readonly current: () => Route) {}

    public begin(): void {
        this.navigating += 1;
    }

    public end(): void {
        this.navigating -= 1;
    }

    /**
     * Record the current view. `settle` tells the host even when nothing
     * changed (a declined navigation still has to report where the app is).
     */
    public record(mode: 'push' | 'replace' = 'push', settle = false): void {
        if (this.navigating > 0) return;
        const hash = formatRoute(this.current());
        const changed = hash !== this.lastRoute;
        const first = this.lastRoute === null;
        this.lastRoute = hash;
        // The URL can name another view than the one shown: an edited hash or
        // a host route the user declined (kept unsaved changes). Put it back.
        if (this.opts.routing === 'hash' && window.location.hash !== hash) {
            if (first || mode === 'replace' || !changed) window.history.replaceState(window.history.state, '', hash);
            else window.history.pushState(null, '', hash);
        }
        if (changed || settle) this.opts.onRouteChange?.(hash);
    }
}
