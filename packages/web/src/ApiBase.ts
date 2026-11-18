/**
 * Single place that turns an API path into a URL (plan P3 / E1).
 *
 * Standalone the base is empty and `/api/notes` stays `/api/notes`.
 * Embedded (PKG Studio) `mount()` sets the base, e.g. `/synaipse`, and
 * every fetch, EventSource and `<img src>` goes to `/synaipse/api/...`
 * — no host-side `window.fetch` rewrite needed, and polling from a
 * background tab can't be routed to the wrong module.
 *
 * Module-level state: one base per page. Two Synaipse mounts on the same
 * page would have to share it, which is fine — they talk to one backend.
 */
let base = '';

const normalise = (raw: string): string => {
    const trimmed = raw.trim().replace(/\/+$/, '');
    if (trimmed.length === 0) return '';
    return trimmed.startsWith('/') || /^https?:\/\//.test(trimmed) ? trimmed : `/${trimmed}`;
};

export const setApiBase = (raw: string | undefined): void => {
    base = normalise(raw ?? '');
};

export const getApiBase = (): string => base;

/** `/api/notes` → `<base>/api/notes`. Absolute URLs pass through. */
export const apiUrl = (path: string): string => {
    if (/^https?:\/\//.test(path)) return path;
    return `${base}${path.startsWith('/') ? path : `/${path}`}`;
};
