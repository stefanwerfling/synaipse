import type {ForceGraph3DInstance} from '3d-force-graph';
import * as THREE from 'three';
import {CONCENTRATE_COLOR, concentrateOpacity, concentrateRadius} from './GraphRenderer.js';
import {FOCUS_DISTANCE, FOCUS_DURATION_MS, hasPosition, type NodeRecord} from './Graph3DModel.js';
import {trailOpacity} from './Trail.js';

/**
 * Transient effects of the 3D graph (plan P7 / D2): event trails between
 * notes, the "concentrate" wave around a note, and the camera fly-to plus
 * slow orbit after a click. Each effect owns its own self-stopping rAF
 * loop and follows the live node positions through `nodeOf`.
 */

type NodeLookup = (id: string) => NodeRecord | undefined;

const TRAIL_DURATION_MS = 2200;
const WAVE_DURATION_MS = 1100;
const WAVE_END_SCALE_FACTOR = 7;
const WAVE_SECONDARY_DELAY_MS = 220;
const ORBIT_SPEED_RAD_PER_FRAME = 0.0018;
const ORBIT_START_DELAY_MS = 150;

interface TrailRecord {
    line: THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial>;
    fromId: string;
    toId: string;
    startedAt: number;
}

/** Fading line from one note to another. */
export class Trails3D {
    private trails: TrailRecord[] = [];
    private raf: number | null = null;

    public constructor(private readonly nodeOf: NodeLookup) {}

    public add(scene: THREE.Scene, from: NodeRecord, to: NodeRecord, colorHex: string): void {
        const material = new THREE.LineBasicMaterial({
            color: new THREE.Color(colorHex),
            transparent: true,
            opacity: 0.95,
            linewidth: 2
        });

        const points = [
            new THREE.Vector3(from.x ?? 0, from.y ?? 0, from.z ?? 0),
            new THREE.Vector3(to.x ?? 0, to.y ?? 0, to.z ?? 0)
        ];
        const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), material);
        scene.add(line);

        this.trails.push({line, fromId: from.id, toId: to.id, startedAt: performance.now()});
        this.schedule();
    }

    public dispose(): void {
        if (this.raf !== null) {
            cancelAnimationFrame(this.raf);
            this.raf = null;
        }
        for (const trail of this.trails) {
            Trails3D.remove(trail);
        }
        this.trails = [];
    }

    private static remove(trail: TrailRecord): void {
        trail.line.parent?.remove(trail.line);
        trail.line.geometry.dispose();
        trail.line.material.dispose();
    }

    private schedule(): void {
        if (this.raf !== null) {
            return;
        }

        const tick = (): void => {
            const now = performance.now();
            const survivors: TrailRecord[] = [];

            for (const trail of this.trails) {
                const opacity = trailOpacity(now - trail.startedAt, TRAIL_DURATION_MS);

                if (opacity <= 0) {
                    Trails3D.remove(trail);
                    continue;
                }

                trail.line.material.opacity = opacity;

                const from = this.nodeOf(trail.fromId);
                const to = this.nodeOf(trail.toId);

                if (from !== undefined && to !== undefined && from.x !== undefined && to.x !== undefined) {
                    const positions = trail.line.geometry.getAttribute('position') as THREE.BufferAttribute;
                    positions.setXYZ(0, from.x ?? 0, from.y ?? 0, from.z ?? 0);
                    positions.setXYZ(1, to.x ?? 0, to.y ?? 0, to.z ?? 0);
                    positions.needsUpdate = true;
                }

                survivors.push(trail);
            }

            this.trails = survivors;
            this.raf = this.trails.length === 0 ? null : requestAnimationFrame(tick);
        };

        this.raf = requestAnimationFrame(tick);
    }
}

interface WaveRecord {
    mesh: THREE.LineSegments<THREE.WireframeGeometry, THREE.LineBasicMaterial>;
    nodeId: string;
    startRadius: number;
    endRadius: number;
    startedAt: number;
}

/** Two expanding wireframe spheres around a note, the second slightly delayed. */
export class Waves3D {
    private waves: WaveRecord[] = [];
    private raf: number | null = null;

    public constructor(private readonly nodeOf: NodeLookup) {}

    public concentrate(scene: THREE.Scene, node: NodeRecord): void {
        this.spawn(scene, node, 0);
        this.spawn(scene, node, WAVE_SECONDARY_DELAY_MS);
        this.schedule();
    }

    public dispose(): void {
        if (this.raf !== null) {
            cancelAnimationFrame(this.raf);
            this.raf = null;
        }
        for (const wave of this.waves) {
            Waves3D.remove(wave);
        }
        this.waves = [];
    }

    private static remove(wave: WaveRecord): void {
        wave.mesh.parent?.remove(wave.mesh);
        wave.mesh.geometry.dispose();
        wave.mesh.material.dispose();
    }

