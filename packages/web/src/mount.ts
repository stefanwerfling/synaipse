import './Styles.css';
import {App} from './App.js';
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
 * API base handling (routing `/api/...` to `/mod/synaipse/api/...`) is
 * owned by the host shell's single request rewrite — a module must not
 * patch `window.fetch` itself, or two mounted modules would fight over
 * it. `apiBase` is accepted for interface symmetry but not needed here.
 */
export interface SynaipseMountOptions {
    /** Namespaced base (e.g. "/mod/synaipse"); applied by the host shell. */
    apiBase?: string;
}

export async function mount(container: HTMLElement, _opts: SynaipseMountOptions = {}): Promise<void> {
    initTheme();
    container.classList.add('synaipse-root');

    const app = new App(null);
    await app.mount(container);
}
