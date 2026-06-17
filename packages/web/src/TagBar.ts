import {clear, el} from './Dom.js';
import {tagColor} from './Colors.js';
import {TagPicker} from './TagPicker.js';
import type {TagEntry} from './TagGroups.js';

export type {TagEntry};

export interface TagBarState {
    tags: TagEntry[];
    selected: ReadonlySet<string>;
    hideIsolated: boolean;
    showHulls: boolean;
    showHeat: boolean;
    showRoomGrid: boolean;
    showCluster: boolean;
    showCommunities: boolean;
    viewMode: '2d' | '3d' | 'atlas';
    project: string | null;
}

export interface TagBarCallbacks {
    onToggleTag: (tag: string) => void;
    onClear: () => void;
    onToggleIsolated: () => void;
    onToggleHulls: () => void;
    onToggleHeat: () => void;
    onToggleRoomGrid: () => void;
    onToggleCluster: () => void;
    onToggleCommunities: () => void;
    onSetViewMode: (mode: '2d' | '3d' | 'atlas') => void;
}

export class TagBar {
    public readonly element: HTMLElement;
    private state: TagBarState;
    private picker: TagPicker | null = null;
    private pickerHost: HTMLElement | null = null;

    public constructor(initial: TagBarState, private readonly cb: TagBarCallbacks) {
        this.state = initial;
        this.element = el('div', {class: 'tagbar'});
        this.render();
    }

    public update(state: TagBarState): void {
        this.state = state;
        this.render();

        if (this.picker !== null) {
            this.picker.update({tags: state.tags, selected: state.selected});
        }
    }

    private render(): void {
        clear(this.element);

        const projectPin = this.renderProjectPin();
        const selectedChips = this.renderSelectedChips();
        const pickerButton = this.renderPickerButton();

        const left = el('div', {class: 'tagbar-left'},
            projectPin,
            pickerButton,
            selectedChips
        );

        const viewGroup = el('div', {class: 'control-group', attrs: {role: 'group', 'aria-label': 'view options'}},
            el('span', {class: 'control-group-label', text: 'view'}),
            this.segmentToggle('heat', this.state.showHeat, () => this.cb.onToggleHeat()),
            this.segmentToggle('hulls', this.state.showHulls, () => this.cb.onToggleHulls()),
            this.segmentToggle('room', this.state.showRoomGrid, () => this.cb.onToggleRoomGrid()),
            this.segmentToggle('cluster', this.state.showCluster, () => this.cb.onToggleCluster()),
            this.segmentToggle('communities', this.state.showCommunities, () => this.cb.onToggleCommunities())
        );

        const filterGroup = el('div', {class: 'control-group', attrs: {role: 'group', 'aria-label': 'filter'}},
            el('span', {class: 'control-group-label', text: 'filter'}),
            this.segmentToggle('isolated', this.state.hideIsolated, () => this.cb.onToggleIsolated())
        );

        const modeToggle = el('div', {class: 'mode-switch', attrs: {role: 'group', 'aria-label': 'view mode'}},
            this.modeButton('2D', this.state.viewMode === '2d', () => {
                if (this.state.viewMode !== '2d') this.cb.onSetViewMode('2d');
            }),
            this.modeButton('3D', this.state.viewMode === '3d', () => {
                if (this.state.viewMode !== '3d') this.cb.onSetViewMode('3d');
            }),
            this.modeButton('Atlas', this.state.viewMode === 'atlas', () => {
                if (this.state.viewMode !== 'atlas') this.cb.onSetViewMode('atlas');
            })
        );

        const actions = el('div', {class: 'tagbar-actions'}, viewGroup, filterGroup, modeToggle);

        this.element.appendChild(left);
        this.element.appendChild(actions);
    }

    private renderProjectPin(): HTMLElement {
        const name = this.state.project;

        if (name === null) {
            return el('span', {class: 'project-pin scope-global', attrs: {title: 'No project pinned — viewing the whole vault'}},
                el('span', {class: 'project-pin-icon', text: '◌'}),
                el('span', {class: 'project-pin-label', text: 'all projects'})
            );
        }

        return el('span', {class: 'project-pin scope-project', attrs: {title: `Pinned to project ${name}`}},
            el('span', {class: 'project-pin-icon', text: '●'}),
            el('span', {class: 'project-pin-label', text: name})
        );
    }

    private renderPickerButton(): HTMLElement {
        const total = this.state.tags.length;
        const selected = this.state.selected.size;
        const label = selected > 0 ? `Tags · ${selected}/${total}` : `Tags · ${total}`;

        const button = el('button', {
            class: this.pickerHost !== null ? 'picker-btn active' : 'picker-btn',
            attrs: {type: 'button', 'aria-haspopup': 'dialog', 'aria-expanded': this.pickerHost !== null ? 'true' : 'false'},
            on: {click: (event) => {
                event.stopPropagation();
                this.togglePicker(button);
            }},
            text: label
        });

        return button;
    }

    private renderSelectedChips(): HTMLElement {
        const host = el('div', {class: 'tagbar-selected'});

        if (this.state.selected.size === 0) {
            return host;
        }

        const lookup = new Map(this.state.tags.map((e) => [e.tag, e.count]));

        for (const tag of this.state.selected) {
            const count = lookup.get(tag) ?? 0;
            host.appendChild(this.chip({tag, count}));
        }

        host.appendChild(
            el('button', {
                class: 'clear-btn',
                attrs: {type: 'button', title: 'Clear tag filter'},
                on: {click: () => this.cb.onClear()},
                text: 'clear'
            })
        );

        return host;
    }

    private togglePicker(anchor: HTMLElement): void {
        if (this.picker !== null) {
            this.closePicker();
            return;
        }

        const wrap = el('div', {class: 'tag-picker-wrap'});
        anchor.appendChild(wrap);
        this.pickerHost = wrap;

        this.picker = new TagPicker(
            {tags: this.state.tags, selected: this.state.selected},
            {
                onToggleTag: (tag) => this.cb.onToggleTag(tag),
                onClearSelection: () => this.cb.onClear(),
                onClose: () => this.closePicker()
            }
        );

        wrap.appendChild(this.picker.element);
        anchor.classList.add('active');
        anchor.setAttribute('aria-expanded', 'true');
    }

    private closePicker(): void {
        if (this.picker === null) {
            return;
        }

        this.picker.destroy();
        this.picker = null;

        if (this.pickerHost !== null) {
            this.pickerHost.remove();
            this.pickerHost = null;
        }

        this.render();
    }

    private segmentToggle(label: string, active: boolean, onToggle: () => void): HTMLElement {
        return el('button', {
            class: active ? 'segment-toggle active' : 'segment-toggle',
            attrs: {type: 'button', 'aria-pressed': active ? 'true' : 'false'},
            on: {click: () => onToggle()},
            text: label
        });
    }

    private modeButton(label: string, active: boolean, onClick: () => void): HTMLElement {
        return el('button', {
            class: active ? 'mode-switch-btn active' : 'mode-switch-btn',
            attrs: {type: 'button', 'aria-pressed': active ? 'true' : 'false'},
            on: {click: () => onClick()},
            text: label
        });
    }

    private chip(entry: TagEntry): HTMLElement {
        const color = tagColor(entry.tag);

        return el('button', {
            class: 'chip active',
            attrs: {type: 'button', title: 'Remove from filter'},
            on: {click: () => this.cb.onToggleTag(entry.tag)},
            style: {background: color, borderColor: color, color: '#0f1115'}
        },
            el('span', {class: 'chip-tag', text: entry.tag}),
            el('span', {class: 'chip-count', text: String(entry.count)})
        );
    }
}