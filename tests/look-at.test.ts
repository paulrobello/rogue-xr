// @vitest-environment node
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  type EnemyActor,
  parseEnemyAsset,
  parseEnemyManifest,
} from '../src/enemies/enemy-asset.ts';
import {
  clampAngle,
  createLookState,
  dampCritical,
  HeadLook,
  inLookCone,
  LOOK_LIMITS,
  type LookAngles,
  lookAngles,
  stepLook,
} from '../src/enemies/look-at.ts';

const DEG = Math.PI / 180;
const L = LOOK_LIMITS;

/** Body-frame offset at `yaw`/`pitch` (look-at convention) and `distance`. */
function offsetAt(yaw: number, pitch: number, distance: number): THREE.Vector3 {
  const flat = Math.cos(pitch) * distance;
  return new THREE.Vector3(
    -Math.sin(yaw) * flat,
    Math.sin(pitch) * distance,
    -Math.cos(yaw) * flat,
  );
}

const forwardOf = (yaw: number, pitch: number): THREE.Vector3 =>
  new THREE.Vector3(0, 0, -1).applyQuaternion(
    new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, yaw, 0, 'YXZ')),
  );

describe('look angles', () => {
  const out: LookAngles = { yaw: 0, pitch: 0, distance: 0 };
  it('is zero straight ahead', () => {
    lookAngles(0, 0, -3, out);
    expect(out.yaw).toBeCloseTo(0);
    expect(out.pitch).toBeCloseTo(0);
    expect(out.distance).toBeCloseTo(3);
  });
  it('turns body forward onto an asymmetric target', () => {
    const target = new THREE.Vector3(-1.2, 0.7, -2);
    lookAngles(target.x, target.y, target.z, out);
    expect(out.yaw).toBeGreaterThan(0);
    expect(out.pitch).toBeGreaterThan(0);
    expect(forwardOf(out.yaw, out.pitch).angleTo(target)).toBeLessThan(1e-9);
  });
  it('round-trips the test helper', () => {
    lookAngles(...(offsetAt(-40 * DEG, -20 * DEG, 2.5).toArray() as [number, number, number]), out);
    expect(out.yaw).toBeCloseTo(-40 * DEG);
    expect(out.pitch).toBeCloseTo(-20 * DEG);
    expect(out.distance).toBeCloseTo(2.5);
  });
});

describe('look cone', () => {
  it('starts watching inside 75 degrees and 6 m only', () => {
    expect(inLookCone(74 * DEG, 3, false)).toBe(true);
    expect(inLookCone(-74 * DEG, 3, false)).toBe(true);
    expect(inLookCone(76 * DEG, 3, false)).toBe(false);
    expect(inLookCone(0, 6.1, false)).toBe(false);
    expect(inLookCone(0, 0.2, false)).toBe(false);
  });
  it('keeps watching to 85 degrees and 7 m (hysteresis)', () => {
    expect(inLookCone(80 * DEG, 3, true)).toBe(true);
    expect(inLookCone(86 * DEG, 3, true)).toBe(false);
    expect(inLookCone(0, 6.5, true)).toBe(true);
    expect(inLookCone(0, 7.1, true)).toBe(false);
    expect(inLookCone(0, 0.2, true)).toBe(false);
    expect(inLookCone(Math.PI, 2, true)).toBe(false);
  });
  it('clamps symmetrically', () => {
    expect(clampAngle(1.5, L.maxYaw)).toBe(L.maxYaw);
    expect(clampAngle(-1.5, L.maxYaw)).toBe(-L.maxYaw);
    expect(clampAngle(0.2, L.maxYaw)).toBe(0.2);
  });
});

describe('critically damped smoothing', () => {
  const out = { x: 0, v: 0 };
  it('eases in from rest and never overshoots', () => {
    let x = 0;
    let v = 0;
    const steps: number[] = [];
    for (let i = 0; i < 200; i++) {
      dampCritical(x, v, 1, L.omega, 1 / 90, out);
      steps.push(out.x - x);
      x = out.x;
      v = out.v;
      expect(x).toBeLessThanOrEqual(1);
    }
    // Ease-in: the second step moves more than the first (exponential smoothing starts at full speed).
    expect(steps[1] ?? 0).toBeGreaterThan(steps[0] ?? 0);
    expect(x).toBeCloseTo(1, 4);
  });
  it('lands on the same state for any split of the same time', () => {
    const one = { ...dampCritical(0.3, -0.5, 1, L.omega, 0.1, out) };
    dampCritical(0.3, -0.5, 1, L.omega, 0.05, out);
    dampCritical(out.x, out.v, 1, L.omega, 0.05, out);
    expect(out.x).toBeCloseTo(one.x, 12);
    expect(out.v).toBeCloseTo(one.v, 12);
  });
  it('tracks the same at 60, 72, 90 and 120 Hz', () => {
    const offset = offsetAt(40 * DEG, -15 * DEG, 2.5);
    const at = (hz: number): { yaw: number; pitch: number } => {
      const s = createLookState();
      for (let i = 0; i < hz / 2; i++) stepLook(s, offset, true, 1 / hz);
      return { yaw: s.yaw, pitch: s.pitch };
    };
    const ref = at(72);
    for (const hz of [60, 90, 120]) {
      expect(at(hz).yaw).toBeCloseTo(ref.yaw, 9);
      expect(at(hz).pitch).toBeCloseTo(ref.pitch, 9);
    }
  });
});

