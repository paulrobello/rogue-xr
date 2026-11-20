import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { conservatoryPlan } from '../src/floor/conservatory.ts';
import { ConservatoryArchive } from '../src/world/conservatory-archive.ts';
import { buildFloorWorld } from '../src/world/floor-world.ts';

function art(): THREE.Group {
  const root = new THREE.Group();
  for (const name of [
    'ArchiveInkLeft',
    'ArchiveInkRight',
    'ArchiveInkTrace',
    'ArchiveInkLatch',
    'ArchiveWindLeft',
    'ArchiveWindRight',
    'ArchiveWindRotor',
    'ArchiveMirrorLeft',
    'ArchiveMirrorRight',
    'ArchiveMirrorSilver',
  ]) {
    const node = new THREE.Group();
    node.name = name;
    node.add(
      new THREE.Mesh(
        new THREE.BoxGeometry(0.12, 0.12, 0.12),
        new THREE.MeshStandardMaterial({ color: 0x777777 }),
      ),
    );
    root.add(node);
  }
  return root;
}

describe('optional conservatory archive', () => {
  it('adds a deterministic room 6 with an aligned archive gate and reward', () => {
    const a = conservatoryPlan('ARCHIVE1');
    const b = conservatoryPlan('ARCHIVE1');
    expect(a.rooms).toHaveLength(7);
    expect(a.rooms.slice(0, 6)).toEqual(b.rooms.slice(0, 6));
    const edge = a.connections.find((connection) => connection.puzzleGate === 'archive');
    expect(edge).toBeTruthy();
    expect(edge?.[1].room).toBe(6);
    expect(a.rooms[6]?.loot.length).toBeGreaterThan(0);
    expect(
      a.sealed.some((sealed) => sealed.room === edge?.[0].room && sealed.door === edge?.[0].door),
    ).toBe(false);
    const rooms = buildFloorWorld(a);
    const da = rooms.rooms[edge![0].room]?.doors.find((door) => door.id === edge![0].door);
    const db = rooms.rooms[6]?.doors.find((door) => door.id === edge![1].door);
    expect(da?.world).toEqual(db?.world);
    expect(db?.facing).toBe(({ N: 'S', S: 'N', E: 'W', W: 'E' } as const)[da?.facing ?? 'N']);
    rooms.dispose();
  });

  it.each(['lantern-ink', 'stillwind', 'looking-glass'] as const)(
    'mounts the %s authored variant room-aware',
    (kind) => {
      const world = buildFloorWorld(conservatoryPlan('ARCHIVE2'));
      const archive = ConservatoryArchive.mount(world, art(), kind, false);
      expect(archive.object.parent).toBeTruthy();
      archive.sync({ revealed: false, opened: false }, true);
      expect(archive.near(new THREE.Vector3(), 4)).toBeNull();
      expect(archive.effect.visible).toBe(kind !== 'lantern-ink');
      if (kind === 'lantern-ink') {
        expect(archive.latch?.visible).toBe(false);
        archive.sync({ revealed: true, opened: false }, true);
        expect(archive.effect.visible).toBe(true);
        expect(archive.latch?.visible).toBe(true);
      }
      if (kind === 'stillwind') {
        const room = world.plan.rooms[archive.room];
        world.update(...room.position);
        const start = archive.effect.rotation.z;
        archive.update(0.25);
        expect(archive.effect.rotation.z).toBeGreaterThan(start);
      }
      archive.sync({ revealed: true, opened: true }, true);
      expect(archive.effect.visible).toBe(false);
      expect(archive.leaves[0].rotation.y).toBeCloseTo(Math.PI / 2);
      archive.dispose();
      world.dispose();
    },
  );
});
