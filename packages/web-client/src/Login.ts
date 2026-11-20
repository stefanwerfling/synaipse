import {el} from './Dom.js';
import {login} from './Auth.js';
import {defineMessages} from './I18n.js';

const t = defineMessages('login', {
    hostSignIn: 'Sign in through the host application to use Synaipse.',
    noAccount: 'No Synaipse account for {user}. Ask a Synaipse admin to create one with this e-mail.',
    subtitle: 'Sign in to continue',
    email: 'Email',
    password: 'Password',
    signIn: 'Sign in',
    required: 'Email and password are required',
    signingIn: 'Signing in…'
});

export interface LoginScreenOptions {
    /** Called after successful login so the caller can mount the app. */
    onSuccess: () => void;
}

/**
 * Shown instead of the login form when the embedding host owns sign-in
 * and Synaipse can't map the host's user to an account (or nobody is
 * signed in at the host). Nothing to do here but explain.
 */
export const mountHostSignInNotice = (host: HTMLElement, hostUser: string | undefined): void => {
    host.innerHTML = '';
    const card = el('div', {class: 'login-card'},
        el('h1', {class: 'login-title', text: 'Synaipse'}),
        el('p', {class: 'login-subtitle', text: hostUser === undefined
            ? t('hostSignIn')
            : t('noAccount', {user: hostUser})})
    );
    host.appendChild(el('div', {class: 'login-screen'}, card));
};

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
    const subtitle = el('p', {class: 'login-subtitle', text: t('subtitle')});

    const emailInput = el('input', {
        class: 'login-input',
        attrs: {type: 'email', name: 'email', placeholder: t('email'), autocomplete: 'username', required: 'true'}
    });

    const passwordInput = el('input', {
        class: 'login-input',
        attrs: {type: 'password', name: 'password', placeholder: t('password'), autocomplete: 'current-password', required: 'true'}
    });

    const errorMsg = el('div', {class: 'login-error', attrs: {'aria-live': 'polite'}});
    const submitBtn = el('button', {
        class: 'login-submit',
        attrs: {type: 'submit'},
        text: t('signIn')
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
            errorMsg.textContent = t('required');
            return;
        }

        submitBtn.disabled = true;
        submitBtn.textContent = t('signingIn');
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
                submitBtn.textContent = t('signIn');
            }
        })();
    });

    // Auto-focus email so keyboard users land directly in the form.
    queueMicrotask(() => emailInput.focus());
};