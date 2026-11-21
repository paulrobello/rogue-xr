import * as THREE from 'three';
import type { Facing } from '../content/rooms.ts';
import type { StoneRoom } from '../floor/stone-rooms.ts';
import type { FloorWorld } from './floor-world.ts';
import type { InteriorPlacement } from './interior-furnishings.ts';
import { findPuzzleMount } from './puzzle-placement.ts';
import type { RoomStyleDoor } from './room-styles.ts';

export const STONE_ROOM_PARTS = [
  'StoneBay',
  'StoneDoor',
  'StoneNicheBay',
  'StoneFloor',
  'StoneCeiling',
  'StoneSkylight',
  'StoneShelf',
  'StoneTorch',
  'StonePlanter',
  'StoneDishes',
] as const;
type StonePart = (typeof STONE_ROOM_PARTS)[number];
export type StoneRoomKit = Readonly<Record<StonePart, THREE.Object3D>>;

export function stoneRoomKitFromScene(scene: THREE.Object3D): StoneRoomKit {
  const kit = {} as Record<StonePart, THREE.Object3D>;
  for (const name of STONE_ROOM_PARTS) {
    const piece = scene.getObjectByName(name);
    if (!piece) throw Error(`Missing stone module ${name}`);
    kit[name] = piece;
  }
  for (const [root, name] of [
    [kit.StoneTorch, 'StoneTorchFlame'],
    [kit.StoneTorch, 'SocketTorchLight'],
    [kit.StoneShelf, 'SocketShelfDish'],
    [kit.StoneShelf, 'SocketShelfPlant'],
  ] as const) {
    if (!root.getObjectByName(name)) throw Error(`Missing stone socket ${name}`);
  }
  return kit;
}

const WALL_YAW: Record<Facing, number> = { N: 0, E: -Math.PI / 2, S: Math.PI, W: Math.PI / 2 };
const UP = new THREE.Vector3(0, 1, 0);
const SURFACES = new Set<StonePart>(['StoneFloor', 'StoneCeiling', 'StoneSkylight']);
const SKY_TILE = [-1, 4, 1] as const;

function instancePart(
  room: THREE.Group,
  name: StonePart,
  source: THREE.Object3D,
  poses: readonly THREE.Matrix4[],
): void {
  source.updateWorldMatrix(true, true);
  const inverse = source.matrixWorld.clone().invert();
  source.traverse((mesh) => {
    if (!(mesh instanceof THREE.Mesh)) return;
    const local = new THREE.Matrix4().multiplyMatrices(inverse, mesh.matrixWorld);
    const matrix = new THREE.Matrix4();
    const copy = new THREE.InstancedMesh(mesh.geometry, mesh.material, poses.length);
    for (let i = 0; i < poses.length; i++)
      copy.setMatrixAt(i, matrix.multiplyMatrices(poses[i], local));
    copy.name = `finish-${name}-${mesh.name}`;
    copy.userData.stoneShell = true;
    copy.userData.stoneSurface = SURFACES.has(name);
    copy.computeBoundingSphere();
    room.add(copy);
  });
}

