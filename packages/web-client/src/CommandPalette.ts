import {clear, el, isAppVisible} from './Dom.js';
import {searchNotes, type NoteCandidate, type NoteRanked} from './Fuzzy.js';
import {PersistentValue} from './Persistence.js';

const STORAGE_RECENT = 'synaipse.palette.recent';
const RECENT_MAX = 8;

/** An action the palette offers (plan P7 / C1); the app supplies the list. */
export interface PaletteCommand {
    id: string;
    label: string;
    /** Right-hand hint: the group ("tab", "note", …) or a shortcut. */
    hint: string;
    /** Extra words that should find it ("dark", "light" for the theme). */
    keywords?: readonly string[];
    run: () => void;
}

export interface PaletteCallbacks {
    onSelectNote: (noteId: string) => void;
    /** The current commands; asked each time the list is built (they depend on state). */
    commands?: () => readonly PaletteCommand[];
}

interface BuiltinCommand extends PaletteCommand {
    kind: 'command';
}

/**
 * Whether every word of the query occurs in the command's label or
 * keywords (case-insensitive), so "theme dark" and "go gra" both hit.
 */
export const matchesCommand = (command: Pick<PaletteCommand, 'label' | 'keywords' | 'hint'>, query: string): boolean => {
    const hay = [command.label, command.hint, ...(command.keywords ?? [])].join(' ').toLowerCase();
    return query.toLowerCase().split(/\s+/).filter((w) => w.length > 0).every((w) => hay.includes(w));
};

interface NoteItem<T extends NoteCandidate> {
    kind: 'note';
    rank: NoteRanked<T>;
}

type Item<T extends NoteCandidate> = NoteItem<T> | BuiltinCommand;

const recentStore = new PersistentValue<readonly string[]>(STORAGE_RECENT, []);

export class CommandPalette<T extends NoteCandidate = NoteCandidate> {
    public readonly element: HTMLElement;
    private notes: readonly T[] = [];
    private input!: HTMLInputElement;
    private list!: HTMLElement;
    private items: Item<T>[] = [];
    private cursor = 0;
    private open = false;
    private returnFocus: HTMLElement | null = null;
    private backdrop!: HTMLElement;
    private readonly listeners = new AbortController();

    public constructor(private readonly cb: PaletteCallbacks) {
        this.element = el('div', {class: 'palette-wrap', attrs: {hidden: 'true'}});
        this.build();

        document.addEventListener('keydown', (event) => this.onGlobalKey(event), {signal: this.listeners.signal});
    }

    public destroy(): void {
        this.listeners.abort();
        this.element.remove();
    }

    public setNotes(notes: readonly T[]): void {
        this.notes = notes;
        if (this.open) this.refresh();
    }

    public openPalette(): void {
        if (this.open) return;
        this.open = true;
        this.returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        this.element.removeAttribute('hidden');
        this.input.value = '';
        this.cursor = 0;
        this.refresh();
        this.input.focus();
    }

    public closePalette(): void {
        if (!this.open) return;
        this.open = false;
        this.element.setAttribute('hidden', 'true');
        // Back to where the user was, unless a command moved focus on purpose.
        if (this.returnFocus?.isConnected === true && (document.activeElement === this.input || document.activeElement === document.body)) {
            this.returnFocus.focus();
        }
        this.returnFocus = null;
    }

    public isOpen(): boolean {
        return this.open;
    }

