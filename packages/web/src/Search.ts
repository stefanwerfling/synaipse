import type {SearchHit, SearchMode} from '@synaipse/core';
import {api} from './Api.js';
import {clear, el} from './Dom.js';

export interface SearchOptions {
    semanticEnabled: boolean;
    onOpenNote: (noteId: string) => void;
    onTopHitChanged?: (noteId: string | null) => void;
}

const DEBOUNCE_MS = 220;

export class Search {
    public readonly element: HTMLElement;
    private input!: HTMLInputElement;
    private modeSelect!: HTMLSelectElement;
    private dropdown!: HTMLElement;
    private mode: SearchMode;
    private debounceTimer: number | null = null;
    private currentQuery = '';
    private results: SearchHit[] = [];
    private highlight = -1;
    private busy = false;
    private lastTopHitId: string | null = null;
    private outsideClickHandler: ((event: MouseEvent) => void) | null = null;
    private readonly globalKeyHandler: (event: KeyboardEvent) => void;

    public constructor(private readonly opts: SearchOptions) {
        this.mode = opts.semanticEnabled ? 'hybrid' : 'fulltext';
        this.element = el('div', {class: 'search'});
        this.build();
        this.globalKeyHandler = (event) => this.handleGlobalKey(event);
        window.addEventListener('keydown', this.globalKeyHandler);
    }

    public focus(): void {
        this.input.focus();
        this.input.select();
    }

    public destroy(): void {
        window.removeEventListener('keydown', this.globalKeyHandler);
        if (this.outsideClickHandler !== null) {
            window.removeEventListener('click', this.outsideClickHandler);
            this.outsideClickHandler = null;
        }
        if (this.debounceTimer !== null) {
            window.clearTimeout(this.debounceTimer);
        }
    }

    private build(): void {
        this.input = el('input', {
            class: 'search-input',
            attrs: {type: 'search', placeholder: 'Search…  (Ctrl+K)', autocomplete: 'off', spellcheck: 'false'},
            on: {
                input: (e) => this.onInput((e.target as HTMLInputElement).value),
                focus: () => {
                    if (this.results.length > 0) {
                        this.showDropdown();
                    }
                },
                keydown: (e) => this.onInputKey(e as KeyboardEvent)
            }
        }) as HTMLInputElement;

        this.modeSelect = el('select', {
            class: 'search-mode',
            on: {change: (e) => {
                this.mode = (e.target as HTMLSelectElement).value as SearchMode;

                if (this.currentQuery.trim() !== '') {
                    void this.runSearch(this.currentQuery);
                }
            }}
        },
            el('option', {attrs: {value: 'fulltext'}, text: 'fulltext'}),
            el('option', {attrs: {value: 'semantic', ...(this.opts.semanticEnabled ? {} : {disabled: ''})}, text: 'semantic'}),
            el('option', {attrs: {value: 'hybrid', ...(this.opts.semanticEnabled ? {} : {disabled: ''})}, text: 'hybrid'})
        ) as HTMLSelectElement;
        this.modeSelect.value = this.mode;

        this.dropdown = el('div', {class: 'search-dropdown', style: {display: 'none'}});

        this.element.appendChild(this.input);
        this.element.appendChild(this.modeSelect);
        this.element.appendChild(this.dropdown);
    }

    private onInput(value: string): void {
        this.currentQuery = value;

        if (this.debounceTimer !== null) {
            window.clearTimeout(this.debounceTimer);
        }

        if (value.trim() === '') {
            this.results = [];
            this.highlight = -1;
            this.notifyTopHit(null);
            this.hideDropdown();
            return;
        }

        this.debounceTimer = window.setTimeout(() => {
            this.debounceTimer = null;
            void this.runSearch(value);
        }, DEBOUNCE_MS);
    }

