import {describe, it, expect} from 'vitest';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {scopeCss} from '../src/Theme.js';

/** Plan P3 / D3: Synaipse CSS never reaches outside .synaipse-root. */

const here = path.dirname(fileURLToPath(import.meta.url));

const preludes = (css: string): string[] => {
    const noComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const noKeyframes = noComments.replace(/@keyframes[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '');
    return [...noKeyframes.matchAll(/([^{};]+)\{/g)].map((m) => m[1]!.trim());
};

/** Splits a selector list at its top-level commas, not those inside :where()/:is(). */
const selectors = (prelude: string): string[] => {
    const out: string[] = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < prelude.length; i++) {
        const c = prelude[i];
        if (c === '(') depth++;
        else if (c === ')') depth--;
        else if (c === ',' && depth === 0) {
            out.push(prelude.slice(start, i).trim());
            start = i + 1;
        }
    }
    out.push(prelude.slice(start).trim());
    return out;
};

const ALLOWED = ['.synaipse-root', '.synaipse-portal', 'body.synaipse-'];

describe('Styles.css scoping', () => {
    const css = readFileSync(path.join(here, '../src/Styles.css'), 'utf8');

    it('has no comment that closes early (a star-slash inside a comment)', () => {
        // An early close leaves the comment tail in front of the next rule:
        // the browser reads it as part of the selector and drops the rule.
        expect(preludes(css).filter((p) => p.includes('*/'))).toEqual([]);
    });

    it('scopes every selector', () => {
        const offenders: string[] = [];
        for (const prelude of preludes(css)) {
            if (prelude.startsWith('@')) continue;
            for (const sel of selectors(prelude)) {
                if (!ALLOWED.some((prefix) => sel.startsWith(prefix))) offenders.push(sel);
            }
        }
        expect(offenders).toEqual([]);
    });

    it('defines tokens on the root element, not :root/html', () => {
        expect(css.replace(/\/\*[\s\S]*?\*\//g, '')).not.toMatch(/(^|[\s,}]):root\b/);
        expect(css).toMatch(/\.synaipse-root\[data-theme='light'\]/);
    });
});

describe('scopeCss', () => {
    it('prefixes each selector of each rule and drops comments', () => {
        const out = scopeCss('/* x */\n.hljs, pre code.hljs { color: red }\n.hljs-keyword{font-weight:bold}', '.s[data-theme="dark"]');
        expect(out).toContain('.s[data-theme="dark"] .hljs, .s[data-theme="dark"] pre code.hljs {');
        expect(out).toContain('.s[data-theme="dark"] .hljs-keyword {');
        expect(out).not.toContain('/*');
    });
});
