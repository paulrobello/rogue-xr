// @vitest-environment node
/**
 * Quest 3 playtest 2026-11-16: "The boss head covers part of its stats panel." The seated eye looks
 * up at a tall automaton whose head stands nearer than the readout plane, so the head projects
 * higher on that plane than its own top. `readoutCentreY` lifts each readout clear of that.
 */
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { DEFAULT_TABLE_DISTANCE, WAIST_DROP } from '../src/combat/placement.ts';
import { crownBounds, READOUT_MARGIN, readoutCentreY } from '../src/combat-view/index.ts';

/** The in-game readout: a 0.85 m wide, 640 x 260 canvas (combat-session.ts). */
const LABEL_HEIGHT = (0.85 * 260) / 640;
/** A capsule's lunge toward the seat (combat-session.ts `LUNGE_METRES`). */
const LUNGE = 0.35;
const EYE = new THREE.Vector3(0, 0.85 + WAIST_DROP, 0);

interface Manifest {
  bounds: { min: [number, number, number]; max: [number, number, number] };
  sockets: { 'socket-eye'?: { position: [number, number, number] } };
}
const manifest = (kind: string): Manifest =>
  JSON.parse(
    readFileSync(
      new URL(`../public/assets/enemies/${kind}/${kind}.manifest.json`, import.meta.url),
      'utf8',
    ),
  );

/**
 * World bounds of a model standing `ahead` metres north of the eye and turned to face it: the
 * model faces local -Z, so turning it to face +Z (rotation.y = pi) flips its local z.
 */
function standing(kind: string, ahead: number): THREE.Box3 {
  const { min, max } = manifest(kind).bounds;
  return new THREE.Box3(
    new THREE.Vector3(-max[0], min[1], -ahead - max[2]),
    new THREE.Vector3(-min[0], max[1], -ahead - min[2]),
  );
}

/**
 * Independent of the implementation: the highest point on the readout plane (through `at`, facing
 * the eye) that any point of the box's top face hides, with the box moved `reach` toward the eye.
 */
function hiddenUpTo(eye: THREE.Vector3, at: THREE.Vector3, box: THREE.Box3, reach: number): number {
  const n = new THREE.Vector3(at.x - eye.x, 0, at.z - eye.z);
  const planeDepth = n.length();
  n.normalize();
  let highest = box.max.y;
  for (let u = 0; u <= 1 + 1e-9; u += 0.05) {
    for (let v = 0; v <= 1 + 1e-9; v += 0.05) {
      const x = box.min.x + (box.max.x - box.min.x) * u;
      const z = box.min.z + (box.max.z - box.min.z) * v;
      const depth = (x - eye.x) * n.x + (z - eye.z) * n.z - reach;
      if (depth <= 0 || depth >= planeDepth) continue;
      highest = Math.max(highest, eye.y + ((box.max.y - eye.y) * planeDepth) / depth);
    }
  }
  return highest;
}

/** Every bind-pose vertex of a shipped enemy GLB (its meshes carry no node transform). */
function glbVertices(kind: string): Array<[number, number, number]> {
  const buf = readFileSync(
    new URL(`../public/assets/enemies/${kind}/${kind}.glb`, import.meta.url),
  );
  const jsonLength = buf.readUInt32LE(12);
  const gltf = JSON.parse(buf.subarray(20, 20 + jsonLength).toString('utf8'));
  const bin = 20 + jsonLength + 8;
  const out: Array<[number, number, number]> = [];
  for (const mesh of gltf.meshes) {
    for (const prim of mesh.primitives) {
      const acc = gltf.accessors[prim.attributes.POSITION];
      const view = gltf.bufferViews[acc.bufferView];
      const start = bin + (view.byteOffset ?? 0) + (acc.byteOffset ?? 0);
      const stride = view.byteStride ?? 12;
      for (let i = 0; i < acc.count; i++) {
        const o = start + i * stride;
        out.push([buf.readFloatLE(o), buf.readFloatLE(o + 4), buf.readFloatLE(o + 8)]);
      }
    }
  }
  return out;
}

/** The highest point on the readout plane the real mesh hides, the model standing as `standing`. */
function meshHiddenUpTo(kind: string, ahead: number): number {
  let highest = Number.NEGATIVE_INFINITY;
  for (const [, y, z] of glbVertices(kind)) {
    const depth = ahead + z;
    const shown = depth > 1e-6 && depth < ahead ? EYE.y + ((y - EYE.y) * ahead) / depth : y;
    highest = Math.max(highest, y, shown);
  }
  return highest;
}

const KINDS = [
  { kind: 'cog-sentry', tier: 'regular' },
  { kind: 'spring-hound', tier: 'regular' },
  { kind: 'bellows-golem', tier: 'regular' },
  { kind: 'orrery-warden', tier: 'regular' },
  { kind: 'grand-escapement', tier: 'guardian' },
] as const;

