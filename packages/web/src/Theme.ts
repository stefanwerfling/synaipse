import hljsDarkCss from 'highlight.js/styles/github-dark.css?inline';
import hljsLightCss from 'highlight.js/styles/github.css?inline';

export type Theme = 'dark' | 'light';

const STORAGE_KEY = 'synaipse-theme';
const HLJS_STYLE_ID = 'hljs-theme';
const EVENT_NAME = 'synaipse:theme-change';

const isTheme = (value: unknown): value is Theme => value === 'dark' || value === 'light';

const readStoredTheme = (): Theme => {
    if (typeof localStorage === 'undefined') {
        return 'dark';
    }

    try {
        const raw = localStorage.getItem(STORAGE_KEY);

        return isTheme(raw) ? raw : 'dark';
    } catch {
        return 'dark';
    }
};

const persistTheme = (theme: Theme): void => {
    if (typeof localStorage === 'undefined') {
        return;
    }

    try {
        localStorage.setItem(STORAGE_KEY, theme);
    } catch {
        // ignore — localStorage disabled / quota
    }
};

const applyHljsStylesheet = (theme: Theme): void => {
    if (typeof document === 'undefined') {
        return;
    }

    let style = document.getElementById(HLJS_STYLE_ID) as HTMLStyleElement | null;

    if (style === null) {
        style = document.createElement('style');
        style.id = HLJS_STYLE_ID;
        document.head.appendChild(style);
    }

    style.textContent = theme === 'light' ? hljsLightCss : hljsDarkCss;
};

export const getTheme = (): Theme => {
    if (typeof document === 'undefined') {
        return readStoredTheme();
    }

    const attr = document.documentElement.getAttribute('data-theme');

    return isTheme(attr) ? attr : readStoredTheme();
};

export const applyTheme = (theme: Theme): void => {
    if (typeof document !== 'undefined') {
        document.documentElement.setAttribute('data-theme', theme);
    }

    applyHljsStylesheet(theme);
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