import {consentApi, type ConsentRequestSummary} from './Api.js';
import {clear, el} from './Dom.js';
import {defineMessages, formatDateTime} from './I18n.js';

const t = defineMessages('consentInbox', {
    title: 'Consent Inbox',
    hint: 'Claude has asked to read these notes via MCP. Approve or deny each request. '
        + 'The decision is written into the note\'s frontmatter (mcp_consent) so subsequent reads pass through without another prompt.',
    empty: 'No pending requests. When Claude asks to read a note whose frontmatter carries "mcp_consent: pending", it will show up here.',
    openNote: 'Open note in the notes panel',
    requester: 'requester: {name}',
    approve: 'Approve',
    deny: 'Deny'
});

export interface ConsentInboxOptions {
    /** Called whenever the pending count changes so App can update its badge. */
    onCountChange?: (count: number) => void;
    /** Called when the user clicks a note-id to inspect it in the notes panel. */
    onOpenNote?: (noteId: string) => void;
}

/**
 * Consent Inbox: shows every open just-in-time consent request from the
 * MCP tool gate, one per row, with Approve / Deny buttons. Live-updates
 * via `/api/consent/stream` (SSE) so the list stays in sync even when
 * multiple tabs are open.
 *
 * The badge count on the topbar tab is derived from the same stream —
 * we keep the local `requests` map as the single source of truth and
 * push counts up via `opts.onCountChange`.
 */
export class ConsentInbox {
    public readonly element: HTMLElement;
    private readonly listHost: HTMLElement;
    private readonly requests = new Map<string, ConsentRequestSummary>();
    private closeStream: (() => void) | null = null;
    private started = false;

    public constructor(private readonly opts: ConsentInboxOptions = {}) {
        this.element = el('div', {class: 'consent-panel'});
        this.element.appendChild(el('div', {class: 'consent-head'},
            el('h2', {text: t('title')}),
            el('p', {
                class: 'consent-hint',
                text: t('hint')
            })
        ));

        this.listHost = el('div', {class: 'consent-list'});
        this.element.appendChild(this.listHost);

        this.render();
    }

    /**
     * Start the live subscription — call once from App.mount() so the
     * badge count is accurate before the user ever opens the tab.
     */
    public start(): void {
        if (this.started) return;
        this.started = true;

        // Fire an initial fetch so the panel renders even if the SSE
        // replay hasn't reached us yet. Idempotent with the stream's
        // own "new" replay (same-id events overwrite each other).
        void consentApi.listPending()
            .then((initial) => {
                for (const r of initial) this.requests.set(r.id, r);
                this.render();
                this.emitCount();
            })
            .catch((err) => {
                console.warn('[consent] initial fetch failed', err);
            });

        this.closeStream = consentApi.stream(
            (req) => {
                this.requests.set(req.id, req);
                this.render();
                this.emitCount();
            },
            (req) => {
                this.requests.delete(req.id);
                this.render();
                this.emitCount();
            }
        );
    }

    public stop(): void {
        if (this.closeStream !== null) {
            this.closeStream();
            this.closeStream = null;
        }
        this.started = false;
    }

    public getPendingCount(): number {
        return this.requests.size;
    }

    public async onShow(): Promise<void> {
        // In case start() hasn't been called yet (e.g. bootstrap error),
        // opening the tab is a good moment to converge on server state.
        try {
            const initial = await consentApi.listPending();
            this.requests.clear();
            for (const r of initial) this.requests.set(r.id, r);
            this.render();
            this.emitCount();
        } catch (err) {
            console.warn('[consent] refresh on show failed', err);
        }
    }

    private emitCount(): void {
        this.opts.onCountChange?.(this.requests.size);
    }

    private render(): void {
        clear(this.listHost);

        if (this.requests.size === 0) {
            this.listHost.appendChild(el('p', {
                class: 'consent-empty',
                text: t('empty')
            }));
            return;
        }

        const sorted = [...this.requests.values()]
            .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

        for (const req of sorted) {
            this.listHost.appendChild(this.renderRow(req));
        }
    }

    private renderRow(req: ConsentRequestSummary): HTMLElement {
        const openNote = (): void => this.opts.onOpenNote?.(req.noteId);

        const noteLink = el('button', {
            class: 'consent-note-link',
            attrs: {type: 'button', title: t('openNote')},
            text: req.noteId,
            on: {click: openNote}
        });

        const meta = el('div', {class: 'consent-meta'},
            el('span', {class: 'consent-requester', text: t('requester', {name: req.requester})}),
            el('span', {class: 'consent-time', text: formatDateTime(req.createdAt)})
        );

        const approveBtn = el('button', {
            class: 'btn consent-approve',
            attrs: {type: 'button'},
            text: t('approve'),
            on: {click: () => void this.decide(req.id, 'approve')}
        }) as HTMLButtonElement;

        const denyBtn = el('button', {
            class: 'btn consent-deny',
            attrs: {type: 'button'},
            text: t('deny'),
            on: {click: () => void this.decide(req.id, 'deny')}
        }) as HTMLButtonElement;

        return el('div', {class: 'consent-row'},
            el('div', {class: 'consent-row-main'}, noteLink, meta),
            el('div', {class: 'consent-row-actions'}, approveBtn, denyBtn)
        );
    }

    private async decide(id: string, action: 'approve' | 'deny'): Promise<void> {
        try {
            if (action === 'approve') {
                await consentApi.approve(id);
            } else {
                await consentApi.deny(id);
            }
            // The SSE `resolved` event will remove the row + update the count;
            // we don't touch local state here to avoid double-render races.
        } catch (err) {
            console.warn(`[consent] ${action} failed for`, id, err);
        }
    }
}