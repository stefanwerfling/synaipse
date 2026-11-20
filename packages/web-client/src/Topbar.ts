import {el} from './Dom.js';
import logoSvg from './Logo.svg?raw';
import {Settings} from './Settings.js';
import {TAB_DEFS, type Tab} from './Tabs.js';
import {getTheme, onThemeChange, toggleTheme, type Theme} from './Theme.js';

/**
 * The app's top bar (plan P7 / D2): brand, tab buttons with the consent
 * badge, palette trigger, import, theme toggle, activity button and,
 * signed in, the account button. The search box is appended later.
 */

export interface TopbarAccount {
    id: number;
    email: string;
    isAdmin: boolean;
    managedByHost?: boolean;
}

export interface TopbarOptions {
    initialTab: Tab;
    account: TopbarAccount | null;
    onSignedOut?: () => void;
    onTab: (tab: Tab) => void;
    onPalette: () => void;
    onImport: () => void;
    onActivity: () => void;
}

/** Badge text for an unread count; hidden at zero. */
const setBadge = (badge: HTMLElement, owner: HTMLElement | undefined, count: number): void => {
    if (count > 0) {
        badge.style.display = '';
        badge.textContent = count > 9 ? '9+' : String(count);
        owner?.classList.add('has-unread');
    } else {
        badge.style.display = 'none';
        owner?.classList.remove('has-unread');
    }
};

export class Topbar {
    public readonly element: HTMLElement;
    /** Account settings dialog; only when signed in. */
    public readonly settings: Settings | null = null;
    private readonly tabButtons = new Map<Tab, HTMLButtonElement>();
    private readonly consentBadge: HTMLElement;
    private readonly activityBtn: HTMLButtonElement;
    private readonly activityBadge: HTMLElement;
    private readonly themeToggleBtn: HTMLButtonElement;
    private readonly offTheme: () => void;

    public constructor(opts: TopbarOptions) {
        this.consentBadge = el('span', {class: 'tab-badge', style: {display: 'none'}, text: '0'});
        for (const def of TAB_DEFS) {
            const btn = el('button', {
                class: def.id === opts.initialTab ? 'tab active' : 'tab',
                attrs: {type: 'button', ...(def.title !== undefined ? {title: def.title} : {})},
                on: {click: () => opts.onTab(def.id)}
            }, el('span', {text: def.label})) as HTMLButtonElement;
            if (def.id === 'consent') btn.appendChild(this.consentBadge);
            this.tabButtons.set(def.id, btn);
        }

        const brand = el('div', {class: 'brand'});
        const logo = el('span', {class: 'brand-logo'});
        logo.innerHTML = logoSvg;
        brand.appendChild(logo);
        brand.appendChild(el('span', {class: 'brand-text', text: 'Synaipse'}));

        this.activityBadge = el('span', {class: 'activity-btn-badge', style: {display: 'none'}, text: '0'});
        this.activityBtn = el('button', {
            class: 'activity-btn',
            attrs: {type: 'button', title: 'Activity log', 'aria-label': 'Toggle activity log'},
            on: {click: () => opts.onActivity()}
        },
            el('span', {class: 'activity-btn-icon', text: '●'}),
            el('span', {class: 'activity-btn-label', text: 'Activity'}),
            this.activityBadge
        ) as HTMLButtonElement;

        const paletteBtn = el('button', {
            class: 'palette-trigger',
            attrs: {type: 'button', title: 'Open command palette (Ctrl/Cmd+K)'},
            on: {click: () => opts.onPalette()}
        },
            el('span', {text: 'Search'}),
            el('kbd', {text: '⌘K'})
        );

        const importBtn = el('button', {
            class: 'topbar-import',
            attrs: {type: 'button', title: 'Import notes from external source'},
            text: 'Import',
            on: {click: () => opts.onImport()}
        });

        this.themeToggleBtn = el('button', {
            class: 'theme-toggle',
            attrs: {type: 'button'},
            on: {click: () => toggleTheme()}
        }) as HTMLButtonElement;
        this.updateThemeToggle(getTheme());
        this.offTheme = onThemeChange((theme) => this.updateThemeToggle(theme));

        const trailing: HTMLElement[] = [importBtn, this.themeToggleBtn, this.activityBtn];

        if (opts.account !== null) {
            const account = opts.account;
            const settings = new Settings({
                account,
                ...(opts.onSignedOut !== undefined ? {onSignedOut: opts.onSignedOut} : {})
            });
            this.settings = settings;
            trailing.push(el('button', {
                class: 'topbar-account',
                attrs: {type: 'button', title: `Signed in as ${account.email} — open account settings`},
                text: account.email,
                on: {click: () => settings.open()}
            }));
        }

        this.element = el('header', {class: 'topbar'},
            brand,
            el('nav', {class: 'tabs'}, ...this.tabButtons.values()),
            paletteBtn,
            el('div', {class: 'topbar-spacer'}),
            ...trailing
        );
    }

    /** Mark `tab` as the current page. */
    public setActiveTab(tab: Tab): void {
        for (const [id, btn] of this.tabButtons) {
            btn.classList.toggle('active', id === tab);
            if (id === tab) btn.setAttribute('aria-current', 'page');
            else btn.removeAttribute('aria-current');
        }
    }

    public setActivityBadge(count: number): void {
        setBadge(this.activityBadge, this.activityBtn, count);
    }

    public setConsentBadge(count: number): void {
        setBadge(this.consentBadge, this.tabButtons.get('consent'), count);
    }

    public destroy(): void {
        this.offTheme();
        this.settings?.close();
    }

    private updateThemeToggle(theme: Theme): void {
        const isLight = theme === 'light';

        this.themeToggleBtn.textContent = isLight ? '☾' : '☀';
        this.themeToggleBtn.title = isLight ? 'Switch to dark theme' : 'Switch to light theme';
        this.themeToggleBtn.setAttribute('aria-label', this.themeToggleBtn.title);
    }
}
