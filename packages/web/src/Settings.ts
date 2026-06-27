import {logout} from './Auth.js';
import {el} from './Dom.js';
import {TokensPanel} from './TokensPanel.js';

export interface SettingsOptions {
    account: {email: string; isAdmin: boolean};
}

/**
 * Account settings modal. Hosts the tokens panel and a logout footer.
 * Single-tab for now — Admin tab (slice 16d) will add a second section.
 */
export class Settings {
    private overlay: HTMLElement | null = null;
    private isOpen = false;

    public constructor(private readonly opts: SettingsOptions) {}

    public open(): void {
        if (this.isOpen) return;
        this.isOpen = true;

        this.overlay = el('div', {class: 'settings-overlay'});
        this.overlay.addEventListener('click', (e) => {
            if (e.target === this.overlay) this.close();
        });

        const dialog = el('div', {class: 'settings-dialog'});
        this.overlay.appendChild(dialog);

        const closeBtn = el('button', {
            class: 'import-close',
            attrs: {type: 'button', 'aria-label': 'close'},
            text: '×',
            on: {click: () => this.close()}
        });

        const head = el('div', {class: 'settings-head'},
            el('div', {class: 'settings-head-main'},
                el('h2', {text: 'Account settings'}),
                el('div', {class: 'settings-head-email', text: this.opts.account.email})
            ),
            closeBtn
        );

        const body = el('div', {class: 'settings-body'});
        const tokens = new TokensPanel();
        body.appendChild(tokens.element);

        const logoutBtn = el('button', {
            class: 'btn',
            attrs: {type: 'button'},
            text: 'Sign out',
            on: {
                click: () => {
                    void (async () => {
                        await logout();
                        location.reload();
                    })();
                }
            }
        });

        const footer = el('div', {class: 'settings-footer'},
            el('span', {class: 'settings-footer-hint', text: 'You stay signed in across browser sessions until you sign out.'}),
            logoutBtn
        );

        dialog.appendChild(head);
        dialog.appendChild(body);
        dialog.appendChild(footer);

        document.body.appendChild(this.overlay);
        void tokens.onShow();
    }

    public close(): void {
        if (!this.isOpen) return;
        this.isOpen = false;
        this.overlay?.remove();
        this.overlay = null;
    }
}