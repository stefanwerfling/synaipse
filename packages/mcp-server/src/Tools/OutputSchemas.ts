/**
 * Output schemas (MCP `outputSchema`, plan P8 / B1) for the tools a
 * program is most likely to consume. A tool listed here also returns
 * `structuredContent` — the same object as its JSON text (see Acl.ts).
 * Kept loose (only the stable core fields, extra fields allowed): the
 * client validates every result against it.
 */
type Schema = Record<string, unknown>;
/** The MCP shape of an output schema: an object schema at the top. */
export type ObjectSchema = {type: 'object'; properties?: Record<string, object>; required?: string[]; [key: string]: unknown};

const str = {type: 'string'};
const num = {type: 'number'};
const obj = (properties: Record<string, Schema>, required: string[] = []): ObjectSchema => ({type: 'object', properties, ...(required.length > 0 ? {required} : {})});
const arr = (items: Schema): Schema => ({type: 'array', items});

const modified = {modified: str, age: str};

const writeResult = obj({id: str, title: str, hash: str, ...modified, changed: {type: 'boolean'}, warnings: arr(str)}, ['id', 'hash']);

export const OUTPUT_SCHEMAS: Readonly<Record<string, ObjectSchema>> = {
    synaipse_search: obj({
        hits: arr(obj({noteId: str, title: str, score: num, snippet: str, section: str, lines: arr({type: 'integer'}), supersededBy: str}, ['noteId', 'title', 'score'])),
        skippedByConsent: num
    }, ['hits']),
    synaipse_read_note: obj({
        note: obj({id: str, title: str, hash: str, content: str, tags: arr(str), ...modified, supersededBy: str}, ['id', 'content'])
    }, ['note']),
    synaipse_list: obj({
        notes: arr(obj({id: str, title: str, tags: arr(str), ...modified}, ['id', 'title'])),
        total: num,
        nextCursor: str,
        removed: arr(obj({id: str, how: {type: 'string', enum: ['deleted', 'archived']}, ...modified}, ['id', 'how']))
    }, ['notes', 'total']),
    synaipse_note_history: obj({
        id: str,
        versions: arr(obj({sha: str, tool: str, ...modified}, ['sha'])),
        from: str,
        diff: str
    }, ['id']),
    synaipse_write_note: writeResult,
    synaipse_update_note: writeResult,
    synaipse_edit_note: writeResult
};
