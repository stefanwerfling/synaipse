import {activityApi, type ActivityBucket, type ActivityCommit, type ActivityCount, type ActivityReport} from './Api.js';
import {clear, el} from './Dom.js';
import {defineMessages, tc} from './I18n.js';

/** The server's bucket for commits without a project (Activity.ts). */
const NO_PROJECT = '<no project>';

const t = defineMessages('activityPanel', {
    noProject: 'no project',
    range24h: '24h',
    range7d: '7d',
    range30d: '30d',
    range90d: '90d',
    justNow: 'just now',
    minutesAgo: '{count}m ago',
    hoursAgo: '{count}h ago',
    daysAgo: '{count}d ago',
    title: 'Activity',
    failed: 'failed: {error}',
    emptyTitle: 'No activity in this window',
    emptyHint: 'Try a longer range. Activity only shows up after Synaipse-driven writes; manual edits via Obsidian appear here too once the watcher picks them up.',
    statCommits: 'Commits',
    statNotes: 'Notes touched',
    statTools: 'Tools used',
    statProjects: 'Projects',
    tools: 'Tools',
    projects: 'Projects',
    perDay: 'Commits per day',
    noData: 'no data',
    barTitle: '{date}: {commits}, {notes}',
    commits: '{count} commit|{count} commits',
    notes: '{count} note|{count} notes',
    hotNotes: 'Hot notes',
    noNotes: 'no notes touched',
    recent: 'Recent commits',
    loadOlder: 'Load older'
});

/**
 * Activity dashboard — reads from the ngit log, aggregates per-day commit
 * activity, hot notes, tool/project histograms. Pure SVG charts so we don't
 * pull in a charting library for a single view.
 */

export interface ActivityPanelOptions {
    onOpenNote: (noteId: string) => void;
}

/** Commits per "Ältere laden" click. */
const MORE_PAGE = 50;

const RANGES: ReadonlyArray<{label: 'range24h' | 'range7d' | 'range30d' | 'range90d'; days: number}> = [
    {label: 'range24h', days: 1},
    {label: 'range7d', days: 7},
    {label: 'range30d', days: 30},
    {label: 'range90d', days: 90}
];

const TOOL_COLORS: Record<string, string> = {
    write_note: '#6c9aff',
    relink: '#34d399',
    compile: '#fbbf24',
    import_chatgpt: '#a78bfa',
    clip: '#22d3ee',
    log_session: '#f472b6',
    delete_note: '#f87171'
};

const colorForTool = (tool: string): string => TOOL_COLORS[tool] ?? '#8c93a4';

const formatRelative = (ts: number): string => {
    const now = Date.now();
    const diff = now - ts;

    if (diff < 60_000) return t('justNow');
    if (diff < 3_600_000) return t('minutesAgo', {count: Math.floor(diff / 60_000)});
    if (diff < 86_400_000) return t('hoursAgo', {count: Math.floor(diff / 3_600_000)});
    if (diff < 604_800_000) return t('daysAgo', {count: Math.floor(diff / 86_400_000)});
    return new Date(ts).toISOString().slice(0, 10);
};

export class ActivityPanel {
    public readonly element: HTMLElement;
    private rangeDays = 7;
    private bodyHost!: HTMLElement;
    private rangeHost!: HTMLElement;
    private statsHost!: HTMLElement;

    public constructor(private readonly opts: ActivityPanelOptions) {
        this.element = el('div', {class: 'activity-panel'});
        this.build();
    }

    public async onShow(): Promise<void> {
        await this.refresh();
    }

    private build(): void {
        this.rangeHost = el('div', {class: 'activity-ranges'});
        this.renderRanges();

        this.statsHost = el('div', {class: 'activity-stats'});
        this.bodyHost = el('div', {class: 'activity-body'});

        const head = el('div', {class: 'activity-head'},
            el('h2', {text: t('title')}),
            el('button', {
                class: 'btn',
                attrs: {type: 'button'},
                text: tc('refresh'),
                on: {click: () => void this.refresh()}
            })
        );

        this.element.appendChild(head);
        this.element.appendChild(this.rangeHost);
        this.element.appendChild(this.statsHost);
        this.element.appendChild(this.bodyHost);
    }

    private renderRanges(): void {
        clear(this.rangeHost);

        for (const r of RANGES) {
            const btn = el('button', {
                class: r.days === this.rangeDays ? 'range-btn active' : 'range-btn',
                attrs: {type: 'button'},
                text: t(r.label),
                on: {click: () => {
                    this.rangeDays = r.days;
                    this.renderRanges();
                    void this.refresh();
                }}
            });
            this.rangeHost.appendChild(btn);
        }
    }