describe('stepLook', () => {
  const run = (
    s: ReturnType<typeof createLookState>,
    offset: THREE.Vector3 | null,
    enabled: boolean,
    seconds: number,
  ): boolean => {
    let active = true;
    for (let t = 0; t < seconds; t += 1 / 72) active = stepLook(s, offset, enabled, 1 / 72);
    return active;
  };
  it('settles on the clamped angles of a player in the cone', () => {
    const s = createLookState();
    run(s, offsetAt(70 * DEG, -50 * DEG, 2), true, 3);
    expect(s.tracking).toBe(true);
    expect(s.yaw).toBeCloseTo(L.maxYaw, 4);
    expect(s.pitch).toBeCloseTo(-L.maxPitch, 4);
  });
  it('ignores a player outside the cone, behind, or out of range', () => {
    for (const offset of [offsetAt(80 * DEG, 0, 2), offsetAt(170 * DEG, 0, 2), offsetAt(0, 0, 9)]) {
      const s = createLookState();
      expect(run(s, offset, true, 1)).toBe(false);
      expect(s.yaw).toBe(0);
      expect(s.pitch).toBe(0);
    }
  });
  it('eases back and comes to rest when the player leaves, or when disabled', () => {
    for (const leave of [
      (s: ReturnType<typeof createLookState>) => run(s, offsetAt(120 * DEG, 0, 2), true, 2),
      (s: ReturnType<typeof createLookState>) => run(s, null, true, 2),
      (s: ReturnType<typeof createLookState>) => run(s, offsetAt(30 * DEG, 0, 2), false, 1),
    ]) {
      const s = createLookState();
      run(s, offsetAt(30 * DEG, 10 * DEG, 2), true, 2);
      expect(s.yaw).toBeCloseTo(30 * DEG, 3);
      const first = stepLook(s, null, true, 1 / 72);
      expect(first).toBe(true);
      expect(s.yaw).toBeGreaterThan(29 * DEG);
      expect(leave(s)).toBe(false);
      expect(s).toEqual(createLookState());
    }
  });
  it('releases fast when disabled (dead or frozen)', () => {
    const s = createLookState();
    run(s, offsetAt(0, -25 * DEG, 2), true, 2);
    run(s, null, false, 0.4);
    expect(Math.abs(s.pitch)).toBeLessThan(0.01 * 25 * DEG);
  });
});

/** A chain like the hound's: a strongly pitched spine, a sanitised `neck.2`, a pitched head. */
function hound(): { root: THREE.Object3D; neck: THREE.Object3D; head: THREE.Object3D } {
  const root = new THREE.Object3D();
  const spine = new THREE.Bone();
  spine.position.set(0, 0.6, 0.2);
  spine.quaternion.setFromEuler(new THREE.Euler(-0.9, 0, 0.1));
  const neck = new THREE.Bone();
  neck.name = THREE.PropertyBinding.sanitizeNodeName('neck.2');
  neck.position.set(0, 0.4, 0);
  neck.quaternion.setFromEuler(new THREE.Euler(0.75, 0.05, 0));
  const head = new THREE.Bone();
  head.name = 'head';
  head.position.set(0, 0.2, 0);
  head.quaternion.setFromEuler(new THREE.Euler(-1.08, 0, 0));
  root.add(spine);
  spine.add(neck);
  neck.add(head);
  return { root, neck, head };
}

const bodyQuat = (root: THREE.Object3D, bone: THREE.Object3D): THREE.Quaternion => {
  const q = bone.quaternion.clone();
  for (let p = bone.parent; p && p !== root; p = p.parent) q.premultiply(p.quaternion);
  return q;
};

