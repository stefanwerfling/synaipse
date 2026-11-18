import {clear, el} from './Dom.js';
import {slugify} from './Wikilinks.js';

export interface TocEntry {
    level: number;
    id: string;
    text: string;
}

/**
 * Walk h1-h6 in `host`, assign unique slug IDs (needed so hash-links from
 * the TOC find them), and return a flat outline. Empty-text headings are
 * skipped so a stray `<h2></h2>` from an infographic stub can't produce a
 * blank row.
 */
export const extractToc = (host: HTMLElement): TocEntry[] => {
    const nodes = host.querySelectorAll<HTMLHeadingElement>('h1, h2, h3, h4, h5, h6');
    const entries: TocEntry[] = [];
    const seen = new Set<string>();

    for (const h of nodes) {
        const text = (h.textContent ?? '').trim();
        if (text.length === 0) continue;

        const level = parseInt(h.tagName.substring(1), 10);
        let base = slugify(text);
        if (base.length === 0) base = 'section';
        let id = base;
        let n = 1;
        while (seen.has(id)) {
            n += 1;
            id = `${base}-${n}`;
        }
        seen.add(id);
        h.id = id;
        entries.push({level, id, text});
    }

    return entries;
};

export interface TocPanelOptions {
    onNavigate: (id: string) => void;
}

const TOC_COLLAPSED_KEY = 'synaipse-toc-collapsed';

export class TocPanel {
    public readonly element: HTMLElement;
    private readonly list: HTMLElement;
    private readonly head: HTMLElement;
    private readonly buttons = new Map<string, HTMLButtonElement>();
    private activeId: string | null = null;
    private collapsed = false;

    public constructor(private readonly opts: TocPanelOptions) {
        this.list = el('ul', {class: 'viewer-toc-list'});
        this.head = el('button', {
            class: 'viewer-toc-head',
            attrs: {type: 'button', 'aria-expanded': 'true', title: 'Toggle outline'}
        },
            el('span', {class: 'viewer-toc-caret', text: '▾'}),
            el('span', {class: 'viewer-toc-head-label', text: 'On this page'})
        );
        this.head.addEventListener('click', () => this.toggle());

        this.element = el('aside', {class: 'viewer-toc', attrs: {'aria-label': 'Note outline'}},
            this.head,
            this.list
        );

        // Restore prior collapse state. Fail-silent if localStorage is
        // locked down (e.g. private mode) — the panel just starts open.
        try {
            if (window.localStorage.getItem(TOC_COLLAPSED_KEY) === '1') {
                this.setCollapsed(true);
            }
        } catch {
            /* ignore */
        }
    }

    private toggle(): void {
        this.setCollapsed(!this.collapsed);
    }

    private setCollapsed(next: boolean): void {
        if (this.collapsed === next) return;
        this.collapsed = next;
        this.element.classList.toggle('collapsed', next);
        this.head.setAttribute('aria-expanded', next ? 'false' : 'true');
        try {
            window.localStorage.setItem(TOC_COLLAPSED_KEY, next ? '1' : '0');
        } catch {
            /* ignore */
        }
    }

    public setEntries(entries: readonly TocEntry[]): void {
        clear(this.list);
        this.buttons.clear();
        this.activeId = null;

        if (entries.length === 0) {
            return;
        }

        // Trim leading indent so an all-h2 note doesn't render as if it
        // were deeply nested.
        const minLevel = entries.reduce((m, e) => Math.min(m, e.level), 6);

        for (const entry of entries) {
            const depth = Math.max(0, entry.level - minLevel);
            const button = el('button', {
                class: 'viewer-toc-link',
                attrs: {type: 'button', title: entry.text},
                text: entry.text,
                on: {click: () => this.opts.onNavigate(entry.id)}
            }) as HTMLButtonElement;

            this.buttons.set(entry.id, button);

            this.list.appendChild(el('li', {
                class: `viewer-toc-item lvl-${entry.level}`,
                style: {paddingLeft: `${depth * 12}px`}
            }, button));
        }
    }

    /**
     * Mark one entry as active (scroll-spy). Auto-scrolls the TOC list so
     * the active row stays visible when the note is long enough that the
     * outline itself needs to scroll.
     */
    public setActive(id: string | null): void {
        if (id === this.activeId) return;

        if (this.activeId !== null) {
            this.buttons.get(this.activeId)?.classList.remove('active');
        }

        this.activeId = id;

        if (id === null) return;

        const btn = this.buttons.get(id);
        if (btn === undefined) return;

        btn.classList.add('active');
        btn.scrollIntoView({block: 'nearest'});
    }
}