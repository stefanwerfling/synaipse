export interface ResolveSummary {
    id: string;
    title: string;
    aliases: string[];
}

export type WikilinkResolver = (titleOrAlias: string) => string | undefined;

export const buildWikilinkResolver = (notes: readonly ResolveSummary[]): WikilinkResolver => {
    const byKey = new Map<string, string>();

    for (const n of notes) {
        if (n.title.length > 0 && !byKey.has(n.title)) {
            byKey.set(n.title, n.id);
        }
    }

    for (const n of notes) {
        for (const alias of n.aliases) {
            if (alias.length > 0 && !byKey.has(alias)) {
                byKey.set(alias, n.id);
            }
        }
    }

    return (key) => byKey.get(key);
};

export const slugify = (input: string): string => {
    return input
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
};

export const splitWikilinkTarget = (raw: string): {title: string; label: string} => {
    const pipe = raw.indexOf('|');

    if (pipe === -1) {
        const hash = raw.indexOf('#');
        const title = hash === -1 ? raw : raw.slice(0, hash);
        return {title: title.trim(), label: raw.trim()};
    }

    return {title: raw.slice(0, pipe).trim(), label: raw.slice(pipe + 1).trim()};
};