/**
 * Code highlighting as a hydration pass (plan P4 / D4). highlight.js
 * (`lib/common`, ~160 KB) used to be bundled into the entry chunk through
 * marked-highlight; now it is imported on the first rendered code block.
 *
 * Markdown renders plain `<pre><code class="language-x">`; this pass marks
 * every block `hljs` right away (background and spacing from the theme
 * CSS, no layout shift) and colours it once the library is there. After
 * the first load it runs synchronously, like the old inline highlighter.
 */

type Hljs = typeof import('highlight.js/lib/common').default;

let hljs: Hljs | null = null;
let loading: Promise<Hljs> | null = null;

const load = (): Promise<Hljs> => {
    loading ??= import('highlight.js/lib/common').then((mod) => {
        hljs = mod.default;
        return hljs;
    });
    return loading;
};

const DONE = 'data-highlighted';

const pending = (host: ParentNode): HTMLElement[] =>
    [...host.querySelectorAll<HTMLElement>('pre > code')].filter((code) => !code.hasAttribute(DONE));

const languageOf = (code: HTMLElement): string | null => {
    for (const cls of code.classList) {
        if (cls.startsWith('language-')) return cls.slice('language-'.length);
    }
    return null;
};

const colour = (lib: Hljs, blocks: readonly HTMLElement[]): void => {
    // Detached blocks are coloured too: callers often render into an
    // element before inserting it (chat bubbles). A block replaced while
    // the library loaded costs one wasted highlight, nothing more.
    for (const code of blocks) {
        const lang = languageOf(code);
        const language = lang !== null && lib.getLanguage(lang) !== undefined ? lang : 'plaintext';
        code.innerHTML = lib.highlight(code.textContent ?? '', {language, ignoreIllegals: true}).value;
        code.setAttribute(DONE, '');
    }
};

/**
 * Highlight every not yet highlighted code block under `host`. Resolves
 * when they are coloured; callers that do not need to wait (live views)
 * use `void`, the PDF export awaits it.
 */
export const highlightCodeIn = (host: ParentNode): Promise<void> => {
    const blocks = pending(host);
    if (blocks.length === 0) return Promise.resolve();

    for (const code of blocks) code.classList.add('hljs');

    if (hljs !== null) {
        colour(hljs, blocks);
        return Promise.resolve();
    }

    return load().then((lib) => colour(lib, blocks), () => {
        // Offline / chunk failed: the code stays readable, just uncoloured.
    });
};