    private async runSearch(query: string): Promise<void> {
        if (this.busy) {
            return;
        }

        this.busy = true;
        this.renderLoading();

        try {
            this.results = await api.search(query, this.mode, 20);
            this.highlight = this.results.length > 0 ? 0 : -1;
            this.notifyTopHit(this.results[0]?.noteId ?? null);
            this.renderResults();
            this.showDropdown();
        } catch (error) {
            this.renderError(error);
            this.showDropdown();
        } finally {
            this.busy = false;
        }
    }

    private renderLoading(): void {
        clear(this.dropdown);
        this.dropdown.appendChild(el('div', {class: 'search-empty', text: 'searching…'}));
        this.showDropdown();
    }

    private renderError(error: unknown): void {
        clear(this.dropdown);
        const message = error instanceof Error ? error.message : String(error);
        this.dropdown.appendChild(el('div', {class: 'search-empty', text: `error: ${message}`}));
    }

    private renderResults(): void {
        clear(this.dropdown);

        if (this.results.length === 0) {
            this.dropdown.appendChild(el('div', {class: 'search-empty', text: 'no results'}));
            return;
        }

        this.results.forEach((hit, i) => {
            const row = el('div', {
                class: i === this.highlight ? 'search-result active' : 'search-result',
                on: {
                    click: () => this.choose(hit),
                    mouseenter: () => {
                        this.highlight = i;
                        this.updateHighlight();
                    }
                }
            },
                el('div', {class: 'search-result-head'},
                    el('span', {class: 'search-result-title', text: hit.title}),
                    el('span', {class: 'search-result-score', text: hit.score.toFixed(2)})
                ),
                el('div', {class: 'search-result-path', text: hit.noteId}),
                hit.snippet ? el('div', {class: 'search-result-snippet', text: hit.snippet}) : ''
            );

            this.dropdown.appendChild(row);
        });
    }

    private updateHighlight(): void {
        const rows = this.dropdown.querySelectorAll<HTMLElement>('.search-result');
        rows.forEach((row, i) => {
            row.classList.toggle('active', i === this.highlight);
        });
    }

    private choose(hit: SearchHit): void {
        this.opts.onOpenNote(hit.noteId);
        this.input.value = '';
        this.currentQuery = '';
        this.results = [];
        this.highlight = -1;
        this.notifyTopHit(null);
        this.hideDropdown();
        this.input.blur();
    }

    private notifyTopHit(noteId: string | null): void {
        if (noteId === this.lastTopHitId) {
            return;
        }

        this.lastTopHitId = noteId;
        this.opts.onTopHitChanged?.(noteId);
    }

    private onInputKey(event: KeyboardEvent): void {
        if (event.key === 'ArrowDown') {
            event.preventDefault();
            this.highlight = Math.min(this.results.length - 1, this.highlight + 1);
            this.updateHighlight();
            return;
        }

        if (event.key === 'ArrowUp') {
            event.preventDefault();
            this.highlight = Math.max(0, this.highlight - 1);
            this.updateHighlight();
            return;
        }

        if (event.key === 'Enter') {
            const hit = this.results[this.highlight];

            if (hit !== undefined) {
                event.preventDefault();
                this.choose(hit);
            }
            return;
        }

        if (event.key === 'Escape') {
            event.preventDefault();
            this.hideDropdown();
            this.input.blur();
        }
    }

    private handleGlobalKey(event: KeyboardEvent): void {
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
            event.preventDefault();
            this.focus();
        }
    }

    private showDropdown(): void {
        this.dropdown.style.display = '';

        if (this.outsideClickHandler !== null) {
            return;
        }

        this.outsideClickHandler = (event) => {
            const target = event.target;

            if (target instanceof Node && !this.element.contains(target)) {
                this.hideDropdown();
            }
        };

        window.addEventListener('click', this.outsideClickHandler);
    }

    private hideDropdown(): void {
        this.dropdown.style.display = 'none';

        if (this.outsideClickHandler !== null) {
            window.removeEventListener('click', this.outsideClickHandler);
            this.outsideClickHandler = null;
        }
    }
}