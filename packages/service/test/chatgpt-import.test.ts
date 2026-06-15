import {describe, it, expect} from 'vitest';
import {renderChatgptConversation, type ChatgptImportConversation} from '../src/ChatgptImport.js';

const baseConv = (overrides: Partial<ChatgptImportConversation> = {}): ChatgptImportConversation => ({
    id: 'abc-123',
    title: 'My first chat',
    createTime: 1_700_000_000,
    updateTime: 1_700_001_000,
    model: 'gpt-4o',
    messages: [
        {role: 'user', text: 'Hello', createTime: 1_700_000_000},
        {role: 'assistant', text: 'Hi there', createTime: 1_700_000_010}
    ],
    attachments: [],
    ...overrides
});

describe('renderChatgptConversation', () => {
    it('builds a slugged path under chatgpt-import/<uuid>/', () => {
        const result = renderChatgptConversation(baseConv(), () => null);
        expect(result.pathHint).toBe('chatgpt-import/abc-123/my-first-chat.md');
    });

    it('falls back to a slug when title is unusable', () => {
        const result = renderChatgptConversation(baseConv({title: '   '}), () => null);
        expect(result.pathHint).toBe('chatgpt-import/abc-123/chat.md');
    });

    it('writes chatgpt_id, source, tags, and model into frontmatter', () => {
        const result = renderChatgptConversation(baseConv(), () => null);
        expect(result.frontmatter.chatgpt_id).toBe('abc-123');
        expect(result.frontmatter.source).toBe('chatgpt-export');
        expect(result.frontmatter.chatgpt_model).toBe('gpt-4o');
        expect(result.frontmatter.tags).toEqual(['chatgpt', 'gpt-4o']);
    });

    it('omits chatgpt_model and gpt-* tag when model is unknown', () => {
        const result = renderChatgptConversation(baseConv({model: null}), () => null);
        expect(result.frontmatter.chatgpt_model).toBeUndefined();
        expect(result.frontmatter.tags).toEqual(['chatgpt']);
    });

    it('renders user + assistant headings with model name', () => {
        const result = renderChatgptConversation(baseConv(), () => null);
        expect(result.content).toContain('## You');
        expect(result.content).toContain('## ChatGPT (gpt-4o)');
        expect(result.content).toContain('Hello');
        expect(result.content).toContain('Hi there');
    });

    it('resolves asset pointers via the lookup callback', () => {
        const conv = baseConv({
            messages: [
                {role: 'user', text: 'see image', createTime: null, assetPointers: ['file-service://file-XYZ']}
            ]
        });

        const result = renderChatgptConversation(conv, (ptr) => {
            if (ptr === 'file-service://file-XYZ') return '../../_assets/img-abc.png';
            return null;
        });

        expect(result.content).toContain('![](../../_assets/img-abc.png)');
    });

    it('falls back to a placeholder when an attachment is missing', () => {
        const conv = baseConv({
            messages: [
                {role: 'assistant', text: '', createTime: null, assetPointers: ['file-service://file-MISSING']}
            ]
        });

        const result = renderChatgptConversation(conv, () => null);
        expect(result.content).toContain('*[missing attachment: file-service://file-MISSING]*');
    });
});