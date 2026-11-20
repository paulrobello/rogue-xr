import * as THREE from 'three';
import { expect, it } from 'vitest';
import { makeClockworkOwlAsset } from '../src/enemies/conservatory-actors.ts';
import { conservatoryPlan } from '../src/floor/conservatory.ts';
import { ConservatoryGallery } from '../src/world/conservatory-gallery.ts';
import { buildFloorWorld } from '../src/world/floor-world.ts';

it('keeps moving figures inside separate fixed frames and gives the owl combat clips', () => {
  const world = buildFloorWorld(conservatoryPlan('MAPTEST3'));
  const art = new THREE.Group();
  for (const name of ['MechanicalBroom', 'OwlHead', 'OwlWingL', 'OwlWingR']) {
    const node = new THREE.Mesh(
      new THREE.BoxGeometry(0.1, 0.1, 0.1),
      new THREE.MeshStandardMaterial(),
    );
    node.name = name;
    art.add(node);
  }
  const textures = [0.75, 0.86, 0.8].map(
    (r) => new THREE.Texture({ width: 100 * r, height: 100 } as HTMLImageElement),
  );
  const gallery = ConservatoryGallery.mount(world, art, textures)!;
  expect(new Set(gallery.roomIds).size).toBe(2);
  const frame = gallery.portraitGroups[0];
  const wizard = frame.getObjectByName('wizard-portrait-0') as THREE.Mesh;
  const pose = frame.quaternion.clone();
  gallery.update(1, frame.localToWorld(new THREE.Vector3(2, 0, 1)));
  expect(frame.quaternion.equals(pose)).toBe(true);
  expect(wizard.rotation.y).toBeGreaterThan(0.03);
  expect(wizard.position.z - Math.sin(wizard.rotation.y) * 0.5).toBeGreaterThan(0);
  const owl = makeClockworkOwlAsset(art),
    actor = owl.spawn();
  expect(actor.socket('socket-hit')?.position.y).toBeGreaterThan(0.4);
  const head = actor.object.getObjectByName('OwlHead')!;
  head.position.y = 0.62;
  actor.update(0.1);
  expect(head.getWorldPosition(new THREE.Vector3()).y).toBeGreaterThan(1.5);
  actor.attack();
  actor.update(0.22);
  expect(Math.abs(actor.object.getObjectByName('OwlWingL')!.rotation.z)).toBeGreaterThan(0.2);
  actor.dispose();
  owl.dispose();
  gallery.dispose();
  world.dispose();
});
