import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { DEFAULT_EYE_HEIGHT, TABLE_HALF_DEPTH, WAIST_DROP } from '../src/combat/placement.ts';
import type { Box } from '../src/content/rooms.ts';
import { ActionBus } from '../src/core/actions.ts';
import { formatSeed, isValidSeed, normalizeSeed, randomSeed } from '../src/core/rng.ts';
import { fitCombatFraming, projectToNdc, type XYZ } from '../src/desktop/combat-framing.ts';
import { combatPitch, createDesktopControls } from '../src/desktop/controls.ts';
import { WALK_SPEED, Walker } from '../src/desktop/walker.ts';
import { generateFloor } from '../src/floor/generate.ts';
import { platePoseAboveTable } from '../src/sigil-plate/index.ts';
import { buildFloorWorld, type FloorWorld } from '../src/world/floor-world.ts';

const DT = 1 / 60;

describe('seed parse and format', () => {
  it('round-trips random seeds through the display form', () => {
    for (let i = 0; i < 500; i++) {
      const seed = randomSeed();
      const shown = formatSeed(seed);
      expect(shown).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
      expect(normalizeSeed(shown)).toBe(seed);
      expect(normalizeSeed(shown.toLowerCase())).toBe(seed);
    }
  });

  it('maps look-alikes and rejects bad input', () => {
    expect(formatSeed('spire-001')).toBe('SP1R-E001');
    expect(normalizeSeed('ol0o-ilil')).toBe('0100' + '1111');
    expect(isValidSeed('SPIRE00')).toBe(false);
    expect(isValidSeed('SPIRE00U')).toBe(false);
    expect(() => formatSeed('nope')).toThrow(RangeError);
  });
});

function walkerRig(colliders: () => readonly Box[] = () => []) {
  const rig = new THREE.Group();
  const actions = new ActionBus();
  const walker = new Walker(rig, actions, colliders);
  return { rig, actions, walker };
}

describe('Walker', () => {
  it('walks north at yaw 0 and east after a 90 degree turn', () => {
    const { rig, actions, walker } = walkerRig();
    actions.emit({ type: 'move', forward: 1, strafe: 0 });
    walker.update(0.5);
    expect(rig.position.z).toBeCloseTo(-1, 5);
    actions.emit({ type: 'turn', degrees: 90 });
    actions.emit({ type: 'move', forward: 1, strafe: 0 });
    walker.update(0.5);
    expect(rig.position.x).toBeCloseTo(1, 5);
    // The rig faces where it walks: its local -Z is +X in the world.
    const ahead = new THREE.Vector3(0, 0, -1).applyQuaternion(rig.quaternion);
    expect(ahead.x).toBeCloseTo(1, 5);
  });

  it('stops at a wall and ignores input while disabled', () => {
    const wall = { min: [-5, 0, -1.2] as const, max: [5, 3, -1] as const };
    const { rig, actions, walker } = walkerRig(() => [wall]);
    for (let i = 0; i < 120; i++) {
      actions.emit({ type: 'move', forward: 1, strafe: 0 });
      walker.update(DT);
    }
    expect(rig.position.z).toBeCloseTo(-0.75, 3);
    walker.enabled = false;
    actions.emit({ type: 'move', forward: 0, strafe: 1 });
    actions.emit({ type: 'turn', degrees: 45 });
    walker.update(DT);
    expect(rig.position.x).toBe(0);
    expect(walker.yaw).toBe(0);
  });
});

/** Drives the walker toward each waypoint in turn; returns false if it gets stuck. */
function walkTo(
  world: FloorWorld,
  walker: Walker,
  rig: THREE.Object3D,
  actions: ActionBus,
  target: readonly [number, number],
) {
  let last = Number.POSITIVE_INFINITY;
  let stalled = 0;
  for (let step = 0; step < 3000; step++) {
    const dx = target[0] - rig.position.x;
    const dz = target[1] - rig.position.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 0.1) return true;
    const want = (Math.atan2(dx, -dz) * 180) / Math.PI;
    actions.emit({ type: 'turn', degrees: want - walker.yaw });
    actions.emit({ type: 'move', forward: Math.min(1, dist / (WALK_SPEED * DT)), strafe: 0 });
    walker.update(DT);
    world.update(rig.position.x, rig.position.z);
    stalled = last - dist < 1e-4 ? stalled + 1 : 0;
    if (stalled > 30) return false;
    last = dist;
  }
  return false;
}

