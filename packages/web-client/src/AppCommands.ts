import type {PaletteCommand} from './CommandPalette.js';
import {openShortcutsDialog} from './Shortcuts.js';
import {TAB_DEFS, type Tab} from './Tabs.js';
import {toast} from './Toast.js';

/**
 * What the command palette offers besides notes (plan P7 / C1, split out
 * in D2). The app supplies the actions; this module only decides labels,
 * keywords and which commands exist in the current state.
 */

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
        () => toast('Link copied', {kind: 'success'}),
        () => toast(window.location.href, {durationMs: 0})
    );
};

export const paletteCommands = (a: CommandActions): PaletteCommand[] => {
    const commands: PaletteCommand[] = TAB_DEFS.map((def) => ({
        id: `tab:${def.id}`,
        label: `Go to ${def.label}`,
        hint: 'tab',
        keywords: [def.id, ...(def.title !== undefined ? [def.title] : [])],
        run: () => a.goTab(def.id)
    }));
    commands.push(
        {id: 'note:new', label: 'New note', hint: 'note', keywords: ['create', 'neu', 'notiz'], run: a.newNote},
        {id: 'search', label: 'Search notes (full text / semantic)', hint: '/', keywords: ['find', 'suche'], run: a.focusSearch},
        {id: 'import', label: 'Import ChatGPT export', hint: 'import', keywords: ['zip', 'chatgpt'], run: a.openImport},
        {
            id: 'theme', label: a.isLightTheme ? 'Switch to dark theme' : 'Switch to light theme', hint: 'theme',
            keywords: ['dark', 'light', 'dunkel', 'hell'], run: a.toggleTheme
        },
        {id: 'activity', label: 'Toggle activity log', hint: 'panel', keywords: ['events', 'mcp'], run: a.toggleActivity},
        {
            id: 'graph:mode', label: a.is3d ? 'Graph: switch to 2D' : 'Graph: switch to 3D', hint: 'graph', keywords: ['2d', '3d', 'view'],
            run: a.toggleGraphMode
        },
        {id: 'roadmap:project', label: 'Roadmap: new project', hint: 'roadmap', keywords: ['projekt', 'create'], run: a.newRoadmapProject},
        {id: 'roadmap:step', label: 'Roadmap: new step', hint: 'roadmap', keywords: ['schritt', 'create'], run: a.newRoadmapStep},
        {id: 'shortcuts', label: 'Keyboard shortcuts', hint: '?', keywords: ['help', 'keys', 'hilfe', 'tasten'], run: () => openShortcutsDialog()}
    );
    if (a.copyLink !== undefined) {
        commands.push({id: 'link', label: 'Copy link to this view', hint: 'link', keywords: ['share', 'url', 'teilen'], run: a.copyLink});
    }
    if (a.openSettings !== undefined) {
        commands.push({id: 'settings', label: 'Account settings', hint: 'account', keywords: ['token', 'sign out'], run: a.openSettings});
    }
    return commands;
};