    private async refresh(): Promise<void> {
        clear(this.bodyHost);
        clear(this.statsHost);
        this.bodyHost.appendChild(el('div', {class: 'activity-loading', text: tc('loading')}));

        try {
            const report = await activityApi.get(this.rangeDays);
            this.render(report);
        } catch (cause) {
            clear(this.bodyHost);
            this.bodyHost.appendChild(el('div', {class: 'activity-error', text: t('failed', {error: String(cause)})}));
        }
    }

    private render(report: ActivityReport): void {
        clear(this.statsHost);
        clear(this.bodyHost);

        if (report.total === 0) {
            this.bodyHost.appendChild(el('div', {class: 'activity-empty'},
                el('h3', {text: t('emptyTitle')}),
                el('p', {text: t('emptyHint')})
            ));
            return;
        }

        const totalNotes = new Set(report.commits.filter((c) => c.noteId !== null).map((c) => c.noteId)).size;
        this.statsHost.appendChild(this.statTile(t('statCommits'), String(report.total)));
        this.statsHost.appendChild(this.statTile(t('statNotes'), String(totalNotes)));
        this.statsHost.appendChild(this.statTile(t('statTools'), String(report.byTool.length)));
        this.statsHost.appendChild(this.statTile(t('statProjects'), String(report.byProject.length)));

        this.bodyHost.appendChild(this.renderTimeline(report.timeline));

        const grid = el('div', {class: 'activity-grid'});
        grid.appendChild(this.renderHotNotes(report.hotNotes));
        grid.appendChild(this.renderHistogram(t('tools'), report.byTool, (k) => colorForTool(k)));
        grid.appendChild(this.renderHistogram(t('projects'), report.byProject, () => 'var(--accent)'));
        this.bodyHost.appendChild(grid);

        this.bodyHost.appendChild(this.renderRecent(report.commits.slice(0, 30)));
    }

    private statTile(label: string, value: string): HTMLElement {
        return el('div', {class: 'activity-stat-tile'},
            el('div', {class: 'activity-stat-value', text: value}),
            el('div', {class: 'activity-stat-label', text: label})
        );
    }

    private renderTimeline(buckets: ActivityBucket[]): HTMLElement {
        const section = el('section', {class: 'activity-section'});
        section.appendChild(el('h3', {class: 'activity-section-title', text: t('perDay')}));

        const chartHost = el('div', {class: 'activity-chart'});

        if (buckets.length === 0) {
            chartHost.appendChild(el('div', {class: 'activity-empty', text: t('noData')}));
            section.appendChild(chartHost);
            return section;
        }

        const max = Math.max(1, ...buckets.map((b) => b.commits));
        const width = Math.max(buckets.length * 18, 600);
        const height = 180;
        const padding = 24;

        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
        svg.setAttribute('preserveAspectRatio', 'none');
        svg.setAttribute('class', 'activity-svg');

        const barWidth = Math.max(8, (width - padding * 2) / buckets.length - 2);

        buckets.forEach((b, i) => {
            const h = ((height - padding * 2) * b.commits) / max;
            const x = padding + i * ((width - padding * 2) / buckets.length);
            const y = height - padding - h;

            const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
            rect.setAttribute('x', String(x));
            rect.setAttribute('y', String(y));
            rect.setAttribute('width', String(barWidth));
            rect.setAttribute('height', String(h));
            rect.setAttribute('fill', 'var(--accent)');
            rect.setAttribute('rx', '2');

            const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
            title.textContent = t('barTitle', {date: b.date, commits: t('commits', {count: b.commits}), notes: t('notes', {count: b.notes})});
            rect.appendChild(title);

            svg.appendChild(rect);
        });

        chartHost.appendChild(svg);
        section.appendChild(chartHost);

        const labels = el('div', {class: 'activity-chart-labels'});
        const firstDate = buckets[0]?.date ?? '';
        const lastDate = buckets[buckets.length - 1]?.date ?? '';
        labels.appendChild(el('span', {text: firstDate}));
        labels.appendChild(el('span', {text: lastDate}));
        section.appendChild(labels);

        return section;
    }

