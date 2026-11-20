import * as THREE from 'three';
import {easeOutCubic, heatLevel, PULSE_DURATION_MS, type NodeRecord} from './Graph3DModel.js';

/**
 * Rich render tier of the 3D graph (plan P7 / D2): one lit sphere mesh
 * per node, used below the lean-tier threshold. Heat, hover dimming and
 * pulses act on each node's own material.
 */

const NODE_OPACITY_NORMAL = 0.95;
const NODE_OPACITY_DIM = 0.16;
const HOT_COLOR = new THREE.Color('#ffd166');

export class RichNodes {
    // Sphere geometry is identical for every node of the same radius, so we
    // share one instance per (radius, segments) instead of allocating a fresh
    // ~650-triangle geometry per node — 2646 allocations became a handful.
    private geoCache = new Map<string, THREE.SphereGeometry>();
    private pulseRaf: number | null = null;

    /** @param nodes the current node list; read on every pulse frame. */
    public constructor(private readonly nodes: () => readonly NodeRecord[]) {}

    public makeSphere(record: NodeRecord, segments: number): THREE.Object3D {
        const key = `${record.radius}:${segments}`;
        let geom = this.geoCache.get(key);

        if (geom === undefined) {
            geom = new THREE.SphereGeometry(record.radius, segments, segments);
            this.geoCache.set(key, geom);
        }

        const baseColor = new THREE.Color(record.color);
        // Opaque by default: transparent:true would make three.js depth-sort
        // every sphere each frame and skip early-z. Hover dimming re-enables
        // transparency only on the dimmed subset (see applyDim).
        const mat = new THREE.MeshLambertMaterial({
            color: baseColor.clone(),
            emissive: baseColor.clone().multiplyScalar(0.25),
            transparent: false,
            opacity: 1
        });
        const sphere = new THREE.Mesh(geom, mat);
        record.sphere = sphere;
        record.baseColor = baseColor;
        return sphere;
    }

    public applyHeat(heatById: ReadonlyMap<string, number>, showHeat: boolean): void {
        for (const node of this.nodes()) {
            if (node.sphere === undefined || node.baseColor === undefined || node.pulseUntil !== undefined) {
                continue;
            }

            const heat = heatLevel(heatById.get(node.id) ?? 0);

            if (!showHeat || heat <= 0) {
                node.sphere.material.emissive.copy(node.baseColor).multiplyScalar(0.25);
                node.sphere.scale.setScalar(1);
                continue;
            }

            node.sphere.material.emissive
                .copy(node.baseColor)
                .lerp(HOT_COLOR, 0.3 + heat * 0.5)
                .multiplyScalar(0.4 + heat * 0.6);
            node.sphere.scale.setScalar(1 + heat * 0.4);
        }
    }

    /** Fade every node outside `highlight`; null restores all. */
    public applyDim(highlight: ReadonlySet<string> | null): void {
        for (const node of this.nodes()) {
            if (node.sphere === undefined) {
                continue;
            }

            const dimmed = highlight !== null && !highlight.has(node.id);
            const mat = node.sphere.material;

            // Only dimmed spheres need blending; keep the rest opaque so the
            // common (no-hover) case never pays the transparent-sort cost.
            // Toggling `transparent` requires a shader recompile flag, but this
            // fires only on hover so the cost is negligible.
            if (dimmed) {
                if (!mat.transparent) {
                    mat.transparent = true;
                    mat.needsUpdate = true;
                }
                mat.opacity = NODE_OPACITY_DIM;
            } else {
                if (mat.transparent) {
                    mat.transparent = false;
                    mat.needsUpdate = true;
                }
                mat.opacity = NODE_OPACITY_NORMAL;
            }
        }
    }

    /** Run the pulse animation until no node has a pending `pulseUntil`. */
    public animatePulses(): void {
        if (this.pulseRaf !== null) {
            return;
        }

        const tick = (): void => {
            const now = Date.now();
            let active = 0;

            for (const node of this.nodes()) {
                if (node.sphere === undefined || node.pulseUntil === undefined || node.baseColor === undefined) {
                    continue;
                }

                const remaining = node.pulseUntil - now;

                if (remaining <= 0) {
                    node.sphere.material.color.copy(node.baseColor);
                    node.sphere.material.emissive.copy(node.baseColor).multiplyScalar(0.25);
                    node.sphere.scale.setScalar(1);
                    delete node.pulseUntil;
                    delete node.pulseColor;
                    continue;
                }

                const intensity = 1 - easeOutCubic(1 - remaining / PULSE_DURATION_MS);
                const pulseColor = node.pulseColor ?? node.baseColor;

                node.sphere.material.color.copy(node.baseColor).lerp(pulseColor, intensity);
                node.sphere.material.emissive.copy(pulseColor).multiplyScalar(0.65 * intensity);
                node.sphere.scale.setScalar(1 + intensity * 0.9);

                active += 1;
            }

            this.pulseRaf = active === 0 ? null : requestAnimationFrame(tick);
        };

        this.pulseRaf = requestAnimationFrame(tick);
    }

    public dispose(): void {
        if (this.pulseRaf !== null) {
            cancelAnimationFrame(this.pulseRaf);
            this.pulseRaf = null;
        }

        for (const geom of this.geoCache.values()) {
            geom.dispose();
        }
        this.geoCache.clear();
    }
}
