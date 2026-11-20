import {readdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {defineMessages, formatMessage, getLocale, initLocale, onLocaleChange, registerMessages, setLocale, tc} from '../src/I18n.js';
import {DE} from '../src/I18nDe.js';

/** Plan P7 / C3: one small t() with English (default) and German tables. */

afterEach(async () => {
    await initLocale('en');
});

describe('formatMessage', () => {
    it('fills placeholders and leaves unknown ones visible', () => {
        expect(formatMessage('Hello {name}', {name: 'Ada'}, 'en')).toBe('Hello Ada');
        expect(formatMessage('Hello {name}', {}, 'en')).toBe('Hello {name}');
        expect(formatMessage('No params', undefined, 'en')).toBe('No params');
    });

    it('picks one|other by count and locale', () => {
        const m = '{count} note|{count} notes';
        expect(formatMessage(m, {count: 1}, 'en')).toBe('1 note');
        expect(formatMessage(m, {count: 0}, 'en')).toBe('0 notes');
        expect(formatMessage(m, {count: 2}, 'de')).toBe('2 notes');
        expect(formatMessage('{count} Notiz|{count} Notizen', {count: 1}, 'de')).toBe('1 Notiz');
    });
});

describe('locale state', () => {
    it('defaults to English; the host choice wins over the stored one', async () => {
        expect(await initLocale()).toBe('en');
        expect(await initLocale('de')).toBe('de');
    });

    it('t() reads the current language on every call; missing German falls back to English', async () => {
        const t = defineMessages('test.state', {hi: 'Hello', only: 'English only'});
        registerMessages('de', 'test.state', {hi: 'Hallo'});
        expect(t('hi')).toBe('Hello');
        await setLocale('de');
        expect(t('hi')).toBe('Hallo');
        expect(t('only')).toBe('English only');
    });

    it('loads the German chunk on demand', async () => {
        await setLocale('de');
        expect(tc('cancel')).toBe('Abbrechen');
    });

    it('notifies listeners only on a real change', async () => {
        const seen: string[] = [];
        const off = onLocaleChange((l) => seen.push(l));
        await setLocale('en');
        await setLocale('de');
        await setLocale('de');
        off();
        await setLocale('en');
        expect(seen).toEqual(['de']);
        expect(getLocale()).toBe('en');
    });
});

/**
 * Modules already on t(): their tables are checked against the German
 * ones, and their source for leftover UI literals. Each S4 slice adds
 * its files here.
 */
const MIGRATED = [
    'ActivityLog', 'App', 'AppCommands', 'CommandPalette', 'ConsentInbox', 'Dialogs', 'Graph', 'Graph3D', 'GraphTab',
    'Login', 'Search', 'Settings', 'Shortcuts', 'Tabs', 'TagBar', 'TagPicker', 'Toast', 'Topbar',
    // S4b notes and editor
    'Drafts', 'Editor', 'EditorToolbar', 'HistoryPanel', 'MarkdownPreview', 'NoteLinks', 'NoteToolbar', 'NotesPanel',
    'NotesSidebar', 'NotesTree', 'PreviewDialog', 'SummarizeDialog', 'Toc',
    // S4c panels
    'ActivityPanel', 'AuditPanel', 'BenchmarksPanel', 'CanvasBottomBar', 'CanvasCards', 'CanvasPanel', 'CanvasRenderer',
    'CardEditor', 'ChatPanel', 'ChatSidebar', 'InboxPanel', 'JobsPanel', 'RoadmapPanel'
];

const placeholders = (message: string): string[] => [...message.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();
const pluralForms = (message: string): number => message.split('|').length;

const SRC = join(__dirname, '../src');
const source = (name: string): string => readFileSync(join(SRC, `${name}.ts`), 'utf8');

/** Namespace → English table of every defineMessages call in src, read from source (importing would need a DOM). */
const englishTables = (): Map<string, Record<string, string>> => {
    const tables = new Map<string, Record<string, string>>();
    for (const file of readdirSync(SRC).filter((f) => f.endsWith('.ts'))) {
        const text = readFileSync(join(SRC, file), 'utf8');
        // Real calls only: not in a comment.
        for (const match of text.matchAll(/^(?!\s*\*).*\bdefineMessages\('([\w.]+)', \{/gm)) {
            const start = match.index! + match[0].length - 1;
            const end = text.indexOf('\n});', start);
            // A plain object literal of string literals.
            const table = new Function(`return ${text.slice(start, end + 2)}`)() as Record<string, string>;
            expect(tables.has(match[1]!), `namespace ${match[1]} defined twice`).toBe(false);
            tables.set(match[1]!, table);
        }
    }
    return tables;
};

describe('message tables', () => {
    it('German matches English: same namespaces and keys, non-empty, same placeholders and plural shape', () => {
        const en = englishTables();
        const problems: string[] = [];
        expect(en.size).toBeGreaterThan(10);

        for (const [namespace, table] of en) {
            const german = DE[namespace];
            if (german === undefined) {
                problems.push(`${namespace}: no German table`);
                continue;
            }
            for (const [key, english] of Object.entries(table)) {
                const text = german[key];
                if (text === undefined || text.trim() === '') problems.push(`${namespace}.${key}: German missing`);
                else if (placeholders(english).join() !== placeholders(text).join()) problems.push(`${namespace}.${key}: placeholders differ`);
                else if (pluralForms(english) !== pluralForms(text)) problems.push(`${namespace}.${key}: plural forms differ`);
            }
            for (const key of Object.keys(german)) {
                if (!(key in table)) problems.push(`${namespace}.${key}: German only (stale)`);
            }
        }
        for (const namespace of Object.keys(DE)) {
            if (!en.has(namespace)) problems.push(`${namespace}: German table without English one`);
        }
        expect(problems).toEqual([]);
    });
});

describe('migrated modules', () => {
    // A quoted literal in a spot the user reads; group 1 is its text.
    const UI_LITERAL = /\b(?:text|title|placeholder|label|subtitle|message|confirmLabel|cancelLabel|closeLabel|'aria-label')\s*:\s*['`]([^'`]*)['`]/g;
    const ASSIGNED = /\.(?:textContent|title)\s*=\s*['`]([^'`]*)['`]/g;
    const TOAST = /\b(?:toast|toastError)\(\s*['`]([^'`]*)['`]/g;
    // A text child on a line of its own: el('label', {}, input, 'preview').
    const BARE_CHILD = /^\s*['`]([^'`]*)['`],?\s*$/g;
    // Brand and product names, the same in every language.
    const ALLOWED = new Set(['Synaipse', 'demote', 'Benchmarks', 'URL', '🔎 Web']);
    // A line may say why its literals are not UI text: `// i18n: id` or `// i18n: example`.
    const MARKED = /\/\/ i18n: (id|example)\b/;

    /** Words a reader sees, as opposed to ids (snake_case, camelCase, with digits) and paths or URLs. */
    const isText = (value: string): boolean => {
        // Interpolations are code, including a nested template cut off by the pattern.
        const plain = value.replace(/\$\{[^}]*\}/g, '').replace(/\$\{.*$/, '').trim();
        if (!/[A-Za-zÄÖÜäöü]{3,}/.test(plain)) return false;
        if (ALLOWED.has(plain)) return false;
        if (!/\s/.test(plain)) {
            if (/[_\d]|[a-z][A-Z]/.test(plain)) return false;
            if (/[/.:-]/.test(plain)) return false;
        }
        return true;
    };

    it('keep no hard-coded UI text', () => {
        const found: string[] = [];
        for (const name of MIGRATED) {
            const lines = source(name).split('\n');
            let inTable = false;
            lines.forEach((line, i) => {
                // The defineMessages tables are where the text belongs.
                if (line.includes('defineMessages(')) inTable = true;
                if (inTable) {
                    if (/^\}\);/.test(line)) inTable = false;
                    return;
                }
                const code = line.trim();
                if (code.startsWith('//') || code.startsWith('*') || MARKED.test(line)) return;
                const literals = [UI_LITERAL, ASSIGNED, TOAST, BARE_CHILD].flatMap((re) => [...line.matchAll(re)].map((m) => m[1]!));
                if (literals.some(isText)) found.push(`${name}.ts:${i + 1}: ${code}`);
            });
        }
        expect(found).toEqual([]);
    });

    it('isText tells UI words from ids, paths and brands', () => {
        expect(['preview', 'Save', 'No notes yet', 'loading…'].map(isText)).toEqual([true, true, true, true]);
        expect(['in_progress', 'range24h', 'aiActive', 'Crawler/', 'https://x.org', 'Synaipse', ' · '].map(isText))
            .toEqual([false, false, false, false, false, false, false]);
    });
});
