import {logout} from './Auth.js';
import {clear, el} from './Dom.js';
import {TokensPanel} from './TokensPanel.js';
import {AdminPanel} from './AdminPanel.js';

export interface SettingsOptions {
    account: {id: number; email: string; isAdmin: boolean};
}

type TabKey = 'tokens' | 'admin';

/**
 * Account settings modal. Hosts tabbed panels and a logout footer.
 *
 *   Tab 1: My tokens — self-service MCP-token CRUD (everyone)
 *   Tab 2: Admin     — user-management (admin accounts only)
 */
export class Settings {
    private overlay: HTMLElement | null = null;
    private isOpen = false;
    private activeTab: TabKey = 'tokens';
    private bodyHost: HTMLElement | null = null;
    private tokensPanel: TokensPanel | null = null;
    private adminPanel: AdminPanel | null = null;
    private tabButtons = new Map<TabKey, HTMLButtonElement>();

    public constructor(private readonly opts: SettingsOptions) {}

    public open(): void {
        if (this.isOpen) return;
        this.isOpen = true;
        this.activeTab = 'tokens';

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

        const tabs = this.buildTabs();
        this.bodyHost = el('div', {class: 'settings-body'});

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
        if (tabs !== null) dialog.appendChild(tabs);
        dialog.appendChild(this.bodyHost);
        dialog.appendChild(footer);

        document.body.appendChild(this.overlay);
        this.renderActiveTab();
    }

    public close(): void {
        if (!this.isOpen) return;
        this.isOpen = false;
        this.overlay?.remove();
        this.overlay = null;
        this.bodyHost = null;
        this.tokensPanel = null;
        this.adminPanel = null;
        this.tabButtons.clear();
    }

    private buildTabs(): HTMLElement | null {
        if (!this.opts.account.isAdmin) {
            // Non-admins only see one panel; skip the tab bar entirely to
            // keep the modal compact.
            return null;
        }

        const tokensBtn = el('button', {
            class: 'settings-tab active',
            attrs: {type: 'button'},
            text: 'My tokens',
            on: {click: () => this.switchTab('tokens')}
        }) as HTMLButtonElement;

        const adminBtn = el('button', {
            class: 'settings-tab',
            attrs: {type: 'button'},
            text: 'Admin',
            on: {click: () => this.switchTab('admin')}
        }) as HTMLButtonElement;

        this.tabButtons.set('tokens', tokensBtn);
        this.tabButtons.set('admin', adminBtn);

        return el('nav', {class: 'settings-tabs'}, tokensBtn, adminBtn);
    }

    private switchTab(key: TabKey): void {
        if (this.activeTab === key) return;
        this.activeTab = key;
        for (const [k, btn] of this.tabButtons) {
            btn.className = k === key ? 'settings-tab active' : 'settings-tab';
        }
        this.renderActiveTab();
    }

    private renderActiveTab(): void {
        if (this.bodyHost === null) return;
        clear(this.bodyHost);

        if (this.activeTab === 'tokens') {
            if (this.tokensPanel === null) this.tokensPanel = new TokensPanel();
            this.bodyHost.appendChild(this.tokensPanel.element);
            void this.tokensPanel.onShow();
            return;
        }

        if (this.activeTab === 'admin') {
            if (this.adminPanel === null) this.adminPanel = new AdminPanel({selfId: this.opts.account.id});
            this.bodyHost.appendChild(this.adminPanel.element);
            void this.adminPanel.onShow();
        }
    }
}