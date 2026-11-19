// @vitest-environment node

import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { GREYBOX_TEMPLATES, parseRoomTemplate } from '../src/content/rooms.ts';
import { attachPressureWing, generateFloor } from '../src/floor/generate.ts';
import { buildFloorWorld } from '../src/world/floor-world.ts';
import {
  applyRoomStyle,
  copyStudyDesk,
  disposeRoomStyle,
  type RoomStyleKit,
  roomStyleFor,
  roomStyleKitFromScene,
} from '../src/world/room-styles.ts';

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
});
