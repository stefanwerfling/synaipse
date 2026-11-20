import {logout} from './Auth.js';
import {clear, el} from './Dom.js';
import {defineMessages, tc} from './I18n.js';
import {openModal, type ModalHandle} from './Modal.js';
import {TokensPanel} from './TokensPanel.js';
import {AdminPanel} from './AdminPanel.js';

export interface SettingsOptions {
    /** managedByHost: the embedding host owns sign-in, so no sign-out button here. */
    account: {id: number; email: string; isAdmin: boolean; managedByHost?: boolean};
    /** After sign-out; the boot code shows the login screen again (no page reload). */
    onSignedOut?: () => void;
}

type TabKey = 'tokens' | 'admin';

const t = defineMessages('settings', {
    signOut: 'Sign out',
    hostManaged: 'Signed in through the host application; sign out there.',
    staySignedIn: 'You stay signed in across browser sessions until you sign out.',
    title: 'Account settings',
    sections: 'Settings sections',
    myTokens: 'My tokens',
    admin: 'Admin'
});

/**
 * Account settings modal. Hosts tabbed panels and a logout footer.
 *
 *   Tab 1: My tokens — self-service MCP-token CRUD (everyone)
 *   Tab 2: Admin     — user-management (admin accounts only)
 */
export class Settings {
    private modal: ModalHandle | null = null;
    private activeTab: TabKey = 'tokens';
    private bodyHost: HTMLElement | null = null;
    private tokensPanel: TokensPanel | null = null;
    private adminPanel: AdminPanel | null = null;
    private tabButtons = new Map<TabKey, HTMLButtonElement>();

    public constructor(private readonly opts: SettingsOptions) {}

    public open(): void {
        if (this.modal !== null) return;
        this.activeTab = 'tokens';

        const tabs = this.buildTabs();
        this.bodyHost = el('div', {
            class: 'settings-body',
            attrs: tabs !== null ? {role: 'tabpanel', id: 'settings-tabpanel'} : {}
        });

        const logoutBtn = el('button', {
            class: 'btn',
            attrs: {type: 'button'},
            text: t('signOut'),
            on: {
                click: () => {
                    void (async () => {
                        await logout();
                        this.close();
                        if (this.opts.onSignedOut !== undefined) this.opts.onSignedOut();
                        else location.reload();
                    })();
                }
            }
        });

        const footer = this.opts.account.managedByHost === true
            ? [el('span', {class: 'settings-footer-hint', text: t('hostManaged')})]
            : [
                el('span', {class: 'settings-footer-hint', text: t('staySignedIn')}),
                logoutBtn
            ];

        this.modal = openModal({
            title: t('title'),
            subtitle: this.opts.account.email,
            closeLabel: tc('close'),
            size: 'lg',
            layout: 'sections',
            className: 'settings-dialog',
            body: tabs !== null ? [tabs, this.bodyHost] : [this.bodyHost],
            footer,
            ...(tabs !== null ? {initialFocus: this.tabButtons.get('tokens')!} : {}),
            onDismiss: () => this.reset()
        });
        this.renderActiveTab();
    }

    public close(): void {
        if (this.modal === null) return;
        this.modal.close();
        this.reset();
    }

    private reset(): void {
        this.modal = null;
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

        const tab = (key: TabKey, label: string): HTMLButtonElement => {
            const btn = el('button', {
                class: 'settings-tab',
                attrs: {type: 'button', role: 'tab', 'aria-controls': 'settings-tabpanel'},
                text: label,
                on: {click: () => this.switchTab(key)}
            }) as HTMLButtonElement;
            this.tabButtons.set(key, btn);
            return btn;
        };

        const nav = el('nav', {class: 'settings-tabs', attrs: {role: 'tablist', 'aria-label': t('sections')}},
            tab('tokens', t('myTokens')),
            tab('admin', t('admin'))
        );
        // Arrow keys move between tabs (WAI-ARIA tabs pattern).
        nav.addEventListener('keydown', (ev) => {
            if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return;
            const keys = [...this.tabButtons.keys()];
            const i = keys.indexOf(this.activeTab);
            const next = keys[(i + (ev.key === 'ArrowRight' ? 1 : keys.length - 1)) % keys.length]!;
            ev.preventDefault();
            this.switchTab(next);
            this.tabButtons.get(next)?.focus();
        });
        this.syncTabs();
        return nav;
    }

    private syncTabs(): void {
        for (const [k, btn] of this.tabButtons) {
            const active = k === this.activeTab;
            btn.classList.toggle('active', active);
            btn.setAttribute('aria-selected', String(active));
            btn.tabIndex = active ? 0 : -1;
        }
    }

    private switchTab(key: TabKey): void {
        if (this.activeTab === key) return;
        this.activeTab = key;
        this.syncTabs();
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