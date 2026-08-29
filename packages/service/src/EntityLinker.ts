const MIN_SPAN_LENGTH = 3;

// Runs of capitalized/alphanumeric tokens (e.g. "Neo4j", "Graph3D", "Vector1
// AI"). Measured against the real ~2.8k-note synaipse-vault: compromise's
// #ProperNoun/#Acronym tagger added ~11% more raw matches than this regex
// alone (and still missed "Neo4j"/"Relik") at ~340x the cost (54s vs 160ms
// for the full vault) — not worth the dependency for this closed-vocabulary
// use case, where precision comes from the title/alias lookup, not from the
// span extraction itself.
const CAPITALIZED_RUN = /\b[A-Z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*(?:\s+[A-Z][A-Za-z0-9]*)*\b/g;

/**
 * Extracts candidate entity spans (capitalized/technical terms) from free
 * text. Deliberately coarse and over-inclusive — this is not a precision NER
 * pipeline. Callers are expected to filter the result against a known
 * vocabulary (e.g. note titles); false positives that don't match anything
 * in that vocabulary are harmless.
 */
export function extractEntitySpans(text: string): string[] {
    const spans = new Set<string>();

    for (const match of text.matchAll(CAPITALIZED_RUN)) {
        const trimmed = match[0].trim();

        if (trimmed.length >= MIN_SPAN_LENGTH) {
            spans.add(trimmed);
        }
    }

    return [...spans];
}
