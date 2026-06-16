import {jobsApi, type JobRecord, type JobType} from './Api.js';
import {clear, el} from './Dom.js';

/**
 * Two-section panel: the top half is a launcher with one card per job type,
 * the bottom half is a live list of running/recent jobs. Each running job
 * gets its own SSE connection and a progress bar that updates in place.
 */

export interface JobsPanelOptions {
    onChange?: () => void;
}

interface LaunchSpec {
    type: JobType;
    title: string;
    description: string;
    /** Suggested defaults shown in the form. */
    defaults: {prefix: string; force?: boolean; useLlm?: boolean; limit?: number};
    /** Show the "use LLM" checkbox (only meaningful for relink). */
    showLlm: boolean;
}

const LAUNCHERS: readonly LaunchSpec[] = [
    {
        type: 'relink',
        title: 'Relink',
        description: 'Find related notes via hybrid search and write a "## Related" section with score + reason.',
        defaults: {prefix: 'Crawler/'},
        showLlm: true
    },
    {
        type: 'compile',
        title: 'Compile',
        description: 'Extract summary, key concepts and entities from a note into a sibling .compiled.md.',
        defaults: {prefix: 'Crawler/'},
        showLlm: false
    }
];

interface JobCard {
    job: JobRecord;
    element: HTMLElement;
    bar: HTMLElement;
    label: HTMLElement;
    currentLabel: HTMLElement;
    logHost: HTMLElement;
    stopBtn: HTMLButtonElement;
    closeStream: (() => void) | null;
}

export class JobsPanel {
    public readonly element: HTMLElement;
    private readonly launcherHost: HTMLElement;
    private readonly listHost: HTMLElement;
    private readonly cards = new Map<string, JobCard>();
    private mounted = false;

    public constructor(private readonly opts: JobsPanelOptions = {}) {
        this.element = el('div', {class: 'jobs-panel'});

        this.launcherHost = el('div', {class: 'jobs-launcher'});
        this.listHost = el('div', {class: 'jobs-list'});

        this.element.appendChild(el('div', {class: 'jobs-head'},
            el('h2', {text: 'Jobs'}),
            el('button', {
                class: 'btn jobs-refresh',
                attrs: {type: 'button'},
                text: 'Refresh',
                on: {click: () => void this.refresh()}
            })
        ));

        this.element.appendChild(this.launcherHost);
        this.element.appendChild(el('h3', {class: 'jobs-section-title', text: 'Active & recent'}));
        this.element.appendChild(this.listHost);

        this.renderLaunchers();
    }

    public async onShow(): Promise<void> {
        if (!this.mounted) {
            await this.refresh();
            this.mounted = true;
        }
    }

    public destroy(): void {
        for (const card of this.cards.values()) {
            card.closeStream?.();
        }
        this.cards.clear();
    }

    private renderLaunchers(): void {
        clear(this.launcherHost);

        for (const spec of LAUNCHERS) {
            this.launcherHost.appendChild(this.renderLauncherCard(spec));
        }
    }

    private renderLauncherCard(spec: LaunchSpec): HTMLElement {
        const prefixInput = el('input', {
            class: 'job-input',
            attrs: {type: 'text', placeholder: spec.defaults.prefix}
        }) as HTMLInputElement;
        prefixInput.value = spec.defaults.prefix;

        const limitInput = el('input', {
            class: 'job-input',
            attrs: {type: 'number', placeholder: 'no limit', min: '0'}
        }) as HTMLInputElement;

        const forceBox = el('input', {attrs: {type: 'checkbox'}}) as HTMLInputElement;
        const llmBox = el('input', {attrs: {type: 'checkbox'}}) as HTMLInputElement;

        const startBtn = el('button', {
            class: 'btn btn-primary',
            attrs: {type: 'button'},
            text: `Start ${spec.title}`
        }) as HTMLButtonElement;

        startBtn.addEventListener('click', () => {
            const prefix = prefixInput.value.trim() || spec.defaults.prefix;
            const limitRaw = limitInput.value.trim();
            const limit = limitRaw === '' ? undefined : Number.parseInt(limitRaw, 10);
            void this.launch(spec.type, {
                prefix,
                ...(forceBox.checked ? {force: true} : {}),
                ...(spec.showLlm && llmBox.checked ? {useLlm: true} : {}),
                ...(limit !== undefined && Number.isFinite(limit) && limit > 0 ? {limit} : {})
            });
        });

        const card = el('div', {class: 'job-card'},
            el('div', {class: 'job-card-head'},
                el('h3', {text: spec.title}),
                el('p', {text: spec.description})
            ),
            el('div', {class: 'job-form'},
                el('label', {class: 'job-field'},
                    el('span', {text: 'Prefix'}),
                    prefixInput
                ),
                el('label', {class: 'job-field'},
                    el('span', {text: 'Limit'}),
                    limitInput
                ),
                el('label', {class: 'job-checkbox'}, forceBox, el('span', {text: 'force (rebuild even if already done)'})),
                ...(spec.showLlm
                    ? [el('label', {class: 'job-checkbox'}, llmBox, el('span', {text: 'use LLM (smarter filter, costs quota)'}))]
                    : [])
            ),
            el('div', {class: 'job-actions'}, startBtn)
        );

        return card;
    }

