import {describe, it, expect} from 'vitest';
import type {Note} from '@synaipse/core';
import {
    serializeChatSession,
    parseChatSession,
    slugifyChatTitle,
    buildChatId,
    isChatNote,
    summarizeChat,
    type ChatSession
} from '../src/ChatStore.js';

const noteFrom = (id: string, content: string, frontmatter: Record<string, unknown> = {}): Note => ({
    id,
    path: `/vault/${id}`,
    title: typeof frontmatter.title === 'string' ? frontmatter.title : id,
    content,
    frontmatter,
    tags: [],
    wikilinks: [],
    backlinks: [],
    mtime: Date.parse('2026-06-18T11:30:00Z'),
    hash: 'h'
});

const baseSession = (): ChatSession => ({
    id: 'Chats/2026-06-18-1130-relink.md',
    title: 'How does relink work?',
    createdAt: '2026-06-18T11:30:00Z',
    updatedAt: '2026-06-18T11:35:00Z',
    lastModel: 'ollama:llama3.1',
    turns: [
        {role: 'user', content: 'Wie funktioniert der relink command?'},
        {
            role: 'assistant',
            content: 'Der relink command scannt die Notiz und schlägt Wikilinks vor [^1].',
            model: 'ollama:llama3.1',
            sources: [
                {target: 'packages/service/Relink.ts', title: 'Relink', index: 1, score: 0.87}
            ]
        }
    ]
});

