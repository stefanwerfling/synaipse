import {el} from './Dom.js';
import {openDsgvoDialog} from './DsgvoDialog.js';
import {
    buildContainerAttrs,
    insertAt,
    insertCodeBlock as buildCodeBlock,
    insertContainer as buildContainer,
    insertLink as buildLink,
    prefixLines,
    wrap,
    type InsertionResult
} from './MarkdownInsertion.js';

/**
 * GitHub-style formatting toolbar that sits above the editor textarea.
 * Operates on the textarea's current selection by wrapping, line-
 * prefixing, or inserting at the caret — never replaces unrelated text,
 * never moves focus off the textarea (so keyboard-only editing keeps
 * working). After every mutation we fire `onChange(value)` so the
 * editor can re-render the preview and update its dirty flag.
 *
 * Keyboard shortcuts (Ctrl/Cmd):
 *   B → bold       I → italic     K → link
 *   E → inline code (matches the GH convention)
 *
 * Containers (`::: <type>`) get their own dropdown — the renderer side
 * lives in `MarkdownContainer.ts`, the LLM-side strip in
 * `service/src/Containers.ts`. Inserting picks `infographic` by default;
 * other types (warning / tip / note / success / danger) are one click
 * deeper in the dropdown.
 */

export interface EditorToolbarOptions {
    textarea: HTMLTextAreaElement;
    onChange: (value: string) => void;
}

interface SimpleButton {
    label: string;
    title: string;
    action: () => void;
}

const CONTAINER_TYPES: readonly {type: string; label: string; icon: string; color?: string}[] = [
    {type: 'infographic', label: 'Infographic step', icon: '🚀', color: 'blue'},
    {type: 'tip', label: 'Tip', icon: '💡'},
    {type: 'warning', label: 'Warning', icon: '⚠️'},
    {type: 'note', label: 'Note', icon: '📝'},
    {type: 'success', label: 'Success', icon: '✅'},
    {type: 'danger', label: 'Danger', icon: '🚨'}
];

export class EditorToolbar {
    public readonly element: HTMLElement;
    private readonly textarea: HTMLTextAreaElement;
    private readonly onChange: (value: string) => void;
    private containerMenu: HTMLElement | null = null;
    private nextStep = 1;

    public constructor(opts: EditorToolbarOptions) {
        this.textarea = opts.textarea;
        this.onChange = opts.onChange;
        this.element = el('div', {class: 'editor-toolbar', attrs: {role: 'toolbar'}});
        this.build();
        this.bindShortcuts();
    }

    private build(): void {
        const groups: SimpleButton[][] = [
            [
                {label: 'B', title: 'Bold (Ctrl+B)', action: () => this.wrap('**', '**', 'bold')},
                {label: 'I', title: 'Italic (Ctrl+I)', action: () => this.wrap('*', '*', 'italic')},
                {label: 'S̶', title: 'Strikethrough', action: () => this.wrap('~~', '~~', 'strikethrough')},
                {label: '</>', title: 'Inline code (Ctrl+E)', action: () => this.wrap('`', '`', 'code')}
            ],
            [
                {label: 'H1', title: 'Heading 1', action: () => this.prefix('# ')},
                {label: 'H2', title: 'Heading 2', action: () => this.prefix('## ')},
                {label: 'H3', title: 'Heading 3', action: () => this.prefix('### ')}
            ],
            [
                {label: '🔗', title: 'Link (Ctrl+K)', action: () => this.insertLink()},
                {label: '"', title: 'Quote', action: () => this.prefix('> ')},
                {label: '•', title: 'Bulleted list', action: () => this.prefix('- ')},
                {label: '1.', title: 'Numbered list', action: () => this.prefix('1. ')},
                {label: '☐', title: 'Task list', action: () => this.prefix('- [ ] ')}
            ],
            [
                {label: '{ }', title: 'Code block', action: () => this.insertCodeBlock()},
                {label: '—', title: 'Horizontal rule', action: () => this.insertAtCursor('\n\n---\n\n')},
                {label: '⊞', title: 'Table', action: () => this.insertTable()}
            ],
            [
                {label: '🔒', title: 'Mark selection as DSGVO (Ctrl+Shift+D)', action: () => this.openDsgvo()}
            ]
        ];

        for (let i = 0; i < groups.length; i++) {
            const group = groups[i] as SimpleButton[];
            const groupEl = el('div', {class: 'editor-toolbar-group'});

            for (const btn of group) {
                groupEl.appendChild(el('button', {
                    class: 'editor-toolbar-btn',
                    attrs: {type: 'button', title: btn.title, 'aria-label': btn.title},
                    text: btn.label,
                    on: {click: (e) => {
                        e.preventDefault();
                        btn.action();
                    }}
                }));
            }

            this.element.appendChild(groupEl);
        }

        this.element.appendChild(this.buildContainerDropdown());
    }

    private buildContainerDropdown(): HTMLElement {
        const wrap = el('div', {class: 'editor-toolbar-group editor-toolbar-container'});

        const btn = el('button', {
            class: 'editor-toolbar-btn',
            attrs: {type: 'button', title: 'Insert container block (infographic / tip / warning / note / …)', 'aria-haspopup': 'true'},
            text: '::: ▾',
            on: {click: (e) => {
                e.preventDefault();
                this.toggleContainerMenu(btn);
            }}
        });

        wrap.appendChild(btn);
        return wrap;
    }

