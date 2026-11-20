// @vitest-environment node

import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { expect, it } from 'vitest';
import { generateUpperFloor } from '../src/floor/generate.ts';
import { calibrationPlan, GEAR_TEETH, readCalibration } from '../src/rules/calibration.ts';
import { CalibrationBench, pitchRadius, spindleCenters } from '../src/world/calibration-bench.ts';
import { CalibrationKeyStand } from '../src/world/calibration-cabinet.ts';
import { buildFloorWorld } from '../src/world/floor-world.ts';
import { nodeGeometryLoader } from './helpers/gltf-node.ts';

function kit(names: readonly string[]) {
  const a = new THREE.Group();
  for (const name of names) {
    const g = new THREE.Group();
    g.name = name;
    g.add(
      new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.09, 0.09), new THREE.MeshStandardMaterial()),
    );
    a.add(g);
  }
  return a;
}
it('spindle spacing matches the pitch radius of its two actual neighbors in every seeded permutation', () => {
  const orders = new Set<string>();
  for (let i = 0; i < 80; i++) {
    const p = calibrationPlan('B' + String(i).padStart(7, '0')),
      xs = spindleCenters(p.gearOrder),
      rs = [pitchRadius(0), ...p.gearOrder.map(pitchRadius), pitchRadius(0)];
    orders.add(p.gearOrder.join(''));
    for (let j = 1; j < 5; j++) expect(xs[j] - xs[j - 1]).toBeCloseTo(rs[j] + rs[j - 1]);
    expect(xs[0] - rs[0]).toBeGreaterThan(-0.66);
    expect(xs[4] + rs[4]).toBeLessThan(0.66);
  }
  expect(orders.size).toBe(6);
});
it.each(['gears', 'orrery'] as const)(
  'mounts and poses the actual control points for %s',
  (kind) => {
    const seed = Array.from({ length: 32 }, (_, i) => 'B' + String(i).padStart(7, '0')).find(
      (s) => calibrationPlan(s).kind === kind,
    )!;
    const world = buildFloorWorld(generateUpperFloor(seed));
    const kitA = kit([
        'CalibrationFrame',
        'OrreryInner',
        'OrreryMiddle',
        'OrreryOuter',
        'OrreryBed',
        'OrreryDrive',
        'OrreryConsole',
        'OrreryCoupling',
        'OrrerySplitCollar',
        'OrreryKnob',
      ]),
      kitB = kit([
        'gear_small',
        'gear_medium',
        'gear_large',
        'winding_key',
        'winding_arbor',
        'pegboard_spindle',
      ]);
    const bench = CalibrationBench.mount(world, kitA, kitB, seed, [], false),
      s = readCalibration({ seed });
    bench.sync(s, true);
    world.current = bench.room;
    const name = kind === 'gears' ? 'calibration-wheel-hit-0' : 'orrery-control-0';
    const target = bench.object.getObjectByName(name)!;
    const point = target.getWorldPosition(new THREE.Vector3());
    expect(bench.near(point, 0.02)?.action).toBe(kind === 'gears' ? 'gear' : 'ring');
    const arbor = bench.object.getObjectByName('calibration-wind-target')!;
    const key = bench.object.getObjectByName('calibration-seated-key')!;
    const socket = arbor.getWorldPosition(new THREE.Vector3());
    const front = bench.object.getWorldDirection(new THREE.Vector3());
    const origin = socket.clone().add(front);
    const inward = front.negate();
    expect(key.visible).toBe(false);
    if (kind === 'gears') {
      const order = bench.plan.gearOrder;
      bench.sync({ ...s, slots: order, selected: null, chart: true }, true);
      expect(key.visible).toBe(true);
      expect(bench.near(socket, 0.02)?.action).toBe('wind');
      expect(bench.object.getObjectByName('calibration-wheel-' + order[0])?.position.x).toBeCloseTo(
        bench.positions[1],
      );
      expect(GEAR_TEETH[order[0]]).toBeGreaterThan(0);
    } else {
      const repair = bench.object.getObjectByName('orrery-repair-target')!;
      expect(bench.near(repair.getWorldPosition(new THREE.Vector3()), 0.02)?.action).toBe('repair');
      const knobs = [0, 1, 2].map((id) => bench.object.getObjectByName('orrery-control-' + id)!);
      const dial = bench.object.getObjectByName('OrreryOuter')!;
      expect(knobs.every((knob) => knob.position.x - dial.position.x > 0.42)).toBe(true);
      bench.sync({ ...s, detents: [1, 2, 3], chart: true }, true);
      expect(bench.object.getObjectByName('OrreryMiddle')?.rotation.z).toBeCloseTo(-Math.PI);
      bench.sync({ ...s, chart: true, repaired: true }, true);
      expect(bench.object.getObjectByName('OrrerySplitCollar')?.visible).toBe(false);
      expect(bench.object.getObjectByName('OrreryCoupling')?.visible).toBe(true);
      expect(key.visible).toBe(false);
      expect(bench.pick(origin, inward)?.action).toBe('insert-key');
      bench.sync({ ...s, key: 'held' });
      expect(bench.near(socket, 0.02)?.action).toBe('insert-key');
      bench.sync({ ...s, key: 'inserted' });
      expect(key.visible).toBe(true);
      const start = key.position.z;
      expect(start).toBeGreaterThan(0.1);
      world.roomGroups[bench.room].visible = true;
      bench.update(0.25);
      expect(key.position.z).toBeGreaterThan(0);
      expect(key.position.z).toBeLessThan(start);
      bench.sync({ ...s, key: 'inserted' }, true);
      expect(key.position.z).toBe(0);
      expect(bench.pick(origin, inward)?.action).toBe('wind');
      expect(bench.near(socket, 0.02)?.action).toBe('wind');
    }
    bench.dispose();
    world.dispose();
  },
);

