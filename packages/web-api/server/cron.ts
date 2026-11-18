/**
 * Tiny cron grammar for the scheduler runner. Deliberately narrower
 * than crontab syntax — we cover the two cases users actually ask for
 * ("check every 2 hours", "daily at 8am") and reject everything else
 * with a clear message. Callers should surface parse errors back to
 * the UI rather than accepting mystery strings.
 *
 * Grammar:
 *   every Nh                — fire every N hours (N in 1..999)
 *   daily HH:MM             — fire once per day at HH:MM local time
 *
 * If v1 turns out to be too restrictive in practice, expanding to
 * cron-parser or `every Nm`/`every Nd` is a purely additive change —
 * the parser returns a discriminated ParsedCron so new variants slot
 * in without breaking callers.
 */

export type ParsedCron =
    | {kind: 'every-hours'; hours: number}
    | {kind: 'daily'; hour: number; minute: number};

export interface CronParseError {
    ok: false;
    message: string;
}

export interface CronParseOk {
    ok: true;
    parsed: ParsedCron;
}

export const parseCron = (expr: string): CronParseOk | CronParseError => {
    const trimmed = expr.trim();

    const everyMatch = /^every\s+(\d{1,3})h$/i.exec(trimmed);
    if (everyMatch !== null) {
        const hours = Number.parseInt(everyMatch[1] as string, 10);
        if (hours < 1) {
            return {ok: false, message: `'every Nh' requires N >= 1 (got ${hours})`};
        }
        return {ok: true, parsed: {kind: 'every-hours', hours}};
    }

    const dailyMatch = /^daily\s+(\d{1,2}):(\d{2})$/i.exec(trimmed);
    if (dailyMatch !== null) {
        const hour = Number.parseInt(dailyMatch[1] as string, 10);
        const minute = Number.parseInt(dailyMatch[2] as string, 10);
        if (hour < 0 || hour > 23) {
            return {ok: false, message: `'daily HH:MM' requires HH in 00-23 (got ${hour})`};
        }
        if (minute < 0 || minute > 59) {
            return {ok: false, message: `'daily HH:MM' requires MM in 00-59 (got ${minute})`};
        }
        return {ok: true, parsed: {kind: 'daily', hour, minute}};
    }

    return {
        ok: false,
        message: `unsupported cron expression: '${expr}'. Grammar: 'every Nh' or 'daily HH:MM'`
    };
};

/**
 * Compute the next fire time (Unix ms) for a parsed cron, relative to
 * `now` (Unix ms). For `every Nh` this is a simple `now + N*3600*1000`.
 * For `daily HH:MM` we compute the next occurrence of HH:MM in the
 * local timezone: today's HH:MM if it's still in the future, otherwise
 * tomorrow's HH:MM.
 *
 * DST note: we intentionally build the target Date from local
 * year/month/day + hour/minute, so on the spring-forward day the
 * scheduled 02:30 event just doesn't fire that day (Date normalizes
 * it to 03:30 which is > now, so the next-day fallback kicks in on
 * the 24h check).
 */
export const nextFireTime = (parsed: ParsedCron, now: number): number => {
    if (parsed.kind === 'every-hours') {
        return now + parsed.hours * 60 * 60 * 1000;
    }

    const nowDate = new Date(now);
    const today = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate(),
        parsed.hour, parsed.minute, 0, 0);

    if (today.getTime() > now) {
        return today.getTime();
    }

    const tomorrow = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate() + 1,
        parsed.hour, parsed.minute, 0, 0);
    return tomorrow.getTime();
};

/**
 * Convenience: parse + compute next fire time, throwing on parse
 * error. Used by the scheduler when a schedule is loaded and its
 * cron string was already validated at CREATE time.
 */
export const nextFireForCron = (expr: string, now: number): number => {
    const result = parseCron(expr);
    if (!result.ok) {
        throw new Error(`invalid cron '${expr}': ${result.message}`);
    }
    return nextFireTime(result.parsed, now);
};