    private build(): void {
        this.backdrop = el('div', {
            class: 'palette-backdrop',
            on: {click: () => this.closePalette()}
        });

        this.input = el('input', {
            class: 'palette-input',
            attrs: {
                type: 'search',
                placeholder: 'Type a command or search notes… (esc to close)',
                'aria-label': 'Command palette',
                role: 'combobox',
                'aria-expanded': 'true',
                'aria-controls': 'synaipse-palette-list',
                'aria-autocomplete': 'list',
                autocomplete: 'off',
                spellcheck: 'false'
            },
            on: {
                input: () => this.refresh(),
                keydown: (event) => this.onInputKey(event as KeyboardEvent)
            }
        }) as HTMLInputElement;

        this.list = el('div', {class: 'palette-list', attrs: {role: 'listbox', id: 'synaipse-palette-list', 'aria-label': 'Results'}});

        const panel = el('div', {class: 'palette-panel', attrs: {role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Command palette'}},
            this.input,
            this.list
        );

        this.element.appendChild(this.backdrop);
        this.element.appendChild(panel);
    }

    private builtinCommands(): BuiltinCommand[] {
        return (this.cb.commands?.() ?? []).map((c) => ({...c, kind: 'command'}));
    }

    private refresh(): void {
        const q = this.input.value.trim();

        if (q.length === 0) {
            this.items = this.recentItems();
        } else {
            this.items = this.searchItems(q);
        }

        this.cursor = 0;
        this.renderList();
    }

    private recentItems(): Item<T>[] {
        const ids = recentStore.get();
        const byId = new Map(this.notes.map((n) => [n.id, n]));
        const out: Item<T>[] = [];

        for (const id of ids) {
            const note = byId.get(id);

            if (note !== undefined) {
                out.push({
                    kind: 'note',
                    rank: {note, score: 0, via: 'title', indices: [], matchedText: note.title}
                });
            }
        }

        for (const cmd of this.builtinCommands()) {
            out.push(cmd);
        }

        return out;
    }

    private searchItems(q: string): Item<T>[] {
        const ranked = searchNotes(q, this.notes, 20);
        const items: Item<T>[] = ranked.map((r) => ({kind: 'note', rank: r}));

        // Commands first: "theme", "graph", "new" are usually meant as actions.
        const commands = this.builtinCommands().filter((cmd) => matchesCommand(cmd, q));
        return [...commands, ...items];
    }

    private renderList(): void {
        clear(this.list);

        if (this.items.length === 0) {
            this.input.removeAttribute('aria-activedescendant');
            this.list.appendChild(el('div', {class: 'palette-empty', text: 'No matches'}));
            return;
        }

        this.items.forEach((item, idx) => {
            this.list.appendChild(this.renderItem(item, idx));
        });
        this.input.setAttribute('aria-activedescendant', `synaipse-palette-opt-${this.cursor}`);
        this.list.querySelector('.palette-row.active')?.scrollIntoView({block: 'nearest'});
    }

    private renderItem(item: Item<T>, idx: number): HTMLElement {
        const active = idx === this.cursor;

        if (item.kind === 'command') {
            return el('div', {
                class: active ? 'palette-row command active' : 'palette-row command',
                attrs: {role: 'option', id: `synaipse-palette-opt-${idx}`, 'aria-selected': String(active)},
                on: {
                    mouseenter: () => this.setCursor(idx),
                    click: () => this.activate(idx)
                }
            },
                el('span', {class: 'palette-row-icon', attrs: {'aria-hidden': 'true'}, text: '⌘'}),
                el('span', {class: 'palette-row-title', text: item.label}),
                el('span', {class: 'palette-row-hint', text: item.hint})
            );
        }

        const r = item.rank;
        const title = this.renderHighlight(r.matchedText, r.via === 'title' ? r.indices : []);
        const via = r.via === 'title' ? '' : `via ${r.via}`;

        return el('div', {
            class: active ? 'palette-row note active' : 'palette-row note',
            attrs: {role: 'option', id: `synaipse-palette-opt-${idx}`, 'aria-selected': String(active), title: r.note.id},
            on: {
                mouseenter: () => this.setCursor(idx),
                click: () => this.activate(idx)
            }
        },
            el('span', {class: 'palette-row-icon', attrs: {'aria-hidden': 'true'}, text: '📄'}),
            el('div', {class: 'palette-row-main'},
                title,
                el('div', {class: 'palette-row-sub'},
                    el('span', {class: 'palette-row-path', text: r.note.id}),
                    via ? el('span', {class: 'palette-row-via', text: via}) : ''
                )
            )
        );
    }

    private renderHighlight(text: string, indices: readonly number[]): HTMLElement {
        const host = el('span', {class: 'palette-row-title'});

        if (indices.length === 0) {
            host.textContent = text;
            return host;
        }

        const hit = new Set(indices);
        let buffer = '';
        let inHit = false;

        const flush = (): void => {
            if (buffer.length === 0) return;
            host.appendChild(inHit
                ? el('mark', {class: 'palette-hit', text: buffer})
                : document.createTextNode(buffer) as unknown as HTMLElement
            );
            buffer = '';
        };

        for (let i = 0; i < text.length; i += 1) {
            const isHit = hit.has(i);

            if (isHit !== inHit) {
                flush();
                inHit = isHit;
            }

            buffer += text[i];
        }

        flush();
        return host;
    }

    private setCursor(idx: number): void {
        if (idx === this.cursor) return;
        this.cursor = idx;
        this.renderList();
    }

    private activate(idx: number): void {
        const item = this.items[idx];

        if (item === undefined) return;

        if (item.kind === 'command') {
            this.closePalette();
            item.run();
            return;
        }

        const id = item.rank.note.id;
        this.recordRecent(id);
        this.closePalette();
        this.cb.onSelectNote(id);
    }

    private recordRecent(id: string): void {
        recentStore.update((prev) => {
            const next = [id, ...prev.filter((p) => p !== id)].slice(0, RECENT_MAX);
            return next;
        });
    }

    private onInputKey(event: KeyboardEvent): void {
        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            this.closePalette();
            return;
        }

        // The input is the only stop; options are reached with the arrows.
        if (event.key === 'Tab') {
            event.preventDefault();
            return;
        }

        if (event.key === 'Enter') {
            event.preventDefault();
            this.activate(this.cursor);
            return;
        }

        if (event.key === 'ArrowDown') {
            event.preventDefault();
            this.setCursor(Math.min(this.cursor + 1, Math.max(0, this.items.length - 1)));
            return;
        }

        if (event.key === 'ArrowUp') {
            event.preventDefault();
            this.setCursor(Math.max(0, this.cursor - 1));
        }
    }

    private onGlobalKey(event: KeyboardEvent): void {
        const isModK = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k';

        if (!isModK) return;
        // The editor binds Ctrl+K to "insert link" and handles it first.
        if (event.defaultPrevented) return;
        // Not over a dialog: Ctrl+K there belongs to the dialog (or nobody).
        if (!this.open && document.querySelector('body > .synaipse-portal > .modal-backdrop') !== null) return;
        if (!this.open && !isAppVisible(this.element.parentElement ?? this.element)) return;

        event.preventDefault();

        if (this.open) {
            this.closePalette();
        } else {
            this.openPalette();
        }
    }
}