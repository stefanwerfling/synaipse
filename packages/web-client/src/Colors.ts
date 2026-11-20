export const hashString = (input: string): number => {
    let h = 0;

    for (let i = 0; i < input.length; i += 1) {
        h = (h * 31 + input.charCodeAt(i)) | 0;
    }

    return Math.abs(h);
};

export const tagColor = (tag: string): string => {
    const hue = (hashString(tag) * 137) % 360;

    return `hsl(${hue}, 60%, 58%)`;
};

export const NEUTRAL_COLOR = '#6b7280';

// --- readable tag text (WCAG AA) -------------------------------------------

/** Tag text must reach this against the darkest/lightest background it sits on (AA is 4.5). */
const TAG_TEXT_CONTRAST = 4.6;
/** Worst backgrounds a tag label sits on: the selected note row in each theme. */
const TAG_TEXT_BG = {dark: [0x20, 0x29, 0x3d], light: [0xd7, 0xdf, 0xef]} as const;

const channel = (c: number): number => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};

const luminance = ([r, g, b]: readonly number[]): number =>
    0.2126 * channel(r!) + 0.7152 * channel(g!) + 0.0722 * channel(b!);

export const contrastRatio = (a: readonly number[], b: readonly number[]): number => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
    return (hi + 0.05) / (lo + 0.05);
};

/** HSL (s, l in 0..100) → sRGB 0..255. */
export const hslToRgb = (h: number, s: number, l: number): [number, number, number] => {
    const sat = s / 100;
    const lig = l / 100;
    const k = (n: number): number => (n + h / 30) % 12;
    const a = sat * Math.min(lig, 1 - lig);
    const f = (n: number): number => Math.round(255 * (lig - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))));
    return [f(0), f(8), f(4)];
};

/**
 * The tag's hue at a lightness that reads as text on the theme's
 * backgrounds: from the swatch lightness (58 %) up for dark, down for
 * light, until {@link TAG_TEXT_CONTRAST} is met. Equal lightness is not
 * enough: a green or yellow at 58 % is far brighter than a blue.
 */
export const tagTextColor = (tag: string, theme: 'dark' | 'light'): string => {
    const hue = (hashString(tag) * 137) % 360;
    const bg = TAG_TEXT_BG[theme];
    const step = theme === 'dark' ? 1 : -1;
    let l = 58;
    while (l > 0 && l < 100 && contrastRatio(hslToRgb(hue, 60, l), bg) < TAG_TEXT_CONTRAST) l += step;
    return `hsl(${hue}, 60%, ${l}%)`;
};

/**
 * Colour `node`'s text in the tag's readable colour for both themes; the
 * stylesheet picks the one for the active theme (class `tag-text`).
 */
export const applyTagText = <T extends HTMLElement>(node: T, tag: string): T => {
    node.classList.add('tag-text');
    node.style.setProperty('--tag-fg-dark', tagTextColor(tag, 'dark'));
    node.style.setProperty('--tag-fg-light', tagTextColor(tag, 'light'));
    return node;
};

/**
 * Fill `node` with the tag's readable colour (selected chips): light enough
 * for dark text in the dark theme, dark enough for white text in the light
 * one (class `tag-fill`).
 */
export const applyTagFill = <T extends HTMLElement>(node: T, tag: string): T => {
    applyTagText(node, tag);
    node.classList.replace('tag-text', 'tag-fill');
    return node;
};

export const colorForNode = (tags: string[]): string => {
    const first = tags[0];

    return first === undefined ? NEUTRAL_COLOR : tagColor(first);
};