import {describe, it, expect} from 'vitest';
import {formatRoute, parseRoute} from '../src/Router.js';
import {matchesCommand} from '../src/CommandPalette.js';
import {TABS} from '../src/Tabs.js';

describe('parseRoute / formatRoute (plan P7 / C1)', () => {
    it('reads tabs, notes, roadmap projects and graph focus', () => {
        expect(parseRoute('#/graph')).toEqual({tab: 'graph'});
        expect(parseRoute('#/notes/Memory/demo/a%20b.md')).toEqual({tab: 'notes', note: 'Memory/demo/a b.md'});
        expect(parseRoute('#/roadmap/synaipse')).toEqual({tab: 'roadmap', project: 'synaipse'});
        expect(parseRoute('#/graph?focus=Memory%2Fa.md')).toEqual({tab: 'graph', focus: 'Memory/a.md'});
    });

    it('takes bare tab names and legacy note ids from hosts', () => {
        expect(parseRoute('chat')).toEqual({tab: 'chat'});
        expect(parseRoute('Memory/a.md')).toEqual({tab: 'notes', note: 'Memory/a.md'});
        expect(parseRoute('')).toBeNull();
        expect(parseRoute('#')).toBeNull();
        expect(parseRoute('#/')).toBeNull();
    });

    it('ignores parts a tab does not use', () => {
        expect(parseRoute('#/chat/whatever?focus=x')).toEqual({tab: 'chat'});
        expect(formatRoute({tab: 'chat', note: 'a.md', project: 'p', focus: 'x'})).toBe('#/chat');
    });

    it('round-trips every route it formats', () => {
        const routes = [
            ...TABS.map((tab) => ({tab})),
            {tab: 'notes' as const, note: 'Memory/projekt/Ä ö #1?.md'},
            {tab: 'roadmap' as const, project: 'my-proj.v2'},
            {tab: 'graph' as const, focus: 'Memory/x y.md'}
        ];
        for (const route of routes) expect(parseRoute(formatRoute(route))).toEqual(route);
    });

    it('keeps slashes readable and encodes the rest', () => {
        expect(formatRoute({tab: 'notes', note: 'Memory/a b#c.md'})).toBe('#/notes/Memory/a%20b%23c.md');
    });

    it('survives a malformed escape', () => {
        expect(parseRoute('#/notes/50%.md')).toEqual({tab: 'notes', note: '50%.md'});
    });
});

describe('matchesCommand', () => {
    const theme = {label: 'Switch to dark theme', hint: 'theme', keywords: ['dunkel', 'hell']};

    it('needs every word, in label, hint or keywords, case-insensitive', () => {
        expect(matchesCommand(theme, 'dark')).toBe(true);
        expect(matchesCommand(theme, 'THEME dunkel')).toBe(true);
        expect(matchesCommand(theme, 'swi da')).toBe(true);
        expect(matchesCommand(theme, 'dark graph')).toBe(false);
    });
});