/** Applies solid, niche and doorway bays over the existing socket and collision envelope. */
export function applyStoneRoom(
  room: THREE.Group,
  theme: StoneRoom,
  kit: StoneRoomKit,
  doors: readonly RoomStyleDoor[],
  edge: number,
): void {
  const matrices = new Map<StonePart, THREE.Matrix4[]>();
  const centers = edge === 5 ? [-4.5, -3, -1, 1, 3, 4.5] : [-3, -1, 1, 3];
  const width = (value: number) => (edge === 5 && Math.abs(value) === 4.5 ? 0.5 : 1);
  const add = (part: StonePart, pose: THREE.Matrix4) => {
    const slots = matrices.get(part);
    if (slots) slots.push(pose);
    else matrices.set(part, [pose]);
  };
  for (const wall of ['N', 'E', 'S', 'W'] as const) {
    const ns = wall === 'N' || wall === 'S';
    const fixed = wall === 'N' || wall === 'W' ? -edge : edge;
    for (const along of centers) {
      const opening = doors.some(
        (d) => d.facing === wall && !d.closed && Math.abs(d.position[ns ? 0 : 2] - along) < 0.001,
      );
      const niche = !opening && along === (wall === 'N' || wall === 'E' ? -3 : 3);
      const pose = new THREE.Matrix4().makeRotationAxis(UP, WALL_YAW[wall]);
      pose
        .scale(new THREE.Vector3(width(along), 1, 1))
        .setPosition(ns ? along : fixed, 0, ns ? fixed : along);
      add(opening ? 'StoneDoor' : niche ? 'StoneNicheBay' : 'StoneBay', pose);
    }
  }
  for (const x of centers)
    for (const z of centers) {
      const tile = new THREE.Matrix4().makeScale(width(x), 1, width(z));
      add('StoneFloor', tile.clone().setPosition(x, 0, z));
      const skylight = theme === 'cloister' && x === SKY_TILE[0] && z === SKY_TILE[2];
      add(skylight ? 'StoneSkylight' : 'StoneCeiling', tile.setPosition(x, 4, z));
    }
  for (const [part, poses] of matrices) instancePart(room, part, kit[part], poses);
  room.userData.roomStyle = `stone-${theme}`;
  room.userData.finishEdge = edge;
  if (theme === 'cloister') {
    room.userData.stoneSkylight = SKY_TILE;
    const skyGeometry = new THREE.PlaneGeometry(1.45, 1.45, 1, 1);
    skyGeometry.userData.roomStyleOwned = true;
    const skyMaterial = new THREE.MeshBasicMaterial({ color: 0xd9d2b6, toneMapped: false });
    skyMaterial.userData.roomStyleOwned = true;
    const sky = new THREE.Mesh(skyGeometry, skyMaterial);
    sky.name = 'StoneSkylightDaylight';
    sky.rotation.x = Math.PI / 2;
    sky.position.set(SKY_TILE[0], SKY_TILE[1] + 0.275, SKY_TILE[2]);
    room.add(sky);
  }
}

/** Independent props use the same clearance scan as the other room fixtures. */
export function furnishStoneRoom(
  world: FloorWorld,
  index: number,
  room: THREE.Group,
  kit: StoneRoomKit,
  existing: readonly InteriorPlacement[],
): readonly (() => void)[] {
  const releases: (() => void)[] = [];
  const localObstacles: THREE.Box3[] = [];
  const shelfMount = findPuzzleMount(world, [index], existing, 'stone-shelf', 0.72, 1.35, 1.58);
  if (shelfMount) {
    const shelf = kit.StoneShelf.clone(true);
    shelf.position.copy(shelfMount.center).setY(0);
    shelf.rotation.y = shelfMount.yaw;
    shelf.translateZ(0.38);
    const dishes = kit.StoneDishes.clone(true);
    const leaves = kit.StonePlanter.clone(true);
    leaves.scale.setScalar(0.68);
    shelf.getObjectByName('SocketShelfDish')!.add(dishes);
    shelf.getObjectByName('SocketShelfPlant')!.add(leaves);
    room.add(shelf);
    const bounds = new THREE.Box3().setFromObject(shelf);
    releases.push(
      world.addFixtureCollider(index, { min: bounds.min.toArray(), max: bounds.max.toArray() }),
    );
  }

  const torchSockets: THREE.Object3D[] = [];
  const inverse = world.roomGroups[index].matrixWorld.clone().invert();
  for (const key of ['stone-torch-left', 'stone-torch-right']) {
    const mount = findPuzzleMount(
      world,
      [index],
      existing,
      key,
      0.29,
      0.45,
      undefined,
      localObstacles,
    );
    if (!mount) continue;
    const torch = kit.StoneTorch.clone(true);
    torch.position.copy(mount.wallSurface).setY(1.54);
    torch.rotation.y = mount.yaw;
    torch.translateZ(0.14);
    room.add(torch);
    const light = torch.getObjectByName('SocketTorchLight')!;
    torchSockets.push(light);
    localObstacles.push(new THREE.Box3().setFromObject(torch).applyMatrix4(inverse));
  }
  room.userData.stoneTorchSockets = torchSockets;
  return releases;
}
