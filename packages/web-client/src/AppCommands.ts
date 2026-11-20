import type {PaletteCommand} from './CommandPalette.js';
import {defineMessages, getLocale, LOCALE_NAMES, setLocale} from './I18n.js';
import {openShortcutsDialog} from './Shortcuts.js';
import {TAB_DEFS, type Tab} from './Tabs.js';
import {toast} from './Toast.js';

/**
 * What the command palette offers besides notes (plan P7 / C1, split out
 * in D2). The app supplies the actions; this module only decides labels,
 * keywords and which commands exist in the current state. Keywords stay
 * in both languages, so either finds a command.
 */

const t = defineMessages('appCommands', {
    goTo: 'Go to {tab}',
    newNote: 'New note',
    search: 'Search notes (full text / semantic)',
    import: 'Import ChatGPT export',
    toDark: 'Switch to dark theme',
    toLight: 'Switch to light theme',
    activity: 'Toggle activity log',
    to2d: 'Graph: switch to 2D',
    to3d: 'Graph: switch to 3D',
    roadmapProject: 'Roadmap: new project',
    roadmapStep: 'Roadmap: new step',
    shortcuts: 'Keyboard shortcuts',
    copyLink: 'Copy link to this view',
    linkCopied: 'Link copied',
    settings: 'Account settings',
    language: 'Language: switch to {name}'
});

export interface CommandActions {
    goTab: (tab: Tab) => void;
    isLightTheme: boolean;
    is3d: boolean;
    newNote: () => void;
    focusSearch: () => void;
    openImport: () => void;
    toggleTheme: () => void;
    toggleActivity: () => void;
    toggleGraphMode: () => void;
    newRoadmapProject: () => void;
    newRoadmapStep: () => void;
    /** Present only when the view lives in the URL hash. */
    copyLink?: () => void;
    /** Present only when signed in. */
    openSettings?: () => void;
}

/** Copy the current URL; shows it in a sticky toast if the clipboard refuses. */
export const copyCurrentLink = (): void => {
    void navigator.clipboard.writeText(window.location.href).then(
        () => toast(t('linkCopied'), {kind: 'success'}),
        () => toast(window.location.href, {durationMs: 0})
    );
};

const otherLocale = (): 'en' | 'de' => (getLocale() === 'en' ? 'de' : 'en');

export const paletteCommands = (a: CommandActions): PaletteCommand[] => {
    const commands: PaletteCommand[] = TAB_DEFS.map((def) => ({
        id: `tab:${def.id}`,
        label: t('goTo', {tab: def.label}),
        hint: 'tab',
        keywords: [def.id, ...(def.title !== undefined ? [def.title] : [])],
        run: () => a.goTab(def.id)
    }));
    commands.push(
        {id: 'note:new', label: t('newNote'), hint: 'note', keywords: ['create', 'neu', 'notiz'], run: a.newNote},
        {id: 'search', label: t('search'), hint: '/', keywords: ['find', 'suche'], run: a.focusSearch},
        {id: 'import', label: t('import'), hint: 'import', keywords: ['zip', 'chatgpt'], run: a.openImport},
        {
            id: 'theme', label: a.isLightTheme ? t('toDark') : t('toLight'), hint: 'theme',
            keywords: ['dark', 'light', 'dunkel', 'hell'], run: a.toggleTheme
        },
        {id: 'activity', label: t('activity'), hint: 'panel', keywords: ['events', 'mcp'], run: a.toggleActivity},
        {
            id: 'graph:mode', label: a.is3d ? t('to2d') : t('to3d'), hint: 'graph', keywords: ['2d', '3d', 'view'],
            run: a.toggleGraphMode
        },
        {id: 'roadmap:project', label: t('roadmapProject'), hint: 'roadmap', keywords: ['projekt', 'create'], run: a.newRoadmapProject},
        {id: 'roadmap:step', label: t('roadmapStep'), hint: 'roadmap', keywords: ['schritt', 'create'], run: a.newRoadmapStep},
        {id: 'shortcuts', label: t('shortcuts'), hint: '?', keywords: ['help', 'keys', 'hilfe', 'tasten'], run: () => openShortcutsDialog()},
        {
            id: 'language', label: t('language', {name: LOCALE_NAMES[otherLocale()]}), hint: 'language',
            keywords: ['language', 'sprache', 'english', 'deutsch', 'locale'], run: () => void setLocale(otherLocale(), true)
        }
    );
    if (a.copyLink !== undefined) {
        commands.push({id: 'link', label: t('copyLink'), hint: 'link', keywords: ['share', 'url', 'teilen'], run: a.copyLink});
    }
    if (a.openSettings !== undefined) {
        commands.push({id: 'settings', label: t('settings'), hint: 'account', keywords: ['token', 'sign out'], run: a.openSettings});
    }
    return commands;
};
