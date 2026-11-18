import {api, type InboxItem, type InboxRef} from './Api.js';
import {clear, el} from './Dom.js';

/**
 * The `remember` inbox (plan P8 / C5): what agents noted in passing, per
 * project, with where it could go. "Übernehmen" appends the (editable)
 * text to a note or starts a new one, "Verwerfen" drops the entry; both
 * are versioned writes in the vault.
 */
export interface InboxPanelOptions {
    onOpenNote: (noteId: string) => void;
    /** Title/alias/path → note id, null when nothing matches. */
    resolveNoteLink: (ref: string) => string | null;
    /** A note was created or changed (refresh the notes tree). */
    onChange: () => void;
}

const OTHER = '__other__';
const NEW = '__new__';

interface CardState {
    target: string;
    other: string;
    newTitle: string;
    text: string;
    editing: boolean;
}

export class InboxPanel {
    public readonly element: HTMLElement;

    private readonly picker: HTMLSelectElement;
    private readonly summary: HTMLElement;
    private readonly listHost: HTMLElement;

    private project: string | null = null;
    private entries: InboxItem[] = [];
    private total = 0;
    private busy = false;
    private readonly cards = new Map<string, CardState>();
    private error: {key: string; message: string} | null = null;

    public constructor(private readonly opts: InboxPanelOptions) {
        this.picker = el('select', {class: 'rm-picker-select', on: {change: () => void this.pick(this.picker.value || null)}});
        this.summary = el('p', {class: 'rm-sub'});
        this.listHost = el('div', {class: 'ib-list'});

        const header = el('div', {class: 'rm-head'},
            el('div', {class: 'rm-head-left'},
                el('h1', {class: 'rm-title', text: 'Inbox'}),
                el('p', {class: 'rm-sub', text: 'Was Agenten per remember nebenbei notiert haben. Übernehmen hängt den Text an eine Notiz an oder legt eine neue an, Verwerfen entfernt den Eintrag. Beides steht in der Versionsgeschichte.'}),
                el('div', {class: 'rm-picker'},
                    el('span', {class: 'rm-picker-label', text: 'Projekt'}),
                    this.picker
                ),
                this.summary
            )
        );

        this.element = el('div', {class: 'rm-panel ib-panel'}, header, this.listHost);
    }

    public async onShow(): Promise<void> {
        await this.loadProjects();
    }

    /** Reload when an inbox of the shown project changed (MCP remember, another tab). */
    public onVaultEvent(touched: readonly string[]): void {
        if (this.project === null || this.busy || !this.element.isConnected) return;
        const prefix = `Memory/${this.project}/inbox/`;
        if (touched.some((id) => id.startsWith(prefix))) void this.load();
    }

    private async loadProjects(): Promise<void> {
        let inboxes: Array<{project: string; entries: number}> = [];
        try {
            inboxes = await api.listInboxes();
        } catch (e) {
            console.error('failed to list inboxes', e);
        }

        clear(this.picker);
        if (inboxes.length === 0) this.picker.appendChild(el('option', {text: '— keine Einträge —', attrs: {value: ''}}));
        for (const i of inboxes) {
            this.picker.appendChild(el('option', {text: `${i.project} (${i.entries})`, attrs: {value: i.project}}));
        }

        const keep = this.project !== null && inboxes.some((i) => i.project === this.project);
        await this.pick(keep ? this.project : inboxes[0]?.project ?? null);
    }

    private async pick(project: string | null): Promise<void> {
        this.project = project;
        if (project !== null) this.picker.value = project;
        this.cards.clear();
        this.error = null;
        await this.load();
    }

    private async load(): Promise<void> {
        if (this.project === null) {
            this.entries = [];
            this.total = 0;
            this.render();
            return;
        }
        try {
            const result = await api.getInbox(this.project);
            this.entries = result.entries;
            this.total = result.total;
        } catch (e) {
            console.error('failed to load inbox', e);
            this.entries = [];
            this.total = 0;
        }
        this.render();
    }

    private keyOf(ref: InboxRef): string {
        return `${ref.inbox}|${ref.time}|${ref.text}`;
    }

    private stateOf(entry: InboxItem): CardState {
        const key = this.keyOf(entry);
        let state = this.cards.get(key);
        if (state === undefined) {
            const first = entry.alreadyIn[0]?.id ?? entry.targets[0]?.id;
            state = {target: first ?? NEW, other: '', newTitle: '', text: entry.text, editing: false};
            this.cards.set(key, state);
        }
        return state;
    }

    // --- actions ----------------------------------------------------------------

    private async run(entry: InboxItem, action: () => Promise<void>): Promise<void> {
        if (this.busy) return;
        this.busy = true;
        this.error = null;
        this.render();
        try {
            await action();
            this.cards.delete(this.keyOf(entry));
            this.opts.onChange();
        } catch (e) {
            this.error = {key: this.keyOf(entry), message: e instanceof Error ? e.message.replace(/^API \d+: /, '') : String(e)};
        } finally {
            this.busy = false;
        }
        await this.loadProjects();
    }

    private promote(entry: InboxItem, state: CardState): void {
        const project = this.project;
        if (project === null) return;

        let target: {id: string} | {newTitle: string};
        if (state.target === NEW) {
            if (state.newTitle.trim() === '') {
                this.error = {key: this.keyOf(entry), message: 'Titel für die neue Notiz fehlt.'};
                this.render();
                return;
            }
            target = {newTitle: state.newTitle.trim()};
        } else if (state.target === OTHER) {
            const id = this.opts.resolveNoteLink(state.other.trim());
            if (id === null) {
                this.error = {key: this.keyOf(entry), message: `Keine Notiz „${state.other.trim()}“ gefunden.`};
                this.render();
                return;
            }
            target = {id};
        } else {
            target = {id: state.target};
        }

        const ref: InboxRef = {inbox: entry.inbox, time: entry.time, text: entry.text};
        const content = state.text.trim() === entry.text ? undefined : state.text;
        void this.run(entry, async () => {
            await api.promoteInboxEntry(project, ref, target, content);
        });
    }

