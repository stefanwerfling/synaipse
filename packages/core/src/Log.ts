/**
 * Structured logging (plan P1 / G2). Dependency-free and browser-safe —
 * no node imports; on the server it writes to stderr, never stdout,
 * because stdout carries the MCP stdio protocol.
 *
 *   const log = createLogger('service');
 *   log.warn('embedding failed', {noteId, error});
 *
 * Environment:
 *   SYNAIPSE_LOG_LEVEL  debug | info (default) | warn | error | silent
 *   SYNAIPSE_LOG_FORMAT text (default, "[synaipse:service] WARN msg k=v") | json (one object per line)
 *
 * Context such as the calling MCP token or an HTTP request id is merged
 * into every line via {@link setLogContextProvider}, so call sites don't
 * thread it through.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';
export type LogFields = Record<string, unknown>;

export interface Logger {
    debug(message: string, fields?: LogFields): void;
    info(message: string, fields?: LogFields): void;
    warn(message: string, fields?: LogFields): void;
    error(message: string, fields?: LogFields): void;
    /** Logger with extra fixed fields (e.g. {jobId}). */
    child(bindings: LogFields): Logger;
}

export interface LogRecord {
    time: string;
    level: Exclude<LogLevel, 'silent'>;
    component: string;
    message: string;
    fields: LogFields;
}

const RANK: Record<LogLevel, number> = {debug: 10, info: 20, warn: 30, error: 40, silent: 99};

interface LogSettings {
    level: LogLevel;
    format: 'text' | 'json';
    sink: (line: string, record: LogRecord) => void;
    context: () => LogFields | undefined;
}

const env = (): Record<string, string | undefined> =>
    (globalThis as {process?: {env?: Record<string, string | undefined>}}).process?.env ?? {};

const defaultSink = (line: string): void => {
    const stderr = (globalThis as {process?: {stderr?: {write?: (s: string) => unknown}}}).process?.stderr;
    if (stderr?.write !== undefined) {
        stderr.write(`${line}\n`);
    } else {
        console.warn(line);
    }
};

const parseLevel = (raw: string | undefined): LogLevel =>
    raw !== undefined && raw in RANK ? raw as LogLevel : 'info';

const settings: LogSettings = {
    level: parseLevel(env().SYNAIPSE_LOG_LEVEL),
    format: env().SYNAIPSE_LOG_FORMAT === 'json' ? 'json' : 'text',
    sink: defaultSink,
    context: () => undefined
};

/** Override level/format/sink at runtime (tests, embedding hosts like PKG Studio). */
export const configureLogging = (patch: Partial<Pick<LogSettings, 'level' | 'format' | 'sink'>>): void => {
    Object.assign(settings, patch);
};

/** Fields merged into every record, e.g. the current request id. Last call wins. */
export const setLogContextProvider = (provider: () => LogFields | undefined): void => {
    settings.context = provider;
};

/** Error → {message, stack?}; anything else passes through. */
const normalise = (value: unknown): unknown => {
    if (value instanceof Error) {
        return {message: value.message, ...(value.stack !== undefined ? {stack: value.stack} : {})};
    }
    return value;
};

const textValue = (value: unknown): string => {
    if (value instanceof Error) return JSON.stringify(value.message);
    if (typeof value === 'string') return /[\s"=]/.test(value) ? JSON.stringify(value) : value;
    if (typeof value === 'number' || typeof value === 'boolean' || value === null) return String(value);
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
};

const emit = (record: LogRecord): void => {
    if (settings.format === 'json') {
        const fields = Object.fromEntries(Object.entries(record.fields).map(([k, v]) => [k, normalise(v)]));
        settings.sink(JSON.stringify({time: record.time, level: record.level, component: record.component, msg: record.message, ...fields}), record);
        return;
    }
    const tail = Object.entries(record.fields)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => `${k}=${textValue(v)}`)
        .join(' ');
    const level = record.level === 'info' ? '' : `${record.level.toUpperCase()} `;
    settings.sink(`[synaipse:${record.component}] ${level}${record.message}${tail.length > 0 ? ` ${tail}` : ''}`, record);
};

const make = (component: string, bindings: LogFields): Logger => {
    const log = (level: Exclude<LogLevel, 'silent'>, message: string, fields?: LogFields): void => {
        if (RANK[level] < RANK[settings.level]) return;
        emit({
            time: new Date().toISOString(),
            level,
            component,
            message,
            fields: {...settings.context(), ...bindings, ...fields}
        });
    };
    return {
        debug: (m, f) => log('debug', m, f),
        info: (m, f) => log('info', m, f),
        warn: (m, f) => log('warn', m, f),
        error: (m, f) => log('error', m, f),
        child: (more) => make(component, {...bindings, ...more})
    };
};

export const createLogger = (component: string): Logger => make(component, {});
