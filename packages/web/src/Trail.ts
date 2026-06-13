export interface Point2D {
    x: number;
    y: number;
}

export const bezierControl = (a: Point2D, b: Point2D, curveStrength: number): Point2D => {
    const midX = (a.x + b.x) / 2;
    const midY = (a.y + b.y) / 2;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);

    if (len === 0) {
        return {x: midX, y: midY};
    }

    const offsetX = (-dy / len) * curveStrength;
    const offsetY = (dx / len) * curveStrength;

    return {x: midX + offsetX, y: midY + offsetY};
};

export const trailSvgPath = (a: Point2D, b: Point2D, control: Point2D): string => {
    return `M ${a.x.toFixed(1)} ${a.y.toFixed(1)} Q ${control.x.toFixed(1)} ${control.y.toFixed(1)} ${b.x.toFixed(1)} ${b.y.toFixed(1)}`;
};

export const easeOutCubic = (t: number): number => 1 - Math.pow(1 - t, 3);

export const trailOpacity = (elapsed: number, durationMs: number, peak = 0.95): number => {
    if (elapsed <= 0) return peak;
    if (elapsed >= durationMs) return 0;
    return peak * (1 - easeOutCubic(elapsed / durationMs));
};