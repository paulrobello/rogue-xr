import { readFileSync } from 'node:fs';
import { createStandardHand, type StandardHand } from '@par/xr-workspace';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { CardFan } from '../../src/hand/card-fan.ts';

/**
 * The off-hand model as the XR rig draws it (`createStandardHand`, the toolkit's Quest hand meshes
 * plus the elastic arm), measured in the grip space the card fan is parented to.
 */

const handBytes = (side: 'left' | 'right'): ArrayBuffer =>
  new Uint8Array(readFileSync(`node_modules/@par/xr-workspace/assets/xr-hands/${side}.glb`)).slice()
    .buffer;

export async function loadStandardHand(): Promise<StandardHand> {
  const hand = createStandardHand({
    loader: {
      loadAsync: (url: string) =>
        new GLTFLoader().parseAsync(handBytes(url.includes('right') ? 'right' : 'left'), ''),
    } as unknown as GLTFLoader,
  });
  if (!(await hand.assetReady)) throw new Error('standard hand meshes did not load');
  return hand;
}

/** IWER's Meta Quest 3 left grip offset from the target ray (column-major), the same offset Quest reports. */
const LEFT_GRIP_OFFSET = new THREE.Matrix4().fromArray([
  0.9925461411476135, 4.673031295254759e-9, -0.12186938524246216, 0, 0.08617470413446426,
  0.7071065306663513, 0.7018362283706665, 0, 0.0861746296286583, -0.70710688829422,
  0.7018358707427979, 0, -0.003979847766458988, -0.01585787907242775, 0.04964185878634453, 1,
]);

export interface HeldPose {
  name: string;
  /** Head (eye centre) in world space. */
  head: THREE.Vector3Tuple;
  /** Left controller target-ray origin in world space. */
  ray: THREE.Vector3Tuple;
  /** World point the ray's -Z aims at. */
  aim: THREE.Vector3Tuple;
}

/**
 * Seated ways of holding the left controller. The arm runs from a shoulder anchor near the head to
 * the wrist, so its shape depends on where the head is; the hand itself is rigid in grip space.
 */
export const HELD_POSES: readonly HeldPose[] = [
  // The emulator walk's rest pose: low and forward, aiming down the room.
  { name: 'rest', head: [0, 1.2, 0], ray: [-0.18, 0.92, -0.3], aim: [-0.18, 1.6, -3] },
  // Raised to read the cards: the ray points away from the eyes.
  { name: 'reading', head: [0, 1.2, 0], ray: [-0.12, 1.0, -0.32], aim: [-0.3, 0.9, -1.2] },
  // Held low by the lap, ray level.
  { name: 'lap', head: [0, 1.2, 0], ray: [-0.2, 0.8, -0.25], aim: [-0.2, 0.8, -2] },
  // Held high and close, ray up.
  { name: 'high', head: [0, 1.2, 0], ray: [-0.15, 1.1, -0.28], aim: [-0.2, 2.2, -1.5] },
];

export interface Surface {
  /** Grip-space vertex positions, xyz packed. */
  positions: Float32Array;
  /** Triangle vertex indices. */
  triangles: Uint32Array;
  names: string[];
}

/** Grip object for `pose`: target ray at `pose.ray` aimed at `pose.aim`, times the Quest grip offset. */
export function gripFor(pose: HeldPose): THREE.Object3D {
  const ray = new THREE.Matrix4().lookAt(
    new THREE.Vector3(...pose.ray),
    new THREE.Vector3(...pose.aim),
    new THREE.Vector3(0, 1, 0),
  );
  ray.setPosition(...pose.ray);
  const grip = new THREE.Group();
  ray.multiply(LEFT_GRIP_OFFSET).decompose(grip.position, grip.quaternion, grip.scale);
  grip.updateMatrixWorld(true);
  return grip;
}

/**
 * Every visible triangle of the posed hand, in the grip's local space. `curls` are the three
 * controller inputs the toolkit curls the digits with: thumb buttons, trigger, squeeze (0..1).
 */
