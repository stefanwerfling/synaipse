import type {Bounds} from './CanvasGeometry.js';

const MIN_SCALE = 0.15;
const MAX_SCALE = 4;
const ZOOM_STEP = 1.15;

const clampScale = (s: number): number => Math.max(MIN_SCALE, Math.min(MAX_SCALE, s));

/**
 * Pan and zoom of the canvas stage (plan P7 / D2): world → screen is
 * `screen = world * scale + (tx, ty)`, relative to the viewport's
 * top-left corner. Pure state; the renderer applies {@link transform}.
 */
export class CanvasCamera {
    public scale = 1;
    public tx = 0;
    public ty = 0;
    private panStart: {x: number; y: number; tx: number; ty: number} | null = null;

    /** CSS transform for the stage element. */
    public transform(): string {
        return `translate3d(${this.tx}px, ${this.ty}px, 0) scale(${this.scale})`;
    }

    /** Viewport-relative point → world coordinates. */
    public toWorld(x: number, y: number): {x: number; y: number} {
        return {x: (x - this.tx) / this.scale, y: (y - this.ty) / this.scale};
    }

    /** Fit `bounds` into a `viewW`×`viewH` viewport at 90 %, centred. Leaves the camera alone for empty bounds. */
    public fit(bounds: Bounds, viewW: number, viewH: number): void {
        const contentW = bounds.maxX - bounds.minX;
        const contentH = bounds.maxY - bounds.minY;
        if (contentW <= 0 || contentH <= 0) return;

        this.scale = clampScale(Math.min((viewW * 0.9) / contentW, (viewH * 0.9) / contentH));
        this.tx = viewW / 2 - ((bounds.minX + bounds.maxX) / 2) * this.scale;
        this.ty = viewH / 2 - ((bounds.minY + bounds.maxY) / 2) * this.scale;
    }

    /** One wheel step towards (`zoomIn`) or away, keeping the world point under (x, y) in place. */
    public zoomAt(x: number, y: number, zoomIn: boolean): void {
        const world = this.toWorld(x, y);
        const nextScale = clampScale(this.scale * (zoomIn ? ZOOM_STEP : 1 / ZOOM_STEP));

        this.tx = x - world.x * nextScale;
        this.ty = y - world.y * nextScale;
        this.scale = nextScale;
    }

    public get panning(): boolean {
        return this.panStart !== null;
    }

    public startPan(clientX: number, clientY: number): void {
        this.panStart = {x: clientX, y: clientY, tx: this.tx, ty: this.ty};
    }

    public panTo(clientX: number, clientY: number): void {
        if (this.panStart === null) return;
        this.tx = this.panStart.tx + (clientX - this.panStart.x);
        this.ty = this.panStart.ty + (clientY - this.panStart.y);
    }

    public endPan(): void {
        this.panStart = null;
    }
}
