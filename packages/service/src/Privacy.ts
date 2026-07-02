import type {Note} from '@synaipse/core';

/**
 * DSGVO Layer 2: classify a note as "private" — must not leave the host
 * when the chat provider is external. Triggers (any one is enough):
 *
 *  - `frontmatter.private === true`
 *  - `frontmatter.dsgvo === true`
 *  - tag `private` (synaipse stores tags without the `#` prefix in
 *    `note.tags`; frontmatter `tags:` arrays follow the same convention)
 *  - path begins with `Private/`, `Personal/` or `secrets/` (matched
 *    case-insensitively so vault layout typos don't punch holes in the guard)
 *
 * Pure function — no I/O, no Service dependency. Service decides what to
 * *do* with the verdict (filter, abort, fall back to deterministic mode).
 */

const PRIVATE_PATH_PREFIXES: readonly string[] = ['private/', 'personal/', 'secrets/'];

export const isPathPrivate = (path: string): boolean => {
    const lower = path.toLowerCase();
    return PRIVATE_PATH_PREFIXES.some((p) => lower.startsWith(p));
};

const hasPrivateTag = (tags: readonly string[]): boolean => {
    return tags.some((t) => t.toLowerCase() === 'private' || t.toLowerCase() === '#private');
};

export const isNotePrivate = (note: Note): boolean => {
    if (note.frontmatter.private === true) return true;
    if (note.frontmatter.dsgvo === true) return true;
    if (hasPrivateTag(note.tags)) return true;
    if (isPathPrivate(note.path)) return true;
    if (isPathPrivate(note.id)) return true;
    return false;
};

/**
 * DSGVO Layer 3: scan content for obvious PII / secrets and replace each
 * match with `[REDACTED <kind>]`. Pure function — no I/O, no Service
 * dependency. Callers (Service) decide whether to apply it (external
 * provider) or skip it (local provider).
 *
 * Detectors are ordered specific-first so that high-entropy tokens (JWT,
 * API keys) are caught before the more permissive email/phone/IP scanners
 * could partially consume them. Redaction is idempotent — the resulting
 * `[REDACTED …]` strings don't match any detector pattern.
 *
 * Note: this is a best-effort filter, not a guarantee. Names, addresses,
 * birthdates and free-form sensitive context still pass through; that's
 * what Layer 2 (path/tag/frontmatter marker → block entirely) is for.
 */

export interface RedactionHit {
    kind: string;
    count: number;
}

export interface RedactionResult {
    redacted: string;
    hits: RedactionHit[];
}

interface Detector {
    kind: string;
    label: string;
    pattern: RegExp;
    validate?: (match: string) => boolean;
}

const luhnValid = (digits: string): boolean => {
    const stripped = digits.replace(/[\s-]/g, '');
    if (stripped.length < 13 || stripped.length > 19) return false;
    if (!/^\d+$/.test(stripped)) return false;

    let sum = 0;
    let alternate = false;

    for (let i = stripped.length - 1; i >= 0; i--) {
        let n = Number(stripped[i]);

        if (alternate) {
            n *= 2;
            if (n > 9) n -= 9;
        }

        sum += n;
        alternate = !alternate;
    }

    return sum % 10 === 0;
};