it('hangs a collectible authored winding key in a separate Upper Works room', async () => {
  const bytes = await readFile('public/assets/props/puzzle-instruments/puzzle-instruments.glb');
  const { scene } = await nodeGeometryLoader().parseAsync(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    '',
  );
  const world = buildFloorWorld(generateUpperFloor('MAPTEST2'));
  const entry = world.stairEntry?.room ?? 0;
  for (const benchRoom of [entry === 0 ? 1 : 0, entry]) {
    const stand = CalibrationKeyStand.mount(world, scene, [], benchRoom);
    expect(stand.room).not.toBe(benchRoom);
    if (entry !== benchRoom) expect(stand.room).toBe(entry);
    expect(stand.object.getObjectByName('left_bow')).toBeDefined();
    expect(stand.object.getObjectByName('orrery-key-board')).toBeDefined();
    const target = stand.key.getWorldPosition(new THREE.Vector3());
    const front = stand.object.getWorldDirection(new THREE.Vector3());
    const origin = target.clone().add(front);
    const inward = front.negate();
    world.current = stand.room;
    expect(stand.pick(origin, inward)?.action).toBe('key');
    expect(stand.near(target, 0.04)?.action).toBe('key');
    const remove = world.addFixtureCollider(stand.room, {
      min: origin.clone().addScaledVector(inward, 0.5).addScalar(-0.06).toArray(),
      max: origin.clone().addScaledVector(inward, 0.5).addScalar(0.06).toArray(),
    });
    expect(stand.pick(origin, inward)).toBeNull();
    remove();
    world.current = benchRoom;
    expect(stand.near(target, 1)).toBeNull();
    world.current = stand.room;
    stand.sync(true);
    expect(stand.pick(origin, inward)).toBeNull();
    expect(stand.near(target, 1)).toBeNull();
    stand.dispose();
    expect(stand.object.parent).toBeNull();
  }
  world.dispose();
});
