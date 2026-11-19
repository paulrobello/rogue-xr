// @vitest-environment node

import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { describe, expect, it } from 'vitest';
import { parseRoomTemplate, templateById } from '../src/content/rooms.ts';
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

async function realAsset(): Promise<InteriorFurnishingsAsset> {
  const bytes = await readFile('public/assets/props/interior-furnishings/interior-furnishings.glb');
  const start = bytes.byteOffset;
  const end = start + bytes.byteLength;
  const gltf = await new GLTFLoader().parseAsync(bytes.buffer.slice(start, end), '');
  gltf.scene.updateMatrixWorld(true);
  const roots = {} as Record<(typeof ROOTS)[number], THREE.Object3D>;
  for (const name of ROOTS) {
    const root = gltf.scene.getObjectByName(name);
    if (!root) throw new Error(`missing GLB root ${name}`);
    roots[name] = root;
  }
  return { scene: gltf.scene, roots };
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

  it('keeps every portrait paired with a same-room bookcase and anchors curtains to windows', () => {
    let portraits = 0;
    let curtains = 0;
    const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    const seeds = Array.from({ length: 100 }, (_, i) => {
      const a = alphabet[Math.floor(i / alphabet.length)];
      const b = alphabet[i % alphabet.length];
      return `S${a}${b}R00X0`;
    });
    for (const seed of [...seeds, 'N0TE0032']) {
      const world = buildFloorWorld(generateFloor(seed));
      const furnishings = new InteriorFurnishings(world, asset());
      for (const portrait of furnishings.placements.filter((p) => p.root === 'FramedPainting')) {
        portraits++;
        expect(
          furnishings.placements.some((p) => p.room === portrait.room && p.root === 'Bookcase'),
        ).toBe(true);
      }
      for (const curtain of furnishings.placements.filter((p) => p.root === 'Curtain')) {
        curtains++;
        const template = templateById(world.plan.rooms[curtain.room]?.templateId ?? 'corridor');
        expect(['hall', 'study']).toContain(template.id);
        expect(curtain.position.z).toBeCloseTo(template.footprint.min[1] + 0.2615, 3);
      }
      furnishings.dispose();
    }
    expect(portraits).toBeGreaterThan(0);
    expect(curtains).toBeGreaterThan(0);
    const noteWorld = buildFloorWorld(generateFloor('N0TE0032'));
    const noteFurnishings = new InteriorFurnishings(noteWorld, asset());
    expect(noteFurnishings.placements.some((p) => p.root === 'FramedPainting')).toBe(true);
    noteFurnishings.dispose();
  });

  it('keeps real GLB furnishings out of every rotated doorway and flush to their walls', async () => {
    const furnishingsAsset = await realAsset();
    const templates = await Promise.all(
      ['study', 'hall', 'corridor', 'guardian-vault', 'gear-shaft'].map(async (id) =>
        parseRoomTemplate(
          JSON.parse(
            await readFile(
              new URL(`../public/assets/rooms/${id}/${id}.manifest.json`, import.meta.url),
              'utf8',
            ),
          ),
        ),
      ),
    );
    let curtainCount = 0;
    let portraitCount = 0;
    const seedAlphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    const seeds = [
      'N0TE0032',
      'SPIRE002',
      'SPIRE004',
      ...Array.from({ length: seedAlphabet.length }, (_, i) => `S0${seedAlphabet[i]}R00X0`),
    ];
    for (const seed of seeds) {
      const world = buildFloorWorld(generateFloor(seed), templates);
      const furnishings = new InteriorFurnishings(world, furnishingsAsset);
      if (seed === 'N0TE0032')
        expect(furnishings.placements.some((p) => p.root === 'FramedPainting')).toBe(true);
      world.group.updateMatrixWorld(true);
      for (const placement of furnishings.placements) {
        if (placement.root === 'Curtain') curtainCount++;
        if (placement.root === 'FramedPainting') portraitCount++;
        const group = world.roomGroups[placement.room];
        if (!group) throw new Error(`missing room group ${placement.room}`);
        const inverse = group.matrixWorld.clone().invert();
        const local = new THREE.Box3().setFromObject(placement.object).applyMatrix4(inverse);
        const template = templateById(world.plan.rooms[placement.room]?.templateId ?? 'corridor');
        for (const door of template.doors) {
          const [x, , z] = door.position;
          const alongDoor = door.facing === 'N' || door.facing === 'S';
          const alongMin = (alongDoor ? x : z) - door.width / 2 - 0.08;
          const alongMax = (alongDoor ? x : z) + door.width / 2 + 0.08;
          const acrossMin = (alongDoor ? z : x) - 0.55;
          const acrossMax = (alongDoor ? z : x) + 0.55;
          const a0 = alongDoor ? local.min.x : local.min.z;
          const a1 = alongDoor ? local.max.x : local.max.z;
          const c0 = alongDoor ? local.min.z : local.min.x;
          const c1 = alongDoor ? local.max.z : local.max.x;
          expect(a0 <= alongMax && a1 >= alongMin && c0 <= acrossMax && c1 >= acrossMin).toBe(
            false,
          );
        }
        if (['Bookcase', 'WallClock', 'FramedPainting', 'Curtain'].includes(placement.root)) {
          const distances = [
            Math.abs(local.min.x - template.footprint.min[0]),
            Math.abs(template.footprint.max[0] - local.max.x),
            Math.abs(local.min.z - template.footprint.min[1]),
            Math.abs(template.footprint.max[1] - local.max.z),
          ];
          expect(Math.min(...distances)).toBeGreaterThanOrEqual(0.005);
          expect(Math.min(...distances)).toBeCloseTo(
            placement.root === 'Curtain' ? 0.125 : 0.012,
            2,
          );
        }
        if (placement.root === 'Curtain') {
          expect(local.min.y).toBeGreaterThan(1.0);
          expect(local.max.y).toBeLessThan(3.9);
        }
      }
      furnishings.dispose();
    }
    expect(curtainCount).toBeGreaterThan(0);
    expect(portraitCount).toBeGreaterThan(0);
  });
});
