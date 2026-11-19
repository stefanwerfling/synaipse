import {describe, it, expect} from 'vitest';
import {readFileSync, readdirSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {wrapFocusIndex} from '../src/Modal.js';
import {toastDuration} from '../src/Toast.js';
import {validProjectName} from '../src/Dialogs.js';

describe('wrapFocusIndex (modal focus trap)', () => {
    it('moves forward and wraps to the first', () => {
        expect(wrapFocusIndex(0, 3, false)).toBe(1);
        expect(wrapFocusIndex(2, 3, false)).toBe(0);
    });
    it('moves backward and wraps to the last', () => {
        expect(wrapFocusIndex(1, 3, true)).toBe(0);
        expect(wrapFocusIndex(0, 3, true)).toBe(2);
    });
    it('pulls focus from outside to the first or last', () => {
        expect(wrapFocusIndex(-1, 3, false)).toBe(0);
        expect(wrapFocusIndex(-1, 3, true)).toBe(2);
    });
    it('has nowhere to go without focusables', () => {
        expect(wrapFocusIndex(-1, 0, false)).toBe(-1);
    });
});

describe('toastDuration', () => {
    it('keeps errors longer and honours an explicit duration', () => {
        expect(toastDuration('info', undefined)).toBe(4000);
        expect(toastDuration('error', undefined)).toBe(8000);
        expect(toastDuration('error', 0)).toBe(0);
    });
});

describe('validProjectName', () => {
    it('accepts a-z, 0-9, . _ - and empty (cancel-like)', () => {
        expect(validProjectName('my-project_1.0')).toBeNull();
        expect(validProjectName('')).toBeNull();
    });
    it('rejects anything else', () => {
        expect(validProjectName('mein projekt')).not.toBeNull();
        expect(validProjectName('a/b')).not.toBeNull();
    });
});

describe('no native dialogs (plan P7 / C2)', () => {
    it('the client source calls no window.alert / confirm / prompt', () => {
        const src = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src');
        const offenders = readdirSync(src)
            .filter((f) => f.endsWith('.ts'))
            .filter((f) => /\b(window\.)?(alert|confirm|prompt)\(\s*[`'"]/.test(readFileSync(path.join(src, f), 'utf8'))
                || /window\.(alert|confirm|prompt)\(/.test(readFileSync(path.join(src, f), 'utf8')));
        expect(offenders).toEqual([]);
    });
});

/** The options object of each `el('button', {...})` call, brace-balanced. */
const buttonOptions = (source: string): string[] => {
    const found: string[] = [];
    const re = /el\(\s*'button'\s*,\s*\{/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
        let depth = 0;
        let i = m.index + m[0].length - 1;
        for (; i < source.length; i++) {
            if (source[i] === '{') depth++;
            else if (source[i] === '}' && --depth === 0) break;
        }
        found.push(source.slice(m.index + m[0].length - 1, i + 1));
    }
    return found;
};

describe('icon buttons have an accessible name (plan P7 / C4)', () => {
    it('a button whose own text is only a glyph carries aria-label', () => {
        const src = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src');
        const offenders: string[] = [];
        for (const f of readdirSync(src).filter((n) => n.endsWith('.ts'))) {
            for (const opts of buttonOptions(readFileSync(path.join(src, f), 'utf8'))) {
                const text = /\btext:\s*'([^']*)'/.exec(opts)?.[1];
                if (text === undefined || /[\p{L}\p{N}]{2,}/u.test(text)) continue;
                if (!opts.includes("'aria-label'")) offenders.push(`${f}: ${JSON.stringify(text)}`);
            }
        }
        expect(offenders).toEqual([]);
    });
});
