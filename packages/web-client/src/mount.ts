import './Styles.css';
import {App} from './App.js';
import {setApiBase} from './ApiBase.js';
import {fetchAuthMode} from './Auth.js';
import {getLocale, initLocale, onLocaleChange, setLocale, type Locale} from './I18n.js';
import {mountHostSignInNotice, mountLoginScreen} from './Login.js';
import {getTheme, initTheme, onThemeChange, ROOT_CLASS, setTheme, type Theme} from './Theme.js';

/**
 * The one entry point for the Synaipse web UI (plan P3 / E1) — used by
 * `Main.ts` standalone and by embedding hosts such as PKG Studio.
 *
 *   const handle = await mount(container, {apiBase: '/synaipse', onRouteChange: (r) => …});
 *   handle.onHide(); handle.onShow(); handle.navigate('#/roadmap/synaipse');
 *   await handle.unmount();   // stops SSE, timers, listeners; removes DOM
 *
 * `apiBase` prefixes every API URL via apiUrl(), so the host needs no
 * `window.fetch` rewrite (a host that still has one leaves the prefixed
 * URLs alone). Hosts that ignore the returned handle keep working.
 */
export interface SynaipseMountOptions {
    /** Namespaced base (e.g. "/synaipse"), prefixed to every API URL. */
    apiBase?: string;
    /** Initial theme; later changes via handle.setTheme(). Default: stored preference. */
    theme?: Theme;
    /**
     * Ask the backend for its auth mode and show the login screen when a
     * server-mode session is missing (default false). Standalone sets it.
     * A host that passes `principal` to the backend sets it too: then the
     * gate shows the app for the host's user, or a notice when Synaipse has
     * no account for them, never a login form.
     */
    authGate?: boolean;
    /** Initial route: `#/notes/<path>`, `#/graph?focus=<id>`, `#/roadmap/<project>`, a tab name or a note id. */
    route?: string;
    /**
     * Where the current view lives (plan P7 / C1). 'hash': in location.hash,
     * so deep links, Back and sharing work — standalone uses it. 'none'
     * (default): the page URL belongs to the host; Synaipse only reports
     * views via onRouteChange and takes them via handle.navigate().
     */
    routing?: 'hash' | 'none';
    /** Every view change as a route (`#/notes/a.md`), for a host that mirrors it in its own URL. */
    onRouteChange?: (route: string) => void;
    /** false: hide the Synaipse logo and name in the top bar, when the host's tab names it already (default true). */
    brand?: boolean;
    /**
     * Called with the active theme once after mount and whenever it changes
     * (the user's toggle or handle.setTheme), so the host can switch its own
     * shell tokens (--sh-*) along — Synaipse reads them first (plan P9 / E3).
     */
    onThemeChange?: (theme: Theme) => void;
    /**
     * UI language (plan P7 / C3); later changes via handle.setLocale().
     * Default: the user's stored choice, else English.
     */
    locale?: Locale;
}

export interface SynaipseMountHandle {
    unmount(): Promise<void>;
    setTheme(theme: Theme): void;
    getTheme(): Theme;
    /** Switch the UI language; the view is rebuilt on the same route. */
    setLocale(locale: Locale): Promise<void>;
    getLocale(): Locale;
    /** Go to a route (see SynaipseMountOptions.route); resolves when the view is shown. */
    navigate(route: string): Promise<void>;
    /** Host tab became visible / hidden. */
    onShow(): void;
    onHide(): void;
}

type Account = {id: number; email: string; isAdmin: boolean; managedByHost?: boolean};

export async function mount(container: HTMLElement, opts: SynaipseMountOptions = {}): Promise<SynaipseMountHandle> {
    setApiBase(opts.apiBase);
    // Class first: the theme is stamped on every .synaipse-root.
    container.classList.add(ROOT_CLASS);
    if (opts.brand === false) container.setAttribute('data-brand', 'off');
    if (opts.theme !== undefined) setTheme(opts.theme);
    else initTheme();
    const notify = opts.onThemeChange;
    const offTheme = notify === undefined ? undefined : onThemeChange(notify);
    notify?.(getTheme());
    // German text is its own chunk; load it before anything renders.
    await initLocale(opts.locale);
    container.setAttribute('lang', getLocale());

    let app: App | null = null;
    let unmounted = false;
    /** Last route the app reported; a language switch rebuilds the view there. */
    let lastRoute: string | null = null;
    let resumeRoute: string | null = null;

    const showApp = async (account: Account | null): Promise<void> => {
        container.replaceChildren();
        app = new App(account, {
            onSignedOut: () => void boot(),
            routing: opts.routing ?? 'none',
            onRouteChange: (route) => {
                lastRoute = route;
                opts.onRouteChange?.(route);
            }
        });
        await app.mount(container);
        const initial = resumeRoute ?? opts.route ?? (opts.routing === 'hash' ? window.location.hash : '');
        resumeRoute = null;
        await app.navigate(initial, {replace: true});
    };

    const showLogin = (): void => {
        app?.destroy();
        app = null;
        mountLoginScreen(container, {onSuccess: () => void boot()});
    };

    const boot = async (): Promise<void> => {
        if (unmounted) return;
        if (opts.authGate === true) {
            // /api/auth/mode is public in both modes. On failure mount the
            // app anyway so a mis-deployed auth endpoint can't strand the UI.
            try {
                const mode = await fetchAuthMode();
                if (mode.mode === 'server') {
                    if (!mode.authenticated) {
                        if (mode.managed === 'host') {
                            app?.destroy();
                            app = null;
                            mountHostSignInNotice(container, mode.hostUser);
                        } else {
                            showLogin();
                        }
                        return;
                    }
                    app?.destroy();
                    await showApp({
                        id: mode.account.id,
                        email: mode.account.email,
                        isAdmin: mode.account.isAdmin,
                        ...(mode.managed === 'host' ? {managedByHost: true} : {})
                    });
                    return;
                }
            } catch (err) {
                console.warn('[synaipse] /api/auth/mode failed, mounting app anyway:', err);
            }
        }
        app?.destroy();
        await showApp(null);
    };

    await boot();

    // Text is built once per view, so a language switch rebuilds the app
    // (and the login screen) on the route it was showing.
    const offLocale = onLocaleChange((locale) => {
        container.setAttribute('lang', locale);
        resumeRoute = lastRoute;
        void boot();
    });

    return {
        unmount: async () => {
            unmounted = true;
            offTheme?.();
            offLocale();
            app?.destroy();
            app = null;
            container.replaceChildren();
            container.classList.remove(ROOT_CLASS);
            container.removeAttribute('data-theme');
            container.removeAttribute('data-brand');
            container.removeAttribute('lang');
            // Overlays left open (dialogs, menus) live in the portal layer.
            if (document.querySelector(`.${ROOT_CLASS}:not(.synaipse-portal)`) === null) {
                document.querySelector('body > .synaipse-portal')?.remove();
            }
        },
        setTheme: (theme) => setTheme(theme),
        getTheme: () => getTheme(),
        setLocale: (locale) => setLocale(locale),
        getLocale: () => getLocale(),
        navigate: async (route) => {
            await app?.navigate(route);
        },
        onShow: () => app?.onShow(),
        onHide: () => app?.onHide()
    };
}
