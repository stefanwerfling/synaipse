import {describe, it, expect, afterEach} from 'vitest';
import {configureLogging, createLogger, setLogContextProvider, type LogRecord} from '../src/Log.js';

/** Plan P1 / G2: structured logger. */

const capture = (): {lines: string[]; records: LogRecord[]} => {
    const lines: string[] = [];
    const records: LogRecord[] = [];
    configureLogging({sink: (line, record) => { lines.push(line); records.push(record); }});
    return {lines, records};
};

afterEach(() => {
    configureLogging({level: 'info', format: 'text', sink: () => undefined});
    setLogContextProvider(() => undefined);
});

describe('Logger', () => {
    it('text format: component tag, level for non-info, key=value fields', () => {
        const {lines} = capture();
        const log = createLogger('service');
        log.info('indexed', {reindexed: 3, total: 10});
        log.warn('embedding failed', {noteId: 'a b.md', error: new Error('boom')});
        expect(lines).toEqual([
            '[synaipse:service] indexed reindexed=3 total=10',
            '[synaipse:service] WARN embedding failed noteId="a b.md" error="boom"'
        ]);
    });

    it('json format: one object per line, errors with stack', () => {
        const {lines} = capture();
        configureLogging({format: 'json'});
        createLogger('vault').error('commit failed', {error: new Error('x')});
        const obj = JSON.parse(lines[0]!) as Record<string, unknown>;
        expect(obj).toMatchObject({level: 'error', component: 'vault', msg: 'commit failed', error: {message: 'x'}});
        expect(typeof obj['time']).toBe('string');
        expect((obj['error'] as {stack?: string}).stack).toContain('Error: x');
    });

    it('filters by level', () => {
        const {lines} = capture();
        configureLogging({level: 'warn'});
        const log = createLogger('x');
        log.debug('d');
        log.info('i');
        log.warn('w');
        configureLogging({level: 'silent'});
        log.error('e');
        expect(lines).toEqual(['[synaipse:x] WARN w']);
    });

    it('merges context provider and child bindings', () => {
        const {records} = capture();
        setLogContextProvider(() => ({token: 'cli'}));
        createLogger('jobs').child({jobId: 'j1'}).info('done', {notes: 2});
        expect(records[0]!.fields).toEqual({token: 'cli', jobId: 'j1', notes: 2});
    });
});
