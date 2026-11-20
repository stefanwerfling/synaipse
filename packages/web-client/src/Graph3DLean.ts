import * as THREE from 'three';
import {el} from './Dom.js';
import {easeOutCubic, heatLevel, PULSE_DURATION_MS, type EndpointRef, type LinkRecord, type NodeRecord} from './Graph3DModel.js';

/**
 * Lean render tier of the 3D graph (plan P7 / D2), used for big vaults.
 * All node spheres collapse into a single InstancedMesh (one draw call
 * for the whole graph instead of one per node) and all links share one
 * LineSegments buffer. The library's built-in per-node meshes are what
 * it raycasts for hover/click, so with them gone this tier does its own
 * picking and tooltip.
 */

export const SPHERE_SEGMENTS_LEAN = 8;
const HOT_COLOR = new THREE.Color('#ffd166');

/** What the lean tier paints each frame; read live from the view. */
export interface LeanFrame {
    nodes: readonly NodeRecord[];
    links: readonly LinkRecord[];
    nodeById: ReadonlyMap<string, NodeRecord>;
    heatById: ReadonlyMap<string, number> | null;
    showHeat: boolean;
    highlight: ReadonlySet<string> | null;
}

export class LeanLayer {
    private instanced: THREE.InstancedMesh | null = null;
    private instanceGeom: THREE.SphereGeometry | null = null;
    private instanceMat: THREE.MeshLambertMaterial | null = null;
    // The library draws every link as its own THREE.Line (one draw call
    // each — 5000+ on a big vault); batching them collapses that to one.
    private linkLines: THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial> | null = null;
    private linkPositions: Float32Array | null = null;
    private dirty = false;
    private syncRaf: number | null = null;
    private raycaster = new THREE.Raycaster();
    private readonly identityQuat = new THREE.Quaternion();
    private readonly tmpMatrix = new THREE.Matrix4();
    private readonly tmpColor = new THREE.Color();
    private readonly tmpPos = new THREE.Vector3();
    private readonly tmpScale = new THREE.Vector3();
    private readonly tmpNdc = new THREE.Vector2();

    public constructor(private readonly frame: () => LeanFrame) {}

    /** True once the instanced mesh exists, i.e. this tier owns node rendering. */
    public get active(): boolean {
        return this.instanced !== null;
    }

    /** (Re)build the instanced nodes and the batched links for the current frame. */
    public build(scene: THREE.Scene): void {
        this.buildInstances(scene);
        this.buildLinkBatch(scene);
    }

    /** Request a repaint on the next animation frame. */
    public markDirty(): void {
        if (this.instanced === null) {
            return;
        }

        this.dirty = true;
        this.ensureSync();
    }

    /** Raycast the instanced mesh under the pointer; map hit → node. */
    public pick(ev: PointerEvent, canvas: HTMLElement, camera: THREE.Camera): NodeRecord | null {
        if (this.instanced === null) {
            return null;
        }

        const rect = canvas.getBoundingClientRect();

        if (rect.width === 0 || rect.height === 0) {
            return null;
        }

        this.tmpNdc.set(
            ((ev.clientX - rect.left) / rect.width) * 2 - 1,
            -((ev.clientY - rect.top) / rect.height) * 2 + 1
        );
        this.raycaster.setFromCamera(this.tmpNdc, camera);

        const hit = this.raycaster.intersectObject(this.instanced, false)[0];

        if (hit === undefined || hit.instanceId === undefined || hit.instanceId === null) {
            return null;
        }

        return this.frame().nodes[hit.instanceId] ?? null;
    }

    public dispose(): void {
        if (this.syncRaf !== null) {
            cancelAnimationFrame(this.syncRaf);
            this.syncRaf = null;
        }
        if (this.instanced !== null) {
            this.instanced.parent?.remove(this.instanced);
            this.instanced.dispose();
            this.instanced = null;
        }
        this.instanceGeom?.dispose();
        this.instanceGeom = null;
        this.instanceMat?.dispose();
        this.instanceMat = null;
        this.disposeLinkBatch();
    }

    private buildInstances(scene: THREE.Scene): void {
        this.dispose();

        const {nodes} = this.frame();

        if (nodes.length === 0) {
            return;
        }

        const geom = new THREE.SphereGeometry(1, SPHERE_SEGMENTS_LEAN, SPHERE_SEGMENTS_LEAN);
        // A little baked emissive keeps nodes vivid without bloom; per-instance
        // color still carries the actual hue via instanceColor.
        const mat = new THREE.MeshLambertMaterial({color: 0xffffff, emissive: 0x111111});
        const mesh = new THREE.InstancedMesh(geom, mat, nodes.length);
        mesh.frustumCulled = false;
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

        nodes.forEach((node, i) => {
            node.index = i;
            node.baseColor = new THREE.Color(node.color);
        });

        this.instanced = mesh;
        this.instanceGeom = geom;
        this.instanceMat = mat;
        scene.add(mesh);

        this.refresh();
    }

    private buildLinkBatch(scene: THREE.Scene): void {
        this.disposeLinkBatch();

        const {links} = this.frame();

        if (links.length === 0) {
            return;
        }

        const positions = new Float32Array(links.length * 6);
        const geom = new THREE.BufferGeometry();
        geom.setAttribute('position', new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage));
        const mat = new THREE.LineBasicMaterial({color: 0x9aa4b8, transparent: true, opacity: 0.32});
        const lines = new THREE.LineSegments(geom, mat);
        lines.frustumCulled = false;

        this.linkLines = lines;
        this.linkPositions = positions;
        scene.add(lines);

