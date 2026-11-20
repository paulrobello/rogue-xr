// @vitest-environment node
import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { expect, it } from 'vitest';
import { templateById } from '../src/content/rooms.ts';
import { makeClockworkOwlAsset, makeOwlPerch } from '../src/enemies/conservatory-actors.ts';
import { conservatoryPlan } from '../src/floor/conservatory.ts';
import { ConservatoryGallery } from '../src/world/conservatory-gallery.ts';
import { buildFloorWorld } from '../src/world/floor-world.ts';
import { kitPart } from '../src/world/puzzle-placement.ts';
import { nodeGeometryLoader } from './helpers/gltf-node.ts';

async function loadPropScene(path: string): Promise<THREE.Group> {
  const bytes = await readFile(`public/assets/props/${path}/${path}.glb`);
  return (
    await nodeGeometryLoader().parseAsync(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      '',
    )
  ).scene;
}

it('encloses both paintings at oblique angles and keeps the cases clear of the timber chair rail', async () => {
  const world = buildFloorWorld(conservatoryPlan('MAPTEST3'));
  const wall = kitPart(await loadPropScene('architectural-finishes'), 'TimberBay');
  wall.updateWorldMatrix(true, true);
  const rail = new THREE.Raycaster(
    new THREE.Vector3(0, 1.165, 0.5),
    new THREE.Vector3(0, 0, -1),
  ).intersectObject(wall, true)[0];
  expect(rail.point.z).toBeGreaterThan(0.1);
  const art = new THREE.Group();
  const broom = new THREE.Group();
  broom.name = 'MechanicalBroom';
  art.add(broom);
  const textures = [0.75, 768 / 891, 0.8].map(
    (r) => new THREE.Texture({ width: 100 * r, height: 100 } as HTMLImageElement),
  );
  const gallery = ConservatoryGallery.mount(world, art, textures);
  if (!gallery) throw Error('Missing portrait mount');
  expect(new Set(gallery.roomIds).size).toBe(2);
  for (const [i, frame] of gallery.portraitGroups.entries()) {
    const wizard = kitPart(frame, `wizard-portrait-${i}`) as THREE.Mesh<THREE.PlaneGeometry>;
    const back = kitPart(frame, `observatory-background-${i}`) as THREE.Mesh<THREE.PlaneGeometry>;
    const shell = kitPart(frame, `portrait-case-${i}`) as THREE.Mesh;
    const solids = frame.children.filter((o) => o instanceof THREE.Mesh && o !== wizard);
    const pose = frame.quaternion.clone();
    const hw = back.geometry.parameters.width / 2;
    const hh = back.geometry.parameters.height / 2;
    shell.geometry.computeBoundingBox();
    const inward = new THREE.Vector3(0, 0, 1).applyQuaternion(frame.quaternion);
    const fromWall = templateById('hall').footprint.max[0] + frame.position.dot(inward);
    const rear = fromWall + shell.position.z + (shell.geometry.boundingBox?.min.z ?? -Infinity);
    expect(rear - rail.point.z).toBeGreaterThan(0.01);
    world.roomGroups[gallery.roomIds[i]].visible = true;
    frame.updateWorldMatrix(true, true);
    const straight = new THREE.Raycaster(
      frame.localToWorld(new THREE.Vector3(0, 0, 1.5)),
      new THREE.Vector3(0, 0, -1).transformDirection(frame.matrixWorld),
    );
    expect(straight.intersectObjects(solids, false)[0]?.object).toBe(back);
    for (const sign of [-1, 1]) {
      const eye = new THREE.Vector3(sign * 1.8, 0.4, 0.34);
      gallery.update(1, frame.localToWorld(eye.clone()));
      frame.updateWorldMatrix(true, true);
      expect(frame.quaternion.equals(pose)).toBe(true);
      expect(sign * wizard.rotation.y).toBeGreaterThan(0.03);
      for (const offset of [-0.032, 0.032]) {
        const origin = frame.localToWorld(eye.clone().add(new THREE.Vector3(offset, 0, 0)));
        const rayTo = (p: THREE.Vector3) =>
          new THREE.Raycaster(origin, frame.localToWorld(p).sub(origin).normalize());
        // Every sightline through the opening meets the lining or the rear art, including its corners.
        for (const x of [-hw + 0.04, 0, hw - 0.04]) {
          for (const y of [-hh + 0.04, 0, hh - 0.04]) {
            const ray = rayTo(new THREE.Vector3(x, y, 0.16));
            expect(ray.intersectObjects(solids, false).length).toBeGreaterThan(0);
          }
        }
        // At this angle the far edge can be seen inside; the near edges must disappear behind the case.
        for (const panel of [wizard, back]) {
          const edge = new THREE.Vector3(
            sign * (panel.geometry.parameters.width / 2 - 0.001),
            0,
            0,
          );
          const ray = rayTo(edge.applyMatrix4(panel.matrix));
          expect(ray.intersectObjects([shell, panel], false)[0]?.object).toBe(shell);
        }
      }
    }
    expect(wizard.position.z - back.position.z).toBeGreaterThan(0.06);
  }
  gallery.dispose();
  world.dispose();
});

it('rests both shipped owl talons on the floor-mounted perch throughout idle and lifts off to attack', async () => {
  const scene = await loadPropScene('alchemy-kit');
  const owl = makeClockworkOwlAsset(kitPart(scene, 'ClockworkOwl'));
  const actor = owl.spawn();
  const perch = makeOwlPerch();
  expect(new THREE.Box3().setFromObject(perch.object).min.y).toBeCloseTo(0, 5);
  const ray = new THREE.Raycaster();
  const flight = kitPart(actor.object, 'OwlFlight');
  const rest = flight.position.y;
  for (let t = 0; t <= 2.4; t += 0.2) {
    actor.update(0.2);
    actor.object.updateWorldMatrix(true, true);
    for (const x of [-0.12, 0.12]) {
      ray.set(new THREE.Vector3(x, 0.94, -0.08), new THREE.Vector3(0, 1, 0));
      const talon = ray.intersectObject(actor.object, true)[0].point.y;
      ray.set(new THREE.Vector3(x, 1.2, -0.08), new THREE.Vector3(0, -1, 0));
      const bar = ray.intersectObject(perch.object, true)[0].point.y;
      expect(bar - talon).toBeGreaterThanOrEqual(0);
      expect(bar - talon).toBeLessThan(0.003);
    }
  }
  expect(actor.socket('socket-hit')?.position.y).toBeGreaterThan(0.4);
  actor.attack();
  actor.update(0.22);
  expect(flight.position.y).toBeGreaterThan(rest + 0.05);
  expect(Math.abs(kitPart(actor.object, 'OwlWingL').rotation.z)).toBeGreaterThan(0.2);
  actor.dispose();
  owl.dispose();
  perch.dispose();
});