describe('desktop walk through a seeded floor', () => {
  for (const seed of ['SPIRE001', 'SPIRE002', 'GEARS777', 'BRASS042']) {
    it(`reaches the guardian vault of ${seed} from the entry through doors only`, () => {
      const plan = generateFloor(seed);
      const world = buildFloorWorld(plan);
      const rig = new THREE.Group();
      const actions = new ActionBus();
      const walker = new Walker(rig, actions, () => world.nearbyColliders());
      rig.position.copy(world.spawnPoint());

      // Door chain from the entry to the vault, following each room's parent link backwards.
      const chain: (readonly [number, number])[] = [];
      let room = plan.guardianRoom;
      while (room !== 0) {
        const link = plan.connections.find(([, b]) => b.room === room);
        expect(link).toBeDefined();
        const [a, b] = link as NonNullable<typeof link>;
        const door = world.rooms[b.room]?.doors.find((d) => d.id === b.door);
        const out = { N: [0, -1], S: [0, 1], E: [1, 0], W: [-1, 0] }[door?.facing ?? 'N'];
        const [x, z] = door?.world ?? [0, 0];
        // Facing points out of room b, so approach from room a's side and step into room b.
        chain.unshift([x + out[0] * 0.9, z + out[1] * 0.9], [x - out[0] * 0.9, z - out[1] * 0.9]);
        room = a.room;
      }
      for (const point of chain) {
        expect(walkTo(world, walker, rig, actions, point), `stuck short of ${point}`).toBe(true);
      }
      expect(world.current).toBe(plan.guardianRoom);
      world.dispose();
    });
  }

  it('cannot walk through a sealed door', () => {
    const plan = generateFloor('SPIRE001');
    const world = buildFloorWorld(plan);
    const sealed = plan.sealed[0];
    expect(sealed).toBeDefined();
    const door = world.rooms[sealed?.room ?? 0]?.doors.find((d) => d.id === sealed?.door);
    const out = { N: [0, -1], S: [0, 1], E: [1, 0], W: [-1, 0] }[door?.facing ?? 'N'];
    const [x, z] = door?.world ?? [0, 0];
    world.update(x - out[0] * 1.5, z - out[1] * 1.5);
    const rig = new THREE.Group();
    const actions = new ActionBus();
    const walker = new Walker(rig, actions, () => world.nearbyColliders());
    rig.position.set(x - out[0] * 1.5, 0, z - out[1] * 1.5);
    expect(walkTo(world, walker, rig, actions, [x + out[0] * 1.5, z + out[1] * 1.5])).toBe(false);
    const past = (rig.position.x - x) * out[0] + (rig.position.z - z) * out[1];
    expect(past).toBeLessThan(0);
    world.dispose();
  });
});

describe('desktop combat framing', () => {
  const setup = () => {
    const camera = new THREE.PerspectiveCamera(70, 1.6, 0.05, 100);
    camera.position.set(0, DEFAULT_EYE_HEIGHT, 0);
    const controls = createDesktopControls(
      camera,
      document.createElement('canvas'),
      new ActionBus(),
    );
    return { camera, controls };
  };

  it('tilts the view down to the table while a fight runs and restores it after', () => {
    const { camera, controls } = setup();
    controls.update();
    expect(camera.rotation.x).toBe(0);
    // True only on the opening frame, which is when main.ts turns the walker to the table.
    expect(controls.frameCombat(-0.4)).toBe(true);
    controls.update();
    expect(camera.rotation.x).toBe(-0.4);
    // The loop calls it every frame of the fight; the saved pitch must survive that.
    expect(controls.frameCombat(-0.5)).toBe(false);
    expect(controls.pitch).toBe(-0.4);
    controls.frameCombat(null);
    controls.update();
    expect(controls.pitch).toBe(0);
    expect(camera.rotation.x).toBe(0);
  });

  // The bug bash found fights opening with the table below the view (seed SPIRE001, room 2: the
  // table fell back to 0.5 m), so the sigil plate and dice tray could not be seen or drawn on.
  for (const distance of [0.5, 0.65]) {
    it(`frames the table centre and the automaton line with the table ${distance} m ahead`, () => {
      const { camera, controls } = setup();
      const top = DEFAULT_EYE_HEIGHT - WAIST_DROP;
      controls.frameCombat(combatPitch(distance, DEFAULT_EYE_HEIGHT - top, camera.fov));
      controls.update();
      camera.updateMatrixWorld(true);
      const points = [
        new THREE.Vector3(0, top, -distance),
        new THREE.Vector3(0, top, -distance - TABLE_HALF_DEPTH),
        new THREE.Vector3(0, 1.6, -distance - 2),
      ];
      for (const p of points) {
        const ndc = p.clone().project(camera);
        expect(Math.abs(ndc.y), `point ${p.toArray()}`).toBeLessThanOrEqual(1);
      }
    });
  }

  it('lands on about -0.4 rad at the default placement', () => {
    expect(
      combatPitch(0.65, DEFAULT_EYE_HEIGHT - (DEFAULT_EYE_HEIGHT - WAIST_DROP), 70),
    ).toBeCloseTo(-0.4, 1);
  });
});

