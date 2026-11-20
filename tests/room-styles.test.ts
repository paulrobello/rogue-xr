// @vitest-environment node

import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { GREYBOX_TEMPLATES, parseRoomTemplate } from '../src/content/rooms.ts';
import { attachPressureWing, generateFloor, generateUpperFloor } from '../src/floor/generate.ts';
import { placeTableDecor } from '../src/floor/table-decor.ts';
import { playableFloorPlan } from '../src/world/floor-view.ts';
import { buildFloorWorld } from '../src/world/floor-world.ts';
import {
  applyRoomStyle,
  applyUpperShaftFinish,
  copyHallBenches,
  copyStudyDesk,
  disposeRoomStyle,
  type RoomStyleKit,
  roomStyleFor,
  roomStyleKitFromScene,
} from '../src/world/room-styles.ts';
import { nodeGeometryLoader } from './helpers/gltf-node.ts';

const PIECES = [
  'BoilerBay',
  'BoilerServiceBay',
  'BoilerExchangerBay',
  'BoilerDoor',
  'TimberBay',
  'TimberCarvedBay',
  'TimberDoor',
] as const;

function kit(): RoomStyleKit {
  const scene = new THREE.Group();
  for (const name of PIECES) {
    const piece = new THREE.Group();
    piece.name = name;
    piece.add(
      new THREE.Mesh(
        new THREE.BoxGeometry(2, 4, 0.1),
        new THREE.MeshBasicMaterial({ name: name.endsWith('Bay') ? 'BoilerFinish' : name }),
      ),
    );
    scene.add(piece);
  }
  return roomStyleKitFromScene(scene);
}

function instanced(model: THREE.Group, piece: string): THREE.InstancedMesh[] {
  return model.children.filter(
    (node): node is THREE.InstancedMesh =>
      node instanceof THREE.InstancedMesh && node.userData.roomStylePiece === piece,
  );
}