    private toggleContainerMenu(anchor: HTMLElement): void {
        if (this.containerMenu !== null) {
            this.closeContainerMenu();
            return;
        }

        const menu = el('div', {class: 'editor-toolbar-menu', attrs: {role: 'menu'}});

        for (const opt of CONTAINER_TYPES) {
            const attrs = opt.type === 'infographic'
                ? buildContainerAttrs({
                    icon: opt.icon,
                    ...(opt.color !== undefined ? {color: opt.color} : {}),
                    step: this.nextStep
                })
                : '';

            menu.appendChild(el('button', {
                class: 'editor-toolbar-menu-item',
                attrs: {type: 'button', role: 'menuitem'},
                on: {click: (e) => {
                    e.preventDefault();
                    this.insertContainer(opt.type, attrs);
                    if (opt.type === 'infographic') this.nextStep++;
                    this.closeContainerMenu();
                }}
            },
                el('span', {class: 'editor-toolbar-menu-icon', text: opt.icon}),
                el('span', {text: opt.label})
            ));
        }

        const rect = anchor.getBoundingClientRect();
        menu.style.position = 'fixed';
        menu.style.top = `${rect.bottom + 4}px`;
        menu.style.left = `${rect.left}px`;

        document.body.appendChild(menu);
        this.containerMenu = menu;

        // Dismiss on outside click / Escape — defer to next tick so the
        // opening click itself doesn't immediately close us.
        window.setTimeout(() => {
            const onDoc = (ev: MouseEvent): void => {
                if (this.containerMenu !== null && !this.containerMenu.contains(ev.target as Node)) {
                    this.closeContainerMenu();
                }
            };
            const onEsc = (ev: KeyboardEvent): void => {
                if (ev.key === 'Escape') {
                    this.closeContainerMenu();
                }
            };
            document.addEventListener('mousedown', onDoc, {once: true});
            document.addEventListener('keydown', onEsc, {once: true});
        }, 0);
    }

    private closeContainerMenu(): void {
        if (this.containerMenu !== null) {
            this.containerMenu.remove();
            this.containerMenu = null;
        }
    }

    private bindShortcuts(): void {
        this.textarea.addEventListener('keydown', (e) => {
            if (!(e.ctrlKey || e.metaKey) || e.altKey) return;

            const key = e.key.toLowerCase();
            if (e.shiftKey) {
                if (key === 'd') { e.preventDefault(); this.openDsgvo(); }
                return;
            }
            if (key === 'b') { e.preventDefault(); this.wrap('**', '**', 'bold'); }
            else if (key === 'i') { e.preventDefault(); this.wrap('*', '*', 'italic'); }
            else if (key === 'e') { e.preventDefault(); this.wrap('`', '`', 'code'); }
            else if (key === 'k') { e.preventDefault(); this.insertLink(); }
        });
    }

    private sel(): {start: number; end: number} {
        return {start: this.textarea.selectionStart, end: this.textarea.selectionEnd};
    }

    private wrap(before: string, after: string, placeholder: string): void {
        const {start, end} = this.sel();
        this.apply(wrap(this.textarea.value, start, end, before, after, placeholder));
    }

    private prefix(prefix: string): void {
        const {start, end} = this.sel();
        this.apply(prefixLines(this.textarea.value, start, end, prefix));
    }

    private insertAtCursor(text: string): void {
        const {start, end} = this.sel();
        this.apply(insertAt(this.textarea.value, start, end, text));
    }

    private insertLink(): void {
        const {start, end} = this.sel();
        this.apply(buildLink(this.textarea.value, start, end));
    }

    private insertCodeBlock(): void {
        const {start, end} = this.sel();
        this.apply(buildCodeBlock(this.textarea.value, start, end));
    }

    private insertTable(): void {
        this.insertAtCursor('\n| Column 1 | Column 2 |\n| -------- | -------- |\n| cell     | cell     |\n');
    }

    private insertContainer(type: string, attrs: string): void {
        const {start, end} = this.sel();
        this.apply(buildContainer(this.textarea.value, start, end, type, attrs));
    }

    /**
     * Open the DSGVO dialog for the current selection. Multi-line
     * selections aren't allowed — the `[[dsgvo:kind|text]]` marker must
     * stay on one line for the preview's wikilink walk to match. Empty
     * selection is rejected with a subtle prompt via `alert` (dialog UX
     * doesn't need selection because there's nothing to wrap).
     */
    private openDsgvo(): void {
        const {start, end} = this.sel();
        if (end <= start) {
            window.alert('Erst Text markieren, den du als DSGVO-relevant kennzeichnen willst.');
            this.textarea.focus();
            return;
        }
        const selection = this.textarea.value.slice(start, end);
        if (selection.includes('\n')) {
            window.alert('DSGVO-Marker unterstützen nur einzeilige Markierungen.');
            this.textarea.focus();
            return;
        }
        openDsgvoDialog({
            selection,
            onConfirm: (marker) => {
                const result: InsertionResult = {
                    value: this.textarea.value.slice(0, start) + marker + this.textarea.value.slice(end),
                    selStart: start,
                    selEnd: start + marker.length
                };
                this.apply(result);
            },
            onCancel: () => this.textarea.focus()
        });
    }

    private apply(result: InsertionResult): void {
        this.textarea.value = result.value;
        this.textarea.focus();
        this.textarea.selectionStart = result.selStart;
        this.textarea.selectionEnd = result.selEnd;
        this.onChange(result.value);
    }

    public destroy(): void {
        this.closeContainerMenu();
    }
}