export function handSurface(
  hand: StandardHand,
  pose: HeldPose,
  curls: readonly [number, number, number],
): Surface {
  const head = new THREE.Object3D();
  head.position.set(...pose.head);
  head.updateMatrixWorld(true);
  const grip = gripFor(pose);
  const [thumb, trigger, squeeze] = curls;
  const values = [trigger, squeeze, 0, 0, thumb, thumb];
  const gamepad = { buttons: values.map((value) => ({ value, pressed: value > 0 })) };
  // A long step settles the toolkit's eased curl in one update; the arm settles over a few.
  for (let i = 0; i < 4; i++)
    hand.updateController(grip, head, 'left', gamepad as unknown as Gamepad, 1);
  hand.root.updateMatrixWorld(true);
  const toGrip = grip.matrixWorld.clone().invert();

  const positions: number[] = [];
  const triangles: number[] = [];
  const names: string[] = [];
  const v = new THREE.Vector3();
  hand.root.traverseVisible((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const geometry = object.geometry as THREE.BufferGeometry;
    const pos = geometry.getAttribute('position');
    const base = positions.length / 3;
    names.push(object.name);
    for (let i = 0; i < pos.count; i++) {
      if (object instanceof THREE.SkinnedMesh) object.getVertexPosition(i, v);
      else v.fromBufferAttribute(pos, i);
      v.applyMatrix4(object.matrixWorld).applyMatrix4(toGrip);
      positions.push(v.x, v.y, v.z);
    }
    const index = geometry.getIndex();
    const range = geometry.drawRange;
    const count = Math.min(index ? index.count : pos.count, range.count);
    for (let i = range.start; i + 2 < range.start + count; i += 3) {
      for (let k = 0; k < 3; k++) triangles.push(base + (index ? index.getX(i + k) : i + k));
    }
  });
  return {
    positions: Float32Array.from(positions),
    triangles: Uint32Array.from(triangles),
    names,
  };
}

/** A card face as drawn: centre, unit axes and half extents, in fan-root (grip) space. */
export interface CardQuad {
  index: number;
  centre: THREE.Vector3;
  right: THREE.Vector3;
  up: THREE.Vector3;
  normal: THREE.Vector3;
  halfWidth: number;
  halfHeight: number;
}

/**
 * The fan's card quads in its parent's (the grip's) space, from the instanced body matrices and
 * the root's mount offset, skipping hidden (zero-scale) cards.
 */
export function cardQuads(fan: CardFan): CardQuad[] {
  const body = fan.root.getObjectByName('card-fan-bodies') as THREE.InstancedMesh;
  const out: CardQuad[] = [];
  const m = new THREE.Matrix4();
  fan.root.updateMatrix();
  for (let i = 0; i < body.count; i++) {
    body.getMatrixAt(i, m);
    m.premultiply(fan.root.matrix);
    const e = m.elements;
    const right = new THREE.Vector3(e[0], e[1], e[2]);
    const up = new THREE.Vector3(e[4], e[5], e[6]);
    const width = right.length();
    const height = up.length();
    if (width < 1e-6 || height < 1e-6) continue;
    right.divideScalar(width);
    up.divideScalar(height);
    out.push({
      index: i,
      centre: new THREE.Vector3(e[12], e[13], e[14]),
      right,
      up,
      normal: new THREE.Vector3().crossVectors(right, up),
      halfWidth: width / 2,
      halfHeight: height / 2,
    });
  }
  return out;
}

export interface Contact {
  /** Smallest distance from a hand vertex to the card rectangle, metres. */
  gap: number;
  /** A hand triangle edge passes through the card, or a card edge through a hand triangle. */
  crosses: boolean;
}

const EPS = 1e-9;

