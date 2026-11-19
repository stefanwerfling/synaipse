import type {NoteSummary} from './Api.js';
import {el} from './Dom.js';
import type {WikilinkResolver} from './Wikilinks.js';

export interface NoteLinkActions {
    open: (noteId: string) => void;
    /** An unresolved `[[title]]`: offer to create the note. */
    create: (title: string) => void;
}

const linkRow = (icon: string, title: string, noteId: string, actions: NoteLinkActions): HTMLElement =>
    el('li', {class: 'viewer-link-row'},
        el('button', {
            class: 'viewer-link-btn',
            attrs: {type: 'button', title: noteId},
            on: {click: () => actions.open(noteId)}
        },
            el('span', {class: 'viewer-link-icon', text: icon}),
            el('span', {class: 'viewer-link-title', text: title})
        ),
        el('span', {class: 'viewer-link-path', text: noteId})
    );

const linksBlock = (heading: string, count: number): {block: HTMLElement; list: HTMLElement} => {
    const block = el('div', {class: 'viewer-links-block'},
        el('h3', {class: 'viewer-links-head'},
            el('span', {text: heading}),
            el('span', {class: 'viewer-links-count', text: String(count)})
        )
    );
    const list = el('ul', {class: 'viewer-links-list'});
    block.appendChild(list);
    return {block, list};
};

/** "Linked from": notes that wikilink the open note. */
export const renderBacklinks = (backlinks: readonly string[], lookup: ReadonlyMap<string, NoteSummary>, actions: NoteLinkActions): HTMLElement => {
    const {block, list} = linksBlock('Linked from', backlinks.length);

    for (const id of backlinks) {
        list.appendChild(linkRow('←', lookup.get(id)?.title ?? id, id, actions));
    }

    return block;
};

/** "Links to": the open note's wikilinks, resolved ones first, unresolved ones as "click to create". */
export const renderOutgoing = (wikilinks: readonly string[], resolve: WikilinkResolver, actions: NoteLinkActions): HTMLElement => {
    const resolved: Array<{title: string; noteId: string}> = [];
    const unresolved: string[] = [];

    for (const link of wikilinks) {
        const noteId = resolve(link);

        if (noteId !== undefined) {
            resolved.push({title: link, noteId});
        } else {
            unresolved.push(link);
        }
    }

    const {block, list} = linksBlock('Links to', wikilinks.length);

    for (const {title, noteId} of resolved) {
        list.appendChild(linkRow('→', title, noteId, actions));
    }

    for (const title of unresolved) {
        list.appendChild(el('li', {class: 'viewer-link-row unresolved'},
            el('button', {
                class: 'viewer-link-btn unresolved',
                attrs: {type: 'button', title: `Create '${title}'`},
                on: {click: () => actions.create(title)}
            },
                el('span', {class: 'viewer-link-icon', text: '?'}),
                el('span', {class: 'viewer-link-title', text: title})
            ),
            el('span', {class: 'viewer-link-path', text: 'unresolved — click to create'})
        ));
    }

    return block;
};
