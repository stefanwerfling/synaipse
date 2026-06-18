import {api, type ChatSummary} from './Api.js';
import {clear, el} from './Dom.js';

export interface ChatSidebarCallbacks {
    onSelect: (id: string) => void;
    onNew: () => void;
}

/**
 * Left-rail conversation list, ChatGPT-style. Owns its own list cache and
 * provides imperative refresh / select methods for the parent ChatPanel.
 */
export class ChatSidebar {
    public readonly element: HTMLElement;
    private readonly listHost: HTMLElement;
    private chats: ChatSummary[] = [];
    private activeId: string | null = null;
    private loading = false;

    public constructor(private readonly cb: ChatSidebarCallbacks) {
        const newBtn = el('button', {
            class: 'chat-sidebar-new',
            attrs: {type: 'button'},
            text: '+  Neues Gespräch',
            on: {click: () => this.cb.onNew()}
        });

        const head = el('div', {class: 'chat-sidebar-head'},
            el('div', {class: 'chat-sidebar-title', text: 'Gespräche'}),
            newBtn
        );

        this.listHost = el('ul', {class: 'chat-sidebar-list'});
        this.element = el('aside', {class: 'chat-sidebar'}, head, this.listHost);
    }

    public async refresh(): Promise<void> {
        if (this.loading) return;
        this.loading = true;

        try {
            this.chats = await api.listChats();
            this.render();
        } catch (cause) {
            console.error('failed to list chats', cause);
            clear(this.listHost);
            this.listHost.appendChild(
                el('li', {class: 'chat-sidebar-empty', text: 'Liste konnte nicht geladen werden.'})
            );
        } finally {
            this.loading = false;
        }
    }

    public setActive(id: string | null): void {
        this.activeId = id;
        this.render();
    }

    private render(): void {
        clear(this.listHost);

        if (this.chats.length === 0) {
            this.listHost.appendChild(
                el('li', {class: 'chat-sidebar-empty', text: 'Noch keine Gespräche.'})
            );
            return;
        }

        for (const chat of this.chats) {
            const isActive = chat.id === this.activeId;
            const dateLabel = formatDate(chat.updatedAt);

            const titleEl = el('span', {class: 'chat-sidebar-item-title', text: chat.title});
            const metaEl = el('span', {class: 'chat-sidebar-item-meta', text: dateLabel});

            const deleteBtn = el('button', {
                class: 'chat-sidebar-item-delete',
                attrs: {type: 'button', title: 'Gespräch löschen', 'aria-label': 'Gespräch löschen'},
                text: '×',
                on: {
                    click: (event) => {
                        event.stopPropagation();
                        void this.handleDelete(chat.id);
                    }
                }
            });

            const row = el('li', {
                class: isActive ? 'chat-sidebar-item active' : 'chat-sidebar-item',
                attrs: {role: 'button', tabindex: '0'},
                on: {click: () => this.cb.onSelect(chat.id)}
            },
                el('div', {class: 'chat-sidebar-item-main'}, titleEl, metaEl),
                deleteBtn
            );

            this.listHost.appendChild(row);
        }
    }

    private async handleDelete(id: string): Promise<void> {
        if (!window.confirm('Dieses Gespräch wirklich löschen?')) return;

        try {
            await api.deleteChat(id);
            await this.refresh();

            if (this.activeId === id) {
                this.activeId = null;
                this.cb.onNew();
            }
        } catch (cause) {
            console.error('failed to delete chat', cause);
        }
    }
}

const formatDate = (iso: string): string => {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return iso;

    const now = new Date();
    const sameDay = date.toDateString() === now.toDateString();

    if (sameDay) {
        return `Heute ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
    }

    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    if (date.toDateString() === yesterday.toDateString()) {
        return 'Gestern';
    }

    return `${String(date.getDate()).padStart(2, '0')}.${String(date.getMonth() + 1).padStart(2, '0')}.`;
};