import * as THREE from 'three';
import type { Facing } from '../content/rooms.ts';
import { Stream } from '../core/rng.ts';
import type { FloorPlan } from '../floor/generate.ts';
import { releaseDiningLighting } from './room-style-lighting.ts';
import { createRoomSurfaces } from './room-style-surfaces.ts';

export const ROOM_STYLE_PIECES = [
  'BoilerBay',
  'BoilerServiceBay',
  'BoilerExchangerBay',
  'BoilerDoor',
  'TimberBay',
  'TimberCarvedBay',
  'TimberDoor',
] as const;
export type RoomStylePiece = (typeof ROOM_STYLE_PIECES)[number];
export type RoomStyle = 'boiler' | 'timber';
export type RoomStyleKit = Readonly<Record<RoomStylePiece, THREE.Object3D>>;
export interface RoomStyleDoor {
  facing: Facing;
  position: readonly [number, number, number];
  closed?: boolean;
}

export function roomStyleKitFromScene(scene: THREE.Object3D): RoomStyleKit {
  const kit = {} as Record<RoomStylePiece, THREE.Object3D>;
  for (const name of ROOM_STYLE_PIECES) {
    const piece = scene.getObjectByName(name);
    if (!piece) throw new Error(`Missing architectural finish ${name}`);
    kit[name] = piece;
  }
  return kit;
}

export function roomStyleFor(plan: FloorPlan, room: number): RoomStyle | null {
  if (plan.pressureWing?.pumpRoom === room) return 'boiler';
  if (plan.rooms[room]?.templateId !== 'study') return null;
  if (plan.seed === 'MAPTEST2') return room === 2 ? 'timber' : null;
  return Stream.fromKey(`${plan.seed}:study-finish:${room}`).int(0, 2) === 0 ? 'timber' : null;
}

const YAW: Record<Facing, number> = { N: 0, E: -Math.PI / 2, S: Math.PI, W: Math.PI / 2 };
const UP = new THREE.Vector3(0, 1, 0);
const BAY_CENTERS = [-3, -1, 1, 3] as const;

/** The source template is unrotated. Its parent room group applies the floor plan's quarter-turn. */
export function applyRoomStyle(
  model: THREE.Group,
  style: RoomStyle,
  kit: RoomStyleKit,
  doors: readonly RoomStyleDoor[],
): number {
  const bays = new Map<RoomStylePiece, THREE.Matrix4[]>();
  for (const wall of ['N', 'E', 'S', 'W'] as const) {
    const ns = wall === 'N' || wall === 'S';
    const fixed = wall === 'N' || wall === 'W' ? -4 : 4;
    for (const along of BAY_CENTERS) {
      const door = doors.find(
        (d) => d.facing === wall && Math.abs(d.position[ns ? 0 : 2] - along) < 0.001 && !d.closed,
      );
      // Keep lights and inspection panels clear of the tank banks on the north wall.
      const practical = wall === 'N' || wall === 'S' ? along === 3 : along === -3;
      let piece: RoomStylePiece;
      if (style === 'boiler') {
        if (door) piece = 'BoilerDoor';
        else if (wall === 'W' && along === -1) piece = 'BoilerExchangerBay';
        else piece = practical && wall !== 'N' ? 'BoilerServiceBay' : 'BoilerBay';
      } else {
        piece = door ? 'TimberDoor' : practical ? 'TimberCarvedBay' : 'TimberBay';
      }
      const poses = bays.get(piece) ?? [];
      if (!bays.has(piece)) bays.set(piece, poses);
      poses.push(
        new THREE.Matrix4()
          .makeRotationAxis(UP, YAW[wall])
          .setPosition(ns ? along : fixed, 0, ns ? fixed : along),
      );
    }
  }
  for (const [piece, poses] of bays) {
    const root = kit[piece];
    root.updateWorldMatrix(true, true);
    const inverse = root.matrixWorld.clone().invert();
    root.traverse((node) => {
      if (!(node instanceof THREE.Mesh)) return;
      const local = new THREE.Matrix4().multiplyMatrices(inverse, node.matrixWorld);
      const instances = new THREE.InstancedMesh(node.geometry, node.material, poses.length);
      const matrix = new THREE.Matrix4();
      for (const [i, pose] of poses.entries())
        instances.setMatrixAt(i, matrix.multiplyMatrices(pose, local));
      instances.name = `finish-${piece}-${node.name}`;
      instances.userData.roomStylePiece = piece;
      instances.computeBoundingSphere();
      model.add(instances);
    });
  }
  model.add(createRoomSurfaces(style, kit));
  model.userData.roomStyle = style;
  return BAY_CENTERS.length * 4;
}