describe('ChatStore round-trip', () => {
    it('serializes a session into a markdown body + frontmatter', () => {
        const out = serializeChatSession(baseSession());

        expect(out.frontmatter.kind).toBe('chat');
        expect(out.frontmatter.title).toBe('How does relink work?');
        expect(out.frontmatter.tags).toEqual(['chat']);
        expect(out.frontmatter.last_model).toBe('ollama:llama3.1');
        expect(out.frontmatter.sources).toEqual(['packages/service/Relink.ts']);

        // body contains the per-turn markers + user + assistant content
        expect(out.content).toContain('<!--chat:user-->');
        expect(out.content).toContain('<!--chat:assistant');
        expect(out.content).toContain('model="ollama:llama3.1"');
        expect(out.content).toContain('Wie funktioniert der relink command?');
        expect(out.content).toContain('Der relink command scannt');
        // wikilinks at the bottom of the assistant turn
        expect(out.content).toContain('[[packages/service/Relink.ts]]');
    });

    it('round-trips serialize → parse without losing user/assistant content', () => {
        const session = baseSession();
        const ser = serializeChatSession(session);
        const note = noteFrom(session.id, ser.content, ser.frontmatter);

        const parsed = parseChatSession(note);

        expect(parsed.turns.length).toBe(2);
        expect(parsed.turns[0]?.role).toBe('user');
        expect(parsed.turns[0]?.content).toBe(session.turns[0]?.content);
        expect(parsed.turns[1]?.role).toBe('assistant');
        expect(parsed.turns[1]?.model).toBe('ollama:llama3.1');
        expect(parsed.turns[1]?.sources?.[0]?.target).toBe('packages/service/Relink.ts');
        expect(parsed.turns[1]?.sources?.[0]?.score).toBe(0.87);
        // assistant content should NOT include the trailing wikilinks line
        // (otherwise re-saving would double-append them)
        expect(parsed.turns[1]?.content).not.toContain('[[packages/service/Relink.ts]]');
        expect(parsed.turns[1]?.content).toContain('Der relink command scannt');
    });

    it('round-trips multiple assistant turns with different models', () => {
        const session: ChatSession = {
            ...baseSession(),
            turns: [
                {role: 'user', content: 'Q1'},
                {role: 'assistant', content: 'A1', model: 'ollama:llama3.1', sources: [
                    {target: 'a.md', title: 'A', index: 1}
                ]},
                {role: 'user', content: 'Q2'},
                {role: 'assistant', content: 'A2', model: 'anthropic:claude-sonnet-4-6', sources: [
                    {target: 'b.md', title: 'B', index: 1}
                ]}
            ]
        };

        const ser = serializeChatSession(session);
        const parsed = parseChatSession(noteFrom(session.id, ser.content, ser.frontmatter));

        expect(parsed.turns.map((t) => t.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
        expect(parsed.turns[1]?.model).toBe('ollama:llama3.1');
        expect(parsed.turns[3]?.model).toBe('anthropic:claude-sonnet-4-6');
    });

    it('aggregates unique source ids into frontmatter for graph backlinks', () => {
        const session: ChatSession = {
            ...baseSession(),
            turns: [
                {role: 'user', content: 'Q1'},
                {role: 'assistant', content: 'A1', model: 'm', sources: [
                    {target: 'a.md', title: 'A', index: 1},
                    {target: 'b.md', title: 'B', index: 2}
                ]},
                {role: 'user', content: 'Q2'},
                {role: 'assistant', content: 'A2', model: 'm', sources: [
                    {target: 'b.md', title: 'B', index: 1},
                    {target: 'c.md', title: 'C', index: 2}
                ]}
            ]
        };

        const ser = serializeChatSession(session);
        expect(ser.frontmatter.sources).toEqual(['a.md', 'b.md', 'c.md']);
    });

    it('skips external URLs from the wikilink/aggregated-sources path', () => {
        const session: ChatSession = {
            ...baseSession(),
            turns: [
                {role: 'user', content: 'Q'},
                {role: 'assistant', content: 'A', model: 'm', sources: [
                    {target: 'https://example.com/article', title: 'Web', index: 1}
                ]}
            ]
        };

        const ser = serializeChatSession(session);
        // No vault backlinks for URLs
        expect(ser.content).not.toContain('[[https://');
        expect(ser.frontmatter.sources).toBeUndefined();
        // But the sources are still in the marker JSON so the UI can show them
        expect(ser.content).toContain('https://example.com/article');
    });

    it('handles a note with no markers (graceful empty)', () => {
        const parsed = parseChatSession(noteFrom('x.md', 'Just some text', {title: 'x'}));
        expect(parsed.turns).toEqual([]);
    });

    it('parses a marker even when the sources JSON contains apostrophes', () => {
        // Another real-world reproducer: source snippets often contain code
        // strings like `import { x } from 'pkg'` or contractions like
        // "it's". A `[^']*?` regex truncates at the first inner `'` and the
        // sources silently disappear from the loaded chat.
        const session: ChatSession = {
            ...baseSession(),
            turns: [
                {role: 'user', content: 'Q'},
                {
                    role: 'assistant',
                    content: 'A',
                    model: 'shell-claude',
                    sources: [{
                        target: 'fuse.md',
                        title: 'Fuse',
                        index: 1,
                        snippet: "import {} from 'node-fuse-bindings'; wie geht das?"
                    }]
                }
            ]
        };

        const ser = serializeChatSession(session);
        const parsed = parseChatSession(noteFrom(session.id, ser.content, ser.frontmatter));

        expect(parsed.turns[1]?.sources?.length).toBe(1);
        expect(parsed.turns[1]?.sources?.[0]?.snippet).toContain("'node-fuse-bindings'");
    });

    it('parses a marker even when the sources JSON contains > characters', () => {
        // Real-world reproducer: source snippets are markdown excerpts that
        // often contain blockquote chars. A `[^>]*?` regex breaks on the
        // first one and merges the whole assistant turn into the previous
        // user turn.
        const session: ChatSession = {
            ...baseSession(),
            turns: [
                {role: 'user', content: 'Welche ACL?'},
                {
                    role: 'assistant',
                    content: 'Es gibt mehrere ACL-Modelle.',
                    model: 'shell-claude',
                    sources: [{
                        target: 'figtree/acl.md',
                        title: 'ACL',
                        index: 1,
                        snippet: 'Beispiel\n\n> Imported from somewhere\n\n## Details'
                    }]
                }
            ]
        };

        const ser = serializeChatSession(session);
        const parsed = parseChatSession(noteFrom(session.id, ser.content, ser.frontmatter));

        expect(parsed.turns.length).toBe(2);
        expect(parsed.turns[0]?.role).toBe('user');
        expect(parsed.turns[0]?.content).toBe('Welche ACL?');
        expect(parsed.turns[1]?.role).toBe('assistant');
        expect(parsed.turns[1]?.content).toBe('Es gibt mehrere ACL-Modelle.');
        expect(parsed.turns[1]?.sources?.[0]?.snippet).toContain('Imported from');
    });

    it('survives content that contains [[wikilinks]] in the middle of an assistant turn', () => {
        // The trailing-wikilinks stripper should only strip the line at the END,
        // not arbitrary inline references.
        const session: ChatSession = {
            ...baseSession(),
            turns: [
                {role: 'user', content: 'Q'},
                {
                    role: 'assistant',
                    content: 'Wie in [[some/inline.md]] erwähnt: blah blah.\n\nNoch mehr Text hier.',
                    model: 'm',
                    sources: [{target: 'some/inline.md', title: 'Inline', index: 1}]
                }
            ]
        };

        const ser = serializeChatSession(session);
        const parsed = parseChatSession(noteFrom(session.id, ser.content, ser.frontmatter));

        expect(parsed.turns[1]?.content).toContain('Wie in [[some/inline.md]] erwähnt');
        expect(parsed.turns[1]?.content).toContain('Noch mehr Text hier.');
        // The trailing wikilinks (after the body) get stripped on parse
        expect(parsed.turns[1]?.content).not.toMatch(/\n\[\[some\/inline\.md\]\]\s*$/);
    });
});

describe('slugifyChatTitle', () => {
    it('lowercases + hyphenates + caps word count', () => {
        expect(slugifyChatTitle('How Does Relink Work?')).toBe('how-does-relink-work');
    });

    it('falls back to "chat" for empty / non-alphanumeric input', () => {
        expect(slugifyChatTitle('???')).toBe('chat');
        expect(slugifyChatTitle('')).toBe('chat');
    });

    it('handles diacritics by stripping them', () => {
        expect(slugifyChatTitle('Wie funktioniert das schöne System?')).toBe('wie-funktioniert-das-schone-system');
    });
});

describe('buildChatId', () => {
    it('produces a deterministic filename (no folder prefix — that is ChatRepo\'s job)', () => {
        const id = buildChatId('How does relink work?', new Date('2026-06-18T11:30:00Z'));
        // exact stamp depends on the local timezone of the test runner,
        // so just check the shape
        expect(id).toMatch(/^\d{4}-\d{2}-\d{2}-\d{4}-how-does-relink-work\.md$/);
        expect(id).not.toContain('/');
    });
});

describe('isChatNote / summarizeChat', () => {
    it('identifies a chat note by frontmatter.kind', () => {
        expect(isChatNote(noteFrom('a.md', '', {kind: 'chat'}))).toBe(true);
        expect(isChatNote(noteFrom('b.md', '', {kind: 'note'}))).toBe(false);
        expect(isChatNote(noteFrom('c.md', '', {}))).toBe(false);
    });

    it('summarizes a chat note', () => {
        const ser = serializeChatSession(baseSession());
        const note = noteFrom('Chats/x.md', ser.content, ser.frontmatter);
        const summary = summarizeChat(note);

        expect(summary.title).toBe('How does relink work?');
        expect(summary.turnCount).toBe(2);
        expect(summary.lastModel).toBe('ollama:llama3.1');
    });
});