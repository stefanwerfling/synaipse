import {api, type ChatSummary} from './Api.js';
import {clear, el} from './Dom.js';
import {confirmDialog} from './Dialogs.js';
import {defineMessages, formatDateTime, tc} from './I18n.js';

const t = defineMessages('chatSidebar', {
    newChat: '+  New conversation',
    title: 'Conversations',
    loadFailed: 'Could not load the list.',
    empty: 'No conversations yet.',
    deleteTitle: 'Delete conversation',
    deleteConfirmTitle: 'Delete conversation?',
    deleteConfirmMessage: 'The conversation will be deleted permanently.',
    today: 'Today {time}',
    yesterday: 'Yesterday'
});

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
            text: t('newChat'),
            on: {click: () => this.cb.onNew()}
        });

        const head = el('div', {class: 'chat-sidebar-head'},
            el('div', {class: 'chat-sidebar-title', text: t('title')}),
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
                el('li', {class: 'chat-sidebar-empty', text: t('loadFailed')})
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
                el('li', {class: 'chat-sidebar-empty', text: t('empty')})
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
                attrs: {type: 'button', title: t('deleteTitle'), 'aria-label': t('deleteTitle')},
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
        const ok = await confirmDialog({
            title: t('deleteConfirmTitle'),
            message: t('deleteConfirmMessage'),
            confirmLabel: tc('delete'),
            cancelLabel: tc('cancel'),
            danger: true
        });
        if (!ok) return;

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
        return t('today', {time: formatDateTime(date, {hour: '2-digit', minute: '2-digit'})});
    }

    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    if (date.toDateString() === yesterday.toDateString()) {
        return t('yesterday');
    }

    return formatDateTime(date, {day: '2-digit', month: '2-digit'});
};