describe('readoutCentreY', () => {
  for (const { kind, tier } of KINDS) {
    for (const beyond of [2, 2.5, 3]) {
      it(`clears the ${tier} ${kind} ${beyond} m beyond the table, mid-lunge included`, () => {
        const ahead = DEFAULT_TABLE_DISTANCE + beyond;
        const at = new THREE.Vector3(0, 0, -ahead);
        const box = standing(kind, ahead);
        const centre = readoutCentreY(EYE, at, box, LABEL_HEIGHT, { reach: LUNGE });
        const bottom = centre - LABEL_HEIGHT / 2;
        expect(bottom).toBeGreaterThanOrEqual(box.max.y + READOUT_MARGIN - 1e-9);
        expect(bottom).toBeGreaterThanOrEqual(
          hiddenUpTo(EYE, at, box, LUNGE) + READOUT_MARGIN - 1e-6,
        );
        expect(bottom).toBeGreaterThanOrEqual(hiddenUpTo(EYE, at, box, 0) + READOUT_MARGIN - 1e-6);
        // Still readable from the seat: the whole panel sits under 40 degrees above level.
        const up = (Math.atan2(centre + LABEL_HEIGHT / 2 - EYE.y, ahead) * 180) / Math.PI;
        expect(up).toBeLessThan(40);
      });
    }
  }

  it('fixes the guardian overlap the old fixed lift left (centre 0.22 m over the top)', () => {
    const ahead = DEFAULT_TABLE_DISTANCE + 2.5;
    const at = new THREE.Vector3(0, 0, -ahead);
    const box = standing('grand-escapement', ahead);
    const oldBottom = box.max.y + 0.22 - LABEL_HEIGHT / 2;
    // The old readout's bottom edge sat inside the head's silhouette.
    expect(hiddenUpTo(EYE, at, box, 0)).toBeGreaterThan(oldBottom + 0.1);
    const bottom = readoutCentreY(EYE, at, box, LABEL_HEIGHT) - LABEL_HEIGHT / 2;
    expect(bottom - hiddenUpTo(EYE, at, box, 0)).toBeCloseTo(READOUT_MARGIN, 2);
  });

  it('sits just over the top of a body below the eye, which projects no higher than itself', () => {
    const at = new THREE.Vector3(1, 0, -4);
    const box = new THREE.Box3(new THREE.Vector3(0.6, 0, -4.4), new THREE.Vector3(1.4, 1.2, -3.6));
    expect(readoutCentreY(EYE, at, box, 0.3)).toBeCloseTo(1.2 + READOUT_MARGIN + 0.15, 12);
  });

  it('falls back to the top when the eye is over the readout', () => {
    const box = new THREE.Box3(new THREE.Vector3(-1, 0, -1), new THREE.Vector3(1, 3, 1));
    const centre = readoutCentreY(
      new THREE.Vector3(0, 1.6, 0),
      new THREE.Vector3(0, 0, 0),
      box,
      0.3,
      {
        margin: 0.1,
      },
    );
    expect(centre).toBeCloseTo(3 + 0.1 + 0.15, 12);
  });

  it('works off the table axis: a guardian standing to one side', () => {
    const at = new THREE.Vector3(1.2, 0, -3.5);
    const yaw = Math.atan2(at.x, -at.z);
    const body = new THREE.Mesh(new THREE.BoxGeometry(3.5, 3.2, 0.96));
    body.position.set(at.x, 1.6, at.z);
    body.rotation.y = -yaw + Math.PI;
    body.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(body);
    const centre = readoutCentreY(EYE, at, box, LABEL_HEIGHT, { reach: LUNGE });
    expect(centre - LABEL_HEIGHT / 2).toBeGreaterThanOrEqual(
      hiddenUpTo(EYE, at, box, LUNGE) + READOUT_MARGIN - 1e-6,
    );
  });

  for (const { kind, tier } of KINDS) {
    it(`sits just over the ${tier} ${kind}'s real head, not floating above it`, () => {
      const m = manifest(kind);
      const crown = crownBounds(m.bounds, m.sockets['socket-eye']?.position);
      for (const beyond of [2, 2.5, 3]) {
        const ahead = DEFAULT_TABLE_DISTANCE + beyond;
        const at = new THREE.Vector3(0, 0, -ahead);
        // The crown column, turned to face the seat like `standing`.
        const box = new THREE.Box3(
          new THREE.Vector3(-crown.max[0], crown.min[1], -ahead - crown.max[2]),
          new THREE.Vector3(-crown.min[0], crown.max[1], -ahead - crown.min[2]),
        );
        const bottom = readoutCentreY(EYE, at, box, LABEL_HEIGHT) - LABEL_HEIGHT / 2;
        const hidden = meshHiddenUpTo(kind, ahead);
        expect(bottom).toBeGreaterThanOrEqual(hidden + READOUT_MARGIN - 1e-6);
        // Second 2026-11-16 playtest: the full-bounds readout floated 0.39 m over the boss.
        expect(bottom - hidden).toBeLessThan(READOUT_MARGIN + 0.12);
      }
    });
  }

  it('falls back to the full bounds without a head socket', () => {
    const bounds = { min: [-1, 0, -0.5], max: [1, 2, 0.5] };
    expect(crownBounds(bounds)).toEqual({ min: [-1, 0, -0.5], max: [1, 2, 0.5] });
    expect(crownBounds(bounds, [0.1, 1.8, -0.3])).toEqual({
      min: [0.1, 0, -0.3],
      max: [0.1, 2, -0.3],
    });
  });
});
