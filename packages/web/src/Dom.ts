type Primitive = string | number | boolean | null | undefined;
type Child = Node | Primitive | Child[];

export interface ElementAttrs {
    class?: string;
    style?: Partial<CSSStyleDeclaration>;
    dataset?: Record<string, string>;
    on?: Record<string, EventListener>;
    attrs?: Record<string, string | number | boolean | undefined>;
    text?: string;
    html?: string;
}

type FullAttrs<K extends keyof HTMLElementTagNameMap> =
    ElementAttrs & Partial<Pick<HTMLElementTagNameMap[K],
        'id' | 'title' | 'tabIndex' | 'hidden' | 'draggable' | 'autocapitalize' | 'spellcheck'>>;

const appendChild = (host: Node, child: Child): void => {
    if (child === null || child === undefined || child === false) {
        return;
    }

    if (Array.isArray(child)) {
        for (const item of child) {
            appendChild(host, item);
        }
        return;
    }

    if (child instanceof Node) {
        host.appendChild(child);
        return;
    }

    host.appendChild(document.createTextNode(String(child)));
};

export const el = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    attrs: FullAttrs<K> = {},
    ...children: Child[]
): HTMLElementTagNameMap[K] => {
    const node = document.createElement(tag);
    const {class: cls, style, dataset, on, attrs: rawAttrs, text, html, ...rest} = attrs;

    if (cls !== undefined) {
        node.className = cls;
    }

    if (style !== undefined) {
        Object.assign(node.style, style);
    }

    if (dataset !== undefined) {
        for (const [k, v] of Object.entries(dataset)) {
            node.dataset[k] = v;
        }
    }

    if (on !== undefined) {
        for (const [k, v] of Object.entries(on)) {
            node.addEventListener(k, v);
        }
    }

    if (rawAttrs !== undefined) {
        for (const [k, v] of Object.entries(rawAttrs)) {
            if (v === undefined || v === false) {
                continue;
            }

            node.setAttribute(k, v === true ? '' : String(v));
        }
    }

    for (const [k, v] of Object.entries(rest)) {
        if (v !== undefined) {
            (node as unknown as Record<string, unknown>)[k] = v;
        }
    }

    if (text !== undefined) {
        node.textContent = text;
    } else if (html !== undefined) {
        node.innerHTML = html;
    }

    appendChild(node, children);

    return node;
};

export const clear = (node: Element): void => {
    while (node.firstChild) {
        node.removeChild(node.firstChild);
    }
};

export const fragment = (...children: Child[]): DocumentFragment => {
    const frag = document.createDocumentFragment();
    appendChild(frag, children);
    return frag;
};

export const mount = (host: HTMLElement, node: Node): void => {
    clear(host);
    host.appendChild(node);
};