describe('HeadLook on a bone chain', () => {
  it('splits the turn over the neck and points the head at the target', () => {
    const { root, neck, head } = hound();
    root.position.set(4, 0, -2);
    root.rotation.y = 0.7;
    const look = HeadLook.find(root);
    expect(look?.bones.map((b) => b.bone)).toEqual([neck, head]);
    const neckRest = neck.quaternion.clone();
    const headRest = head.quaternion.clone();
    const before = bodyQuat(root, head);
    root.updateMatrixWorld(true);
    const pivot = head.getWorldPosition(new THREE.Vector3());
    // Up and to the body's +yaw side, inside both clamps.
    const local = offsetAt(35 * DEG, 18 * DEG, 2.2);
    const target = pivot.clone().add(local.clone().applyQuaternion(root.quaternion));
    for (let i = 0; i < 216; i++) {
      // The mixer's job: back to the animated pose before each look.
      neck.quaternion.copy(neckRest);
      head.quaternion.copy(headRest);
      look?.update(1 / 72, target, true);
    }
    expect(look?.tracking).toBe(true);
    const delta = bodyQuat(root, head).multiply(before.clone().invert());
    const aimed = new THREE.Vector3(0, 0, -1).applyQuaternion(delta);
    expect(aimed.angleTo(local)).toBeLessThan(2 * DEG);
    expect(neck.quaternion.angleTo(neckRest)).toBeGreaterThan(5 * DEG);
  });

  it('gives a rig without a head no look, and a head without a neck the whole turn', () => {
    const { root, neck, head } = hound();
    head.name = 'skull';
    expect(HeadLook.find(root)).toBeNull();
    head.name = 'head';
    neck.name = 'chest';
    expect(HeadLook.find(root)?.bones).toEqual([{ bone: head, share: 1 }]);
  });

  it('leaves the bones untouched while at rest', () => {
    const { root, neck, head } = hound();
    const look = HeadLook.find(root);
    const n = neck.quaternion.clone();
    const h = head.quaternion.clone();
    root.updateMatrixWorld(true);
    look?.update(1 / 72, new THREE.Vector3(0, 1, 5), true);
    look?.update(1 / 72, null, true);
    expect(neck.quaternion.equals(n)).toBe(true);
    expect(head.quaternion.equals(h)).toBe(true);
  });
});

const SHIPPED: Record<string, readonly string[]> = {
  'cog-sentry': ['neck', 'head'],
  'bellows-golem': ['head'],
  'spring-hound': ['neck2', 'head'],
  'orrery-warden': ['neck', 'head'],
  'grand-escapement': ['neck', 'head'],
};

async function spawn(id: string): Promise<[EnemyActor, EnemyActor]> {
  const base = new URL(`../public/assets/enemies/${id}/`, import.meta.url);
  const manifest = parseEnemyManifest(
    JSON.parse(readFileSync(new URL(`${id}.manifest.json`, base), 'utf8')),
    id,
  );
  const bytes = readFileSync(new URL(`${id}.glb`, base));
  const glb = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const asset = await parseEnemyAsset(glb as ArrayBuffer, manifest, null);
  return [asset.spawn(), asset.spawn()];
}

const headOf = (actor: EnemyActor): THREE.Object3D => {
  const head = actor.headLook?.head;
  if (!head) throw new Error(`${actor.kind}: no head`);
  return head;
};

describe('HeadLook on the shipped automatons', () => {
  for (const [id, bones] of Object.entries(SHIPPED)) {
    it(`${id}: looks at a player in front, and lets go when it dies`, async () => {
      const [watcher, still] = await spawn(id);
      const scene = new THREE.Scene();
      for (const a of [watcher, still]) {
        a.object.position.set(1, 0, 3);
        a.object.rotation.y = -0.6;
        scene.add(a.object);
      }
      expect(watcher.headLook?.bones.map((b) => b.bone.name)).toEqual(bones);
      scene.updateMatrixWorld(true);
      const pivot = headOf(still).getWorldPosition(new THREE.Vector3());
      const local = offsetAt(-30 * DEG, 12 * DEG, 2.4);
      const target = pivot.clone().add(local.clone().applyQuaternion(still.object.quaternion));
      for (let i = 0; i < 144; i++) {
        watcher.update(1 / 72, target);
        still.update(1 / 72);
      }
      expect(watcher.headLook?.tracking).toBe(true);
      const root = watcher.object;
      const delta = bodyQuat(root, headOf(watcher)).multiply(
        bodyQuat(still.object, headOf(still)).invert(),
      );
      const aimed = new THREE.Vector3(0, 0, -1).applyQuaternion(delta);
      // The animated head pivot moves a little with the idle, so the tolerance is a few degrees.
      expect(aimed.angleTo(local)).toBeLessThan(4 * DEG);

      void watcher.die();
      void still.die();
      for (let i = 0; i < 36; i++) {
        watcher.update(1 / 72, target);
        still.update(1 / 72);
      }
      expect(watcher.headLook?.tracking).toBe(false);
      expect(headOf(watcher).quaternion.angleTo(headOf(still).quaternion)).toBeLessThan(0.5 * DEG);
      watcher.dispose();
      still.dispose();
    });
  }

  it('does not look while frozen, and resets with the actor', async () => {
    const [watcher, still] = await spawn('cog-sentry');
    const target = new THREE.Vector3(0.6, 1.4, -2);
    for (let i = 0; i < 72; i++) watcher.update(1 / 72, target);
    expect(Math.abs(watcher.headLook?.yaw ?? 0)).toBeGreaterThan(5 * DEG);
    watcher.freeze();
    still.freeze();
    for (let i = 0; i < 72; i++) {
      watcher.update(1 / 72, target);
      still.update(1 / 72);
    }
    expect(watcher.headLook?.tracking).toBe(false);
    expect(watcher.headLook?.yaw).toBe(0);
    watcher.unfreeze();
    for (let i = 0; i < 36; i++) watcher.update(1 / 72, target);
    expect(watcher.headLook?.tracking).toBe(true);
    watcher.reset();
    expect(watcher.headLook?.yaw).toBe(0);
    expect(watcher.headLook?.tracking).toBe(false);
    watcher.dispose();
    still.dispose();
  });
});
