import {clear, el} from './Dom.js';
import {defineMessages, formatNumber} from './I18n.js';
import {applyTagFill} from './Colors.js';
import type {StorageCodec} from './Persistence.js';
import {TagPicker} from './TagPicker.js';
import type {TagEntry} from './TagGroups.js';

export type {TagEntry};

const t = defineMessages('tagBar', {
    viewOptions: 'view options',
    view: 'view',
    heat: 'heat',
    hulls: 'hulls',
    room: 'room',
    cluster: 'cluster',
    communities: 'communities',
    filter: 'filter',
    isolated: 'isolated',
    viewMode: 'view mode',
    tooMany3d: 'Graph has {nodes} nodes — too many for 3D, showing 2D.',
    slow3d: 'Graph has {nodes} nodes — 3D will be slow, 2D recommended.',
    note3dOff: '{nodes} nodes · 3D off',
    note2dRecommended: '{nodes} nodes · 2D recommended',
    noProjectTitle: 'No project pinned — viewing the whole vault',
    allProjects: 'all projects',
    pinnedTo: 'Pinned to project {name}',
    tagsSelected: 'Tags · {selected}/{total}',
    tags: 'Tags · {total}',
    clearTitle: 'Clear tag filter',
    clear: 'clear',
    removeFromFilter: 'Remove from filter'
});

/** 2D (jsNGraph, every vault size) or 3D (three.js). */
export type ViewMode = '2d' | '3d';

/** Stored view mode; anything else (e.g. the former 'atlas') reads as 2D. */
export const viewModeCodec: StorageCodec<ViewMode> = {
    serialize: (mode) => JSON.stringify(mode),
    deserialize: (raw) => (JSON.parse(raw) === '3d' ? '3d' : '2d')
};

export interface TagBarState {
    tags: TagEntry[];
    selected: ReadonlySet<string>;
    hideIsolated: boolean;
    showHulls: boolean;
    showHeat: boolean;
    showRoomGrid: boolean;
    showCluster: boolean;
    showCommunities: boolean;
    /** The user's persisted preference — what the buttons show as "pressed". */
    viewMode: ViewMode;
    /**
     * What the App actually renders. Diverges from `viewMode` when the
     * graph is too large for the requested renderer. Defaults to viewMode
     * if omitted so older callers keep working.
     */
    effectiveViewMode?: ViewMode;
    /**
     * Set when the graph is too big for 3D (`forced`: 3D is off) or close
     * to that limit while 3D is chosen (`warned`). Used to disable/annotate
     * the 3D button.
     */
    modeOverride?: {kind: 'forced' | 'warned'; nodeCount: number} | null;
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
    onSetViewMode: (mode: ViewMode) => void;
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

        const viewGroup = el('div', {class: 'control-group', attrs: {role: 'group', 'aria-label': t('viewOptions')}},
            el('span', {class: 'control-group-label', text: t('view')}),
            this.segmentToggle(t('heat'), this.state.showHeat, () => this.cb.onToggleHeat()),
            this.segmentToggle(t('hulls'), this.state.showHulls, () => this.cb.onToggleHulls()),
            this.segmentToggle(t('room'), this.state.showRoomGrid, () => this.cb.onToggleRoomGrid()),
            this.segmentToggle(t('cluster'), this.state.showCluster, () => this.cb.onToggleCluster()),
            this.segmentToggle(t('communities'), this.state.showCommunities, () => this.cb.onToggleCommunities())
        );

        const filterGroup = el('div', {class: 'control-group', attrs: {role: 'group', 'aria-label': t('filter')}},
            el('span', {class: 'control-group-label', text: t('filter')}),
            this.segmentToggle(t('isolated'), this.state.hideIsolated, () => this.cb.onToggleIsolated())
        );

        const override = this.state.modeOverride ?? null;
        const forced = override !== null && override.kind === 'forced';
        // 2D scales to any vault size (it switches to the server layout and
        // a community overview on its own). 3D is locked out past the hard
        // cap; the softer 'warned' state keeps it clickable with a tooltip.
        const nodes = override === null ? '' : formatNumber(override.nodeCount);
        const title3d = forced
            ? t('tooMany3d', {nodes})
            : override !== null
                ? t('slow3d', {nodes})
                : undefined;

        // "Active" reflects what's actually being rendered, which differs
        // from the user's preference when 3D was replaced by 2D.
        const activeMode = this.state.effectiveViewMode ?? this.state.viewMode;

        const modeToggle = el('div', {class: 'mode-switch', attrs: {role: 'group', 'aria-label': t('viewMode')}},
            this.modeButton('2D', activeMode === '2d', false, undefined, () => {
                if (this.state.viewMode !== '2d') this.cb.onSetViewMode('2d');
            }),
            this.modeButton('3D', activeMode === '3d', forced, title3d, () => {
                if (this.state.viewMode !== '3d') this.cb.onSetViewMode('3d');
            })
        );

        // Visible note when 3D was replaced, so it is clear why it is off.
        if (override !== null && (!forced || this.state.viewMode === '3d')) {
            const noteText = forced ? t('note3dOff', {nodes}) : t('note2dRecommended', {nodes});
            const note = el('span', {
                class: forced ? 'mode-switch-note forced' : 'mode-switch-note warned',
                attrs: {title: title3d ?? ''},
                text: noteText
            });
            modeToggle.appendChild(note);
        }

        const actions = el('div', {class: 'tagbar-actions'}, viewGroup, filterGroup, modeToggle);

        this.element.appendChild(left);
        this.element.appendChild(actions);
    }

    private renderProjectPin(): HTMLElement {
        const name = this.state.project;

        if (name === null) {
            return el('span', {class: 'project-pin scope-global', attrs: {title: t('noProjectTitle')}},
                el('span', {class: 'project-pin-icon', text: '◌'}),
                el('span', {class: 'project-pin-label', text: t('allProjects')})
            );
        }

        return el('span', {class: 'project-pin scope-project', attrs: {title: t('pinnedTo', {name})}},
            el('span', {class: 'project-pin-icon', text: '●'}),
            el('span', {class: 'project-pin-label', text: name})
        );
    }

    private renderPickerButton(): HTMLElement {
        const total = this.state.tags.length;
        const selected = this.state.selected.size;
        const label = selected > 0 ? t('tagsSelected', {selected, total}) : t('tags', {total});

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
                attrs: {type: 'button', title: t('clearTitle')},
                on: {click: () => this.cb.onClear()},
                text: t('clear')
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

    private modeButton(
        label: string,
        active: boolean,
        disabled: boolean,
        title: string | undefined,
        onClick: () => void
    ): HTMLElement {
        const classes = ['mode-switch-btn'];
        if (active) classes.push('active');
        if (disabled) classes.push('disabled');

        const attrs: Record<string, string> = {
            type: 'button',
            'aria-pressed': active ? 'true' : 'false'
        };

        if (disabled) attrs.disabled = 'true';
        if (title !== undefined) attrs.title = title;

        return el('button', {
            class: classes.join(' '),
            attrs,
            on: {click: () => {
                if (disabled) return;
                onClick();
            }},
            text: label
        });
    }

    private chip(entry: TagEntry): HTMLElement {
        return applyTagFill(el('button', {
            class: 'chip active',
            attrs: {type: 'button', title: t('removeFromFilter')},
            on: {click: () => this.cb.onToggleTag(entry.tag)}
        },
            el('span', {class: 'chip-tag', text: entry.tag}),
            el('span', {class: 'chip-count', text: String(entry.count)})
        ), entry.tag);
    }
}