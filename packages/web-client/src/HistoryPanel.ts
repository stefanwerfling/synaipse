import {api, type HistoryEntry, type SnapshotEntry} from './Api.js';
import {clear, el} from './Dom.js';

export interface HistoryPanelCallbacks {
    onClose: () => void;
}

type DetailMode = 'diff' | 'snapshot';

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
    private detailHost: HTMLElement;
    private verifyHost: HTMLElement;
    private detailMode: DetailMode = 'diff';
    private snapshotPath = '';

    public constructor(private readonly cb: HistoryPanelCallbacks) {
        this.element = el('aside', {class: 'history-panel'});
        this.body = el('div', {class: 'history-list'});
        this.detailHost = el('div', {class: 'history-diff'});
        this.verifyHost = el('div', {class: 'history-verify'});

        const header = el('header', {class: 'history-head'},
            el('h3', {class: 'history-title', text: 'History'}),
            el('div', {class: 'history-head-actions'},
                el('button', {
                    class: 'history-verify-btn',
                    attrs: {type: 'button', title: 'Re-hash every stored object'},
                    text: 'Verify',
                    on: {click: () => void this.runVerify()}
                }),
                el('button', {
                    class: 'history-close',
                    attrs: {type: 'button', 'aria-label': 'close'},
                    on: {click: () => this.cb.onClose()},
                    text: '×'
                })
            )
        );

        this.element.appendChild(header);
        this.element.appendChild(this.verifyHost);
        this.element.appendChild(this.body);
        this.element.appendChild(this.detailHost);
    }

    public async load(noteId: string): Promise<void> {
        this.noteId = noteId;
        this.selectedSha = null;
        clear(this.body);
        clear(this.detailHost);
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

    private async runVerify(): Promise<void> {
        clear(this.verifyHost);
        this.verifyHost.appendChild(el('div', {class: 'history-loading', text: 'verifying…'}));

        try {
            const report = await api.verifyHistory();
            clear(this.verifyHost);

            if (!report.enabled) {
                this.verifyHost.appendChild(
                    el('div', {class: 'history-verify-row off', text: 'no commits yet — edit a note via Synaipse to start versioning'})
                );
                return;
            }

            const klass = report.ok ? 'history-verify-row ok' : 'history-verify-row bad';
            const dot = el('span', {class: 'verify-dot'});
            const label = report.ok
                ? `${report.checked} objects · all healthy`
                : `${report.corrupt.length} of ${report.checked} corrupt`;

            this.verifyHost.appendChild(
                el('div', {class: klass}, dot, el('span', {text: label}))
            );

            if (!report.ok) {
                const list = el('ul', {class: 'verify-corrupt-list'});
                for (const c of report.corrupt.slice(0, 5)) {
                    list.appendChild(el('li', {text: `${shortSha(c.sha)} · ${c.reason}`}));
                }
                this.verifyHost.appendChild(list);
            }
        } catch (error) {
            clear(this.verifyHost);
            this.verifyHost.appendChild(el('div', {class: 'history-error', text: String(error)}));
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
        this.detailMode = 'diff';
        this.snapshotPath = '';
        this.renderList();
        await this.renderDetail();
    }

    private async renderDetail(): Promise<void> {
        if (this.selectedSha === null || this.noteId === null) return;

        clear(this.detailHost);
        this.detailHost.appendChild(this.renderDetailHeader(this.selectedSha));

        if (this.detailMode === 'snapshot') {
            await this.renderSnapshotView(this.selectedSha);
            return;
        }

        await this.renderDiffView(this.selectedSha);
    }

    private renderDetailHeader(sha: string): HTMLElement {
        const tabBtn = (label: string, mode: DetailMode): HTMLElement => el('button', {
            class: this.detailMode === mode ? 'history-tab active' : 'history-tab',
            attrs: {type: 'button'},
            text: label,
            on: {click: () => {
                if (this.detailMode === mode) return;
                this.detailMode = mode;
                this.snapshotPath = '';
                void this.renderDetail();
            }}
        });

        return el('div', {class: 'history-detail-head'},
            el('span', {class: 'history-detail-sha', text: shortSha(sha)}),
            el('div', {class: 'history-detail-tabs'},
                tabBtn('Diff', 'diff'),
                tabBtn('Snapshot', 'snapshot')
            )
        );
    }

    private async renderDiffView(sha: string): Promise<void> {
        if (this.noteId === null) return;
        this.detailHost.appendChild(el('div', {class: 'history-loading', text: 'diffing…'}));

        const entry = this.entries.find((e) => e.sha === sha);
        const parentSha = entry?.parents[0];

        try {
            if (parentSha === undefined) {
                const {content} = await api.noteVersion(this.noteId, sha);
                this.removeLoading();
                this.appendInitial(content, sha);
            } else {
                const {unified} = await api.noteDiff(this.noteId, parentSha, sha);
                this.removeLoading();
                this.appendDiff(unified, parentSha, sha);
            }
        } catch (error) {
            this.removeLoading();
            this.detailHost.appendChild(el('div', {class: 'history-error', text: String(error)}));
        }
    }

    private async renderSnapshotView(sha: string): Promise<void> {
        this.detailHost.appendChild(el('div', {class: 'history-loading', text: 'loading…'}));

        try {
            const data = await api.snapshotList(sha, this.snapshotPath.length > 0 ? this.snapshotPath : undefined);
            this.removeLoading();
            this.appendSnapshot(data.entries);
        } catch (error) {
            this.removeLoading();
            this.detailHost.appendChild(el('div', {class: 'history-error', text: String(error)}));
        }
    }

    private appendSnapshot(entries: SnapshotEntry[]): void {
        const crumbs = el('div', {class: 'snapshot-crumbs'},
            el('button', {
                class: 'snapshot-crumb',
                attrs: {type: 'button'},
                text: '/',
                on: {click: () => {
                    this.snapshotPath = '';
                    void this.renderDetail();
                }}
            })
        );

        if (this.snapshotPath.length > 0) {
            const parts = this.snapshotPath.split('/').filter((p) => p.length > 0);
            let acc = '';
            for (const part of parts) {
                acc = acc.length === 0 ? part : `${acc}/${part}`;
                const target = acc;
                crumbs.appendChild(
                    el('button', {
                        class: 'snapshot-crumb',
                        attrs: {type: 'button'},
                        text: part,
                        on: {click: () => {
                            this.snapshotPath = target;
                            void this.renderDetail();
                        }}
                    })
                );
            }
        }

        this.detailHost.appendChild(crumbs);

        if (entries.length === 0) {
            this.detailHost.appendChild(el('div', {class: 'history-empty', text: 'empty tree'}));
            return;
        }

        const list = el('ul', {class: 'snapshot-list'});
        const sorted = [...entries].sort((a, b) => {
            if (a.type !== b.type) {
                return a.type === 'dir' ? -1 : 1;
            }
            return a.name.localeCompare(b.name);
        });

        for (const entry of sorted) {
            const isDir = entry.type === 'dir';
            const next = this.snapshotPath.length === 0 ? entry.name : `${this.snapshotPath}/${entry.name}`;

            list.appendChild(
                el('li', {class: isDir ? 'snapshot-row dir' : 'snapshot-row file'},
                    el('button', {
                        class: 'snapshot-link',
                        attrs: {type: 'button', disabled: isDir ? undefined : 'true' as never},
                        text: isDir ? `${entry.name}/` : entry.name,
                        ...(isDir ? {on: {click: () => {
                            this.snapshotPath = next;
                            void this.renderDetail();
                        }}} : {})
                    }),
                    el('span', {class: 'snapshot-sha', text: shortSha(entry.sha)})
                )
            );
        }

        this.detailHost.appendChild(list);
    }

    private appendInitial(content: string, sha: string): void {
        this.detailHost.appendChild(
            el('div', {class: 'history-diff-head', text: `initial commit · ${shortSha(sha)}`})
        );
        const pre = el('pre', {class: 'history-diff-body initial'});

        for (const line of content.split('\n')) {
            pre.appendChild(this.diffLine('+', line));
        }

        this.detailHost.appendChild(pre);
    }

    private appendDiff(unified: string, from: string, to: string): void {
        this.detailHost.appendChild(
            el('div', {class: 'history-diff-head', text: `${shortSha(from)} → ${shortSha(to)}`})
        );

        if (unified.length === 0) {
            this.detailHost.appendChild(el('div', {class: 'history-empty', text: 'no changes'}));
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

        this.detailHost.appendChild(pre);
    }

    private removeLoading(): void {
        const loading = this.detailHost.querySelector('.history-loading');
        if (loading) loading.remove();
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