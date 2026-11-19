// @vitest-environment node
import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { expect, it } from 'vitest';
import { mountFloorView } from '../src/world/floor-view.ts';
import { nodeGeometryLoader } from './helpers/gltf-node.ts';

it('moves the authored instruments when setting and priming the pump, and restores the running readings', async () => {
  const view = mountFloorView(new THREE.Scene(), new THREE.Group(), 'MAPTEST2');
  const works = view.pressure;
  const wing = view.world.plan.pressureWing;
  if (!wing || !works) throw Error('Pump room missing');
  const load = async (name: string) => {
    const data = await readFile('public/assets/props/pressure-works/' + name + '.glb');
    return (
      await nodeGeometryLoader().parseAsync(
        data.buffer.slice(data.byteOffset, data.byteOffset + data.length),
        '',
      )
    ).scene;
  };
  const [manifold, gallery, bank] = await Promise.all(
    ['manifold', 'gallery-pipes', 'accumulator-bank'].map(load),
  );
  const art = { manifold, 'gallery-pipes': gallery, 'accumulator-bank': bank };
  works.dress(art);
  const instruments = () => {
    const needles: THREE.Object3D[] = [],
      glass: THREE.Object3D[] = [];
    for (const r of [wing.pumpRoom, wing.gallery])
      view.world.roomGroups[r].traverse((n) => {
        if (n.name.startsWith('gauge-needle-')) needles.push(n);
        else if (n.name === 'sight-fluid') glass.push(n);
      });
    expect(needles).toHaveLength(8);
    expect(glass).toHaveLength(3);
    return { angles: needles.map((n) => n.rotation.z), levels: glass.map((n) => n.scale.y) };
  };
  const cold = instruments();
  works.sync({ dials: [1, 2, 3], solved: false }, true, 'turn');
  expect(instruments()).toEqual(cold);
  works.update(1);
  const set = instruments();
  expect(set.angles).not.toEqual(cold.angles);
  expect(Math.max(...set.levels)).toBeGreaterThan(Math.max(...cold.levels));
  works.primeMiss();
  works.update(0.25);
  const pulse = instruments();
  expect(Math.min(...pulse.levels)).toBeGreaterThan(Math.min(...set.levels));
  works.update(2);
  works.sync({ dials: [1, 2, 3], solved: true }, false, 'prime');
  const running = instruments();
  expect(Math.min(...running.levels)).toBeGreaterThan(Math.max(...set.levels));
  works.dress(art);
  expect(instruments()).toEqual(running);
  works.primeMiss(false);
  works.update(0.25);
  expect(instruments()).toEqual(running);
  view.dispose();
});
