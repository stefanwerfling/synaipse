/**
 * Pass to every `matter()` / `matter.stringify()` call.
 *
 * - gray-matter caches each input forever unless an options object is
 *   given; any options object turns that cache off.
 * - gray-matter evaluates a `---js` / `---javascript` block as JavaScript
 *   (its `javascript` engine runs `eval`). Notes come from MCP clients,
 *   the clipper and crawlers, and `matter.stringify()` parses the content
 *   it is given too, so writing a note that starts with `---js` ran code
 *   in the server. The engine is replaced by one that reads nothing.
 */
const refuseJavaScript = Object.freeze({
    parse: (): Record<string, never> => ({}),
    stringify: (): never => {
        throw new Error('JavaScript front matter is not supported');
    }
});

export const NO_CACHE = Object.freeze({
    engines: Object.freeze({javascript: refuseJavaScript})
}) as unknown as Record<string, never>;