const DETECTORS: readonly Detector[] = [
    // Manual DSGVO marker `[[dsgvo:kind|text]]` — placed by the editor
    // dialog. Must run before any auto-detector so that an email/phone
    // wrapped by the user gets the user's chosen kind, not the automatic
    // one. Kind is passed through as-is (`[redact:<kind>]`), which also
    // means custom-labels (patient-id, vertragsnr, …) show up verbatim
    // in the audit log.
    {
        kind: 'dsgvo_marker',
        label: 'dsgvo',
        pattern: /\[\[dsgvo:([a-z][a-z0-9_-]{0,31})\|([^\]\n]+)\]\]/gi
    },

    // High-entropy / specific tokens first — order matters so a JWT doesn't
    // get half-matched by the email or IP pattern downstream.
    {kind: 'jwt', label: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g},
    {kind: 'aws_key', label: 'aws-key', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g},
    {kind: 'github_token', label: 'github-token', pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g},
    {kind: 'slack_token', label: 'slack-token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g},
    // Anthropic before generic openai-style so `sk-ant-…` is attributed correctly.
    {kind: 'anthropic_key', label: 'anthropic-key', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g},
    {kind: 'openai_key', label: 'openai-key', pattern: /\bsk-(?:proj-|live-)?[A-Za-z0-9_-]{20,}\b/g},

    // Password-field heuristic. Match `passwort:` or `password:` (any case)
    // followed by a non-trivial value on the same line. We deliberately
    // bound the value at >=6 non-space chars so trivial placeholders
    // ("password: TODO") don't get redacted into a noisy marker.
    {kind: 'password', label: 'password', pattern: /(passw(?:or[dt])\s*[:=]\s*)([^\s\n]{6,})/gi},

    // Banking
    {kind: 'iban', label: 'iban', pattern: /\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/g},
    {kind: 'bic', label: 'bic', pattern: /\b[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}(?:[A-Z0-9]{3})?\b/g},

    // Credit card with Luhn check to keep false-positives off random 16-digit IDs
    {
        kind: 'creditcard',
        label: 'card',
        pattern: /\b(?:\d[ -]?){13,19}\b/g,
        validate: luhnValid
    },

    // Communications
    {kind: 'email', label: 'email', pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi},

    // DE + international phone numbers — conservative: requires +CC or 00CC
    // prefix to avoid eating random digit groups. Falls short on plain "0…"
    // DE-domestic numbers but that's the price for low false-positive rate
    // in mixed technical content (issue numbers, port numbers, …).
    {kind: 'phone', label: 'phone', pattern: /(?:\+|00)\d{1,3}[ \d./-]{6,18}\d/g},

    // IPs last — high false-positive risk otherwise.
    {kind: 'ipv4', label: 'ipv4', pattern: /\b(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b/g},
    {kind: 'ipv6', label: 'ipv6', pattern: /\b(?:[A-Fa-f0-9]{1,4}:){7}[A-Fa-f0-9]{1,4}\b|\b(?:[A-Fa-f0-9]{1,4}:){1,7}:(?:[A-Fa-f0-9]{1,4})?\b/g}
];

export const redactSensitive = (content: string): RedactionResult => {
    let result = content;
    const counts = new Map<string, number>();

    for (const d of DETECTORS) {
        result = result.replace(d.pattern, (...args: unknown[]) => {
            const match = args[0] as string;

            if (d.validate !== undefined && !d.validate(match)) {
                return match;
            }

            // Manual dsgvo marker carries its kind as the first capture
            // group. Use that as the `[redact:<kind>]` label so custom
            // categories (patient-id, vertragsnr, …) survive to the audit
            // log — otherwise every manual marker would collapse to
            // `[redact:dsgvo]`. The `dsgvo:` prefix on the count key keeps
            // manual hits distinguishable from auto-detects when the
            // audit UI groups them.
            if (d.kind === 'dsgvo_marker') {
                const kindCapture = (args[1] as string).toLowerCase();
                const countKey = `dsgvo:${kindCapture}`;
                counts.set(countKey, (counts.get(countKey) ?? 0) + 1);
                return `[redact:${kindCapture}]`;
            }

            // Marker shape `[redact:<label>]` — lowercase + colon so the
            // marker itself cannot be re-matched by any detector (BIC's
            // 8-uppercase shape ate plain "REDACTED" otherwise, breaking
            // idempotency).
            const marker = `[redact:${d.label}]`;

            // Password detector has a capture group for the field-prefix; we
            // keep the prefix and only redact the value. Every other detector
            // replaces the whole match.
            if (d.kind === 'password') {
                const prefix = args[1] as string;
                counts.set(d.kind, (counts.get(d.kind) ?? 0) + 1);
                return `${prefix}${marker}`;
            }

            counts.set(d.kind, (counts.get(d.kind) ?? 0) + 1);
            return marker;
        });
    }

    const hits: RedactionHit[] = Array.from(counts.entries())
        .map(([kind, count]) => ({kind, count}))
        .sort((a, b) => a.kind.localeCompare(b.kind));

    return {redacted: result, hits};
};