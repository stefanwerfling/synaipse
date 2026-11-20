import {el} from './Dom.js';
import {defineMessages, getLocale, LOCALE_NAMES, setLocale} from './I18n.js';
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

const t = defineMessages('topbar', {
    activityTitle: 'Activity log',
    activityToggle: 'Toggle activity log',
    activity: 'Activity',
    paletteTitle: 'Open command palette (Ctrl/Cmd+K)',
    search: 'Search',
    importTitle: 'Import notes from external source',
    import: 'Import',
    accountTitle: 'Signed in as {email} — open account settings',
    toDark: 'Switch to dark theme',
    toLight: 'Switch to light theme',
    language: 'Language: {name} — switch to {other}'
});

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
            attrs: {type: 'button', title: t('activityTitle'), 'aria-label': t('activityToggle')},
            on: {click: () => opts.onActivity()}
        },
            el('span', {class: 'activity-btn-icon', text: '●'}),
            el('span', {class: 'activity-btn-label', text: t('activity')}),
            this.activityBadge
        ) as HTMLButtonElement;

        const paletteBtn = el('button', {
            class: 'palette-trigger',
            attrs: {type: 'button', title: t('paletteTitle')},
            on: {click: () => opts.onPalette()}
        },
            el('span', {text: t('search')}),
            el('kbd', {text: '⌘K'})
        );

        const importBtn = el('button', {
            class: 'topbar-import',
            attrs: {type: 'button', title: t('importTitle')},
            text: t('import'),
            on: {click: () => opts.onImport()}
        });

        this.themeToggleBtn = el('button', {
            class: 'theme-toggle',
            attrs: {type: 'button'},
            on: {click: () => toggleTheme()}
        }) as HTMLButtonElement;
        this.updateThemeToggle(getTheme());
        this.offTheme = onThemeChange((theme) => this.updateThemeToggle(theme));

        // Language switch: shows the current language, a click flips it and
        // remembers the choice; the app rebuilds itself on the same view.
        const locale = getLocale();
        const other = locale === 'en' ? 'de' : 'en';
        const languageBtn = el('button', {
            class: 'language-toggle',
            attrs: {
                type: 'button',
                title: t('language', {name: LOCALE_NAMES[locale], other: LOCALE_NAMES[other]}),
                'aria-label': t('language', {name: LOCALE_NAMES[locale], other: LOCALE_NAMES[other]})
            },
            text: locale.toUpperCase(),
            on: {click: () => void setLocale(other, true)}
        });

        const trailing: HTMLElement[] = [importBtn, languageBtn, this.themeToggleBtn, this.activityBtn];

        if (opts.account !== null) {
            const account = opts.account;
            const settings = new Settings({
                account,
                ...(opts.onSignedOut !== undefined ? {onSignedOut: opts.onSignedOut} : {})
            });
            this.settings = settings;
            trailing.push(el('button', {
                class: 'topbar-account',
                attrs: {type: 'button', title: t('accountTitle', {email: account.email})},
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
        this.themeToggleBtn.title = isLight ? t('toDark') : t('toLight');
        this.themeToggleBtn.setAttribute('aria-label', this.themeToggleBtn.title);
    }
}