describe('desktop combat framing fit', () => {
  const EYE: XYZ = { x: 0, y: DEFAULT_EYE_HEIGHT, z: 0 };
  const TOP = DEFAULT_EYE_HEIGHT - WAIST_DROP;
  /** The tray (0.3 to 0.05 m toward the player from the table centre), the plate and two automatons. */
  const scene = (distance: number, heading: number) => {
    const fx = Math.sin((heading * Math.PI) / 180);
    const fz = -Math.cos((heading * Math.PI) / 180);
    const at = (forward: number, lateral: number, y: number): XYZ => ({
      x: fx * forward + fz * -lateral,
      y,
      z: fz * forward + fx * lateral,
    });
    const table = { x: fx * distance, z: fz * distance, yaw: heading, height: TOP };
    const must: XYZ[] = [];
    for (const forward of [distance - 0.3, distance - 0.05])
      for (const lateral of [-0.2, 0.2])
        for (const y of [TOP, TOP + 0.08]) must.push(at(forward, lateral, y));
    const plate = platePoseAboveTable(table);
    for (const x of [-plate.halfWidth, plate.halfWidth])
      for (const y of [-plate.halfHeight, plate.halfHeight])
        must.push({
          x: plate.center.x + plate.right.x * x + plate.up.x * y,
          y: plate.center.y + plate.right.y * x + plate.up.y * y,
          z: plate.center.z + plate.right.z * x + plate.up.z * y,
        });
    const want = [at(distance + 1.2, -0.4, 1), at(distance + 1.6, 0.4, 1)];
    return { must, want };
  };

  it('matches the three.js camera projection', () => {
    const camera = new THREE.PerspectiveCamera(80, 1.6, 0.05, 100);
    camera.position.set(EYE.x, EYE.y, EYE.z);
    camera.rotation.set(-0.6, (-37 * Math.PI) / 180, 0, 'YXZ');
    camera.updateMatrixWorld(true);
    const p = { x: 0.7, y: 0.9, z: -0.6 };
    const ndc = new THREE.Vector3(p.x, p.y, p.z).project(camera);
    const mine = projectToNdc(p, EYE, 37, -0.6, 80, 1.6);
    expect(mine?.x).toBeCloseTo(ndc.x, 6);
    expect(mine?.y).toBeCloseTo(ndc.y, 6);
  });

  for (const heading of [0, 90, 215]) {
    for (const distance of [0.5, 0.55, 0.65, 0.8]) {
      for (const aspect of [1.6, 16 / 9, 4 / 3]) {
        it(`keeps the tray, plate and automatons inside the view (table ${distance} m, heading ${heading}, aspect ${aspect.toFixed(2)})`, () => {
          const { must, want } = scene(distance, heading);
          const fit = fitCombatFraming({
            eye: EYE,
            headingDeg: heading,
            aspect,
            baseFov: 70,
            must,
            want,
          });
          expect(fit.fov).toBeGreaterThanOrEqual(70);
          expect(fit.fov).toBeLessThanOrEqual(95);
          for (const p of [...must, ...want]) {
            const ndc = projectToNdc(p, EYE, heading, fit.pitch, fit.fov, aspect);
            expect(ndc, `point ${JSON.stringify(p)}`).not.toBeNull();
            expect(Math.abs(ndc?.x ?? 9)).toBeLessThanOrEqual(0.9);
            expect(Math.abs(ndc?.y ?? 9)).toBeLessThanOrEqual(0.9);
          }
        });
      }
    }
  }

  it('keeps the base field of view when everything fits and widens it only when it does not', () => {
    const wide = scene(0.65, 0);
    const input = { eye: EYE, headingDeg: 0, aspect: 1.6, baseFov: 70 };
    expect(fitCombatFraming({ ...input, ...wide }).fov).toBe(70);
    // An automaton 6 m out and 2.5 m up cannot share a 70 degree view with the tray.
    const far = { must: wide.must, want: [{ x: 0, y: 4.1, z: -6.65 }] };
    expect(fitCombatFraming({ ...input, ...far }).fov).toBeGreaterThan(70);
  });

  it('falls back to the best pitch for the must-fit points when nothing fits', () => {
    const { must } = scene(0.5, 0);
    const fit = fitCombatFraming({
      eye: EYE,
      headingDeg: 0,
      aspect: 1.6,
      baseFov: 70,
      maxFov: 70,
      must: [...must, { x: 0, y: 40, z: -0.6 }],
      want: [],
    });
    expect(fit.fov).toBe(70);
    expect(fit.pitch).toBeLessThanOrEqual(0);
  });

  it('refines the opening pitch and widens the fov for the fight, and restores both after', () => {
    const camera = new THREE.PerspectiveCamera(70, 1.6, 0.05, 100);
    const controls = createDesktopControls(
      camera,
      document.createElement('canvas'),
      new ActionBus(),
    );
    controls.refineCombat({ pitch: -0.9, fov: 90 });
    expect(controls.pitch).toBe(0);
    expect(camera.fov).toBe(70);
    controls.frameCombat(-0.4);
    controls.refineCombat({ pitch: -0.77, fov: 80 });
    expect(controls.pitch).toBe(-0.77);
    expect(camera.fov).toBe(80);
    expect(controls.baseFov).toBe(70);
    controls.frameCombat(null);
    expect(controls.pitch).toBe(0);
    expect(camera.fov).toBe(70);
    expect(controls.baseFov).toBe(70);
  });
});
