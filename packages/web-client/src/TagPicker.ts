import {clear, el} from './Dom.js';
import {tagColor} from './Colors.js';
import {filterEntries, groupLabel, groupTags, isUngrouped, type TagEntry, type TagGroup} from './TagGroups.js';

export interface TagPickerCallbacks {
    onToggleTag: (tag: string) => void;
    onClearSelection: () => void;
    onClose: () => void;
}

export interface TagPickerState {
    tags: readonly TagEntry[];
    selected: ReadonlySet<string>;
}

export class TagPicker {
    public readonly element: HTMLElement;
    private state: TagPickerState;
    private query = '';
    private input: HTMLInputElement | null = null;
    private list: HTMLElement | null = null;
    private readonly onDocClick: (event: MouseEvent) => void;
    private readonly onKeyDown: (event: KeyboardEvent) => void;

    public constructor(initial: TagPickerState, private readonly cb: TagPickerCallbacks) {
        this.state = initial;
        this.element = el('div', {class: 'tag-picker', attrs: {role: 'dialog', 'aria-label': 'select tags'}});
        this.render();

        this.onDocClick = (event) => {
            if (!(event.target instanceof Node)) return;
            if (!this.element.contains(event.target)) {
                this.cb.onClose();
            }
        };

        this.onKeyDown = (event) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                this.cb.onClose();
            }
        };

        setTimeout(() => {
            document.addEventListener('mousedown', this.onDocClick);
            document.addEventListener('keydown', this.onKeyDown);
            this.input?.focus();
        }, 0);
    }

    public update(state: TagPickerState): void {
        this.state = state;
        this.renderList();
    }

    public destroy(): void {
        document.removeEventListener('mousedown', this.onDocClick);
        document.removeEventListener('keydown', this.onKeyDown);
        this.element.remove();
    }

    private render(): void {
        clear(this.element);

        const header = el('div', {class: 'tag-picker-header'},
            el('input', {
                class: 'tag-picker-search',
                attrs: {type: 'search', placeholder: 'Filter tags…', 'aria-label': 'filter tags'},
                on: {
                    input: (event) => {
                        this.query = (event.target as HTMLInputElement).value;
                        this.renderList();
                    }
                }
            })
        );
        this.input = header.firstChild as HTMLInputElement;

        if (this.state.selected.size > 0) {
            header.appendChild(
                el('button', {
                    class: 'tag-picker-clear',
                    attrs: {type: 'button'},
                    on: {click: () => this.cb.onClearSelection()},
                    text: `clear (${this.state.selected.size})`
                })
            );
        }

        this.list = el('div', {class: 'tag-picker-list'});
        this.element.appendChild(header);
        this.element.appendChild(this.list);

        this.renderList();
    }

    private renderList(): void {
        if (this.list === null) return;
        clear(this.list);

        const filtered = filterEntries(this.state.tags, this.query);

        if (filtered.length === 0) {
            this.list.appendChild(el('div', {class: 'tag-picker-empty', text: 'no tags match'}));
            return;
        }

        const groups = groupTags(filtered);

        for (const group of groups) {
            this.list.appendChild(this.renderGroup(group));
        }
    }

    private renderGroup(group: TagGroup): HTMLElement {
        const heading = el('div', {class: 'tag-picker-group-head'},
            el('span', {class: 'tag-picker-group-name', text: groupLabel(group.name)}),
            el('span', {class: 'tag-picker-group-count', text: String(group.total)})
        );

        const items = group.entries.map((entry) => this.renderItem(entry, group.name));

        return el('div', {class: isUngrouped(group.name) ? 'tag-picker-group ungrouped' : 'tag-picker-group'},
            heading,
            ...items
        );
    }

    private renderItem(entry: TagEntry, groupName: string): HTMLElement {
        const active = this.state.selected.has(entry.tag);
        const color = tagColor(entry.tag);
        const shortLabel = isUngrouped(groupName)
            ? entry.tag
            : entry.tag.slice(groupName.length + 1);

        return el('button', {
            class: active ? 'tag-picker-item active' : 'tag-picker-item',
            attrs: {type: 'button', 'aria-pressed': active ? 'true' : 'false', title: entry.tag},
            on: {click: () => this.cb.onToggleTag(entry.tag)}
        },
            el('span', {class: 'tag-picker-swatch', style: {background: color}}),
            el('span', {class: 'tag-picker-item-label', text: shortLabel}),
            el('span', {class: 'tag-picker-item-count', text: String(entry.count)})
        );
    }
}