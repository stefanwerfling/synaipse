/**
 * Path scope of a search (plan P4 / A4). Projects are folders
 * (`Memory/<project>/`), MCP tokens are restricted by path prefixes, the
 * chat scopes by `pathPrefix` and relink skips imported folders, so one
 * prefix-based scope covers all of them.
 *
 * - `include`: a note matches if its id starts with ANY of them
 *   (absent or empty = everything).
 * - `exclude`: a note never matches if its id starts with any of them.
 */
export interface SearchScope {
    include?: readonly string[];
    exclude?: readonly string[];
}

export const isUnscoped = (scope: SearchScope | undefined): boolean =>
    scope === undefined
    || ((scope.include === undefined || scope.include.length === 0) && (scope.exclude === undefined || scope.exclude.length === 0));

export const inScope = (id: string, scope: SearchScope | undefined): boolean => {
    if (scope === undefined) return true;
    if (scope.exclude !== undefined && scope.exclude.some((p) => id.startsWith(p))) return false;
    if (scope.include === undefined || scope.include.length === 0) return true;
    return scope.include.some((p) => id.startsWith(p));
};

/** Marker every note carries in its {@link dirPrefixes}, also notes at the vault root. */
export const ROOT_DIR = '/';

/**
 * Folder prefixes of a note id: `Memory/p/x.md` → `['/', 'Memory/', 'Memory/p/']`.
 * Stored with each vector so a vector store can filter by folder with an
 * exact keyword match instead of a prefix scan.
 */
export const dirPrefixes = (id: string): string[] => {
    const out = [ROOT_DIR];
    let at = id.indexOf('/');

    while (at !== -1) {
        out.push(id.slice(0, at + 1));
        at = id.indexOf('/', at + 1);
    }

    return out;
};

/**
 * The folder part of a prefix: `Memory/dec` → `Memory/`, `Memory/p/` stays.
 * A store filters on this; a prefix that does not end at a folder
 * boundary still needs the exact {@link inScope} check afterwards.
 */
export const folderOf = (prefix: string): string => {
    const at = prefix.lastIndexOf('/');
    return at === -1 ? ROOT_DIR : prefix.slice(0, at + 1);
};

/**
 * Both scopes at once (e.g. a requested project inside a token's allowed
 * paths). Includes intersect: of each pair the longer prefix survives if
 * it lies inside the other. Excludes add up. `null` = nothing can match.
 */
export const intersectScopes = (a: SearchScope | undefined, b: SearchScope | undefined): SearchScope | null => {
    const incA = a?.include ?? [];
    const incB = b?.include ?? [];
    const exclude = [...(a?.exclude ?? []), ...(b?.exclude ?? [])];

    let include: string[];
    if (incA.length === 0) {
        include = [...incB];
    } else if (incB.length === 0) {
        include = [...incA];
    } else {
        const set = new Set<string>();
        for (const x of incA) {
            for (const y of incB) {
                if (x.startsWith(y)) set.add(x);
                else if (y.startsWith(x)) set.add(y);
            }
        }
        if (set.size === 0) return null;
        include = [...set];
    }

    return {
        ...(include.length > 0 ? {include} : {}),
        ...(exclude.length > 0 ? {exclude} : {})
    };
};
