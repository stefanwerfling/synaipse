import './Styles.css';
import {App} from './App.js';
import {fetchAuthMode} from './Auth.js';
import {mountLoginScreen} from './Login.js';
import {initTheme} from './Theme.js';

initTheme();

const host = document.getElementById('root');

if (host === null) {
    throw new Error('Root element not found');
}

const mountApp = (account: {id: number; email: string; isAdmin: boolean} | null = null): void => {
    const app = new App(account);
    void app.mount(host);
};

const bootstrap = async (): Promise<void> => {
    // /api/auth/mode is public in both local and server mode; tells us
    // whether the app should boot directly or show the login screen
    // first. On any failure we fall back to mounting the app so a
    // mis-deployed auth endpoint can't strand the UI.
    try {
        const mode = await fetchAuthMode();
        if (mode.mode === 'server') {
            if (!mode.authenticated) {
                mountLoginScreen(host, {
                    onSuccess: () => {
                        // Refresh after login so the topbar account button picks up the new state.
                        location.reload();
                    }
                });
                return;
            }
            mountApp({id: mode.account.id, email: mode.account.email, isAdmin: mode.account.isAdmin});
            return;
        }
    } catch (err) {
        console.warn('[synaipse] /api/auth/mode failed, mounting app anyway:', err);
    }

    mountApp();
};

void bootstrap();