import './Styles.css';
import {App} from './App.js';
import {setApiBase} from './ApiBase.js';
import {initTheme} from './Theme.js';

/**
 * Embeddable entry point for the Synaipse web UI.
 *
 * Standalone, `Main.ts` boots the app against `#root` and handles the
 * login screen. For in-process hosting (pkgstudio, local mode only),
 * this `mount()` renders the app into a caller-provided container with
 * a namespaced API base — without `Main.ts`'s auth gate or its
 * module-level bootstrap side effects.
 *
 * `apiBase` (e.g. "/synaipse") prefixes every API URL via apiUrl(),
 * so the host needs no `window.fetch` rewrite; a host that still has one
 * leaves the already-prefixed URLs alone.
 */
export interface SynaipseMountOptions {
    /** Namespaced base (e.g. "/synaipse"), prefixed to every API URL. */
    apiBase?: string;
}

export async function mount(container: HTMLElement, opts: SynaipseMountOptions = {}): Promise<void> {
    setApiBase(opts.apiBase);
    initTheme();
    container.classList.add('synaipse-root');

    const app = new App(null);
    await app.mount(container);
}
