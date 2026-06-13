import {api, type HistoryEntry} from './Api.js';
import {clear, el} from './Dom.js';

export interface HistoryPanelCallbacks {
    onClose: () => void;
}

const shortSha = (sha: string): string => sha.slice(0, 7);

const formatDate = (iso: string): string => {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
        year: 'numeric',
        month: 'short',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
    });
};

export class HistoryPanel {
    public readonly element: HTMLElement;
    private body: HTMLElement;
    private entries: HistoryEntry[] = [];
    private noteId: string | null = null;
    private selectedSha: string | null = null;
    private diffHost: HTMLElement;

    public constructor(private readonly cb: HistoryPanelCallbacks) {
        this.element = el('aside', {class: 'history-panel'});
        this.body = el('div', {class: 'history-list'});
        this.diffHost = el('div', {class: 'history-diff'});

        const header = el('header', {class: 'history-head'},
            el('h3', {class: 'history-title', text: 'History'}),
            el('button', {
                class: 'history-close',
                attrs: {type: 'button', 'aria-label': 'close'},
                on: {click: () => this.cb.onClose()},
                text: '×'
            })
        );

        this.element.appendChild(header);
        this.element.appendChild(this.body);
        this.element.appendChild(this.diffHost);
    }

    public async load(noteId: string): Promise<void> {
        this.noteId = noteId;
        this.selectedSha = null;
        clear(this.body);
        clear(this.diffHost);
        this.body.appendChild(el('div', {class: 'history-loading', text: 'loading…'}));

        try {
            const {entries} = await api.noteHistory(noteId, 50);
            this.entries = entries;
            this.renderList();
        } catch (error) {
            clear(this.body);
            this.body.appendChild(el('div', {class: 'history-error', text: String(error)}));
        }
    }

    private renderList(): void {
        clear(this.body);

        if (this.entries.length === 0) {
            this.body.appendChild(el('div', {class: 'history-empty', text: 'no commits yet'}));
            return;
        }

        for (const entry of this.entries) {
            this.body.appendChild(this.renderEntry(entry));
        }
    }

    private renderEntry(entry: HistoryEntry): HTMLElement {
        const active = entry.sha === this.selectedSha;
        const node = el('button', {
            class: active ? 'history-entry active' : 'history-entry',
            attrs: {type: 'button'},
            on: {click: () => void this.selectEntry(entry.sha)}
        },
            el('div', {class: 'history-entry-row1'},
                el('span', {class: 'history-sha', text: shortSha(entry.sha)}),
                el('span', {class: 'history-date', text: formatDate(entry.author.date)})
            ),
            el('div', {class: 'history-entry-msg', text: entry.message}),
            el('div', {class: 'history-entry-author', text: `${entry.author.name} <${entry.author.email}>`})
        );

        return node;
    }

    private async selectEntry(sha: string): Promise<void> {
        if (this.noteId === null) return;
        this.selectedSha = sha;
        this.renderList();

        clear(this.diffHost);
        this.diffHost.appendChild(el('div', {class: 'history-loading', text: 'diffing…'}));

        const entry = this.entries.find((e) => e.sha === sha);
        const parentSha = entry?.parents[0];

        try {
            if (parentSha === undefined) {
                const {content} = await api.noteVersion(this.noteId, sha);
                this.renderInitial(content, sha);
            } else {
                const {unified} = await api.noteDiff(this.noteId, parentSha, sha);
                this.renderDiff(unified, parentSha, sha);
            }
        } catch (error) {
            clear(this.diffHost);
            this.diffHost.appendChild(el('div', {class: 'history-error', text: String(error)}));
        }
    }

    private renderInitial(content: string, sha: string): void {
        clear(this.diffHost);
        this.diffHost.appendChild(
            el('div', {class: 'history-diff-head', text: `initial commit · ${shortSha(sha)}`})
        );
        const pre = el('pre', {class: 'history-diff-body initial'});

        for (const line of content.split('\n')) {
            pre.appendChild(this.diffLine('+', line));
        }

        this.diffHost.appendChild(pre);
    }

    private renderDiff(unified: string, from: string, to: string): void {
        clear(this.diffHost);
        this.diffHost.appendChild(
            el('div', {class: 'history-diff-head', text: `${shortSha(from)} → ${shortSha(to)}`})
        );

        if (unified.length === 0) {
            this.diffHost.appendChild(el('div', {class: 'history-empty', text: 'no changes'}));
            return;
        }

        const pre = el('pre', {class: 'history-diff-body'});
        const lines = unified.split('\n');

        for (const line of lines) {
            if (line.startsWith('--- ') || line.startsWith('+++ ')) {
                continue;
            }

            if (line.startsWith('@@')) {
                pre.appendChild(this.diffLine('@', line));
            } else if (line.startsWith('+')) {
                pre.appendChild(this.diffLine('+', line.slice(1)));
            } else if (line.startsWith('-')) {
                pre.appendChild(this.diffLine('-', line.slice(1)));
            } else {
                pre.appendChild(this.diffLine(' ', line.startsWith(' ') ? line.slice(1) : line));
            }
        }

        this.diffHost.appendChild(pre);
    }

    private diffLine(prefix: '+' | '-' | ' ' | '@', body: string): HTMLElement {
        const klass = prefix === '+' ? 'diff-add'
            : prefix === '-' ? 'diff-del'
            : prefix === '@' ? 'diff-hunk'
            : 'diff-eq';
        const line = el('span', {class: `diff-line ${klass}`});
        line.appendChild(el('span', {class: 'diff-prefix', text: prefix}));
        line.appendChild(el('span', {class: 'diff-body', text: body}));
        return line;
    }
}
