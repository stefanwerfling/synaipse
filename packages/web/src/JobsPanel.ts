import {
    jobsApi,
    schedulesApi,
    type JobParams,
    type JobRecord,
    type JobType,
    type Schedule
} from './Api.js';
import {clear, el} from './Dom.js';

/**
 * Jobs tab, redesigned around persistent jobs:
 *
 *   ┌─ "＋ New job" ─────────────────────────────┐
 *   │  opens a provider-picker + settings MODAL  │
 *   └────────────────────────────────────────────┘
 *   ┌─ Job list ─────────────────────────────────┐
 *   │  one row per persistent job (= a Schedule)  │
 *   │  cron or "manual", enable, run-now, edit,   │
 *   │  delete — plus inline live progress when a  │
 *   │  linked run is active (matched by scheduleId)│
 *   └────────────────────────────────────────────┘
 *
 * A "job" is a stored Schedule. A blank cron makes it MANUAL — it never
 * auto-fires, only "Run now" triggers it. The in-memory JobManager still
 * does the actual execution; we surface a running execution on its row via
 * the JobRecord.scheduleId back-reference.
 */

type FieldType = 'text' | 'number' | 'password' | 'checkbox' | 'select';

interface FieldSpec {
    key: string;
    label: string;
    type: FieldType;
    placeholder?: string;
    options?: readonly string[];
    required?: boolean;
    defaultValue?: string | number | boolean;
    /** Small helper note under the field (e.g. "falls back to env"). */
    hint?: string;
}

interface ProviderSpec {
    type: JobType;
    label: string;
    description: string;
    fields: readonly FieldSpec[];
}

const PROVIDERS: readonly ProviderSpec[] = [
    {
        type: 'relink',
        label: 'Relink notes',
        description: 'Add a "## Related" section to notes that lack one.',
        fields: [
            {key: 'prefix', label: 'Prefix (empty = all notes)', type: 'text', placeholder: 'leave empty for all notes'},
            {key: 'limit', label: 'Limit', type: 'number', placeholder: 'no limit'},
            {key: 'force', label: 'force (rebuild even if already linked)', type: 'checkbox'},
            {key: 'useLlm', label: 'use LLM (smarter filter, costs quota)', type: 'checkbox'}
        ]
    },
    {
        type: 'compile',
        label: 'Compile crawler content',
        description: 'Run crawled articles through the LLM into .compiled.md summaries.',
        fields: [
            {key: 'prefix', label: 'Prefix', type: 'text', placeholder: 'Crawler/', defaultValue: 'Crawler/'},
            {key: 'limit', label: 'Limit', type: 'number', placeholder: 'no limit'},
            {key: 'force', label: 'force (rebuild unchanged)', type: 'checkbox'}
        ]
    },
    {
        type: 'crawl-gitea',
        label: 'Crawl Gitea issues',
        description: 'Import issues from a Gitea repo (with consent-pending frontmatter).',
        fields: [
            {key: 'baseUrl', label: 'Base URL', type: 'text', placeholder: 'https://gitea.example.com', required: true},
            {key: 'owner', label: 'Owner (user or org)', type: 'text', placeholder: 'owner-or-org', required: true},
            {key: 'repo', label: 'Repository', type: 'text', placeholder: 'repository', required: true},
            {key: 'project', label: 'Project (target folder + frontmatter.project)', type: 'text', placeholder: 'memory project name', required: true},
            {key: 'token', label: 'API token (optional, for private repos)', type: 'password', placeholder: 'optional'},
            {key: 'state', label: 'Issue state', type: 'select', options: ['open', 'closed', 'all'], defaultValue: 'open'}
        ]
    },
    {
        type: 'crawl-github-stars',
        label: 'Crawl GitHub stars',
        description: 'Import your starred repositories with their READMEs.',
        fields: [
            {key: 'username', label: 'Username (empty = token owner)', type: 'text', placeholder: 'octocat'},
            {key: 'readmeMax', label: 'Max README chars', type: 'number', placeholder: '3000'},
            {key: 'pathPrefix', label: 'Target folder', type: 'text', placeholder: 'Crawler/github/starred', hint: 'Token is read from the server’s GITHUB_TOKEN.'}
        ]
    },
    {
        type: 'crawl-devto',
        label: 'Crawl dev.to',
        description: 'Import the latest dev.to articles.',
        fields: [
            {key: 'perPage', label: 'Articles per page', type: 'number', placeholder: '100'},
            {key: 'bodyMax', label: 'Max body chars (0 = skip full fetch)', type: 'number', placeholder: '3000'},
            {key: 'pathPrefix', label: 'Target folder', type: 'text', placeholder: 'Crawler/devto/articles'},
            {key: 'downloadImages', label: 'download inline images', type: 'checkbox', defaultValue: true, hint: 'API key is read from the server’s DEVTO_API_KEY.'}
        ]
    },
    {
        type: 'crawl-code',
        label: 'Crawl code repository',
        description: 'Walk a repository on the server host into per-file notes.',
        fields: [
            {key: 'repoPath', label: 'Repo path (on the server)', type: 'text', placeholder: '/abs/path/to/repo', required: true},
            {key: 'repoName', label: 'Repo name (defaults to folder name)', type: 'text', placeholder: 'my-repo'},
            {key: 'withSource', label: 'include full source in each note', type: 'checkbox'}
        ]
    }
];

