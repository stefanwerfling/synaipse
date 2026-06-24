import {describe, expect, it} from 'vitest';
import {createLlmProvider, isLocalUrl} from '../src/Llm.js';

describe('isLocalUrl', () => {
    it('classifies loopback hostnames as local', () => {
        expect(isLocalUrl('http://localhost:11434')).toBe(true);
        expect(isLocalUrl('http://127.0.0.1')).toBe(true);
        expect(isLocalUrl('http://127.5.5.5:8080')).toBe(true);
    });

    it('classifies RFC1918 IPv4 ranges as local', () => {
        expect(isLocalUrl('http://10.0.0.5')).toBe(true);
        expect(isLocalUrl('http://10.255.255.255')).toBe(true);
        expect(isLocalUrl('http://192.168.1.1')).toBe(true);
        expect(isLocalUrl('http://172.16.0.1')).toBe(true);
        expect(isLocalUrl('http://172.31.255.255')).toBe(true);
    });

    it('classifies IPs just outside RFC1918 as external', () => {
        expect(isLocalUrl('http://172.15.0.1')).toBe(false);
        expect(isLocalUrl('http://172.32.0.0')).toBe(false);
        expect(isLocalUrl('http://11.0.0.1')).toBe(false);
        expect(isLocalUrl('http://193.168.1.1')).toBe(false);
    });

    it('classifies IPv6 loopback and ULA as local', () => {
        expect(isLocalUrl('http://[::1]:8080')).toBe(true);
        expect(isLocalUrl('http://[fe80::1]')).toBe(true);
        expect(isLocalUrl('http://[fc00::1]')).toBe(true);
        expect(isLocalUrl('http://[fd12:3456:789a::1]')).toBe(true);
    });

    it('classifies mDNS .local hostnames as local', () => {
        expect(isLocalUrl('http://pi.local:11434')).toBe(true);
        expect(isLocalUrl('http://my-mac.local')).toBe(true);
    });

    it('classifies public hostnames as external', () => {
        expect(isLocalUrl('https://api.openai.com')).toBe(false);
        expect(isLocalUrl('https://api.anthropic.com/v1/messages')).toBe(false);
        expect(isLocalUrl('http://example.com')).toBe(false);
    });

    it('classifies unresolved/unknown hostnames as external (safe default)', () => {
        expect(isLocalUrl('http://my-private-server:8000')).toBe(false);
        expect(isLocalUrl('not-a-url')).toBe(false);
        expect(isLocalUrl('')).toBe(false);
    });
});

describe('LlmProvider.isLocal()', () => {
    it('ollama follows the URL classifier', () => {
        const local = createLlmProvider({kind: 'ollama', url: 'http://localhost:11434', model: 'llama3'});
        const remote = createLlmProvider({kind: 'ollama', url: 'https://ollama.example.com', model: 'llama3'});
        expect(local.isLocal()).toBe(true);
        expect(remote.isLocal()).toBe(false);
    });

    it('openai follows the URL classifier (LAN llama.cpp/vLLM count as local)', () => {
        const lan = createLlmProvider({kind: 'openai', url: 'http://192.168.1.50:8000', model: 'qwen'});
        const cloud = createLlmProvider({kind: 'openai', url: 'https://api.openai.com', model: 'gpt-4o-mini'});
        expect(lan.isLocal()).toBe(true);
        expect(cloud.isLocal()).toBe(false);
    });

    it('anthropic is always external regardless of url override', () => {
        const standard = createLlmProvider({kind: 'anthropic', model: 'claude-opus-4-7', apiKey: 'sk-x'});
        const localProxy = createLlmProvider({
            kind: 'anthropic',
            model: 'claude-opus-4-7',
            apiKey: 'sk-x',
            url: 'http://127.0.0.1:9999'
        });
        expect(standard.isLocal()).toBe(false);
        expect(localProxy.isLocal()).toBe(false);
    });

    it('claude-shell is always external (uses Anthropic OAuth)', () => {
        const provider = createLlmProvider({kind: 'claude-shell', command: 'claude', model: 'sonnet'});
        expect(provider.isLocal()).toBe(false);
    });
});