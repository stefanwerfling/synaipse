import {el} from './Dom.js';
import type {EventKind, SynaipseEvent} from './Events.js';

export interface ActivityLogOptions {
    resolveTitle: (noteId: string) => string | undefined;
    onClick?: (event: SynaipseEvent) => void;
    onUnreadChange?: (count: number) => void;
}

const MAX_ENTRIES = 8;
const ENTRY_TTL_MS = 12_000;

const KIND_LABEL: Record<EventKind, string> = {
    read: 'read',
    write: 'write',
    delete: 'delete',
    search: 'search',
    list: 'list',
    graph: 'graph',
    tags: 'tags'
};

const formatRelative = (ts: number, now: number): string => {
    const diff = Math.max(0, now - ts);

    if (diff < 1000) return 'now';
    if (diff < 60_000) return `${Math.floor(diff / 1000)}s`;
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
    return `${Math.floor(diff / 3_600_000)}h`;
};

export class ActivityLog {
    public readonly element: HTMLElement;
    private readonly entries: Array<{event: SynaipseEvent; el: HTMLElement; expiresAt: number}> = [];
    private list!: HTMLElement;
    private tickTimer: number | null = null;
    private isOpen = false;
    private unread = 0;
    private userPinnedClosed = false;

    public constructor(private readonly opts: ActivityLogOptions) {
        this.element = el('aside', {class: 'activity-log', attrs: {'aria-live': 'polite'}});
        this.build();
    }

    public push(event: SynaipseEvent): void {
        const row = this.renderRow(event);
        const expiresAt = Date.now() + ENTRY_TTL_MS;

        this.entries.unshift({event, el: row, expiresAt});
        this.list.prepend(row);

        while (this.entries.length > MAX_ENTRIES) {
            const removed = this.entries.pop();
            removed?.el.remove();
        }

        if (!this.userPinnedClosed && !this.isOpen) {
            this.setOpen(true);
        } else if (!this.isOpen) {
            this.unread += 1;
            this.opts.onUnreadChange?.(this.unread);
        }

        this.ensureTick();
    }

    public toggle(): void {
        this.setOpen(!this.isOpen);
        this.userPinnedClosed = !this.isOpen;
    }

    public setOpen(open: boolean): void {
        this.isOpen = open;
        this.element.classList.toggle('open', open);

        if (open && this.unread > 0) {
            this.unread = 0;
            this.opts.onUnreadChange?.(0);
        }
    }

    public destroy(): void {
        if (this.tickTimer !== null) {
            window.clearInterval(this.tickTimer);
            this.tickTimer = null;
        }
    }

    private build(): void {
        const closeBtn = el('button', {
            class: 'activity-log-close',
            attrs: {type: 'button', 'aria-label': 'Close activity log'},
            text: '×',
            on: {click: () => this.toggle()}
        });

        const header = el('div', {class: 'activity-log-head'},
            el('span', {class: 'activity-log-title', text: 'MCP activity'}),
            closeBtn
        );

        this.list = el('div', {class: 'activity-log-list'});

        this.element.appendChild(header);
        this.element.appendChild(this.list);
    }

    private renderRow(event: SynaipseEvent): HTMLElement {
        const firstId = event.touched[0];
        const title = firstId !== undefined ? this.opts.resolveTitle(firstId) ?? firstId : event.query ?? '';
        const restCount = Math.max(0, event.touched.length - 1);

        const row = el('div', {
            class: `activity-row activity-${event.kind}`,
            attrs: {role: 'button', tabindex: '0'},
            on: {click: () => this.opts.onClick?.(event)}
        },
            el('span', {class: 'activity-kind', text: KIND_LABEL[event.kind]}),
            el('span', {class: 'activity-target'},
                el('span', {class: 'activity-title', text: title}),
                restCount > 0 ? el('span', {class: 'activity-more', text: ` +${restCount}`}) : ''
            ),
            el('span', {class: 'activity-ts', text: formatRelative(event.ts, Date.now())})
        );

        return row;
    }

    private ensureTick(): void {
        if (this.tickTimer !== null) {
            return;
        }

        this.tickTimer = window.setInterval(() => {
            const now = Date.now();
            let mutated = false;

            for (let i = this.entries.length - 1; i >= 0; i -= 1) {
                const entry = this.entries[i]!;

                if (entry.expiresAt <= now) {
                    entry.el.remove();
                    this.entries.splice(i, 1);
                    mutated = true;
                    continue;
                }

                const tsEl = entry.el.querySelector<HTMLElement>('.activity-ts');

                if (tsEl !== null) {
                    tsEl.textContent = formatRelative(entry.event.ts, now);
                }
            }

            if (this.entries.length === 0) {
                if (!this.userPinnedClosed) {
                    this.setOpen(false);
                }

                if (this.tickTimer !== null) {
                    window.clearInterval(this.tickTimer);
                    this.tickTimer = null;
                }

                return;
            }

            if (mutated && this.entries.length === 0 && !this.userPinnedClosed) {
                this.setOpen(false);
            }
        }, 1000);
    }
}