/** The original study packs its desk, letter rack and shelves into material batches. Retain the
 * desk triangles and their original UV/lightmap coordinates for the coffer and service slip. */
export function copyStudyDesk(model: THREE.Object3D, into: THREE.Group): void {
  model.updateWorldMatrix(true, true);
  const inverse = model.matrixWorld.clone().invert();
  const bounds = new THREE.Box3(
    new THREE.Vector3(1.64, -0.001, 1.64),
    new THREE.Vector3(3.16, 1.57, 3.16),
  );
  const point = new THREE.Vector3();
  model.traverse((mesh) => {
    if (
      !(mesh instanceof THREE.Mesh) ||
      Array.isArray(mesh.material) ||
      ![
        'study_walnut',
        'study_brass-aged',
        'study_brass-polished',
        'study_wax',
        'study_flame',
      ].includes(mesh.material.name)
    )
      return;
    const source = mesh.geometry;
    const pos = source.getAttribute('position');
    const index = source.index;
    const toRoom = new THREE.Matrix4().multiplyMatrices(inverse, mesh.matrixWorld);
    const inside = Array.from({ length: pos.count }, (_, i) =>
      bounds.containsPoint(point.fromBufferAttribute(pos, i).applyMatrix4(toRoom)),
    );
    const kept: number[] = [];
    for (let t = 0; t < (index?.count ?? pos.count); t += 3) {
      const a = index ? index.getX(t) : t,
        b = index ? index.getX(t + 1) : t + 1,
        c = index ? index.getX(t + 2) : t + 2;
      if (inside[a] && inside[b] && inside[c]) kept.push(a, b, c);
    }
    if (!kept.length) return;
    const geometry = new THREE.BufferGeometry();
    const used = [...new Set(kept)];
    const remap = new Uint32Array(pos.count);
    for (const [j, i] of used.entries()) remap[i] = j;
    geometry.setIndex(kept.map((i) => remap[i]));
    for (const name of Object.keys(source.attributes)) {
      const attr = source.getAttribute(name);
      const data = new Float32Array(used.length * attr.itemSize);
      for (const [j, i] of used.entries())
        for (let k = 0; k < attr.itemSize; k++)
          data[j * attr.itemSize + k] = attr.getComponent(i, k);
      geometry.setAttribute(name, new THREE.BufferAttribute(data, attr.itemSize));
    }
    geometry.applyMatrix4(toRoom);
    geometry.userData.roomStyleOwned = true;
    const retained = new THREE.Mesh(geometry, mesh.material);
    retained.name = `timber-writing-desk-${mesh.material.name}`;
    into.add(retained);
  });
}

export function disposeRoomStyle(model: THREE.Group): void {
  const ownedMaterials = new Set<THREE.Material>();
  model.userData.finishLightMap?.dispose();
  releaseDiningLighting(model);
  model.traverse((node) => {
    if (node instanceof THREE.InstancedMesh) node.dispose();
    if (!(node instanceof THREE.Mesh)) return;
    if (node.geometry.userData.roomStyleOwned) node.geometry.dispose();
    for (const material of Array.isArray(node.material) ? node.material : [node.material]) {
      if (material.userData.roomStyleOwned) ownedMaterials.add(material);
    }
  });
  for (const material of ownedMaterials) material.dispose();
}
