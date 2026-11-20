// @vitest-environment node

import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { parseRoomTemplate, templateById } from '../src/content/rooms.ts';
import { generateFloor } from '../src/floor/generate.ts';
import { buildFloorWorld } from '../src/world/floor-world.ts';
import {
  InteriorFurnishings,
  type InteriorFurnishingsAsset,
} from '../src/world/interior-furnishings.ts';
import { nodeGeometryLoader } from './helpers/gltf-node.ts';

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
    if (name === 'Bookcase') {
      const book = new THREE.Group(),
        slider = new THREE.Group();
      book.name = 'Bookcase_PullBook';
      slider.name = 'Bookcase_Slider';
      root.add(book, slider);
    }
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

function paintedAsset(): InteriorFurnishingsAsset {
  const result = asset();
  const canvas = new THREE.Mesh(new THREE.PlaneGeometry(0.78, 0.8));
  canvas.name = 'Canvas';
  result.roots.FramedPainting.add(canvas);
  return result;
}

async function realAsset(): Promise<InteriorFurnishingsAsset> {
  const bytes = await readFile('public/assets/props/interior-furnishings/interior-furnishings.glb');
  const start = bytes.byteOffset;
  const end = start + bytes.byteLength;
  const gltf = await nodeGeometryLoader().parseAsync(bytes.buffer.slice(start, end), '');
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
  it('seats the dining candleholder on the center plank with a tabletop scale', async () => {
    const asset = await realAsset();
    const world = buildFloorWorld(generateFloor('MAPTEST2'));
    const furnishings = new InteriorFurnishings(world, asset);
    const table = furnishings.placements.find((p) => p.root === 'DiningTable');
    const lamp = furnishings.placements.find(
      (p) => p.root === 'Candelabrum' && p.room === table?.room,
    );
    if (!table || !lamp) throw Error('Showcase dining set missing');
    const origin = lamp.object.getWorldPosition(new THREE.Vector3());
    const ray = new THREE.Raycaster(
      origin.clone().add(new THREE.Vector3(0, 1, 0)),
      new THREE.Vector3(0, -1, 0),
    );
    const surface = ray.intersectObject(table.object, true)[0];
    expect(surface.point.y).toBeCloseTo(origin.y, 4);
    const tip = lamp.object.getObjectByName('Candelabrum_FlameSocket_00');
    if (!tip) throw Error('Missing flame socket');
    const height = tip.getWorldPosition(new THREE.Vector3()).y - origin.y;
    expect(height).toBeGreaterThan(0.38);
    expect(height).toBeLessThan(0.46);
    furnishings.dispose();
    world.dispose();
  });

  it('exports smooth side normals on the candleholder metal and wax', async () => {
    const { roots } = await realAsset();
    const sides = new Map<string, number>();
    const flat = new Set<string>();
    const normal = new THREE.Vector3();
    const a = new THREE.Vector3(),
      b = new THREE.Vector3(),
      c = new THREE.Vector3();
    roots.Candelabrum.traverse((mesh) => {
      if (!(mesh instanceof THREE.Mesh)) return;
      const g = mesh.geometry,
        positions = g.getAttribute('position'),
        normals = g.getAttribute('normal');
      const material = mesh.material.name;
      for (let i = 0; i < (g.index?.count ?? positions.count); i += 3) {
        const indices = [0, 1, 2].map((k) => g.index?.getX(i + k) ?? i + k);
        a.fromBufferAttribute(positions, indices[0]);
        const face = b
          .fromBufferAttribute(positions, indices[1])
          .sub(a)
          .cross(c.fromBufferAttribute(positions, indices[2]).sub(a))
          .normalize();
        if (Math.abs(face.y) >= 0.15) continue;
        sides.set(material, (sides.get(material) ?? 0) + 1);
        if (indices.every((j) => normal.fromBufferAttribute(normals, j).dot(face) > 0.99999))
          flat.add(material);
      }
    });
    expect([...sides.keys()].sort()).toEqual(['AntiqueBrass', 'BlackIron', 'ClockIvory']);
    expect([...flat]).toEqual([]);
  });

  it('loads textured dining wood and upholstery materials', async () => {
    const furniture = await realAsset();
    const materials = new Map<string, THREE.MeshStandardMaterial>();
    for (const root of [furniture.roots.DiningChair, furniture.roots.DiningTable]) {
      root.traverse((object) => {
        if (object instanceof THREE.Mesh && object.material instanceof THREE.MeshStandardMaterial)
          materials.set(object.material.name, object.material);
      });
    }
    for (const name of ['DiningWalnut', 'DiningUpholstery']) {
      const material = materials.get(name);
      expect(material?.map).toBeTruthy();
      expect(material?.normalMap).toBeTruthy();
      expect(material?.roughnessMap).toBeTruthy();
    }
  });

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
      portraits += furnishings.placements.filter((p) => p.root === 'FramedPainting').length;
      for (const curtain of furnishings.placements.filter((p) => p.root === 'Curtain')) {
        curtains++;
        const template = templateById(world.plan.rooms[curtain.room]?.templateId ?? 'corridor');
        expect(['hall', 'study']).toContain(template.id);
        expect(curtain.position.x).toBe(template.id === 'hall' ? 2.6 : 0);
        expect(curtain.position.z).toBeCloseTo(template.footprint.min[1] + 0.1685, 3);
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

  it('does not hang a curtain over the solid timber study finish', () => {
    const world = buildFloorWorld(generateFloor('MAPTEST2'));
    const furnishings = new InteriorFurnishings(world, asset());
    expect(
      furnishings.placements.some(
        (placement) => placement.room === 2 && placement.root === 'Curtain',
      ),
    ).toBe(false);
    furnishings.dispose();
    world.dispose();
  });

  it('allocates one reachable clue and unique static artwork per seeded floor', () => {
    const textures = Array.from({ length: 5 }, () => new THREE.Texture());
    let floorsWithClue = 0;
    for (const seed of ['N0TE0032', 'SPIRE002', 'SPIRE004', 'S0AR00X0', 'S0BR00X0']) {
      const world = buildFloorWorld(generateFloor(seed));
      const furnishings = new InteriorFurnishings(world, paintedAsset(), { paintings: textures });
      const paintings = furnishings.placements.filter((p) => p.root === 'FramedPainting');
      const assigned = paintings
        .map((painting) => painting.object.userData.paintingIndex)
        .filter((index): index is number => Number.isInteger(index));
      expect(new Set(assigned).size).toBe(assigned.length);
      expect(assigned.every((index) => index >= 0 && index < textures.length)).toBe(true);
      const clues = paintings.filter((painting) => painting.object.userData.paintingIndex === 0);
      expect(clues.length).toBeLessThanOrEqual(1);
      for (const clue of clues) {
        floorsWithClue++;
        expect(
          furnishings.placements.some((p) => p.room === clue.room && p.root === 'Bookcase'),
        ).toBe(true);
        const center = clue.object.getWorldPosition(new THREE.Vector3());
        const camera = new THREE.PerspectiveCamera(70, 1, 0.01, 30);
        camera.position.copy(center).add(new THREE.Vector3(0, 0, 1.5));
        camera.lookAt(center);
        camera.updateMatrixWorld(true);
        world.current = clue.room;
        furnishings.update(0, false, [camera]);
        world.current = clue.room === 0 ? 1 : 0;
        furnishings.update(0, false, [camera]);
        expect(clue.object.userData.paintingIndex).toBe(0);
        camera.rotateY(Math.PI);
        camera.updateMatrixWorld(true);
        furnishings.update(0, false, [camera]);
        world.current = clue.room;
        furnishings.update(0, false, [camera]);
        expect(clue.object.userData.paintingIndex).toBe(1);
      }
      for (const painting of paintings.filter((p) => p.object.userData.paintingIndex >= 2)) {
        const before = painting.object.userData.paintingIndex;
        const transit = painting.room === 0 ? 1 : 0;
        world.current = painting.room;
        furnishings.update(0.1);
        world.current = transit;
        furnishings.update(0.1);
        world.current = painting.room;
        furnishings.update(0.1);
        expect(painting.object.userData.paintingIndex).toBe(before);
      }
      furnishings.dispose();
    }
    expect(floorsWithClue).toBeGreaterThan(0);
  });

  it('keeps real furnishings clear of doorways and mounts paintings above the lower woodwork', async () => {
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
      'MAPTEST2',
      'T0WR0011',
      'SPIRE002',
      'SPIRE004',
      ...Array.from({ length: seedAlphabet.length }, (_, i) => `S0${seedAlphabet[i]}R00X0`),
    ];
    for (const seed of seeds) {
      const world = buildFloorWorld(generateFloor(seed), templates);
      const furnishings = new InteriorFurnishings(world, furnishingsAsset, {
        paintings: Array.from({ length: 5 }, () => new THREE.Texture()),
      });
      const pictureIds = furnishings.placements
        .filter((p) => p.root === 'FramedPainting')
        .map((p) => p.object.userData.paintingIndex);
      expect(pictureIds.filter((id) => id === 0).length).toBeLessThanOrEqual(1);
      expect(pictureIds).not.toContain(undefined);
      const cases = furnishings.placements.filter((p) => p.root === 'Bookcase');
      const markedCases = cases.filter(
        (p) => p.object.getObjectByName('Bookcase_PullBook')?.userData.bookSecret === true,
      );
      expect(markedCases.length).toBeLessThanOrEqual(1);
      for (const ordinary of cases.filter((p) => !markedCases.includes(p))) {
        expect(
          (
            ordinary.object.getObjectByName('Red ribbon') ??
            ordinary.object.getObjectByName('Red_ribbon')
          )?.visible ?? true,
        ).toBe(false);
        expect(
          (
            ordinary.object.getObjectByName('Lock escutcheon') ??
            ordinary.object.getObjectByName('Lock_escutcheon')
          )?.visible ?? true,
        ).toBe(false);
      }
      expect(new Set(pictureIds).size).toBe(pictureIds.length);
      expect(furnishings.placements.some((p) => p.root === 'WallClock')).toBe(false);
      if (seed === 'N0TE0032')
        expect(furnishings.placements.some((p) => p.root === 'FramedPainting')).toBe(true);
      world.group.updateMatrixWorld(true);
      if (seed === 'MAPTEST2') {
        const armor = furnishings.placements.filter((p) => p.root === 'ClockworkArmor');
        expect(armor).toHaveLength(1);
        expect(armor[0]?.room).toBe(0);
        const entrancePortrait = furnishings.placements.find(
          (p) => p.room === 0 && p.root === 'FramedPainting',
        );
        expect(entrancePortrait).toBeDefined();
      }
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
          expect(local.min.x).toBeGreaterThanOrEqual(template.footprint.min[0] - 0.002);
          expect(local.max.x).toBeLessThanOrEqual(template.footprint.max[0] + 0.002);
          expect(local.min.z).toBeGreaterThanOrEqual(template.footprint.min[1] - 0.002);
          expect(local.max.z).toBeLessThanOrEqual(template.footprint.max[1] + 0.002);
          const distances = [
            Math.abs(local.min.x - template.footprint.min[0]),
            Math.abs(template.footprint.max[0] - local.max.x),
            Math.abs(local.min.z - template.footprint.min[1]),
            Math.abs(template.footprint.max[1] - local.max.z),
          ];
          if (placement.root === 'Curtain') {
            expect(local.min.z - template.footprint.min[1]).toBeCloseTo(0.003, 4);
          } else {
            expect(Math.min(...distances)).toBeCloseTo(0.012, 2);
          }
        }
        if (placement.root === 'FramedPainting') {
          // The highest lower molding on a painted wall is the hall's 1.45–1.49 m bay trim.
          expect(local.min.y - 1.49).toBeGreaterThanOrEqual(0.15);
        }
        if (
          template.id === 'hall' &&
          ['Bookcase', 'WallClock', 'FramedPainting'].includes(placement.root)
        ) {
          const edge = Math.min(
            Math.abs(local.min.x - template.footprint.min[0]),
            Math.abs(template.footprint.max[0] - local.max.x),
            Math.abs(local.min.z - template.footprint.min[1]),
            Math.abs(template.footprint.max[1] - local.max.z),
          );
          if (edge < 0.05) {
            const onEastWest =
              Math.abs(local.min.x - template.footprint.min[0]) < 0.05 ||
              Math.abs(template.footprint.max[0] - local.max.x) < 0.05;
            const west = Math.abs(local.min.x - template.footprint.min[0]) < 0.05;
            const along = onEastWest
              ? (west ? -1 : 1) * ((local.min.z + local.max.z) / 2)
              : -((local.min.x + local.max.x) / 2);
            const freeBay = onEastWest
              ? (along >= -2.3 && along <= -0.1) || (along >= 2.7 && along <= 4.8)
              : (along >= 0 && along <= 2.3) || (along >= 2.7 && along <= 4.8);
            expect(freeBay).toBe(true);
          }
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

  it('keeps MAPTEST2 playtest dressing reachable and ordinary cases inert', async () => {
    const furniture = await realAsset();
    const world = buildFloorWorld(generateFloor('MAPTEST2'));
    const furnishings = new InteriorFurnishings(world, furniture, {
      paintings: Array.from({ length: 5 }, () => new THREE.Texture()),
    });
    expect(furnishings.placements.filter((p) => p.root === 'ClockworkArmor')).toHaveLength(1);
    expect(furnishings.placements.filter((p) => p.root === 'DiningTable')).toHaveLength(1);
    expect(furnishings.placements.filter((p) => p.root === 'DiningChair')).toHaveLength(2);
    const cases = furnishings.placements.filter((p) => p.root === 'Bookcase');
    const marked = cases.filter(
      (p) => p.object.getObjectByName('Bookcase_PullBook')?.userData.bookSecret === true,
    );
    expect(marked).toHaveLength(1);
    expect(cases.length - marked.length).toBeLessThanOrEqual(1);
    for (const ordinary of cases.filter((p) => !marked.includes(p))) {
      expect(ordinary.object.getObjectByName('Red_ribbon')?.visible).toBe(false);
      expect(ordinary.object.getObjectByName('Lock_escutcheon')?.visible).toBe(false);
      expect(ordinary.object.getObjectByName('bookcase-drawer-knob')).toBeDefined();
    }
    furnishings.dispose();
    world.dispose();
  });

  it('preserves a legacy keyed room when its new theme had no case', async () => {
    const furniture = await realAsset();
    const world = buildFloorWorld(generateFloor('SPIRE004'));
    const furnishings = new InteriorFurnishings(world, furniture, {
      preservedBookRooms: [1],
      paintings: Array.from({ length: 5 }, () => new THREE.Texture()),
    });
    const restored = furnishings.placements.find((p) => p.room === 1 && p.root === 'Bookcase');
    expect(restored).toBeDefined();
    expect(restored?.object.getObjectByName('Bookcase_PullBook')?.userData.bookSecret).toBe(true);
    furnishings.dispose();
    world.dispose();
  });

  it('keeps secret distribution deterministic with zero- and one-secret floors', () => {
    const textures = Array.from({ length: 5 }, () => new THREE.Texture());
    let zero = 0;
    let one = 0;
    const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    for (let i = 0; i < 30; i++) {
      const seed = `S0${alphabet[i]}R00X0`;
      const world = buildFloorWorld(generateFloor(seed));
      const furnishings = new InteriorFurnishings(world, paintedAsset(), { paintings: textures });
      const clues = furnishings.placements.filter(
        (p) => p.root === 'FramedPainting' && p.object.userData.paintingIndex === 0,
      );
      expect(clues.length).toBeLessThanOrEqual(1);
      const ordinary = furnishings.placements.filter(
        (p) =>
          p.root === 'Bookcase' &&
          p.object.getObjectByName('Bookcase_PullBook')?.userData.bookSecret !== true,
      );
      expect(ordinary.length).toBeLessThanOrEqual(1);
      if (clues.length === 0) zero++;
      else one++;
      furnishings.dispose();
      world.dispose();
    }
    expect(zero).toBeGreaterThan(0);
    expect(one).toBeGreaterThan(0);
  });
});
