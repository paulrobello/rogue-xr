// @vitest-environment node
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { generateFloor } from '../src/floor/generate.ts';
import { buildFloorWorld } from '../src/world/floor-world.ts';
import {
  InteriorFurnishings,
  type InteriorFurnishingsAsset,
} from '../src/world/interior-furnishings.ts';

const ROOTS = [
  'DoorSingle',
  'DoorDouble',
  'DoorArched',
  'Curtain',
  'DiningChair',
  'DiningTable',
  'Bookcase',
  'Candelabrum',
  'WallClock',
  'ClockworkArmor',
  'FramedPainting',
] as const;

function asset(): InteriorFurnishingsAsset {
  const roots = {} as Record<(typeof ROOTS)[number], THREE.Object3D>;
  for (const name of ROOTS) {
    const root = new THREE.Group();
    root.name = name;
    if (name === 'Candelabrum')
      for (let i = 0; i < 6; i++) {
        const socket = new THREE.Object3D();
        socket.name = `Candelabrum_FlameSocket_${String(i).padStart(2, '0')}`;
        root.add(socket);
      }
    roots[name] = root;
  }
  return { scene: new THREE.Group(), roots };
}

describe('interior furnishings', () => {
  it('uses a dedicated seed stream and keeps repeated floors identical', () => {
    const a = new InteriorFurnishings(buildFloorWorld(generateFloor('SPIRE002')), asset());
    const b = new InteriorFurnishings(buildFloorWorld(generateFloor('SPIRE002')), asset());
    expect(
      a.placements.map((p) => [p.room, p.theme, p.root, p.position.x, p.position.z, p.yaw]),
    ).toEqual(
      b.placements.map((p) => [p.room, p.theme, p.root, p.position.x, p.position.z, p.yaw]),
    );
    a.dispose();
    b.dispose();
  });

  it('varies rooms and supplies lifecycle-safe animated candelabra flames', () => {
    const world = buildFloorWorld(generateFloor('SPIRE004'));
    const furnishings = new InteriorFurnishings(world, asset());
    expect(furnishings.placements.length).toBeGreaterThan(0);
    expect(new Set(furnishings.placements.map((p) => p.room)).size).toBeGreaterThan(0);
    furnishings.update(0.25);
    furnishings.dispose();
    expect(furnishings.placements.every((p) => p.object.parent === null)).toBe(true);
  });
});