describe('room styles', () => {
  it('removes rotated authored shelf and shaft colliders while retaining only the timber desk', async () => {
    const raw = JSON.parse(
      await readFile('public/assets/rooms/study/study.manifest.json', 'utf8'),
    ) as unknown;
    const study = parseRoomTemplate(raw);
    const templates = GREYBOX_TEMPLATES.map((template) =>
      template.id === 'study' ? study : template,
    );
    const plan = attachPressureWing(generateFloor('MAPTEST2'));
    const world = buildFloorWorld(plan, templates);
    const pump = plan.pressureWing?.pumpRoom;
    if (pump === undefined) throw new Error('pressure wing missing');
    const timberBefore = world.colliders[2]?.length ?? 0;
    expect(timberBefore).toBe(12);
    world.removeRoomFixtureColliders(2, true);
    expect(world.colliders[2]?.length).toBe(8);
    const added = world.addFixtureCollider(pump, {
      min: [0, 0, 0],
      max: [0.1, 0.1, 0.1],
    });
    const boilerBefore = world.colliders[pump]?.length ?? 0;
    world.removeRoomFixtureColliders(pump, false);
    expect((world.colliders[pump]?.length ?? 0) - boilerBefore).toBe(-5);
    expect(world.colliders[pump]).toContainEqual({ min: [0, 0, 0], max: [0.1, 0.1, 0.1] });
    added();
    world.dispose();
  });

  it('requires all seven architectural roots', () => {
    expect(Object.keys(kit())).toEqual(PIECES);
    expect(() => roomStyleKitFromScene(new THREE.Group())).toThrow(/BoilerBay/);
  });

  it('selects boiler only for the pressure pump room and timber for study rooms', () => {
    const plan = attachPressureWing(generateFloor('MAPTEST2'));
    const pump = plan.pressureWing?.pumpRoom;
    expect(pump).toBeTypeOf('number');
    if (pump === undefined) throw new Error('pressure wing missing');
    expect(roomStyleFor(plan, pump)).toBe('boiler');
    expect(roomStyleFor(plan, 2)).toBe('timber');
  });

  it('fits industrial wall bays to upper halls and studies', () => {
    const plan = generateUpperFloor('SPIRE001');
    expect(plan.rooms[0]?.templateId).toBe('gear-shaft');
    plan.rooms.forEach((room, index) => {
      const style = roomStyleFor(plan, index, 2);
      if (room.templateId === 'study' || room.templateId === 'hall') expect(style).toBe('boiler');
      else expect(style).toBeNull();
    });
  });

  it('styles a legacy upper hall arrival while leaving floor one unchanged', () => {
    const plan = generateFloor('SPIRE001');
    expect(plan.rooms[0]?.templateId).toBe('hall');
    expect(roomStyleFor(plan, 0)).toBeNull();
    expect(roomStyleFor(plan, 0, 2)).toBe('boiler');
  });

  it('keeps regular seed styling deterministic and non-study library rooms unchanged', () => {
    for (const seed of ['SPIRE001', 'SPIRE002', 'SPIRE003']) {
      const first = generateFloor(seed);
      const second = generateFloor(seed);
      expect(first.rooms.map((_, room) => roomStyleFor(first, room))).toEqual(
        second.rooms.map((_, room) => roomStyleFor(second, room)),
      );
      first.rooms.forEach((room, index) => {
        if (room.templateId !== 'study') expect(roomStyleFor(first, index)).toBeNull();
      });
    }
  });

  it('keeps sealed walls, exact open portals, and one exchanger bay', () => {
    const model = new THREE.Group();
    const count = applyRoomStyle(model, 'boiler', kit(), [
      { facing: 'S', position: [-1, 0, 4] },
      { facing: 'E', position: [4, 0, -1] },
      { facing: 'N', position: [-3, 0, -4], closed: true },
    ]);
    expect(count).toBe(16);
    expect(model.userData.roomStyle).toBe('boiler');
    expect(instanced(model, 'BoilerExchangerBay')).toHaveLength(1);
    expect(instanced(model, 'BoilerDoor').reduce((n, node) => n + node.count, 0)).toBe(2);
    expect(model.getObjectByName('room-style-boiler-surfaces')).toBeDefined();
    const door = instanced(model, 'BoilerDoor')[0];
    if (!door) throw new Error('open door instance missing');
    const positions = Array.from({ length: door.count }, (_, i) => {
      const matrix = new THREE.Matrix4();
      door.getMatrixAt(i, matrix);
      return [matrix.elements[12], matrix.elements[14]];
    });
    expect(positions).toEqual(
      expect.arrayContaining([
        [-1, 4],
        [4, -1],
      ]),
    );
  });

  it('fits five boiler bays per wall on the ten metre upper hall', () => {
    const model = new THREE.Group();
    const hall = GREYBOX_TEMPLATES.find((template) => template.id === 'hall');
    if (!hall) throw new Error('hall template missing');
    expect(
      applyRoomStyle(
        model,
        'boiler',
        kit(),
        hall.doors.map((door) => ({ facing: door.facing, position: door.position })),
        5,
      ),
    ).toBe(24);
    const doors = instanced(model, 'BoilerDoor')[0];
    if (!doors) throw new Error('missing upper hall door bays');
    const m = new THREE.Matrix4();
    const positions = Array.from({ length: doors.count }, (_, i) => {
      doors.getMatrixAt(i, m);
      return [m.elements[12], m.elements[14]];
    });
    expect(positions.sort()).toEqual(hall.doors.map((d) => [d.position[0], d.position[2]]).sort());

    expect(model.getObjectByName('room-style-boiler-surfaces')).toBeDefined();
    const surfaces = model.getObjectByName('room-style-boiler-surfaces');
    const bounds = new THREE.Box3().setFromObject(surfaces ?? new THREE.Group());
    expect(bounds.max.x).toBeGreaterThan(4.9);
    expect(bounds.max.z).toBeGreaterThan(4.9);
  });

  it('creates owned floor and ceiling surfaces without legacy study shell nodes', () => {
    const model = new THREE.Group();
    applyRoomStyle(model, 'boiler', kit(), []);
    const surfaces = model.getObjectByName('room-style-boiler-surfaces');
    expect(surfaces).toBeDefined();
    const mesh = surfaces?.getObjectByName('boiler-deck-and-ceiling') as THREE.Mesh;
    expect(mesh.geometry.userData.roomStyleOwned).toBe(true);
    const bounds = new THREE.Box3().setFromObject(mesh);
    expect(bounds.min.y).toBeLessThan(0);
    expect(bounds.max.y).toBeGreaterThan(4);
    expect(model.getObjectByName('study_books')).toBeUndefined();
    expect(model.getObjectByName('study_stone-floor')).toBeUndefined();
  });

  it('copies only tangible desk geometry into timber support', () => {
    const source = new THREE.Group();
    const desk = new THREE.Mesh(
      new THREE.BoxGeometry(1.2, 1.4, 1.2),
      new THREE.MeshBasicMaterial({ name: 'study_walnut' }),
    );
    desk.position.set(2.4, 0.78, 2.4);
    source.add(desk);
    const styled = new THREE.Group();
    copyStudyDesk(source, styled);
    const retained = styled.children[0] as THREE.Mesh;
    expect(retained.name).toContain('timber-writing-desk');
    expect(retained.geometry.userData.roomStyleOwned).toBe(true);
    expect(new THREE.Box3().setFromObject(retained).max.y).toBeGreaterThan(1.4);
  });

  it('retains the baked hall benches under both showcase arrangements and their rotated colliders', async () => {
    const bytes = await readFile('public/assets/rooms/hall/hall.glb');
    const { scene } = await nodeGeometryLoader().parseAsync(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      '',
    );
    const hall = parseRoomTemplate(
      JSON.parse(await readFile('public/assets/rooms/hall/hall.manifest.json', 'utf8')),
    );
    const plan = playableFloorPlan('MAPTEST3', 4, 2);
    const templates = GREYBOX_TEMPLATES.map((t) => (t.id === 'hall' ? hall : t));
    const world = buildFloorWorld(plan, templates);
    const decor = placeTableDecor(
      plan.seed,
      plan.rooms.map((r) => r.templateId),
    );
    const down = new THREE.Vector3(0, -1, 0);
    for (const [index, id, kinds] of [
      [2, 'bench-w', ['books', 'vase']],
      [3, 'bench-e', ['books', 'candle']],
    ] as const) {
      const group = world.roomGroups[index];
      const styled = new THREE.Group();
      copyHallBenches(scene, styled);
      world.removeRoomFixtureColliders(index, true);
      world.dressRoom(index, styled);
      group.updateWorldMatrix(true, true);
      const items = decor.filter((p) => p.room === index && p.table === id);
      expect(items.map((p) => p.kind).sort()).toEqual([...kinds]);
      expect(styled.getObjectByName('hall-benches-hall_brass-aged')).toBeDefined();
      for (const item of items) {
        const at = group.localToWorld(new THREE.Vector3(item.x, item.y + 0.02, item.z));
        const hit = new THREE.Raycaster(at, down, 0, 0.03).intersectObject(styled)[0];
        expect(hit?.object.name).toBe('hall-benches-hall_walnut');
        expect(hit?.point.y).toBeCloseTo(item.y, 3);
        expect(
          world.colliders[index].some(
            (b) =>
              Math.abs(b.max[1] - item.y) < 0.001 &&
              at.x >= b.min[0] &&
              at.x <= b.max[0] &&
              at.z >= b.min[2] &&
              at.z <= b.max[2],
          ),
        ).toBe(true);
      }
      disposeRoomStyle(styled);
    }
    world.dispose();
  });

  it('disposes owned surfaces but not kit geometry or materials', () => {
    const sourceKit = kit();
    const model = new THREE.Group();
    applyRoomStyle(model, 'timber', sourceKit, []);
    const surface = model.getObjectByName('timber-deck-and-ceiling') as THREE.Mesh;
    const geometryDispose = vi.spyOn(surface.geometry, 'dispose');
    const materialDispose = vi.spyOn(surface.material as THREE.Material, 'dispose');
    const kitGeometry = (sourceKit.TimberBay.children[0] as THREE.Mesh).geometry;
    const kitMaterial = (sourceKit.TimberBay.children[0] as THREE.Mesh).material;
    const kitGeometryDispose = vi.spyOn(kitGeometry, 'dispose');
    const kitMaterialDispose = vi.spyOn(kitMaterial as THREE.Material, 'dispose');
    disposeRoomStyle(model);
    expect(geometryDispose).toHaveBeenCalled();
    expect(materialDispose).toHaveBeenCalled();
    expect(kitGeometryDispose).not.toHaveBeenCalled();
    expect(kitMaterialDispose).not.toHaveBeenCalled();
  });

  it('clones only upper shaft wallpaper and walnut materials', () => {
    const model = new THREE.Group();
    const source = new THREE.MeshStandardMaterial({ name: 'gear-shaft_wallpaper' });
    const gear = new THREE.Object3D();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), source);
    gear.name = 'gear-shaft_gear_ring';
    gear.add(mesh);
    model.add(gear);
    const changed = applyUpperShaftFinish(model);
    const variant = mesh.material as THREE.MeshStandardMaterial;
    expect(changed).toEqual([variant]);
    expect(variant).not.toBe(source);
    expect(variant.map).toBeNull();
    expect(variant.onBeforeCompile).toBe(source.onBeforeCompile);
    expect(variant.name).toContain('upper-works-');
    expect(gear.name).toBe('gear-shaft_gear_ring');
    expect(mesh.geometry).toBeDefined();
  });
});
