import * as THREE from 'three';
import { expect, it } from 'vitest';
import { CommissionOffice } from '../src/world/commission-office.ts';
import { playableFloorPlan } from '../src/world/floor-view.ts';
import { buildFloorWorld } from '../src/world/floor-world.ts';

function art() {
  const root = new THREE.Group(),
    part = (name: string, parent: THREE.Object3D) => {
      const n = new THREE.Mesh(
        new THREE.BoxGeometry(0.14, 0.13, 0.035),
        new THREE.MeshStandardMaterial(),
      );
      n.name = name;
      parent.add(n);
      return n;
    };
  const ledger = part('CommissionLedger', root),
    paper = part('CommissionPaperPivot', ledger),
    stamp = part('CommissionStamp', ledger);
  paper.position.x = -0.18;
  stamp.position.set(0.3, -0.13, 0.1);
  part('CommissionPurse', root);
  for (let i = 1; i <= 3; i++) part('ReturnSpring' + i, root);
  return root;
}
it('mounts separate supported pickups, presents the stamp on read, and flies only a live claim', () => {
  const world = buildFloorWorld(playableFloorPlan('MAPTEST2', 5)),
    office = CommissionOffice.mount(world, art(), 1, 'recovery', [], true)!;
  expect(new Set(office.springs.map((s) => s.room)).size).toBe(2);
  expect(office.springs.map((s) => s.spring)).toEqual([0, 1]);
  const book = office.object.getWorldPosition(new THREE.Vector3());
  world.update(book.x, book.z);
  world.current = office.room;
  office.sync({ accepted: false, claimed: false, recovered: [], progress: 0, total: 3 });
  const stamp = office.stamp!.getWorldPosition(new THREE.Vector3());
  expect(office.near(stamp, 0.2)?.action).toBe('read');
  office.read();
  office.update(0.2);
  expect(office.near(stamp, 0.2)?.action).toBe('accept');
  office.sync({ accepted: true, claimed: false, recovered: [0, 1, 2], progress: 3, total: 3 });
  expect(office.purse!.visible).toBe(true);
  office.sync(
    { accepted: true, claimed: true, recovered: [0, 1, 2], progress: 3, total: 3 },
    new THREE.Object3D(),
  );
  expect(office.purse!.visible).toBe(false);
  expect(world.group.getObjectByName('commission-purse-flight')).toBeTruthy();
  office.update(1);
  expect(world.group.getObjectByName('commission-purse-flight')).toBeUndefined();
  office.dispose();
  world.dispose();
});
