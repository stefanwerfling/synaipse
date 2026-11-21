import hljsDarkCss from 'highlight.js/styles/github-dark.css?inline';
import hljsLightCss from 'highlight.js/styles/github.css?inline';
import {readItem, writeItem} from './LocalStore.js';

export type Theme = 'dark' | 'light';

const STORAGE_KEY = 'synaipse-theme';
const HLJS_STYLE_ID = 'hljs-theme';
const EVENT_NAME = 'synaipse:theme-change';

const isTheme = (value: unknown): value is Theme => value === 'dark' || value === 'light';

const readStoredTheme = (): Theme => {
    const raw = readItem(STORAGE_KEY);
    return isTheme(raw) ? raw : 'dark';
};

const persistTheme = (theme: Theme): void => writeItem(STORAGE_KEY, theme);

/** Root class of every Synaipse DOM tree (app container and portal layer). */
export const ROOT_CLASS = 'synaipse-root';

/**
 * Prefix every selector of a plain stylesheet with `scope` (plan P3 / D3),
 * so a third-party stylesheet such as highlight.js only styles Synaipse.
 * Handles flat rule lists (no @media nesting), which is all hljs ships.
 */
export const scopeCss = (css: string, scope: string): string =>
    css
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/([^{}]+)\{/g, (_m, selectors: string) => {
            const scoped = selectors
                .split(',')
                .map((sel) => sel.trim())
                .filter((sel) => sel.length > 0)
                .map((sel) => `${scope} ${sel}`)
                .join(', ');
            return `${scoped} {`;
        });

/**
 * Both highlight.js themes, scoped to the matching root theme. Installed
 * once; switching themes is just the data-theme attribute.
 */
const installHljsStylesheet = (): void => {
    if (typeof document === 'undefined' || document.getElementById(HLJS_STYLE_ID) !== null) {
        return;
    }
    const style = document.createElement('style');
    style.id = HLJS_STYLE_ID;
    style.textContent = [
        scopeCss(hljsDarkCss, `.${ROOT_CLASS}[data-theme='dark']`),
        scopeCss(hljsLightCss, `.${ROOT_CLASS}[data-theme='light']`)
    ].join('\n');
    document.head.appendChild(style);
};

let current: Theme | null = null;

export const getTheme = (): Theme => current ?? readStoredTheme();

/**
 * Stamp the theme on every Synaipse root — never on <html>, which belongs
 * to the host page (plan P3 / E1).
 */
export const applyTheme = (theme: Theme): void => {
    current = theme;
    if (typeof document !== 'undefined') {
        for (const root of document.querySelectorAll(`.${ROOT_CLASS}`)) {
            root.setAttribute('data-theme', theme);
        }
    }

    installHljsStylesheet();
};

export const setTheme = (theme: Theme): void => {
    applyTheme(theme);
    persistTheme(theme);

    if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent<Theme>(EVENT_NAME, {detail: theme}));
    }
};

export const toggleTheme = (): Theme => {
    const next: Theme = getTheme() === 'light' ? 'dark' : 'light';

    setTheme(next);

    return next;
};

export const onThemeChange = (cb: (theme: Theme) => void): (() => void) => {
    if (typeof window === 'undefined') {
        return () => {};
    }

    const handler = (event: Event): void => {
        const detail = (event as CustomEvent<Theme>).detail;

        if (isTheme(detail)) {
            cb(detail);
        }
    };

    window.addEventListener(EVENT_NAME, handler);

    return () => window.removeEventListener(EVENT_NAME, handler);
};

export const initTheme = (): Theme => {
    const theme = getTheme();

    applyTheme(theme);

    return theme;
};