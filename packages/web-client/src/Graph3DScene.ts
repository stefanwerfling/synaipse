import type {ForceGraph3DInstance} from '3d-force-graph';
import * as THREE from 'three';
import {ConvexGeometry} from 'three/examples/jsm/geometries/ConvexGeometry.js';
import {OutputPass} from 'three/examples/jsm/postprocessing/OutputPass.js';
import {UnrealBloomPass} from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import {tagColor} from './Colors.js';
import {hasPosition, type NodeRecord} from './Graph3DModel.js';

/**
 * Static scene decoration of the 3D graph (plan P7 / D2): tag hulls,
 * the room grid, bloom and link particles. All of it is rich-look extra
 * on top of the node and link rendering.
 */

const HULL_FILL_OPACITY = 0.07;
const HULL_EDGE_OPACITY = 0.5;
const HULL_LABEL_SCALE = 22;
const HULL_MIN_POINTS = 4;
const ROOM_GRID_SIZE = 800;
const ROOM_GRID_DIVISIONS = 8;
const ROOM_GRID_COLOR = 0x3a4358;
const ROOM_GRID_OPACITY = 0.32;
const BLOOM_STRENGTH = 0.45;
const BLOOM_RADIUS = 0.4;
const BLOOM_THRESHOLD = 0.55;
const PARTICLE_COUNT = 2;
const PARTICLE_SPEED = 0.0045;
const PARTICLE_WIDTH = 1.1;
const PARTICLE_COLOR = '#ffd166';

/** Dispose every geometry, material and sprite texture below `group`, then detach it. */
const disposeGroup = (group: THREE.Group): void => {
    group.traverse((obj) => {
        if (obj instanceof THREE.Mesh || obj instanceof THREE.LineSegments) {
            obj.geometry.dispose();

            if (Array.isArray(obj.material)) {
                for (const mat of obj.material) {
                    mat.dispose();
                }
            } else {
                obj.material.dispose();
            }
        } else if (obj instanceof THREE.Sprite) {
            if (obj.material.map !== null) {
                obj.material.map.dispose();
            }
            obj.material.dispose();
        }
    });

    group.parent?.remove(group);
};

const buildTagLabel = (tag: string, color: string): THREE.Sprite => {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');

    if (ctx !== null) {
        ctx.font = '600 36px -apple-system, "Segoe UI", sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.shadowColor = '#000000';
        ctx.shadowBlur = 8;
        ctx.fillStyle = color;
        ctx.fillText(tag, canvas.width / 2, canvas.height / 2);
    }

    const texture = new THREE.CanvasTexture(canvas);
    texture.minFilter = THREE.LinearFilter;
    texture.needsUpdate = true;

    const material = new THREE.SpriteMaterial({
        map: texture,
        transparent: true,
        depthWrite: false,
        depthTest: false
    });
    const sprite = new THREE.Sprite(material);
    sprite.scale.set(HULL_LABEL_SCALE, HULL_LABEL_SCALE / 4, 1);
    return sprite;
};

const buildHullObject = (tag: string, points: THREE.Vector3[]): THREE.Object3D => {
    const color = new THREE.Color(tagColor(tag));

    const fillGeometry = new ConvexGeometry(points);
    const fillMaterial = new THREE.MeshBasicMaterial({
        color: color.clone(),
        transparent: true,
        opacity: HULL_FILL_OPACITY,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        depthWrite: false
    });
    const fill = new THREE.Mesh(fillGeometry, fillMaterial);

    const edgeGeometry = new THREE.EdgesGeometry(fillGeometry);
    const edgeMaterial = new THREE.LineBasicMaterial({
        color: color.clone(),
        transparent: true,
        opacity: HULL_EDGE_OPACITY,
        depthWrite: false
    });
    const edges = new THREE.LineSegments(edgeGeometry, edgeMaterial);

    const centroid = new THREE.Vector3();
    for (const p of points) {
        centroid.add(p);
    }
    centroid.divideScalar(points.length);

    const box = new THREE.Box3().setFromPoints(points);
    const label = buildTagLabel(tag, tagColor(tag));
    label.position.set(centroid.x, box.max.y + 4, centroid.z);

    const wrapper = new THREE.Group();
    wrapper.add(fill);
    wrapper.add(edges);
    wrapper.add(label);
    return wrapper;
};

