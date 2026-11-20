import * as THREE from 'three';
import { expect, it } from 'vitest';
import { generateUpperFloor } from '../src/floor/generate.ts';
import { calibrationPlan, GEAR_TEETH, readCalibration } from '../src/rules/calibration.ts';
import { CalibrationBench, pitchRadius, spindleCenters } from '../src/world/calibration-bench.ts';
import { buildFloorWorld } from '../src/world/floor-world.ts';

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
    const kitA = kit(['CalibrationFrame', 'OrreryInner', 'OrreryMiddle', 'OrreryOuter']),
      kitB = kit([
        'gear_small',
        'gear_medium',
        'gear_large',
        'winding_key',
        'winding_arbor',
        'pegboard_spindle',
      ]);
    const bench = CalibrationBench.mount(world, kitA, kitB, seed, [], true),
      s = readCalibration({ seed });
    bench.sync(s, true);
    world.current = bench.room;
    const name = kind === 'gears' ? 'calibration-wheel-hit-0' : 'orrery-control-0';
    const target = bench.object.getObjectByName(name)!;
    const point = target.getWorldPosition(new THREE.Vector3());
    expect(bench.near(point, 0.02)?.action).toBe(kind === 'gears' ? 'gear' : 'ring');
    if (kind === 'gears') {
      const order = bench.plan.gearOrder;
      bench.sync({ ...s, slots: order, selected: null, chart: true }, true);
      expect(bench.object.getObjectByName('calibration-wheel-' + order[0])?.position.x).toBeCloseTo(
        bench.positions[1],
      );
      expect(GEAR_TEETH[order[0]]).toBeGreaterThan(0);
    } else {
      bench.sync({ ...s, detents: [1, 2, 3], chart: true }, true);
      expect(bench.object.getObjectByName('OrreryMiddle')?.rotation.z).toBeCloseTo(-Math.PI);
    }
    bench.dispose();
    world.dispose();
  },
);