/** Möller–Trumbore: does segment p->q pass through triangle (a, b, c)? */
function segmentHitsTriangle(
  p: THREE.Vector3,
  q: THREE.Vector3,
  a: THREE.Vector3,
  b: THREE.Vector3,
  c: THREE.Vector3,
): boolean {
  const dir = new THREE.Vector3().subVectors(q, p);
  const e1 = new THREE.Vector3().subVectors(b, a);
  const e2 = new THREE.Vector3().subVectors(c, a);
  const h = new THREE.Vector3().crossVectors(dir, e2);
  const det = e1.dot(h);
  if (Math.abs(det) < EPS) return false;
  const f = 1 / det;
  const s = new THREE.Vector3().subVectors(p, a);
  const u = f * s.dot(h);
  if (u < 0 || u > 1) return false;
  const qv = new THREE.Vector3().crossVectors(s, e1);
  const v = f * dir.dot(qv);
  if (v < 0 || u + v > 1) return false;
  const t = f * e2.dot(qv);
  return t >= 0 && t <= 1;
}

/** How close the hand surface comes to one card, and whether they interpenetrate. */
export function contact(surface: Surface, card: CardQuad): Contact {
  const { positions, triangles } = surface;
  const n = positions.length / 3;
  const lx = new Float64Array(n);
  const ly = new Float64Array(n);
  const lz = new Float64Array(n);
  let gap = Number.POSITIVE_INFINITY;
  for (let i = 0; i < n; i++) {
    const dx = (positions[i * 3] as number) - card.centre.x;
    const dy = (positions[i * 3 + 1] as number) - card.centre.y;
    const dz = (positions[i * 3 + 2] as number) - card.centre.z;
    const x = dx * card.right.x + dy * card.right.y + dz * card.right.z;
    const y = dx * card.up.x + dy * card.up.y + dz * card.up.z;
    const z = dx * card.normal.x + dy * card.normal.y + dz * card.normal.z;
    lx[i] = x;
    ly[i] = y;
    lz[i] = z;
    const ox = Math.max(0, Math.abs(x) - card.halfWidth);
    const oy = Math.max(0, Math.abs(y) - card.halfHeight);
    gap = Math.min(gap, Math.hypot(ox, oy, z));
  }
  const inside = (x: number, y: number): boolean =>
    Math.abs(x) <= card.halfWidth && Math.abs(y) <= card.halfHeight;
  let crosses = false;
  for (let t = 0; t < triangles.length && !crosses; t += 3) {
    for (let k = 0; k < 3; k++) {
      const a = triangles[t + k] as number;
      const b = triangles[t + ((k + 1) % 3)] as number;
      const za = lz[a] as number;
      const zb = lz[b] as number;
      if ((za > 0 && zb > 0) || (za < 0 && zb < 0)) continue;
      const s = Math.abs(za - zb) < EPS ? 0 : za / (za - zb);
      if (
        inside(
          (lx[a] as number) + s * ((lx[b] as number) - (lx[a] as number)),
          (ly[a] as number) + s * ((ly[b] as number) - (ly[a] as number)),
        )
      ) {
        crosses = true;
        break;
      }
    }
  }
  if (!crosses) {
    const corner = (sx: number, sy: number): THREE.Vector3 =>
      card.centre
        .clone()
        .addScaledVector(card.right, sx * card.halfWidth)
        .addScaledVector(card.up, sy * card.halfHeight);
    const corners = [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)];
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    const at = (out: THREE.Vector3, i: number) =>
      out.set(
        positions[i * 3] as number,
        positions[i * 3 + 1] as number,
        positions[i * 3 + 2] as number,
      );
    for (let t = 0; t < triangles.length && !crosses; t += 3) {
      at(a, triangles[t] as number);
      at(b, triangles[t + 1] as number);
      at(c, triangles[t + 2] as number);
      for (let k = 0; k < 4; k++) {
        const from = corners[k] as THREE.Vector3;
        const to = corners[(k + 1) % 4] as THREE.Vector3;
        if (segmentHitsTriangle(from, to, a, b, c)) {
          crosses = true;
          break;
        }
      }
    }
  }
  return { gap, crosses };
}
