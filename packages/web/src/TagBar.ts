import {clear, el} from './Dom.js';
import {tagColor} from './Colors.js';

export interface TagEntry {
    tag: string;
    count: number;
}

export interface TagBarState {
    tags: TagEntry[];
    selected: ReadonlySet<string>;
    hideIsolated: boolean;
    showHulls: boolean;
    showHeat: boolean;
    showRoomGrid: boolean;
    showCluster: boolean;
    threeD: boolean;
}

export interface TagBarCallbacks {
    onToggleTag: (tag: string) => void;
    onClear: () => void;
    onToggleIsolated: () => void;
    onToggleHulls: () => void;
    onToggleHeat: () => void;
    onToggleRoomGrid: () => void;
    onToggleCluster: () => void;
    onToggle3D: () => void;
}

export class TagBar {
    public readonly element: HTMLElement;
    private state: TagBarState;

    public constructor(initial: TagBarState, private readonly cb: TagBarCallbacks) {
        this.state = initial;
        this.element = el('div', {class: 'tagbar'});
        this.render();
    }

    public update(state: TagBarState): void {
        this.state = state;
        this.render();
    }

    private render(): void {
        clear(this.element);

        const chipsHost = el('div', {class: 'tagbar-chips'},
            ...this.state.tags.map((entry) => this.chip(entry))
        );

        if (this.state.selected.size > 0) {
            chipsHost.appendChild(
                el('button', {
                    class: 'clear-btn',
                    attrs: {type: 'button', title: 'Clear tag filter'},
                    on: {click: () => this.cb.onClear()},
                    text: 'clear'
                })
            );
        }

        const viewGroup = el('div', {class: 'control-group', attrs: {role: 'group', 'aria-label': 'view options'}},
            el('span', {class: 'control-group-label', text: 'view'}),
            this.segmentToggle('heat', this.state.showHeat, () => this.cb.onToggleHeat()),
            this.segmentToggle('hulls', this.state.showHulls, () => this.cb.onToggleHulls()),
            this.segmentToggle('room', this.state.showRoomGrid, () => this.cb.onToggleRoomGrid()),
            this.segmentToggle('cluster', this.state.showCluster, () => this.cb.onToggleCluster())
        );

        const filterGroup = el('div', {class: 'control-group', attrs: {role: 'group', 'aria-label': 'filter'}},
            el('span', {class: 'control-group-label', text: 'filter'}),
            this.segmentToggle('isolated', this.state.hideIsolated, () => this.cb.onToggleIsolated())
        );

        const modeToggle = el('div', {class: 'mode-switch', attrs: {role: 'group', 'aria-label': 'view mode'}},
            this.modeButton('2D', !this.state.threeD, () => {
                if (this.state.threeD) {
                    this.cb.onToggle3D();
                }
            }),
            this.modeButton('3D', this.state.threeD, () => {
                if (!this.state.threeD) {
                    this.cb.onToggle3D();
                }
            })
        );

        const actions = el('div', {class: 'tagbar-actions'}, viewGroup, filterGroup, modeToggle);

        this.element.appendChild(chipsHost);
        this.element.appendChild(actions);
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
        const active = this.state.selected.has(entry.tag);
        const color = tagColor(entry.tag);

        const button = el('button', {
            class: active ? 'chip active' : 'chip',
            attrs: {type: 'button'},
            on: {click: () => this.cb.onToggleTag(entry.tag)},
            style: active
                ? {background: color, borderColor: color, color: '#0f1115'}
                : {borderColor: color, color}
        },
            el('span', {class: 'chip-tag', text: entry.tag}),
            el('span', {class: 'chip-count', text: String(entry.count)})
        );

        return button;
    }
}