    private renderHotNotes(notes: Array<{noteId: string; edits: number}>): HTMLElement {
        const section = el('section', {class: 'activity-section'});
        section.appendChild(el('h3', {class: 'activity-section-title', text: t('hotNotes')}));

        if (notes.length === 0) {
            section.appendChild(el('div', {class: 'activity-empty', text: t('noNotes')}));
            return section;
        }

        const max = Math.max(1, ...notes.map((n) => n.edits));
        const list = el('ul', {class: 'activity-list'});

        for (const n of notes) {
            const pct = (n.edits / max) * 100;
            const row = el('li', {class: 'activity-bar-row', attrs: {role: 'button', tabindex: '0'}},
                el('div', {class: 'activity-bar-bg'},
                    el('div', {class: 'activity-bar-fill', style: {width: `${pct}%`}})
                ),
                el('div', {class: 'activity-bar-content'},
                    el('span', {class: 'activity-bar-label', text: n.noteId}),
                    el('span', {class: 'activity-bar-value', text: String(n.edits)})
                )
            );
            row.addEventListener('click', () => this.opts.onOpenNote(n.noteId));
            list.appendChild(row);
        }

        section.appendChild(list);
        return section;
    }

    private renderHistogram(title: string, counts: ActivityCount[], color: (key: string) => string): HTMLElement {
        const section = el('section', {class: 'activity-section'});
        section.appendChild(el('h3', {class: 'activity-section-title', text: title}));

        if (counts.length === 0) {
            section.appendChild(el('div', {class: 'activity-empty', text: t('noData')}));
            return section;
        }

        const max = Math.max(1, ...counts.map((c) => c.count));
        const list = el('ul', {class: 'activity-list'});

        for (const c of counts) {
            const pct = (c.count / max) * 100;
            list.appendChild(el('li', {class: 'activity-bar-row'},
                el('div', {class: 'activity-bar-bg'},
                    el('div', {class: 'activity-bar-fill', style: {width: `${pct}%`, background: color(c.key)}})
                ),
                el('div', {class: 'activity-bar-content'},
                    el('span', {class: 'activity-bar-label', text: c.key === NO_PROJECT ? t('noProject') : c.key}),
                    el('span', {class: 'activity-bar-value', text: String(c.count)})
                )
            ));
        }

        section.appendChild(list);
        return section;
    }

    private renderRecent(commits: ActivityCommit[]): HTMLElement {
        const section = el('section', {class: 'activity-section'});
        section.appendChild(el('h3', {class: 'activity-section-title', text: t('recent')}));

        const list = el('ul', {class: 'activity-commits'});

        const shown = new Set<string>();
        const appendRows = (batch: readonly ActivityCommit[]): void => {
            for (const c of batch) {
                if (shown.has(c.sha)) continue;
                shown.add(c.sha);
                list.appendChild(this.renderCommitRow(c));
            }
        };
        appendRows(commits);
        section.appendChild(list);

        // Older commits page through /api/activity/commits. The first page
        // starts at HEAD, so rows already shown from the report are skipped.
        let cursor: string | undefined;
        const more = el('button', {
            class: 'btn activity-more',
            attrs: {type: 'button'},
            text: t('loadOlder'),
            on: {
                click: () => {
                    more.setAttribute('disabled', '');
                    void activityApi.commits(MORE_PAGE, cursor).then((page) => {
                        appendRows(page.commits);
                        cursor = page.nextCursor ?? undefined;
                        if (page.nextCursor === null) more.remove();
                    }).catch((cause: unknown) => {
                        more.textContent = t('failed', {error: String(cause)});
                    }).finally(() => more.removeAttribute('disabled'));
                }
            }
        });
        section.appendChild(more);
        return section;
    }

    private renderCommitRow(c: ActivityCommit): HTMLElement {
        const row = el('li', {class: 'activity-commit-row'},
            el('span', {
                class: 'activity-commit-tool',
                style: {background: colorForTool(c.tool)},
                text: c.tool
            }),
            el('span', {
                class: 'activity-commit-note',
                text: c.noteId ?? c.subject,
                attrs: c.noteId !== null ? {role: 'button', tabindex: '0'} : {}
            }),
            el('span', {class: 'activity-commit-meta', text: `${formatRelative(c.ts)} · ${c.author}${c.project !== null ? ` · ${c.project}` : ''}`})
        );

        if (c.noteId !== null) {
            const noteEl = row.querySelector('.activity-commit-note');
            noteEl?.addEventListener('click', () => this.opts.onOpenNote(c.noteId as string));
        }

        return row;
    }
}