const providerByType = new Map(PROVIDERS.map((p) => [p.type, p]));

const formatTime = (ts: number): string => {
    const now = Date.now();
    const diff = ts - now;
    const absDiff = Math.abs(diff);
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

interface RowRefs {
    scheduleId: string;
    progressWrap: HTMLElement;
    bar: HTMLElement;
    progressLabel: HTMLElement;
    currentLabel: HTMLElement;
}

export class JobsPanel {
    public readonly element: HTMLElement;
    private readonly listHost: HTMLElement;
    private schedules: Schedule[] = [];
    private jobs: JobRecord[] = [];
    private mounted = false;
    private modal: HTMLElement | null = null;
    /** Live SSE streams keyed by the running job id, so we can close them. */
    private readonly streams = new Map<string, () => void>();
    private readonly rows = new Map<string, RowRefs>();

    public constructor(private readonly opts: JobsPanelOptions = {}) {
        this.element = el('div', {class: 'jobs-panel'});

        this.listHost = el('div', {class: 'jobs-list'});

        this.element.appendChild(el('div', {class: 'jobs-head'},
            el('h2', {text: 'Jobs'}),
            el('div', {class: 'jobs-head-actions'},
                el('button', {
                    class: 'btn jobs-refresh',
                    attrs: {type: 'button'},
                    text: 'Refresh',
                    on: {click: () => void this.refresh()}
                }),
                el('button', {
                    class: 'btn btn-primary jobs-new-btn',
                    attrs: {type: 'button'},
                    text: '＋ New job',
                    on: {click: () => this.openModal('create')}
                })
            )
        ));

        this.element.appendChild(this.listHost);
        this.renderList();
    }

    public async onShow(): Promise<void> {
        if (!this.mounted) {
            await this.refresh();
            this.mounted = true;
        }
    }

    public destroy(): void {
        this.closeAllStreams();
        this.closeModal();
    }

    // ── data ────────────────────────────────────────────────────────────

    private async refresh(): Promise<void> {
        try {
            [this.schedules, this.jobs] = await Promise.all([
                schedulesApi.list(),
                jobsApi.list()
            ]);
        } catch (cause) {
            console.error('jobs refresh failed', cause);
        }
        this.renderList();
    }

    private runningJobFor(scheduleId: string): JobRecord | undefined {
        return this.jobs.find((j) => j.scheduleId === scheduleId && j.status === 'running');
    }

    // ── list ────────────────────────────────────────────────────────────

    private renderList(): void {
        this.closeAllStreams();
        this.rows.clear();
        clear(this.listHost);

        if (this.schedules.length === 0) {
            this.listHost.appendChild(el('div', {
                class: 'jobs-empty',
                text: 'No jobs yet. Click "＋ New job" to add one — pick a provider, '
                    + 'configure it, and give it a schedule (or leave the cron empty for a manual job).'
            }));
            return;
        }

        for (const s of this.schedules) {
            this.listHost.appendChild(this.renderRow(s));
        }
    }

    private renderRow(s: Schedule): HTMLElement {
        const provider = providerByType.get(s.jobType);
        const providerLabel = provider?.label ?? s.jobType;
        const cronText = s.cron.trim() === '' ? 'manual' : s.cron;
        const nextText = s.nextRun !== undefined ? formatTime(s.nextRun) : '—';
        const lastText = s.lastRun !== undefined
            ? `${formatTime(s.lastRun)} (${s.lastResult ?? 'ok'})`
            : 'never';

        const enabledToggle = el('input', {attrs: {type: 'checkbox'}}) as HTMLInputElement;
        enabledToggle.checked = s.enabled;
        enabledToggle.addEventListener('change', () => {
            void schedulesApi.update(s.id, {enabled: enabledToggle.checked})
                .then(() => this.refresh())
                .catch((cause) => {
                    window.alert(`Failed to toggle: ${String(cause)}`);
                    enabledToggle.checked = s.enabled;
                });
        });

        const runNowBtn = el('button', {
            class: 'btn schedule-run-now',
            attrs: {type: 'button', title: 'Run this job once, right now'},
            text: 'Run now',
            on: {click: () => {
                void schedulesApi.runNow(s.id)
                    .then(() => this.refresh())
                    .catch((cause) => window.alert(`Run-now failed: ${String(cause)}`));
            }}
        });

        const editBtn = el('button', {
            class: 'btn schedule-edit',
            attrs: {type: 'button'},
            text: 'Edit',
            on: {click: () => this.openModal({edit: s})}
        });

        const deleteBtn = el('button', {
            class: 'btn btn-danger schedule-delete',
            attrs: {type: 'button'},
            text: 'Delete',
            on: {click: () => {
                if (!window.confirm(`Delete job "${s.name}"?`)) return;
                void schedulesApi.delete(s.id)
                    .then(() => this.refresh())
                    .catch((cause) => window.alert(`Delete failed: ${String(cause)}`));
            }}
        });

        // Live-progress slot — populated only when a linked run is active.
        const bar = el('div', {class: 'job-progress-fill'});
        const progressLabel = el('div', {class: 'job-progress-label'});
        const currentLabel = el('div', {class: 'job-current'});
        const progressWrap = el('div', {class: 'schedule-progress', attrs: {hidden: 'true'}},
            el('div', {class: 'job-progress'}, bar),
            progressLabel,
            currentLabel
        );

        const row = el('div', {class: `schedule-row${s.enabled ? '' : ' schedule-row-disabled'}`},
            el('div', {class: 'schedule-row-main'},
                el('div', {class: 'schedule-row-head'},
                    el('label', {class: 'schedule-enabled', attrs: {title: 'Enabled'}}, enabledToggle, el('span')),
                    el('span', {class: 'schedule-name', text: s.name}),
                    el('span', {class: 'schedule-badge', text: providerLabel}),
                    el('code', {class: 'schedule-cron', text: cronText})
                ),
                el('div', {class: 'schedule-row-meta'},
                    el('span', {class: 'schedule-summary', text: this.paramSummary(s)}),
                    el('span', {class: 'schedule-next', text: `next: ${nextText}`}),
                    el('span', {class: 'schedule-last', text: `last: ${lastText}`})
                ),
                progressWrap
            ),
            el('div', {class: 'schedule-row-actions'}, runNowBtn, editBtn, deleteBtn)
        );

        const refs: RowRefs = {scheduleId: s.id, progressWrap, bar, progressLabel, currentLabel};
        this.rows.set(s.id, refs);

        const running = this.runningJobFor(s.id);
        if (running !== undefined) {
            this.showProgress(refs, running);
            this.attachStream(running.id, refs);
        }

        return row;
    }

    private paramSummary(s: Schedule): string {
        let params: Record<string, unknown>;
        try {
            params = JSON.parse(s.jobParams) as Record<string, unknown>;
        } catch {
            return '(unparseable params)';
        }

        switch (s.jobType) {
            case 'crawl-gitea':
                return `${String(params.owner)}/${String(params.repo)} → ${String(params.project)}`;
            case 'crawl-code':
                return String(params.repoPath ?? '');
            case 'crawl-github-stars':
                return params.username !== undefined && params.username !== ''
                    ? `@${String(params.username)}` : '(your stars)';
            case 'crawl-devto':
                return 'latest articles';
            default: {
                const prefix = (params.prefix as string | undefined) ?? '';
                return prefix === '' ? '(all notes)' : prefix;
            }
        }
    }

    // ── live progress ───────────────────────────────────────────────────

    private showProgress(refs: RowRefs, job: JobRecord): void {
        refs.progressWrap.removeAttribute('hidden');
        const total = Math.max(job.progress.total, 1);
        const pct = Math.min(100, (job.progress.done / total) * 100);
        refs.bar.style.width = `${pct}%`;
        refs.bar.classList.toggle('failed', job.status === 'failed');
        refs.bar.classList.toggle('done', job.status === 'done');
        refs.progressLabel.textContent = job.progress.failed > 0
            ? `${job.progress.done}/${job.progress.total} · ${job.progress.failed} failed`
            : `${job.progress.done}/${job.progress.total}`;
        refs.currentLabel.textContent = job.progress.current ?? '';
    }

    private attachStream(jobId: string, refs: RowRefs): void {
        const local: JobRecord = {
            id: jobId, type: 'relink', params: {prefix: ''}, status: 'running',
            progress: {done: 0, total: 0, failed: 0}, startedAt: Date.now(), logs: []
        };

        const close = jobsApi.stream(jobId, (event) => {
            if (event.kind === 'snapshot') {
                Object.assign(local, event.job);
            } else if (event.kind === 'progress') {
                local.progress = {
                    done: event.done, total: event.total, failed: event.failed,
                    ...(event.current !== undefined ? {current: event.current} : {})
                };
            } else if (event.kind === 'done') {
                local.status = 'done';
                refs.currentLabel.textContent = `✓ ${event.summary}`;
                this.streams.get(jobId)?.();
                this.streams.delete(jobId);
                void this.refresh();
                return;
            } else if (event.kind === 'failed') {
                local.status = 'failed';
                refs.currentLabel.textContent = `✗ ${event.error}`;
                this.streams.get(jobId)?.();
                this.streams.delete(jobId);
                void this.refresh();
                return;
            } else if (event.kind === 'stopped') {
                this.streams.get(jobId)?.();
                this.streams.delete(jobId);
                void this.refresh();
                return;
            }
            this.showProgress(refs, local);
        });

        this.streams.set(jobId, close);
    }

    private closeAllStreams(): void {
        for (const close of this.streams.values()) close();
        this.streams.clear();
    }

    // ── modal ───────────────────────────────────────────────────────────

    private openModal(mode: 'create' | {edit: Schedule}): void {
        this.closeModal();

        const editing = mode !== 'create' ? mode.edit : null;
        const initialType: JobType = editing?.jobType ?? PROVIDERS[0]!.type;

        const backdrop = el('div', {class: 'jobs-modal-backdrop'});
        const panel = el('div', {class: 'jobs-modal'});

        const title = el('h3', {class: 'jobs-modal-title', text: editing !== null ? 'Edit job' : 'New job'});

        // Provider picker (locked when editing — PUT can't change the type).
        const providerSelect = el('select', {class: 'job-input'},
            ...PROVIDERS.map((p) => el('option', {attrs: {value: p.type}, text: p.label}))
        ) as HTMLSelectElement;
        providerSelect.value = initialType;
        if (editing !== null) providerSelect.disabled = true;

        const fieldsHost = el('div', {class: 'jobs-modal-fields'});
        const nameInput = el('input', {
            class: 'job-input',
            attrs: {type: 'text', placeholder: 'e.g. "Nightly relink"'}
        }) as HTMLInputElement;
        const cronInput = el('input', {
            class: 'job-input',
            attrs: {type: 'text', placeholder: 'empty = manual · every 2h · daily 08:00'}
        }) as HTMLInputElement;
        const enabledBox = el('input', {attrs: {type: 'checkbox'}}) as HTMLInputElement;
        enabledBox.checked = editing?.enabled ?? true;

        // Map of fieldKey → input element for the current provider.
        let fieldInputs = new Map<string, HTMLInputElement | HTMLSelectElement>();

        const parsedParams: Record<string, unknown> = (() => {
            if (editing === null) return {};
            try {
                return JSON.parse(editing.jobParams) as Record<string, unknown>;
            } catch {
                return {};
            }
        })();

        const renderFields = (type: JobType): void => {
            clear(fieldsHost);
            fieldInputs = new Map();
            const provider = providerByType.get(type);
            if (provider === undefined) return;

            fieldsHost.appendChild(el('p', {class: 'jobs-modal-hint', text: provider.description}));

            for (const f of provider.fields) {
                const stored = parsedParams[f.key];
                if (f.type === 'checkbox') {
                    const box = el('input', {attrs: {type: 'checkbox'}}) as HTMLInputElement;
                    box.checked = editing !== null ? stored === true : f.defaultValue === true;
                    if (editing !== null) box.disabled = true;
                    fieldInputs.set(f.key, box);
                    fieldsHost.appendChild(el('label', {class: 'job-checkbox'}, box, el('span', {text: f.label})));
                } else if (f.type === 'select') {
                    const sel = el('select', {class: 'job-input'},
                        ...(f.options ?? []).map((o) => el('option', {attrs: {value: o}, text: o}))
                    ) as HTMLSelectElement;
                    sel.value = editing !== null && typeof stored === 'string' ? stored : String(f.defaultValue ?? '');
                    if (editing !== null) sel.disabled = true;
                    fieldInputs.set(f.key, sel);
                    fieldsHost.appendChild(el('label', {class: 'job-field'}, el('span', {text: f.label}), sel));
                } else {
                    const input = el('input', {
                        class: 'job-input',
                        attrs: {type: f.type, ...(f.placeholder !== undefined ? {placeholder: f.placeholder} : {})}
                    }) as HTMLInputElement;
                    if (editing !== null && stored !== undefined) input.value = String(stored);
                    else if (editing === null && f.defaultValue !== undefined) input.value = String(f.defaultValue);
                    if (editing !== null) input.disabled = true;
                    fieldInputs.set(f.key, input);
                    const field = el('label', {class: 'job-field'}, el('span', {text: f.label}), input);
                    if (f.hint !== undefined) field.appendChild(el('span', {class: 'job-field-hint', text: f.hint}));
                    fieldsHost.appendChild(field);
                }
            }

            if (editing !== null) {
                fieldsHost.appendChild(el('p', {
                    class: 'jobs-modal-note',
                    text: 'Parameters can’t be edited — to change them, delete this job and create a new one.'
                }));
            }
        };

        providerSelect.addEventListener('change', () => renderFields(providerSelect.value as JobType));
        renderFields(initialType);

        if (editing !== null) {
            nameInput.value = editing.name;
            cronInput.value = editing.cron;
        }

        const errorLine = el('div', {class: 'jobs-modal-error', attrs: {hidden: 'true'}});
        const showError = (msg: string): void => {
            errorLine.textContent = msg;
            errorLine.removeAttribute('hidden');
        };

        const saveBtn = el('button', {
            class: 'btn btn-primary',
            attrs: {type: 'button'},
            text: 'Save',
            on: {click: () => void this.saveFromModal(mode, providerSelect.value as JobType, fieldInputs, nameInput, cronInput, enabledBox, showError)}
        });
        const cancelBtn = el('button', {
            class: 'btn',
            attrs: {type: 'button'},
            text: 'Cancel',
            on: {click: () => this.closeModal()}
        });

        panel.appendChild(title);
        panel.appendChild(el('label', {class: 'job-field'}, el('span', {text: 'Provider'}), providerSelect));
        panel.appendChild(fieldsHost);
        panel.appendChild(el('label', {class: 'job-field'}, el('span', {text: 'Job name'}), nameInput));
        panel.appendChild(el('label', {class: 'job-field'}, el('span', {text: 'Schedule (cron)'}), cronInput));
        panel.appendChild(el('label', {class: 'job-checkbox'}, enabledBox, el('span', {text: 'enabled'})));
        panel.appendChild(errorLine);
        panel.appendChild(el('div', {class: 'jobs-modal-actions'}, cancelBtn, saveBtn));

        backdrop.addEventListener('pointerdown', (ev) => {
            if (ev.target === backdrop) this.closeModal();
        });
        const onKey = (ev: KeyboardEvent): void => {
            if (ev.key === 'Escape') this.closeModal();
        };
        backdrop.dataset.keyHandler = 'true';
        window.addEventListener('keydown', onKey);
        this.modalKeyHandler = onKey;

        backdrop.appendChild(panel);
        document.body.appendChild(backdrop);
        this.modal = backdrop;
        nameInput.focus();
    }

    private modalKeyHandler: ((ev: KeyboardEvent) => void) | null = null;

    private closeModal(): void {
        if (this.modalKeyHandler !== null) {
            window.removeEventListener('keydown', this.modalKeyHandler);
            this.modalKeyHandler = null;
        }
        this.modal?.remove();
        this.modal = null;
    }

    private async saveFromModal(
        mode: 'create' | {edit: Schedule},
        type: JobType,
        fieldInputs: Map<string, HTMLInputElement | HTMLSelectElement>,
        nameInput: HTMLInputElement,
        cronInput: HTMLInputElement,
        enabledBox: HTMLInputElement,
        showError: (msg: string) => void
    ): Promise<void> {
        const name = nameInput.value.trim();
        if (name === '') {
            showError('Job name is required.');
            return;
        }
        const cron = cronInput.value.trim();

        try {
            if (mode === 'create') {
                const collected = this.collectParams(type, fieldInputs);
                if (collected.error !== undefined) {
                    showError(collected.error);
                    return;
                }
                await schedulesApi.create({
                    name,
                    jobType: type,
                    jobParams: collected.params,
                    cron,
                    enabled: enabledBox.checked
                });
            } else {
                await schedulesApi.update(mode.edit.id, {name, cron, enabled: enabledBox.checked});
            }
        } catch (cause) {
            showError(`Save failed: ${cause instanceof Error ? cause.message : String(cause)}`);
            return;
        }

        this.closeModal();
        await this.refresh();
        this.opts.onChange?.();
    }

    private collectParams(
        type: JobType,
        fieldInputs: Map<string, HTMLInputElement | HTMLSelectElement>
    ): {params: JobParams; error?: string} {
        const provider = providerByType.get(type);
        const out: Record<string, unknown> = {};
        if (provider === undefined) return {params: out as JobParams};

        for (const f of provider.fields) {
            const input = fieldInputs.get(f.key);
            if (input === undefined) continue;

            if (f.type === 'checkbox') {
                out[f.key] = (input as HTMLInputElement).checked;
                continue;
            }

            const raw = input.value.trim();
            if (f.type === 'number') {
                if (raw === '') continue;
                const n = Number.parseInt(raw, 10);
                if (Number.isFinite(n)) out[f.key] = n;
                continue;
            }

            if (raw === '') {
                if (f.required === true) {
                    return {params: out as JobParams, error: `${f.label} is required.`};
                }
                continue;
            }
            out[f.key] = raw;
        }

        // relink/compile always send prefix (empty = all notes).
        if ((type === 'relink' || type === 'compile') && out.prefix === undefined) {
            out.prefix = '';
        }

        return {params: out as JobParams};
    }
}
