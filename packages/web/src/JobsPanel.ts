import {
    jobsApi,
    schedulesApi,
    type CrawlGiteaJobParams,
    type JobParams,
    type JobRecord,
    type JobType,
    type Schedule
} from './Api.js';
import {clear, el} from './Dom.js';

/**
 * Three-section panel:
 *   1. Launcher — one card per job type; each launcher's "Schedule ⏰"
 *      button captures its current params + a name + cron string.
 *   2. Scheduled — persistent recurring jobs (created via #1) with
 *      Enable-toggle, Run-Now, Delete.
 *   3. Active & recent — live list of running/recent one-shot runs.
 *      Each running job gets its own SSE stream + in-place progress bar.
 */

const formatTime = (ts: number): string => {
    const now = Date.now();
    const diff = ts - now;
    const absDiff = Math.abs(diff);
    // Very close events read relative for a quick "6 min from now" scan;
    // farther-out events read as absolute wall time so DST + week-boundary
    // reasoning stays trivial.
    if (absDiff < 12 * 60 * 60 * 1000) {
        const minutes = Math.round(absDiff / 60_000);
        if (diff > 0) return minutes < 1 ? 'in <1 min' : `in ${minutes} min`;
        return minutes < 1 ? 'just now' : `${minutes} min ago`;
    }
    return new Date(ts).toLocaleString();
};

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
    private readonly scheduledHost: HTMLElement;
    private readonly listHost: HTMLElement;
    private readonly cards = new Map<string, JobCard>();
    private schedules: Schedule[] = [];
    private mounted = false;

    public constructor(private readonly opts: JobsPanelOptions = {}) {
        this.element = el('div', {class: 'jobs-panel'});

        this.launcherHost = el('div', {class: 'jobs-launcher'});
        this.scheduledHost = el('div', {class: 'jobs-scheduled'});
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
        this.element.appendChild(el('h3', {class: 'jobs-section-title', text: 'Scheduled'}));
        this.element.appendChild(this.scheduledHost);
        this.element.appendChild(el('h3', {class: 'jobs-section-title', text: 'Active & recent'}));
        this.element.appendChild(this.listHost);

        this.renderLaunchers();
        this.renderScheduled();
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

        const collectParams = (): CrawlGiteaJobParams | null => {
            const baseUrl = baseUrlInput.value.trim();
            const owner = ownerInput.value.trim();
            const repo = repoInput.value.trim();
            const project = projectInput.value.trim();
            const token = tokenInput.value.trim();
            const state = stateSelect.value as CrawlGiteaJobParams['state'];

            if (baseUrl === '' || owner === '' || repo === '' || project === '') {
                window.alert('Base URL, owner, repo and project are required.');
                return null;
            }

            const params: CrawlGiteaJobParams = {baseUrl, owner, repo, project};
            if (token !== '') params.token = token;
            if (state !== undefined) params.state = state;
            return params;
        };

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

        const actionsHost = el('div', {class: 'job-actions'});
        const scheduleForm = this.wireLauncherActions(actionsHost, optionsHost, 'crawl-gitea', collectParams);

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
            actionsHost,
            scheduleForm,
            optionsHost
        );
    }

    /**
     * Wire the shared launcher action bar: [⚙ Options] [Schedule ⏰] [Start].
     * "Options" toggles the form. "Start" runs the job once. "Schedule" opens
     * a small inline sub-form for name + cron, then creates a persistent
     * schedule via schedulesApi.
     *
     * Returns the inline schedule sub-form so the caller can place it in the
     * card DOM (typically between the action bar and the options form).
     */
    private wireLauncherActions(
        actionsHost: HTMLElement,
        optionsHost: HTMLElement,
        jobType: JobType,
        collectParams: () => JobParams | null
    ): HTMLElement {
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

        const scheduleBtn = el('button', {
            class: 'btn job-schedule-btn',
            attrs: {type: 'button'},
            text: 'Schedule ⏰'
        }) as HTMLButtonElement;

        const startBtn = el('button', {
            class: 'btn btn-primary job-start-btn',
            attrs: {type: 'button'},
            text: 'Start'
        }) as HTMLButtonElement;

        startBtn.addEventListener('click', () => {
            const params = collectParams();
            if (params === null) return;
            void this.launch(jobType, params);
        });

        // Inline schedule sub-form. Toggled by the Schedule button; the
        // Save button reads from these inputs and posts to schedulesApi.
        const nameInput = el('input', {
            class: 'job-input',
            attrs: {type: 'text', placeholder: 'e.g. "Nightly relink"'}
        }) as HTMLInputElement;

        const cronInput = el('input', {
            class: 'job-input',
            attrs: {type: 'text', placeholder: 'every 2h  |  daily 08:00'}
        }) as HTMLInputElement;

        const saveBtn = el('button', {
            class: 'btn btn-primary',
            attrs: {type: 'button'},
            text: 'Save'
        }) as HTMLButtonElement;

        const cancelBtn = el('button', {
            class: 'btn',
            attrs: {type: 'button'},
            text: 'Cancel'
        }) as HTMLButtonElement;

        const scheduleForm = el('div', {class: 'schedule-inline-form', attrs: {hidden: 'true'}},
            el('label', {class: 'job-field'},
                el('span', {text: 'Schedule name'}),
                nameInput
            ),
            el('label', {class: 'job-field'},
                el('span', {text: 'Cron'}),
                cronInput
            ),
            el('div', {class: 'schedule-inline-actions'}, cancelBtn, saveBtn)
        );

        scheduleBtn.addEventListener('click', () => {
            const wasHidden = scheduleForm.hasAttribute('hidden');
            if (wasHidden) {
                scheduleForm.removeAttribute('hidden');
                // Also open the params form so the user can review what they're
                // about to schedule with — silently scheduling with an empty
                // prefix is a footgun.
                optionsHost.removeAttribute('hidden');
                nameInput.focus();
            } else {
                scheduleForm.setAttribute('hidden', 'true');
            }
        });

        cancelBtn.addEventListener('click', () => {
            scheduleForm.setAttribute('hidden', 'true');
            nameInput.value = '';
            cronInput.value = '';
        });

        saveBtn.addEventListener('click', () => {
            const name = nameInput.value.trim();
            const cron = cronInput.value.trim();
            if (name === '' || cron === '') {
                window.alert('Schedule name and cron are required.');
                return;
            }
            const params = collectParams();
            if (params === null) return;
            void this.createSchedule(name, jobType, params, cron).then(() => {
                scheduleForm.setAttribute('hidden', 'true');
                nameInput.value = '';
                cronInput.value = '';
            });
        });

        actionsHost.appendChild(optionsToggle);
        actionsHost.appendChild(scheduleBtn);
        actionsHost.appendChild(startBtn);
        return scheduleForm;
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

        const collectParams = (): JobParams => {
            const prefix = prefixInput.value.trim();
            const limitRaw = limitInput.value.trim();
            const limit = limitRaw === '' ? undefined : Number.parseInt(limitRaw, 10);
            return {
                prefix,
                ...(forceBox.checked ? {force: true} : {}),
                ...(spec.showLlm && llmBox.checked ? {useLlm: true} : {}),
                ...(limit !== undefined && Number.isFinite(limit) && limit > 0 ? {limit} : {})
            };
        };

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

        const actionsHost = el('div', {class: 'job-actions'});
        const scheduleForm = this.wireLauncherActions(actionsHost, optionsHost, spec.type, collectParams);

        const card = el('div', {class: 'job-card'},
            el('div', {class: 'job-card-head'},
                el('h3', {text: spec.title}),
                el('p', {text: spec.description})
            ),
            actionsHost,
            scheduleForm,
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

    private async createSchedule(
        name: string,
        jobType: JobType,
        jobParams: JobParams,
        cron: string
    ): Promise<void> {
        try {
            await schedulesApi.create({name, jobType, jobParams, cron});
            await this.refreshSchedules();
        } catch (cause) {
            window.alert(`Failed to create schedule: ${cause instanceof Error ? cause.message : String(cause)}`);
        }
    }

    private async refreshSchedules(): Promise<void> {
        try {
            this.schedules = await schedulesApi.list();
            this.renderScheduled();
        } catch (cause) {
            console.error('schedules list failed', cause);
        }
    }

    private renderScheduled(): void {
        clear(this.scheduledHost);

        if (this.schedules.length === 0) {
            this.scheduledHost.appendChild(el('p', {
                class: 'jobs-scheduled-empty',
                text: 'No schedules yet. Fill out a launcher above, click "Schedule ⏰", '
                    + 'name it and give it a cron ("every 2h" or "daily 08:00").'
            }));
            return;
        }

        for (const s of this.schedules) {
            this.scheduledHost.appendChild(this.renderScheduleRow(s));
        }
    }

    private renderScheduleRow(s: Schedule): HTMLElement {
        const paramSummary = this.scheduleParamSummary(s);
        const nextText = s.nextRun !== undefined ? formatTime(s.nextRun) : '—';
        const lastText = s.lastRun !== undefined
            ? `${formatTime(s.lastRun)} (${s.lastResult ?? 'ok'})`
            : 'never';

        const enabledToggle = el('input', {attrs: {type: 'checkbox'}}) as HTMLInputElement;
        enabledToggle.checked = s.enabled;
        enabledToggle.addEventListener('change', () => {
            void schedulesApi.update(s.id, {enabled: enabledToggle.checked})
                .then(() => this.refreshSchedules())
                .catch((cause) => {
                    window.alert(`Failed to toggle schedule: ${String(cause)}`);
                    enabledToggle.checked = s.enabled;
                });
        });

        const runNowBtn = el('button', {
            class: 'btn schedule-run-now',
            attrs: {type: 'button', title: 'Trigger now (advances nextRun to this moment)'},
            text: 'Run now'
        });
        runNowBtn.addEventListener('click', () => {
            void schedulesApi.runNow(s.id)
                .then(() => this.refreshSchedules())
                .catch((cause) => window.alert(`Run-now failed: ${String(cause)}`));
        });

        const deleteBtn = el('button', {
            class: 'btn btn-danger schedule-delete',
            attrs: {type: 'button'},
            text: 'Delete'
        });
        deleteBtn.addEventListener('click', () => {
            if (!window.confirm(`Delete schedule "${s.name}"?`)) return;
            void schedulesApi.delete(s.id)
                .then(() => this.refreshSchedules())
                .catch((cause) => window.alert(`Delete failed: ${String(cause)}`));
        });

        return el('div', {class: `schedule-row${s.enabled ? '' : ' schedule-row-disabled'}`},
            el('div', {class: 'schedule-row-main'},
                el('div', {class: 'schedule-row-head'},
                    el('label', {class: 'schedule-enabled'}, enabledToggle, el('span', {text: ''})),
                    el('span', {class: 'schedule-name', text: s.name}),
                    el('span', {class: 'schedule-type', text: s.jobType}),
                    el('code', {class: 'schedule-cron', text: s.cron})
                ),
                el('div', {class: 'schedule-row-meta'},
                    el('span', {class: 'schedule-summary', text: paramSummary}),
                    el('span', {class: 'schedule-next', text: `next: ${nextText}`}),
                    el('span', {class: 'schedule-last', text: `last: ${lastText}`})
                )
            ),
            el('div', {class: 'schedule-row-actions'}, runNowBtn, deleteBtn)
        );
    }

    private scheduleParamSummary(s: Schedule): string {
        try {
            const params = JSON.parse(s.jobParams) as JobParams;
            if (s.jobType === 'crawl-gitea') {
                const p = params as CrawlGiteaJobParams;
                return `${p.owner}/${p.repo} → ${p.project}`;
            }
            const prefix = (params as {prefix?: string}).prefix ?? '';
            return prefix === '' ? '(all notes)' : prefix;
        } catch {
            return '(unparseable params)';
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

        await this.refreshSchedules();
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