    private spawn(scene: THREE.Scene, node: NodeRecord, delayMs: number): void {
        const startRadius = node.radius * 1.2;
        const endRadius = node.radius * WAVE_END_SCALE_FACTOR;

        const sphere = new THREE.SphereGeometry(1, 16, 12);
        const wireframe = new THREE.WireframeGeometry(sphere);
        sphere.dispose();
        const material = new THREE.LineBasicMaterial({
            color: new THREE.Color(CONCENTRATE_COLOR),
            transparent: true,
            opacity: 0,
            depthWrite: false
        });
        const mesh = new THREE.LineSegments(wireframe, material);
        mesh.scale.setScalar(startRadius);

        if (hasPosition(node)) {
            mesh.position.set(node.x, node.y, node.z);
        }

        scene.add(mesh);
        this.waves.push({mesh, nodeId: node.id, startRadius, endRadius, startedAt: performance.now() + delayMs});
    }

    private schedule(): void {
        if (this.raf !== null) {
            return;
        }

        const tick = (): void => {
            const now = performance.now();
            const survivors: WaveRecord[] = [];

            for (const wave of this.waves) {
                const elapsed = now - wave.startedAt;

                if (elapsed < 0) {
                    survivors.push(wave);
                    continue;
                }

                if (elapsed >= WAVE_DURATION_MS) {
                    Waves3D.remove(wave);
                    continue;
                }

                wave.mesh.scale.setScalar(concentrateRadius(elapsed, WAVE_DURATION_MS, wave.startRadius, wave.endRadius));
                wave.mesh.material.opacity = concentrateOpacity(elapsed, WAVE_DURATION_MS) * 0.85;

                const node = this.nodeOf(wave.nodeId);

                if (node !== undefined && hasPosition(node)) {
                    wave.mesh.position.set(node.x, node.y, node.z);
                }

                survivors.push(wave);
            }

            this.waves = survivors;
            this.raf = this.waves.length === 0 ? null : requestAnimationFrame(tick);
        };

        this.raf = requestAnimationFrame(tick);
    }
}

/** Fly the camera to FOCUS_DISTANCE from the node, keeping the current viewing direction. */
export const flyTo = (graph: ForceGraph3DInstance, record: NodeRecord): void => {
    if (!hasPosition(record)) {
        return;
    }

    const camPos = graph.cameraPosition();
    const dx = camPos.x - record.x;
    const dy = camPos.y - record.y;
    const dz = camPos.z - record.z;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
    const scale = FOCUS_DISTANCE / len;

    graph.cameraPosition(
        {x: record.x + dx * scale, y: record.y + dy * scale, z: record.z + dz * scale},
        {x: record.x, y: record.y, z: record.z},
        FOCUS_DURATION_MS
    );
};

/** Slow camera orbit around a focused note; any drag stops it. */
export class Orbit3D {
    private targetId: string | null = null;
    private angle = 0;
    private radius = FOCUS_DISTANCE;
    private height = 0;
    private raf: number | null = null;
    private startTimer: number | null = null;

    public constructor(
        private readonly graph: () => ForceGraph3DInstance | null,
        private readonly nodeOf: NodeLookup
    ) {}

    /** Start orbiting `noteId` shortly, once the fly-to has begun. */
    public start(noteId: string): void {
        this.targetId = noteId;

        if (this.startTimer !== null) {
            window.clearTimeout(this.startTimer);
        }

        this.startTimer = window.setTimeout(() => {
            this.startTimer = null;
            this.begin(noteId);
        }, ORBIT_START_DELAY_MS);
    }

    public stop(): void {
        this.targetId = null;

        if (this.startTimer !== null) {
            window.clearTimeout(this.startTimer);
            this.startTimer = null;
        }

        if (this.raf !== null) {
            cancelAnimationFrame(this.raf);
            this.raf = null;
        }
    }

    private begin(noteId: string): void {
        const graph = this.graph();

        if (graph === null || this.targetId !== noteId) {
            return;
        }

        const node = this.nodeOf(noteId);

        if (node === undefined || !hasPosition(node)) {
            return;
        }

        const camPos = graph.cameraPosition() as {x: number; y: number; z: number};
        const dx = camPos.x - node.x;
        const dz = camPos.z - node.z;
        this.angle = Math.atan2(dz, dx);
        this.radius = Math.max(40, Math.hypot(dx, dz));
        this.height = camPos.y - node.y;

        if (this.raf !== null) {
            return;
        }

        const tick = (): void => {
            const live = this.graph();
            const target = this.targetId === null ? undefined : this.nodeOf(this.targetId);

            if (live === null || target === undefined || !hasPosition(target)) {
                this.raf = null;
                return;
            }

            this.angle += ORBIT_SPEED_RAD_PER_FRAME;
            const x = target.x + Math.cos(this.angle) * this.radius;
            const z = target.z + Math.sin(this.angle) * this.radius;
            const y = target.y + this.height;

            live.cameraPosition({x, y, z}, {x: target.x, y: target.y, z: target.z}, 0);

            this.raf = requestAnimationFrame(tick);
        };

        this.raf = requestAnimationFrame(tick);
    }
}
