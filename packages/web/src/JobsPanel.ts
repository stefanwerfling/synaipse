import {
    jobsApi,
    type CrawlGiteaJobParams,
    type JobParams,
    type JobRecord,
    type JobType
} from './Api.js';
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
        title: 'Relink all notes',
        description: 'Add a "## Related" section with score + reason to any note that hasn\'t got one yet. Safe to run any time — already-linked notes are skipped.',
        defaults: {prefix: ''},
        showLlm: true
    },
    {
        type: 'compile',
        title: 'Compile crawler content',
        description: 'Run dev.to + GitHub-stars articles through the LLM and write structured summaries as sibling .compiled.md notes. Quota-heavy — uses your configured chat provider.',
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

        this.launcherHost.appendChild(this.renderGiteaLauncherCard());
    }

    private renderGiteaLauncherCard(): HTMLElement {
        const mkInput = (placeholder: string, type = 'text'): HTMLInputElement =>
            el('input', {class: 'job-input', attrs: {type, placeholder}}) as HTMLInputElement;

        const baseUrlInput = mkInput('https://gitea.example.com');
        const ownerInput = mkInput('owner-or-org');
        const repoInput = mkInput('repository');
        const projectInput = mkInput('memory project name');
        const tokenInput = mkInput('optional — required for private repos', 'password');

        const stateSelect = el('select', {class: 'job-input'},
            el('option', {attrs: {value: 'open'}, text: 'open'}),
            el('option', {attrs: {value: 'closed'}, text: 'closed'}),
            el('option', {attrs: {value: 'all'}, text: 'all'})
        ) as HTMLSelectElement;

        const startBtn = el('button', {
            class: 'btn btn-primary job-start-btn',
            attrs: {type: 'button'},
            text: 'Start'
        }) as HTMLButtonElement;

        startBtn.addEventListener('click', () => {
            const baseUrl = baseUrlInput.value.trim();
            const owner = ownerInput.value.trim();
            const repo = repoInput.value.trim();
            const project = projectInput.value.trim();
            const token = tokenInput.value.trim();
            const state = stateSelect.value as CrawlGiteaJobParams['state'];

            if (baseUrl === '' || owner === '' || repo === '' || project === '') {
                window.alert('Base URL, owner, repo and project are required.');
                return;
            }

            const params: CrawlGiteaJobParams = {baseUrl, owner, repo, project};
            if (token !== '') params.token = token;
            if (state !== undefined) params.state = state;

            void this.launch('crawl-gitea', params);
        });

        const optionsHost = el('div', {class: 'job-form', attrs: {hidden: 'true'}},
            el('label', {class: 'job-field'},
                el('span', {text: 'Base URL'}),
                baseUrlInput
            ),
            el('label', {class: 'job-field'},
                el('span', {text: 'Owner (user or org)'}),
                ownerInput
            ),
            el('label', {class: 'job-field'},
                el('span', {text: 'Repository'}),
                repoInput
            ),
            el('label', {class: 'job-field'},
                el('span', {text: 'Project (target folder + frontmatter.project)'}),
                projectInput
            ),
            el('label', {class: 'job-field'},
                el('span', {text: 'API token (optional)'}),
                tokenInput
            ),
            el('label', {class: 'job-field'},
                el('span', {text: 'Issue state'}),
                stateSelect
            )
        );

        const optionsToggle = el('button', {
            class: 'job-options-toggle',
            attrs: {type: 'button'},
            text: '⚙ Options'
        });

        optionsToggle.addEventListener('click', () => {
            const hidden = optionsHost.hasAttribute('hidden');
            if (hidden) optionsHost.removeAttribute('hidden');
            else optionsHost.setAttribute('hidden', 'true');
        });

        return el('div', {class: 'job-card'},
            el('div', {class: 'job-card-head'},
                el('h3', {text: 'Crawl Gitea issues'}),
                el('p', {
                    text: 'Pulls open (or closed / all) issues from a Gitea repository into '
                        + 'Crawler/Gitea/<project>/. Each note is written with mcp_consent: pending — '
                        + 'Claude has to wait for your approve/deny in the Consent Inbox before reading '
                        + 'the note over MCP. Todo lines land in synaipse_todos.'
                })
            ),
            el('div', {class: 'job-actions'}, optionsToggle, startBtn),
            optionsHost
        );
    }

    private renderLauncherCard(spec: LaunchSpec): HTMLElement {
        const prefixInput = el('input', {
            class: 'job-input',
            attrs: {type: 'text', placeholder: spec.defaults.prefix || 'leave empty for all notes'}
        }) as HTMLInputElement;
        prefixInput.value = spec.defaults.prefix;

        const limitInput = el('input', {
            class: 'job-input',
            attrs: {type: 'number', placeholder: 'no limit', min: '0'}
        }) as HTMLInputElement;

        const forceBox = el('input', {attrs: {type: 'checkbox'}}) as HTMLInputElement;
        const llmBox = el('input', {attrs: {type: 'checkbox'}}) as HTMLInputElement;

        const startBtn = el('button', {
            class: 'btn btn-primary job-start-btn',
            attrs: {type: 'button'},
            text: 'Start'
        }) as HTMLButtonElement;

        startBtn.addEventListener('click', () => {
            const prefix = prefixInput.value.trim();
            const limitRaw = limitInput.value.trim();
            const limit = limitRaw === '' ? undefined : Number.parseInt(limitRaw, 10);
            void this.launch(spec.type, {
                prefix,
                ...(forceBox.checked ? {force: true} : {}),
                ...(spec.showLlm && llmBox.checked ? {useLlm: true} : {}),
                ...(limit !== undefined && Number.isFinite(limit) && limit > 0 ? {limit} : {})
            });
        });

        const optionsHost = el('div', {class: 'job-form', attrs: {hidden: 'true'}},
            el('label', {class: 'job-field'},
                el('span', {text: 'Prefix (empty = all notes)'}),
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
        );

        const optionsToggle = el('button', {
            class: 'job-options-toggle',
            attrs: {type: 'button'},
            text: '⚙ Options'
        });

        optionsToggle.addEventListener('click', () => {
            const hidden = optionsHost.hasAttribute('hidden');
            if (hidden) optionsHost.removeAttribute('hidden');
            else optionsHost.setAttribute('hidden', 'true');
        });

        const card = el('div', {class: 'job-card'},
            el('div', {class: 'job-card-head'},
                el('h3', {text: spec.title}),
                el('p', {text: spec.description})
            ),
            el('div', {class: 'job-actions'}, optionsToggle, startBtn),
            optionsHost
        );

        return card;
    }

    private async launch(type: JobType, params: JobParams): Promise<void> {
        try {
            const job = await jobsApi.start(type, params);
            this.upsertJob(job);
            this.opts.onChange?.();
        } catch (cause) {
            window.alert(`Failed to start job: ${cause instanceof Error ? cause.message : String(cause)}`);
        }
    }

    private paramSummary(job: JobRecord): string {
        if (job.type === 'crawl-gitea') {
            const p = job.params as CrawlGiteaJobParams;
            return `${p.owner}/${p.repo} → ${p.project}`;
        }
        return (job.params as {prefix: string}).prefix;
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
                el('span', {class: 'job-record-prefix', text: this.paramSummary(job)}),
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