/** Translucent convex hull plus floating label per tag with enough placed nodes. */
export class TagHulls {
    private group: THREE.Group | null = null;

    public rebuild(scene: THREE.Scene, nodes: readonly NodeRecord[]): void {
        this.dispose();

        const tagToPoints = new Map<string, THREE.Vector3[]>();

        for (const node of nodes) {
            if (!hasPosition(node)) {
                continue;
            }

            const point = new THREE.Vector3(node.x, node.y, node.z);

            for (const tag of node.tags) {
                const points = tagToPoints.get(tag) ?? [];
                points.push(point);
                tagToPoints.set(tag, points);
            }
        }

        const group = new THREE.Group();

        for (const [tag, points] of tagToPoints) {
            if (points.length < HULL_MIN_POINTS) {
                continue;
            }

            try {
                group.add(buildHullObject(tag, points));
            } catch {
                // ConvexGeometry throws on degenerate (coplanar) input — skip this tag silently
            }
        }

        scene.add(group);
        this.group = group;
    }

    public dispose(): void {
        if (this.group !== null) {
            disposeGroup(this.group);
            this.group = null;
        }
    }
}

/** Faint 3D lattice that gives the empty space some depth cues. */
export class RoomGrid {
    private group: THREE.Group | null = null;

    public show(scene: THREE.Scene): void {
        if (this.group !== null) {
            return;
        }

        const half = ROOM_GRID_SIZE / 2;
        const step = ROOM_GRID_SIZE / ROOM_GRID_DIVISIONS;
        const positions: number[] = [];

        for (let i = 0; i <= ROOM_GRID_DIVISIONS; i++) {
            for (let j = 0; j <= ROOM_GRID_DIVISIONS; j++) {
                const a = -half + i * step;
                const b = -half + j * step;

                positions.push(-half, a, b, half, a, b);
                positions.push(a, -half, b, a, half, b);
                positions.push(a, b, -half, a, b, half);
            }
        }

        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));

        const material = new THREE.LineBasicMaterial({
            color: ROOM_GRID_COLOR,
            transparent: true,
            opacity: ROOM_GRID_OPACITY,
            depthWrite: false
        });

        const group = new THREE.Group();
        group.add(new THREE.LineSegments(geometry, material));
        scene.add(group);
        this.group = group;
    }

    public dispose(): void {
        if (this.group !== null) {
            disposeGroup(this.group);
            this.group = null;
        }
    }
}

export const installBloom = (graph: ForceGraph3DInstance, width: number, height: number): void => {
    const composer = graph.postProcessingComposer();
    const bloom = new UnrealBloomPass(new THREE.Vector2(width, height), BLOOM_STRENGTH, BLOOM_RADIUS, BLOOM_THRESHOLD);

    composer.addPass(bloom);
    composer.addPass(new OutputPass());
};

export const installParticles = (graph: ForceGraph3DInstance): void => {
    const particled = graph as unknown as {
        linkDirectionalParticles(n: number): unknown;
        linkDirectionalParticleSpeed(s: number): unknown;
        linkDirectionalParticleWidth(w: number): unknown;
        linkDirectionalParticleColor(fn: () => string): unknown;
    };

    particled.linkDirectionalParticles(PARTICLE_COUNT);
    particled.linkDirectionalParticleSpeed(PARTICLE_SPEED);
    particled.linkDirectionalParticleWidth(PARTICLE_WIDTH);
    particled.linkDirectionalParticleColor(() => PARTICLE_COLOR);
};
