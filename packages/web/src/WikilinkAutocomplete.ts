import {clear, el} from './Dom.js';

/**
 * Floating-popup wikilink autocompleter for the editor textarea.
 * Triggered when the caret sits inside an open `[[` that has no
 * closing `]]` yet — the unfinished span between the `[[` and the
 * caret is the live query.
 *
 * The popup lists candidate note titles ranked by fuzzy match
 * (`searchTitles` is supplied by the embedder), arrow keys move the
 * highlight, Enter / Tab commits the highlighted pick by replacing
 * `[[<query>` with `[[<title>]]`, Escape dismisses. Pure index math
 * (open-bracket detection, query substring extraction) lives in the
 * exported `findOpenWikilink` helper so it can be unit-tested in
 * Node without a DOM.
 */

export interface WikilinkMatch {
    noteId: string;
    title: string;
}

export interface WikilinkAutocompleteOptions {
    textarea: HTMLTextAreaElement;
    /** Mount target for the popup. The popup is absolutely positioned. */
    host: HTMLElement;
    searchTitles: (query: string) => readonly WikilinkMatch[];
    /** Fired after the textarea's value has been mutated by a commit. */
    onChange: (value: string) => void;
    /** Cap on rendered results. Defaults to 8. */
    maxResults?: number;
}

/**
 * Look backwards from the caret for an unclosed `[[`. Returns the
 * position of the `[[` and the query (text between `[[` and caret).
 * Returns null when:
 *  - no `[[` precedes the caret on the current logical scan
 *  - a `]` appears between the `[[` and the caret (link is closed)
 *  - a newline appears between the `[[` and the caret (we don't
 *    span lines so a stray `[[` doesn't keep the popup open forever)
 */
export const findOpenWikilink = (text: string, caret: number): {matchStart: number; query: string} | null => {
    const before = text.slice(0, caret);
    const lastOpen = before.lastIndexOf('[[');
    if (lastOpen === -1) return null;

    const between = before.slice(lastOpen + 2);
    if (between.includes(']')) return null;
    if (between.includes('\n')) return null;

    return {matchStart: lastOpen, query: between};
};

export class WikilinkAutocomplete {
    private readonly textarea: HTMLTextAreaElement;
    private readonly host: HTMLElement;
    private readonly searchTitles: (query: string) => readonly WikilinkMatch[];
    private readonly onChange: (value: string) => void;
    private readonly maxResults: number;

    private popup: HTMLElement | null = null;
    private results: readonly WikilinkMatch[] = [];
    private highlighted = 0;
    private matchStart = -1;
    private query = '';

    private readonly onInput: () => void;
    private readonly onKeyDown: (e: KeyboardEvent) => void;
    private readonly onBlur: () => void;

    public constructor(opts: WikilinkAutocompleteOptions) {
        this.textarea = opts.textarea;
        this.host = opts.host;
        this.searchTitles = opts.searchTitles;
        this.onChange = opts.onChange;
        this.maxResults = opts.maxResults ?? 8;

        this.onInput = () => this.refresh();
        this.onKeyDown = (e) => this.handleKey(e);
        this.onBlur = () => window.setTimeout(() => this.close(), 100);

        this.textarea.addEventListener('input', this.onInput);
        this.textarea.addEventListener('keydown', this.onKeyDown);
        this.textarea.addEventListener('blur', this.onBlur);
    }

    public destroy(): void {
        this.textarea.removeEventListener('input', this.onInput);
        this.textarea.removeEventListener('keydown', this.onKeyDown);
        this.textarea.removeEventListener('blur', this.onBlur);
        this.close();
    }

    private refresh(): void {
        const found = findOpenWikilink(this.textarea.value, this.textarea.selectionStart);
        if (found === null) {
            this.close();
            return;
        }

        const matches = this.searchTitles(found.query).slice(0, this.maxResults);
        if (matches.length === 0) {
            this.close();
            return;
        }

        this.matchStart = found.matchStart;
        this.query = found.query;
        this.results = matches;
        this.highlighted = 0;
        this.render();
    }

    private handleKey(e: KeyboardEvent): void {
        if (this.popup === null) return;

        if (e.key === 'ArrowDown') {
            e.preventDefault();
            this.highlighted = (this.highlighted + 1) % this.results.length;
            this.renderHighlight();
            return;
        }
        if (e.key === 'ArrowUp') {
            e.preventDefault();
            this.highlighted = (this.highlighted - 1 + this.results.length) % this.results.length;
            this.renderHighlight();
            return;
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
            e.preventDefault();
            this.commit();
            return;
        }
        if (e.key === 'Escape') {
            e.preventDefault();
            this.close();
        }
    }

    private commit(): void {
        const pick = this.results[this.highlighted];
        if (pick === undefined) return;

        const value = this.textarea.value;
        const before = value.slice(0, this.matchStart);
        const queryEnd = this.matchStart + 2 + this.query.length;
        const tail = value.slice(queryEnd);
        // If the user has already typed `]]` after the query, leave it alone;
        // otherwise we add a fresh `]]` so the cursor lands after the link.
        const closingAlreadyThere = tail.startsWith(']]');
        const inserted = `[[${pick.title}]]`;
        const next = closingAlreadyThere
            ? before + `[[${pick.title}` + tail
            : before + inserted + tail;

        const cursor = closingAlreadyThere
            ? (before + `[[${pick.title}`).length + 2 // past the existing ']]'
            : (before + inserted).length;

        this.textarea.value = next;
        this.textarea.selectionStart = cursor;
        this.textarea.selectionEnd = cursor;
        this.textarea.focus();
        this.onChange(next);
        this.close();
    }

    private render(): void {
        if (this.popup === null) {
            this.popup = el('div', {class: 'editor-autocomplete', attrs: {role: 'listbox'}});
            this.host.appendChild(this.popup);
        }

        clear(this.popup);

        for (let i = 0; i < this.results.length; i++) {
            const r = this.results[i] as WikilinkMatch;
            const item = el('div', {
                class: `editor-autocomplete-item${i === this.highlighted ? ' active' : ''}`,
                attrs: {role: 'option'},
                on: {
                    // mousedown (not click) so the textarea's blur handler
                    // doesn't close the popup before the pick lands.
                    mousedown: (e) => {
                        e.preventDefault();
                        this.highlighted = i;
                        this.commit();
                    }
                }
            },
                el('span', {class: 'editor-autocomplete-title', text: r.title}),
                el('span', {class: 'editor-autocomplete-id', text: r.noteId})
            );

            this.popup.appendChild(item);
        }
    }

    private renderHighlight(): void {
        if (this.popup === null) return;
        const children = Array.from(this.popup.children);
        for (let i = 0; i < children.length; i++) {
            (children[i] as HTMLElement).classList.toggle('active', i === this.highlighted);
        }
    }

    private close(): void {
        if (this.popup !== null) {
            this.popup.remove();
            this.popup = null;
        }
        this.matchStart = -1;
        this.query = '';
        this.results = [];
    }
}