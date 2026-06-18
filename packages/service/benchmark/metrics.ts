export const recallAtK = (retrieved: readonly string[], relevant: ReadonlySet<string>, k: number): number => {
    if (relevant.size === 0) return 0;
    const top = retrieved.slice(0, k);
    let hits = 0;
    for (const id of top) {
        if (relevant.has(id)) hits++;
    }
    return hits / relevant.size;
};

export const precisionAtK = (retrieved: readonly string[], relevant: ReadonlySet<string>, k: number): number => {
    if (k === 0) return 0;
    const top = retrieved.slice(0, k);
    if (top.length === 0) return 0;
    let hits = 0;
    for (const id of top) {
        if (relevant.has(id)) hits++;
    }
    return hits / top.length;
};

export const mrr = (retrieved: readonly string[], relevant: ReadonlySet<string>): number => {
    for (let i = 0; i < retrieved.length; i++) {
        if (relevant.has(retrieved[i] ?? '')) {
            return 1 / (i + 1);
        }
    }
    return 0;
};

export const percentile = (sortedAsc: readonly number[], p: number): number => {
    if (sortedAsc.length === 0) return 0;
    const idx = Math.min(sortedAsc.length - 1, Math.floor((sortedAsc.length - 1) * p));
    return sortedAsc[idx] ?? 0;
};