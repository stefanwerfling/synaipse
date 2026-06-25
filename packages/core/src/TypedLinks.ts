import {TYPED_LINK_KINDS, type Frontmatter, type TypedLink, type TypedLinkKind} from './Types.js';

export const isTypedLinkKind = (value: unknown): value is TypedLinkKind => {
    return typeof value === 'string' && (TYPED_LINK_KINDS as readonly string[]).includes(value);
};

/**
 * Extract validated typed links from a note's frontmatter. Malformed entries
 * (missing target, unknown kind, wrong shape) are silently skipped — typed
 * links are an optional augmentation, never a hard validation surface.
 *
 * The expected YAML shape:
 *
 *   links:
 *     - target: "Foo"
 *       kind: supersedes
 *     - target: "Bar"
 *       kind: relates_to
 */
export const extractTypedLinks = (frontmatter: Frontmatter): TypedLink[] => {
    const raw = frontmatter.links;

    if (!Array.isArray(raw)) {
        return [];
    }

    const out: TypedLink[] = [];

    for (const entry of raw) {
        if (entry === null || typeof entry !== 'object') {
            continue;
        }

        const candidate = entry as {target?: unknown; kind?: unknown};

        if (typeof candidate.target !== 'string' || candidate.target.length === 0) {
            continue;
        }

        if (!isTypedLinkKind(candidate.kind)) {
            continue;
        }

        out.push({target: candidate.target, kind: candidate.kind});
    }

    return out;
};