    private discard(entry: InboxItem): void {
        const project = this.project;
        if (project === null) return;
        void this.run(entry, () => api.discardInboxEntry(project, {inbox: entry.inbox, time: entry.time, text: entry.text}));
    }

    // --- rendering --------------------------------------------------------------

    private render(): void {
        clear(this.listHost);

        if (this.project === null) {
            this.summary.textContent = '';
            this.listHost.appendChild(el('div', {class: 'rm-empty', text: 'Die Inbox ist leer. Einträge entstehen, wenn ein Agent synaipse_remember aufruft.'}));
            return;
        }

        const shown = this.entries.length;
        this.summary.textContent = shown < this.total
            ? `${this.total} Einträge, die neuesten ${shown} mit Vorschlägen`
            : `${this.total} ${this.total === 1 ? 'Eintrag' : 'Einträge'}`;

        let day = '';
        for (const entry of this.entries) {
            if (entry.date !== day) {
                day = entry.date;
                this.listHost.appendChild(el('h3', {class: 'ib-day', text: day}));
            }
            this.listHost.appendChild(this.renderCard(entry));
        }
    }

    private renderCard(entry: InboxItem): HTMLElement {
        const state = this.stateOf(entry);
        const key = this.keyOf(entry);

        const text = state.editing
            ? el('textarea', {class: 'ib-text-edit', attrs: {rows: '4'}, on: {input: (e) => { state.text = (e.target as HTMLTextAreaElement).value; }}})
            : el('div', {class: 'ib-text', text: state.text});
        if (text instanceof HTMLTextAreaElement) text.value = state.text;

        const meta = el('div', {class: 'ib-meta'},
            el('span', {class: 'ib-time', text: entry.time}),
            ...entry.tags.map((t) => el('span', {class: 'ib-tag', text: `#${t}`})),
            el('button', {
                class: 'ib-link',
                attrs: {type: 'button', title: 'Inbox-Notiz öffnen'},
                text: entry.inbox.split('/').pop() ?? entry.inbox,
                on: {click: () => this.opts.onOpenNote(entry.inbox)}
            })
        );

        const card = el('article', {class: 'ib-card'}, meta, text);

        if (entry.alreadyIn.length > 0) {
            card.appendChild(el('div', {class: 'ib-already'},
                el('span', {text: 'Steht vermutlich schon in '}),
                ...entry.alreadyIn.flatMap((d, i) => [
                    ...(i > 0 ? [el('span', {text: ', '})] : []),
                    el('button', {class: 'ib-link', attrs: {type: 'button'}, text: d.title, on: {click: () => this.opts.onOpenNote(d.id)}}),
                    el('span', {class: 'ib-sim', text: ` ${Math.round(d.similarity * 100)} %`})
                ]),
                el('span', {text: ' – dann kann der Eintrag weg.'})
            ));
        }

        const select = el('select', {class: 'rm-picker-select ib-target', on: {change: (e) => { state.target = (e.target as HTMLSelectElement).value; this.render(); }}});
        const seen = new Set<string>();
        for (const n of [...entry.alreadyIn, ...entry.targets]) {
            if (seen.has(n.id)) continue;
            seen.add(n.id);
            select.appendChild(el('option', {text: n.title, attrs: {value: n.id, title: n.id}}));
        }
        select.appendChild(el('option', {text: 'Andere Notiz …', attrs: {value: OTHER}}));
        select.appendChild(el('option', {text: 'Neue Notiz …', attrs: {value: NEW}}));
        select.value = state.target;

        const extra = state.target === OTHER
            ? el('input', {class: 'ib-input', attrs: {type: 'text', placeholder: 'Titel oder Pfad', value: state.other}, on: {input: (e) => { state.other = (e.target as HTMLInputElement).value; }}})
            : state.target === NEW
                ? el('input', {class: 'ib-input', attrs: {type: 'text', placeholder: 'Titel der neuen Notiz', value: state.newTitle}, on: {input: (e) => { state.newTitle = (e.target as HTMLInputElement).value; }}})
                : null;

        const actions = el('div', {class: 'ib-actions'},
            el('span', {class: 'rm-picker-label', text: 'Nach'}),
            select,
            ...(extra !== null ? [extra] : []),
            el('button', {class: 'rm-btn sm', attrs: {type: 'button', disabled: this.busy}, text: 'Übernehmen', on: {click: () => this.promote(entry, state)}}),
            el('button', {
                class: 'rm-btn sm ghost',
                attrs: {type: 'button', disabled: this.busy},
                text: state.editing ? 'Fertig' : 'Bearbeiten',
                on: {click: () => { state.editing = !state.editing; this.render(); }}
            }),
            el('button', {class: entry.alreadyIn.length > 0 ? 'rm-btn sm' : 'rm-btn sm ghost', attrs: {type: 'button', disabled: this.busy}, text: 'Verwerfen', on: {click: () => this.discard(entry)}})
        );
        card.appendChild(actions);

        if (this.error?.key === key) card.appendChild(el('div', {class: 'ib-error', text: this.error.message}));
        return card;
    }
}
