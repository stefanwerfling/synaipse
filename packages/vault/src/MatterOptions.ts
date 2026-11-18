/**
 * Pass to every `matter()` / `matter.stringify()` call. gray-matter caches
 * each input forever unless an options object is given; an empty one keeps
 * the default parsing and turns that cache off.
 */
export const NO_CACHE: Record<string, never> = Object.freeze({}) as Record<string, never>;
