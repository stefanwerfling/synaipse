import {el} from './Dom.js';
import {login} from './Auth.js';

export interface LoginScreenOptions {
    /** Called after successful login so the caller can mount the app. */
    onSuccess: () => void;
}

/**
 * Pre-mount login screen for server-mode. Standalone module so the
 * main App doesn't need to know about authentication state — Main.ts
 * checks /api/auth/mode and either mounts this screen OR mounts App.
 */
export const mountLoginScreen = (host: HTMLElement, opts: LoginScreenOptions): void => {
    host.innerHTML = '';

    const wrap = el('div', {class: 'login-screen'});
    const card = el('form', {class: 'login-card', attrs: {novalidate: 'true'}});

    const title = el('h1', {class: 'login-title', text: 'Synaipse'});
    const subtitle = el('p', {class: 'login-subtitle', text: 'Sign in to continue'});

    const emailInput = el('input', {
        class: 'login-input',
        attrs: {type: 'email', name: 'email', placeholder: 'Email', autocomplete: 'username', required: 'true'}
    });

    const passwordInput = el('input', {
        class: 'login-input',
        attrs: {type: 'password', name: 'password', placeholder: 'Password', autocomplete: 'current-password', required: 'true'}
    });

    const errorMsg = el('div', {class: 'login-error', attrs: {'aria-live': 'polite'}});
    const submitBtn = el('button', {
        class: 'login-submit',
        attrs: {type: 'submit'},
        text: 'Sign in'
    });

    card.appendChild(title);
    card.appendChild(subtitle);
    card.appendChild(emailInput);
    card.appendChild(passwordInput);
    card.appendChild(errorMsg);
    card.appendChild(submitBtn);
    wrap.appendChild(card);
    host.appendChild(wrap);

    card.addEventListener('submit', (e: Event) => {
        e.preventDefault();
        const email = emailInput.value.trim();
        const password = passwordInput.value;

        if (email.length === 0 || password.length === 0) {
            errorMsg.textContent = 'Email and password are required';
            return;
        }

        submitBtn.disabled = true;
        submitBtn.textContent = 'Signing in…';
        errorMsg.textContent = '';

        void (async () => {
            try {
                const result = await login(email, password);
                if (result.ok) {
                    opts.onSuccess();
                    return;
                }
                errorMsg.textContent = result.message;
            } catch (err) {
                errorMsg.textContent = err instanceof Error ? err.message : String(err);
            } finally {
                submitBtn.disabled = false;
                submitBtn.textContent = 'Sign in';
            }
        })();
    });

    // Auto-focus email so keyboard users land directly in the form.
    queueMicrotask(() => emailInput.focus());
};