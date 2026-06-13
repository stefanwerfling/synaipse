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

export const colorForNode = (tags: string[]): string => {
    const first = tags[0];

    return first === undefined ? NEUTRAL_COLOR : tagColor(first);
};