    private async launch(type: JobType, params: JobRecord['params']): Promise<void> {
        try {
            const job = await jobsApi.start(type, params);
            this.upsertJob(job);
            this.opts.onChange?.();
        } catch (cause) {
            window.alert(`Failed to start job: ${cause instanceof Error ? cause.message : String(cause)}`);
        }
    }

    private async refresh(): Promise<void> {
        try {
            const list = await jobsApi.list();

            for (const job of list) {
                this.upsertJob(job);
            }
        } catch (cause) {
            console.error('jobs list failed', cause);
        }
    }

    private upsertJob(job: JobRecord): void {
        const existing = this.cards.get(job.id);

        if (existing !== undefined) {
            existing.job = job;
            this.renderJobCard(existing);
            return;
        }

        const card = this.buildJobCard(job);
        this.cards.set(job.id, card);
        this.listHost.prepend(card.element);
        this.renderJobCard(card);

        if (job.status === 'running') {
            this.attachStream(card);
        }
    }

    private buildJobCard(job: JobRecord): JobCard {
        const label = el('div', {class: 'job-progress-label'});
        const bar = el('div', {class: 'job-progress-fill'});
        const currentLabel = el('div', {class: 'job-current'});
        const logHost = el('div', {class: 'job-log'});

        const stopBtn = el('button', {
            class: 'btn btn-danger',
            attrs: {type: 'button'},
            text: 'Stop'
        }) as HTMLButtonElement;

        stopBtn.addEventListener('click', () => {
            void jobsApi.stop(job.id);
            stopBtn.disabled = true;
        });

        const element = el('div', {class: 'job-record'},
            el('div', {class: 'job-record-head'},
                el('span', {class: 'job-record-type', text: job.type}),
                el('span', {class: 'job-record-prefix', text: job.params.prefix}),
                el('span', {class: `job-record-status status-${job.status}`, text: job.status}),
                stopBtn
            ),
            el('div', {class: 'job-progress'}, bar),
            label,
            currentLabel,
            logHost
        );

        return {job, element, bar, label, currentLabel, logHost, stopBtn, closeStream: null};
    }

    private renderJobCard(card: JobCard): void {
        const {job} = card;
        const total = Math.max(job.progress.total, 1);
        const pct = Math.min(100, (job.progress.done / total) * 100);
        card.bar.style.width = `${pct}%`;
        card.bar.classList.toggle('failed', job.status === 'failed');
        card.bar.classList.toggle('stopped', job.status === 'stopped');
        card.bar.classList.toggle('done', job.status === 'done');

        const statusSpan = card.element.querySelector('.job-record-status');
        if (statusSpan !== null) {
            statusSpan.className = `job-record-status status-${job.status}`;
            statusSpan.textContent = job.status;
        }

        const labelText = job.progress.failed > 0
            ? `${job.progress.done}/${job.progress.total} · ${job.progress.failed} failed`
            : `${job.progress.done}/${job.progress.total}`;
        card.label.textContent = labelText;
        card.currentLabel.textContent = job.progress.current ?? '';

        card.stopBtn.hidden = job.status !== 'running';

        if (job.status !== 'running' && job.summary !== undefined) {
            card.currentLabel.textContent = `✓ ${job.summary}`;
        }

        if (job.status === 'failed' && job.error !== undefined) {
            card.currentLabel.textContent = `✗ ${job.error}`;
        }

        clear(card.logHost);
        const recent = job.logs.slice(-10);
        for (const line of recent) {
            card.logHost.appendChild(el('div', {class: 'job-log-line', text: line}));
        }
    }

    private attachStream(card: JobCard): void {
        card.closeStream = jobsApi.stream(card.job.id, (event) => {
            if (event.kind === 'snapshot') {
                card.job = event.job;
            } else if (event.kind === 'progress') {
                card.job.progress = {
                    done: event.done,
                    total: event.total,
                    failed: event.failed,
                    ...(event.current !== undefined ? {current: event.current} : {})
                };
            } else if (event.kind === 'log') {
                card.job.logs.push(event.message);
                if (card.job.logs.length > 50) card.job.logs.shift();
            } else if (event.kind === 'done') {
                card.job.status = 'done';
                card.job.summary = event.summary;
                card.job.finishedAt = Date.now();
            } else if (event.kind === 'failed') {
                card.job.status = 'failed';
                card.job.error = event.error;
                card.job.finishedAt = Date.now();
            } else if (event.kind === 'stopped') {
                card.job.status = 'stopped';
                card.job.finishedAt = Date.now();
            }

            this.renderJobCard(card);
        });
    }
}
