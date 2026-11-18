/**
 * Pure helpers for the editor toolbar's text-mutation primitives.
 * Separated from `EditorToolbar.ts` so the index-math (selection
 * boundaries, line expansion, container-fence indentation) is testable
 * in Node without a DOM. The toolbar wires these to the textarea and
 * fires the `onChange` callback; everything below is referentially
 * transparent.
 */

export interface InsertionResult {
    value: string;
    selStart: number;
    selEnd: number;
}

export const wrap = (
    text: string,
    start: number,
    end: number,
    before: string,
    after: string,
    placeholder: string
): InsertionResult => {
    const hadSelection = end > start;
    const selected = hadSelection ? text.slice(start, end) : placeholder;
    const value = text.slice(0, start) + before + selected + after + text.slice(end);
    const selStart = start + before.length;
    const selEnd = selStart + selected.length;
    return {value, selStart, selEnd};
};

export const prefixLines = (
    text: string,
    start: number,
    end: number,
    prefix: string
): InsertionResult => {
    const lineStart = text.lastIndexOf('\n', start - 1) + 1;
    const nl = text.indexOf('\n', end);
    const lineEnd = nl === -1 ? text.length : nl;

    const block = text.slice(lineStart, lineEnd);
    const prefixed = block.split('\n').map((l) => prefix + l).join('\n');
    const value = text.slice(0, lineStart) + prefixed + text.slice(lineEnd);

    return {value, selStart: lineStart, selEnd: lineStart + prefixed.length};
};

export const insertAt = (
    text: string,
    start: number,
    end: number,
    insertion: string
): InsertionResult => {
    const value = text.slice(0, start) + insertion + text.slice(end);
    const cursor = start + insertion.length;
    return {value, selStart: cursor, selEnd: cursor};
};

export const insertLink = (
    text: string,
    start: number,
    end: number
): InsertionResult => {
    const selected = text.slice(start, end);
    const label = selected.length > 0 ? selected : 'text';
    const insertion = `[${label}](url)`;
    const value = text.slice(0, start) + insertion + text.slice(end);
    const urlStart = start + label.length + 3;
    const urlEnd = urlStart + 3;
    return {value, selStart: urlStart, selEnd: urlEnd};
};

export const insertCodeBlock = (
    text: string,
    start: number,
    end: number
): InsertionResult => {
    const selected = text.slice(start, end);
    const body = selected.length > 0 ? selected : 'code';
    const insertion = `\n\`\`\`\n${body}\n\`\`\`\n`;
    const value = text.slice(0, start) + insertion + text.slice(end);
    const bodyStart = start + 5; // after \n```\n
    return {value, selStart: bodyStart, selEnd: bodyStart + body.length};
};

/**
 * Build the attribute string `{ icon: "…", color: "…", step: N }` for
 * an infographic container insert. Returns `''` if no attrs were given
 * — keeps the fence header clean for plain `::: tip` etc.
 */
export const buildContainerAttrs = (opts: {icon?: string; color?: string; step?: number}): string => {
    const parts: string[] = [];
    if (opts.icon !== undefined && opts.icon.length > 0) parts.push(`icon: "${opts.icon}"`);
    if (opts.color !== undefined && opts.color.length > 0) parts.push(`color: "${opts.color}"`);
    if (opts.step !== undefined) parts.push(`step: ${opts.step}`);
    return parts.length === 0 ? '' : ` { ${parts.join(', ')} }`;
};

export const insertContainer = (
    text: string,
    start: number,
    end: number,
    type: string,
    attrs: string
): InsertionResult => {
    const selected = text.slice(start, end);
    const body = selected.length > 0 ? selected : 'Content';
    const needsLeadingNl = start > 0 && text[start - 1] !== '\n';
    const lead = needsLeadingNl ? '\n' : '';
    const fenceHeader = `::: ${type}${attrs}\n`;
    const insertion = `${lead}${fenceHeader}${body}\n:::\n`;
    const value = text.slice(0, start) + insertion + text.slice(end);

    const bodyStart = start + lead.length + fenceHeader.length;
    return {value, selStart: bodyStart, selEnd: bodyStart + body.length};
};