        this.refreshLinkPositions();
    }

    private disposeLinkBatch(): void {
        if (this.linkLines !== null) {
            this.linkLines.parent?.remove(this.linkLines);
            this.linkLines.geometry.dispose();
            this.linkLines.material.dispose();
            this.linkLines = null;
        }
        this.linkPositions = null;
    }

    private refreshLinkPositions(): void {
        const positions = this.linkPositions;
        const lines = this.linkLines;

        if (positions === null || lines === null) {
            return;
        }

        const {links, nodeById} = this.frame();
        // graphData() mutates each link, swapping the source/target string
        // ids for the live node objects — resolve either form.
        const resolve = (ref: EndpointRef): NodeRecord | undefined =>
            (typeof ref === 'string' ? nodeById.get(ref) : ref);

        links.forEach((link, i) => {
            const from = resolve(link.source as EndpointRef);
            const to = resolve(link.target as EndpointRef);
            const o = i * 6;

            positions[o] = from?.x ?? 0;
            positions[o + 1] = from?.y ?? 0;
            positions[o + 2] = from?.z ?? 0;
            positions[o + 3] = to?.x ?? 0;
            positions[o + 4] = to?.y ?? 0;
            positions[o + 5] = to?.z ?? 0;
        });

        (lines.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    }

    /** Write current position/scale/color for every instance in one pass. */
    private refresh(): void {
        const mesh = this.instanced;

        if (mesh === null) {
            return;
        }

        const {nodes, heatById, showHeat, highlight} = this.frame();
        const now = Date.now();
        let stillAnimating = false;

        nodes.forEach((node, i) => {
            const base = node.baseColor ?? this.tmpColor.set(node.color);

            this.tmpPos.set(node.x ?? 0, node.y ?? 0, node.z ?? 0);
            this.tmpColor.copy(base);
            let scale = 1;

            if (node.pulseUntil !== undefined) {
                const remaining = node.pulseUntil - now;

                if (remaining > 0) {
                    const intensity = 1 - easeOutCubic(1 - remaining / PULSE_DURATION_MS);
                    this.tmpColor.copy(base).lerp(node.pulseColor ?? base, intensity);
                    scale = 1 + intensity * 0.9;
                    stillAnimating = true;
                } else {
                    delete node.pulseUntil;
                    delete node.pulseColor;
                }
            }

            if (node.pulseUntil === undefined) {
                const heat = heatLevel(heatById?.get(node.id) ?? 0);

                if (showHeat && heat > 0) {
                    this.tmpColor.copy(base).lerp(HOT_COLOR, 0.3 + heat * 0.5);
                    scale = 1 + heat * 0.4;
                }
            }

            if (highlight !== null && !highlight.has(node.id)) {
                this.tmpColor.multiplyScalar(0.22);
            }

            const r = node.radius * scale;
            this.tmpScale.set(r, r, r);
            this.tmpMatrix.compose(this.tmpPos, this.identityQuat, this.tmpScale);
            mesh.setMatrixAt(i, this.tmpMatrix);
            mesh.setColorAt(i, this.tmpColor);
        });

        mesh.instanceMatrix.needsUpdate = true;

        if (mesh.instanceColor !== null) {
            mesh.instanceColor.needsUpdate = true;
        }

        // Links share the same position source, so refresh them in lock-step.
        this.refreshLinkPositions();

        // A live pulse means the next frame is different — keep the loop going.
        if (stillAnimating) {
            this.dirty = true;
        }
    }

    /**
     * Self-stopping rAF: repaints instances whenever they are dirty, then
     * winds down after a few idle frames so a settled graph costs nothing.
     */
    private ensureSync(): void {
        if (this.syncRaf !== null) {
            return;
        }

        let idle = 0;
        const tick = (): void => {
            if (this.instanced === null) {
                this.syncRaf = null;
                return;
            }

            if (this.dirty) {
                this.dirty = false;
                this.refresh();
                idle = 0;
            } else {
                idle += 1;

                if (idle > 3) {
                    this.syncRaf = null;
                    return;
                }
            }

            this.syncRaf = requestAnimationFrame(tick);
        };

        this.syncRaf = requestAnimationFrame(tick);
    }
}

/** Title bubble that follows the pointer over a picked node. */
export class LeanTooltip {
    private tip: HTMLElement | null = null;

    public constructor(private readonly host: HTMLElement, private readonly canvas: HTMLElement) {}

    public update(node: NodeRecord | null, ev: PointerEvent): void {
        if (this.tip === null) {
            this.host.style.position = 'relative';
            this.tip = el('div', {class: 'graph-3d-tooltip'});
            this.tip.style.cssText =
                'position:absolute;pointer-events:none;z-index:20;padding:2px 8px;border-radius:6px;'
                + 'background:rgba(15,18,28,0.92);color:#e8ecf4;font-size:12px;line-height:1.4;'
                + 'white-space:nowrap;transform:translate(-50%,calc(-100% - 12px));display:none;';
            this.host.appendChild(this.tip);
        }

        if (node === null) {
            this.tip.style.display = 'none';
            this.canvas.style.cursor = '';
            return;
        }

        const rect = this.canvas.getBoundingClientRect();
        this.tip.textContent = node.title;
        this.tip.style.left = `${ev.clientX - rect.left}px`;
        this.tip.style.top = `${ev.clientY - rect.top}px`;
        this.tip.style.display = 'block';
        this.canvas.style.cursor = 'pointer';
    }

    public dispose(): void {
        this.tip?.remove();
        this.tip = null;
    }
}
