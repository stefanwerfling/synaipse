export interface HeatEntry {
    score: number;
    ts: number;
}

export type HeatState = Record<string, HeatEntry>;

export const HEAT_HALF_LIFE_MS = 10 * 60 * 1000;
export const HEAT_CLEANUP_THRESHOLD = 0.05;
export const HEAT_NORMALIZE = 5;

export const decayFactor = (elapsedMs: number, halfLifeMs = HEAT_HALF_LIFE_MS): number => {
    if (elapsedMs <= 0) {
        return 1;
    }

    return Math.exp(-Math.LN2 * elapsedMs / halfLifeMs);
};

export const bumpedScore = (
    entry: HeatEntry | undefined,
    now: number,
    amount: number,
    halfLifeMs = HEAT_HALF_LIFE_MS
): HeatEntry => {
    if (entry === undefined) {
        return {score: amount, ts: now};
    }

    const decayed = entry.score * decayFactor(now - entry.ts, halfLifeMs);
    return {score: decayed + amount, ts: now};
};

export const currentHeatMap = (
    state: HeatState,
    now: number,
    halfLifeMs = HEAT_HALF_LIFE_MS,
    threshold = HEAT_CLEANUP_THRESHOLD
): Map<string, number> => {
    const out = new Map<string, number>();

    for (const [id, entry] of Object.entries(state)) {
        const current = entry.score * decayFactor(now - entry.ts, halfLifeMs);

        if (current >= threshold) {
            out.set(id, current);
        }
    }

    return out;
};

export const normalizeHeat = (score: number): number => {
    if (score <= 0) {
        return 0;
    }

    return Math.min(1, score / HEAT_NORMALIZE);
};