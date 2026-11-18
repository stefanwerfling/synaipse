import './Styles.css';
import {App} from './App.js';
import {setApiBase} from './ApiBase.js';
import {fetchAuthMode} from './Auth.js';
import {mountLoginScreen} from './Login.js';
import {initTheme, setTheme, type Theme} from './Theme.js';

/**
 * The one entry point for the Synaipse web UI (plan P3 / E1) — used by
 * `Main.ts` standalone and by embedding hosts such as PKG Studio.
 *
 *   const handle = await mount(container, {apiBase: '/synaipse'});
 *   handle.onHide(); handle.onShow(); handle.navigate('graph');
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
     * server-mode session is missing. Standalone only — an embedding host
     * owns authentication (default false).
     */
    authGate?: boolean;
    /** Initial route: a tab name ("graph") or a note id. */
    route?: string;
}

export interface SynaipseMountHandle {
    unmount(): Promise<void>;
    setTheme(theme: Theme): void;
    navigate(route: string): void;
    /** Host tab became visible / hidden. */
    onShow(): void;
    onHide(): void;
}

type Account = {id: number; email: string; isAdmin: boolean};

export async function mount(container: HTMLElement, opts: SynaipseMountOptions = {}): Promise<SynaipseMountHandle> {
    setApiBase(opts.apiBase);
    if (opts.theme !== undefined) setTheme(opts.theme);
    else initTheme();
    container.classList.add('synaipse-root');

    let app: App | null = null;
    let unmounted = false;

    const showApp = async (account: Account | null): Promise<void> => {
        container.replaceChildren();
        app = new App(account, {onSignedOut: () => void boot()});
        await app.mount(container);
        if (opts.route !== undefined) app.navigate(opts.route);
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
                        showLogin();
                        return;
                    }
                    app?.destroy();
                    await showApp({id: mode.account.id, email: mode.account.email, isAdmin: mode.account.isAdmin});
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

    return {
        unmount: async () => {
            unmounted = true;
            app?.destroy();
            app = null;
            container.replaceChildren();
            container.classList.remove('synaipse-root');
        },
        setTheme: (theme) => setTheme(theme),
        navigate: (route) => app?.navigate(route),
        onShow: () => app?.onShow(),
        onHide: () => app?.onHide()
    };
}
