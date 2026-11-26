import * as THREE from 'three';
import {
  type Box,
  DOOR_WIDTH,
  type Facing,
  GREYBOX_TEMPLATES,
  type Rect,
  type RoomTemplate,
} from '../content/rooms.ts';
import { Stream } from '../core/rng.ts';
import {
  type FloorPlan,
  guardedConnection,
  type PuzzleGate,
  type WorldRoom,
  worldRooms,
} from '../floor/generate.ts';
import {
  placeStairEntry,
  STAIR_DOOR_BARRIER,
  STAIR_HALF_WIDTH,
  STAIR_LANDING_END,
  STAIR_WIDTH,
  type StairEntry,
  stairGroundHeight,
  stairLocalPoint,
  stairTeleportHeight,
} from '../floor/stairs.ts';
import { nearSet, visibleSet } from '../floor/visibility.ts';
import { PALETTE } from '../palette.ts';
import { enemyHeading, enemyLocalRotationY } from './enemy-facing.ts';
import { buildGreyboxRoom, createGreyboxMaterials, type GreyboxMaterials } from './greybox.ts';
import { type Hearth, HearthKit, type HearthMaterials, hearthSocket } from './hearth.ts';
import {
  type Coffer,
  CofferKit,
  type CofferTheme,
  type LootMaterials,
  surfaceHeightAt,
} from './loot.ts';
import type { PbrSet } from './materials.ts';
import { pressureColliders } from './pressure-works.ts';
import { PuzzleGateVisual } from './puzzle-gates.ts';
import { disposeTableDecor } from './table-decor.ts';

export { nearSet, neighbours, shellSet, visibleSet } from '../floor/visibility.ts';

/** Index of the room whose footprint holds the floor point, preferring `hint` on shared walls. */
export function roomAt(rooms: readonly WorldRoom[], x: number, z: number, hint = -1): number {
  const inside = (i: number) => {
    const fp = rooms[i]?.footprint;
    return !!fp && x >= fp.min[0] && x <= fp.max[0] && z >= fp.min[1] && z <= fp.max[1];
  };
  if (hint >= 0 && inside(hint)) return hint;
  for (let i = 0; i < rooms.length; i++) if (inside(i)) return i;
  return -1;
}

export interface FloorWorld {
  group: THREE.Group;
  plan: FloorPlan;
  rooms: readonly WorldRoom[];
  /**
   * One group per room, in plan order. Every room the player can see (`visibleSet`: the current
   * room, its neighbours and the rooms seen down a corridor) is shown with its enemies, coffers and
   * hearths, so nothing appears on approach; the rest are hidden whole.
   */
  roomGroups: readonly THREE.Group[];
  /** Placeholder automatons keyed by room index. */
  enemies: ReadonlyMap<number, readonly THREE.Object3D[]>;
  /** World-space collision boxes per room: template colliders plus sealed-door caps. */
  colliders: readonly (readonly Box[])[];
  current: number;
  /** Colliders of the current room and its neighbours, the only walls the player can reach. */
  nearbyColliders(): readonly Box[];
  /** Adds a world-space collider for a removable room furnishing. */
  addFixtureCollider(room: number, box: Box): () => void;
  /** Removes authored furniture colliders for a room whose baked furniture is being replaced. */
  removeRoomFixtureColliders(room: number, keepFurniture: boolean): void;
  /** World-space walkable rects of the current room and its neighbours (teleport landings). */
  nearbyWalkable(): readonly Rect[];
  /** Re-evaluates the current room from a world-space floor point; returns true when it changed. */
  update(x: number, z: number): boolean;
  /** Opens the forward door held by a defeated encounter. */
  releaseGuardedDoor(room: number, immediate?: boolean): THREE.Vector3 | null;
  dressEncounterDoor(model: THREE.Object3D): void;
  setPuzzleGateOpen(kind: PuzzleGate, open: boolean, immediate?: boolean): void;
  dressPuzzleGates(set: PbrSet, environment: THREE.Texture | null): void;
  pickLockedDoor(
    origin: THREE.Vector3,
    direction: THREE.Vector3,
  ):
    | { kind: PuzzleGate; distance: number; gateIndex: number }
    | { kind: 'encounter'; distance: number }
    | null;
  rattlePuzzleGate(kind: PuzzleGate, gateIndex?: number): THREE.Vector3 | undefined;
  /** Advances moving door leaves and gate hardware. */
  updateAnimations(dt: number): void;
  spawnPoint(): THREE.Vector3;
  /**
   * Swaps one of `room`'s automaton bodies for `next` (a loaded model), keeping its place, heading,
   * name and userData. Returns false, touching nothing, when `body` is not a live body of `room`.
   */
  replaceEnemy(room: number, body: THREE.Object3D, next: THREE.Object3D): boolean;
  /**
   * Dresses `room` with a baked template model in place of its greybox floor, walls and socket
   * markers. The automatons and boarded-door leaves stay. `model` is room-local. A model that
   * carries `door-plug-<id>` and `door-frame-<id>` nodes closes each wall-style door with its
   * plug and drops that door's frame, and hides the plug of every other door; a model without
   * them shows a door leaf in each wall-style door instead.
   */
  dressRoom(room: number, model: THREE.Object3D): void;
  /** The treasure and encounter-guarded coffers on this floor. */
  readonly coffers: readonly Coffer[];
  /** Re-dresses every coffer in `materials` (owned by the caller); they start in flat placeholders. */
  dressCoffers(materials: LootMaterials): void;
  /** The rest-room hearths on this floor, one per rest room. */
  readonly hearths: readonly Hearth[];
  /** Re-dresses every hearth's brass in `materials` (owned by the caller). */
  dressHearths(materials: HearthMaterials): void;
  /** A door leaf in every sealed doorway; only boarded doors show theirs until a room is dressed. */
  readonly sealedDoors: readonly THREE.Mesh[];
  /** Deterministically selected outside stair landing, if this floor has a clear sealed doorway. */
  readonly stairEntry: StairEntry | null;
  /** Opens the selected stair doorway and installs side-rail and far-landing barriers. */
  openStairEntry(floorNumber?: 1 | 2): StairEntry | null;
  /** Signed smooth ground height over the measured stair flight, or null outside it. */
  stairGroundHeight(x: number, z: number): number | null;
  /** Discrete tread/landing top for teleport landings, or null outside the stairwell. */
  teleportSurfaceHeight(x: number, z: number): number | null;
  /**
   * Gives every sealed door leaf `material` (owned by the caller), its UVs scaled so one texture
   * tile covers `tileMeters`. Leaves keep their flat greybox colour until this is called.
   */
  dressSealedDoors(material: THREE.Material, tileMeters: number): void;
  dispose(): void;
}

/**
 * Greybox children a baked room model replaces: the floor, collider walls, socket markers and the
 * wall fill above sealed doorways (the baked shell has its own wall above the lintel).
 */
const GREYBOX_PART = /^(floor|collider-\d+|socket-.+|light-.+|lintel-fill-.+|door-fill-.+)$/;

/** Lintel height of every doorway: baked rooms frame a 1.6 x 2.4 m opening. */
export const DOOR_HEIGHT = 2.4;
/** Greybox wall height and thickness (`perimeterColliders` leaves door gaps the full height). */
const WALL_HEIGHT = 4;
const WALL_THICKNESS = 0.2;
/** Yaw that turns a sealed door's local +z (into the room) to face the room, per wall. */
const INTO_ROOM_YAW: Record<Facing, number> = {
  N: 0,
  S: Math.PI,
  W: Math.PI / 2,
  E: -Math.PI / 2,
};

const checkedFrameGeometry = new WeakSet<THREE.BufferGeometry>();

/** Earlier room bakes include a second reveal up to the lintel inside each full-height jamb. */
function fitBakedDoorFrame(frame: THREE.Object3D): void {
  frame.traverse((mesh) => {
    if (!(mesh instanceof THREE.Mesh)) return;
    const geometry = mesh.geometry;
    const index = geometry.index;
    if (!index || checkedFrameGeometry.has(geometry)) return;
    checkedFrameGeometry.add(geometry);
    const pos = geometry.getAttribute('position');
    const fullJambs = new Set<string>();
    const reveals = new Map<number, string>();
    const bounds = new THREE.Box3(),
      point = new THREE.Vector3();
    for (let i = 0; i < index.count; i += 3) {
      bounds.makeEmpty();
      for (let j = 0; j < 3; j++)
        bounds.expandByPoint(point.fromBufferAttribute(pos, index.getX(i + j)));
      const { min, max } = bounds;
      if (Math.abs(min.y) > 0.0001 || Math.min(max.x - min.x, max.z - min.z) > 0.0001) continue;
      if (Math.abs(Math.max(max.x - min.x, max.z - min.z) - 0.05) > 0.0001) continue;
      const strip = [min.x, max.x, min.z, max.z].map((v) => Math.round(v * 10000)).join(',');
      if (Math.abs(max.y - DOOR_HEIGHT - 0.12) < 0.0001) fullJambs.add(strip);
      else if (Math.abs(max.y - DOOR_HEIGHT) < 0.0001) reveals.set(i, strip);
    }
    if (![...reveals.values()].some((strip) => fullJambs.has(strip))) return;
    const kept: number[] = [];
    for (let i = 0; i < index.count; i += 3) {
      const strip = reveals.get(i);
      if (strip && fullJambs.has(strip)) continue;
      kept.push(index.getX(i), index.getX(i + 1), index.getX(i + 2));
    }
    geometry.dispose();
    geometry.setIndex(kept);
  });
}

/** Keep opposing architraves off the shared wall plane so their threshold/apron faces cannot tie. */
function insetBakedDoorFrame(frame: THREE.Object3D, facing: Facing): void {
  const inset = 0.002;
  if (facing === 'N') frame.position.z += inset;
  else if (facing === 'S') frame.position.z -= inset;
  else if (facing === 'W') frame.position.x += inset;
  else frame.position.x -= inset;
}

function doorwayCollider(
  door: WorldRoom['doors'][number],
  height = WALL_HEIGHT,
  depth = WALL_THICKNESS / 2,
): Box {
  const [x, z] = door.world;
  const width = door.width / 2;
  const acrossX = door.facing === 'N' || door.facing === 'S';
  const [hx, hz] = acrossX ? [width, depth] : [depth, width];
  return { min: [x - hx, 0, z - hz], max: [x + hx, height, z + hz] };
}

const enemyGeometry = new THREE.CapsuleGeometry(0.35, 1.2, 4, 12);
const guardianGeometry = new THREE.CapsuleGeometry(0.6, 1.8, 4, 12);

function buildRoom(
  t: RoomTemplate,
  world: WorldRoom,
  entryDoor: readonly [number, number] | null,
  plan: FloorPlan,
  index: number,
  materials: GreyboxMaterials,
  enemyMaterial: THREE.Material,
  kit: CofferKit,
  hearthKit: HearthKit,
  brassKey?: { room: number; socketId: string },
  stoneRooms?: ReadonlyMap<number, string>,
) {
  const placed = plan.rooms[index];
  if (!placed) throw new Error(`room ${index} missing`);
  const group = buildGreyboxRoom(t, materials);
  group.name = `room-${index}-${t.id}`;
  group.position.set(placed.position[0], 0, placed.position[1]);
  // Templates rotate clockwise seen from above, which is a negative rotation about +Y.
  group.rotation.y = (-Math.PI / 2) * placed.turns;
  const enemies: THREE.Object3D[] = [];
  for (const socketId of placed.encounter?.socketIds ?? []) {
    const s = t.enemySockets.find((socket) => socket.id === socketId);
    if (!s) continue;
    const guardian = placed.encounter?.tier === 'guardian';
    const body = new THREE.Mesh(guardian ? guardianGeometry : enemyGeometry, enemyMaterial);
    body.name = `enemy-${socketId}`;
    body.position.set(s.position[0], guardian ? 1.5 : 0.95, s.position[2]);
    body.userData = { room: index, tier: placed.encounter?.tier, socketId };
    // The room group turns the unrotated socket into place, so the world point comes from the
    // rotated template.
    const w = world.template.enemySockets.find((socket) => socket.id === socketId) ?? s;
    const at: [number, number] = [
      w.position[0] + placed.position[0],
      w.position[2] + placed.position[1],
    ];
    const heading = enemyHeading(at, entryDoor, world.footprint);
    body.rotation.y = enemyLocalRotationY(heading, placed.turns);
    group.add(body);
    enemies.push(body);
  }
  // The guardian vault's reward is paid by the win itself.
  const coffers: Coffer[] = [];
  for (const pickup of placed.loot) {
    const keyed = brassKey?.room === index && brassKey.socketId === pickup.socketId;
    if (!keyed && placed.role !== 'treasure' && placed.role !== 'combat') continue;
    const s = t.lootSockets.find((socket) => socket.id === pickup.socketId);
    if (!s) continue;
    const dungeonRoom = stoneRooms?.get(index) === 'dungeon';
    const surface = dungeonRoom ? 0 : surfaceHeightAt(t.colliders, s.position[0], s.position[2]);
    // The study collider includes the candle rack, 0.29 m above the usable desk top.
    const onDesk = !dungeonRoom && t.id === 'study' && s.id === 'desk-drawer' && surface > 0;
    const socket = onDesk
      ? { ...s, position: [2.322, 0, 2.322] as [number, number, number], yaw: 315 }
      : s;
    const coffer = kit.build(
      index,
      socket,
      pickup.kind,
      onDesk ? 0.78 : surface,
      placed.encounter !== null ||
        plan.shadowStencil?.room === index ||
        plan.floatElevator?.room === index,
      keyed,
      dungeonRoom
        ? (Stream.fromKey(`${plan.seed}:coffer-theme:${index}:${s.id}`).pick([
            'reliquary',
            'strongbox',
          ]) as CofferTheme)
        : 'classic',
    );
    if (onDesk) coffer.object.scale.set(0.85, 1.1, 0.85);
    group.add(coffer.object);
    group.getObjectByName(`socket-${s.id}`)?.removeFromParent();
    coffers.push(coffer);
  }
  // A rest room stands one hearth at its socket; the greybox marker there gives way to it.
  const hearths: Hearth[] = [];
  if (placed.role === 'rest') {
    const s = hearthSocket(t);
    if (s) {
      const hearth = hearthKit.build(index, s);
      group.add(hearth.object);
      group.getObjectByName(`socket-${s.id}`)?.removeFromParent();
      hearths.push(hearth);
    }
  }
  return { group, enemies, coffers, hearths };
}

/** Builds the greybox world for a floor plan: every room, sealed door caps, enemy placeholders. */
export function buildFloorWorld(
  plan: FloorPlan,
  templates: readonly RoomTemplate[] = GREYBOX_TEMPLATES,
  maxShellDepth?: number,
  stoneRooms?: ReadonlyMap<number, string>,
): FloorWorld {
  const materials = createGreyboxMaterials();
  const enemyMaterial = new THREE.MeshStandardMaterial({
    color: PALETTE.ruby,
    metalness: 0.5,
    roughness: 0.45,
  });
  const capMaterial = new THREE.MeshStandardMaterial({ color: PALETTE.walnut, roughness: 0.8 });
  const kit = new CofferKit();
  const coffers: Coffer[] = [];
  const hearthKit = new HearthKit();
  const hearths: Hearth[] = [];
  const rooms = worldRooms(plan, templates);
  const group = new THREE.Group();
  group.name = `floor-${plan.seed}`;
  const roomGroups: THREE.Group[] = [];
  const enemies = new Map<number, THREE.Object3D[]>();
  plan.rooms.forEach((r, index) => {
    const t = templates.find((c) => c.id === r.templateId) as RoomTemplate;
    const rotated = rooms[index] as WorldRoom;
    const entry = plan.connections.find(([, own]) => own.room === index)?.[1].door;
    const entryDoor = rotated.doors.find((d) => d.id === entry)?.world ?? null;
    const built = buildRoom(
      t,
      rotated,
      entryDoor,
      plan,
      index,
      materials,
      enemyMaterial,
      kit,
      hearthKit,
      plan.brassCache,
      stoneRooms,
    );
    coffers.push(...built.coffers);
    hearths.push(...built.hearths);
    roomGroups.push(built.group);
    enemies.set(index, built.enemies);
    group.add(built.group);
  });
  // attach() converts world to local space, so room matrices must be current first.
  group.updateMatrixWorld(true);
  const colliders: Box[][] = rooms.map((r, i) => {
    const [ox, oz] = plan.rooms[i]?.position ?? [0, 0];
    const boxes: Box[] = r.template.colliders.map((c) => ({
      min: [c.min[0] + ox, c.min[1], c.min[2] + oz],
      max: [c.max[0] + ox, c.max[1], c.max[2] + oz],
    }));
    boxes.push(...pressureColliders(plan, i));
    return boxes;
  });
  // A sealed doorway reads as a closed door: a one-sided leaf filling exactly the 1.6 x 2.4 m
  // opening on the wall line, facing into the room, so it sits flush at the back of the baked
  // reveal and never pokes into a room behind the wall. Greybox walls leave the gap open to 4 m,
  // so a fill above the lintel (removed when the room is dressed) closes it to the inner face.
  const capGeometry = new THREE.PlaneGeometry(DOOR_WIDTH, DOOR_HEIGHT);
  capGeometry.translate(0, DOOR_HEIGHT / 2, 0);
  const capUvMeters = Float32Array.from(capGeometry.getAttribute('uv').array, (v, i) =>
    i % 2 === 0 ? v * DOOR_WIDTH : v * DOOR_HEIGHT,
  );
  const fillDepth = WALL_THICKNESS / 2;
  const fillGeometry = new THREE.BoxGeometry(DOOR_WIDTH, WALL_HEIGHT - DOOR_HEIGHT, fillDepth);
  fillGeometry.translate(0, (WALL_HEIGHT + DOOR_HEIGHT) / 2, fillDepth / 2);
  // A wall-style door is greybox wall over the whole gap.
  const wallFillGeometry = new THREE.BoxGeometry(DOOR_WIDTH, WALL_HEIGHT, fillDepth);
  wallFillGeometry.translate(0, WALL_HEIGHT / 2, fillDepth / 2);
  const sealedDoors: THREE.Mesh[] = [];
  for (const s of plan.sealed) {
    const door = rooms[s.room]?.doors.find((d) => d.id === s.door);
    const roomGroup = roomGroups[s.room];
    if (!door || !roomGroup) continue;
    const yaw = INTO_ROOM_YAW[door.facing];
    const cap = new THREE.Mesh(capGeometry, capMaterial);
    cap.name = `sealed-${s.room}-${s.door}`;
    cap.position.set(door.world[0], 0, door.world[1]);
    cap.rotation.y = yaw;
    cap.userData.room = s.room;
    cap.userData.door = s.door;
    cap.userData.style = s.style;
    cap.visible = s.style === 'boarded';
    roomGroup.attach(cap);
    sealedDoors.push(cap);
    const wall = s.style === 'wall';
    const fill = new THREE.Mesh(wall ? wallFillGeometry : fillGeometry, materials.wall);
    fill.name = `${wall ? 'door-fill' : 'lintel-fill'}-${s.room}-${s.door}`;
    fill.position.copy(cap.position);
    fill.quaternion.copy(cap.quaternion);
    roomGroup.add(fill);
    colliders[s.room]?.push(doorwayCollider(door));
  }

  const stairEntry = placeStairEntry(plan, templates);
  let stairOpened = false;
  let stairDirection: 1 | -1 = 1;
  function stairBarrier(entry: StairEntry, x0: number, x1: number, z0: number, z1: number): Box {
    // The four possible facings are cardinal, so opposite corners give the world-space AABB.
    const [fx, fz] = entry.facing,
      [ox, oz] = entry.world;
    const ax = ox + x0 * fz + z0 * fx,
      bx = ox + x1 * fz + z1 * fx;
    const az = oz - x0 * fx + z0 * fz,
      bz = oz - x1 * fx + z1 * fz;
    return {
      min: [Math.min(ax, bx), -2, Math.min(az, bz)],
      max: [Math.max(ax, bx), 4.2, Math.max(az, bz)],
    };
  }
  function openStairSeal(floorNumber: 1 | 2 = 1): StairEntry | null {
    if (!stairEntry) return null;
    if (stairOpened) return stairEntry;
    stairOpened = true;
    stairDirection = floorNumber === 1 ? 1 : -1;
    const cap = sealedDoors.find(
      (candidate) =>
        candidate.userData.room === stairEntry.room && candidate.userData.door === stairEntry.door,
    );
    cap?.removeFromParent();
    const group = roomGroups[stairEntry.room];
    group?.getObjectByName(`door-fill-${stairEntry.room}-${stairEntry.door}`)?.removeFromParent();
    group?.getObjectByName(`lintel-fill-${stairEntry.room}-${stairEntry.door}`)?.removeFromParent();
    const plug = group?.getObjectByName(`door-plug-${stairEntry.door}`);
    if (plug) plug.visible = false;
    const frame = group?.getObjectByName(`door-frame-${stairEntry.door}`);
    if (frame) frame.visible = true;
    const boxes = colliders[stairEntry.room];
    const door = rooms[stairEntry.room]?.doors.find(
      (candidate) => candidate.id === stairEntry.door,
    );
    const barrier = door && doorwayCollider(door);
    if (barrier) {
      const index =
        boxes?.findIndex(
          (candidate) =>
            candidate.min[0] === barrier.min[0] &&
            candidate.min[2] === barrier.min[2] &&
            candidate.max[0] === barrier.max[0] &&
            candidate.max[2] === barrier.max[2],
        ) ?? -1;
      if (index >= 0) {
        boxes.splice(index, 1);
      }
    }
    // The generated mesh leaves the flight open. Rails/side floors own the two edges and the
    // closed far door owns the landing end. Treads are height-only and never collision walls.
    boxes.push(
      stairBarrier(stairEntry, -STAIR_WIDTH / 2, -STAIR_HALF_WIDTH, 0, STAIR_LANDING_END),
      stairBarrier(stairEntry, STAIR_HALF_WIDTH, STAIR_WIDTH / 2, 0, STAIR_LANDING_END),
      stairBarrier(
        stairEntry,
        -STAIR_WIDTH / 2,
        STAIR_WIDTH / 2,
        STAIR_DOOR_BARRIER,
        STAIR_LANDING_END,
      ),
    );
    return stairEntry;
  }

  const passage = guardedConnection(plan);
  const guard = passage?.[0];
  const door = rooms[guard?.room ?? -1]?.doors.find((d) => d.id === guard?.door);
  const guardMaterial = new THREE.MeshStandardMaterial({
    color: PALETTE.walnut,
    side: THREE.DoubleSide,
    roughness: 0.72,
  });
  const guardGeometry = new THREE.BoxGeometry(DOOR_WIDTH - 0.02, DOOR_HEIGHT - 0.03, 0.064);
  guardGeometry.translate(0, DOOR_HEIGHT / 2, 0);
  // The moving leaf's relief ends short of the jambs. Behind it, a thin rebate closes the sightline.
  const guardRebate = new THREE.BoxGeometry(DOOR_WIDTH + 0.002, DOOR_HEIGHT, 0.018);
  guardRebate.translate(0, DOOR_HEIGHT / 2, 0);
  const lockGeometry = new THREE.BoxGeometry(0.14, 0.14, 0.068)
    .rotateZ(Math.PI / 4)
    .translate(0, 1.15, 0);
  const lockMaterial = new THREE.MeshBasicMaterial({ color: PALETTE.candle });
  let guardLeaf: THREE.Group | null = null;
  let guardSource: THREE.Object3D | null = null;
  const lockedDoor = passage && door ? new THREE.Group() : null;
  const barrier = door ? doorwayCollider(door) : null;
  const guardedPick = door && doorwayCollider(door, DOOR_HEIGHT, 0.03);
  let doorAngle = 0;
  let doorOpening = false;
  let doorHinge: THREE.Group | null = null;
  let doorReleased = false;
  const reducedMotion =
    typeof globalThis.matchMedia === 'function' &&
    globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (passage && door && lockedDoor && barrier) {
    lockedDoor.name = `encounter-lock-${passage[0].room}-${door.id}`;
    const leaf = new THREE.Group();
    guardLeaf = leaf;
    leaf.add(
      new THREE.Mesh(guardGeometry, guardMaterial),
      new THREE.Mesh(lockGeometry, lockMaterial),
    );
    leaf.name = 'encounter-lock-leaf';
    const yaw = INTO_ROOM_YAW[door.facing];
    const hinge = new THREE.Group();
    doorHinge = hinge;
    // The barrel sits on the jamb. At 90 degrees even the proudest pull clears the opening.
    const hingeSide = -DOOR_WIDTH / 2 - 0.025;
    const hingeFront = 0.077;
    lockedDoor.position.set(
      door.world[0] + Math.cos(yaw) * hingeSide + Math.sin(yaw) * hingeFront,
      0,
      door.world[1] - Math.sin(yaw) * hingeSide + Math.cos(yaw) * hingeFront,
    );
    lockedDoor.rotation.y = yaw;
    leaf.position.set(-hingeSide, 0, -hingeFront);
    hinge.add(leaf);
    lockedDoor.add(hinge);
    roomGroups[passage[0].room]?.attach(lockedDoor);
    for (const side of passage) colliders[side.room]?.push(barrier);
  }

  const puzzleGates = plan.connections.flatMap((edge) => {
    const kind = edge.puzzleGate;
    if (!kind) return [];
    const [from, to] = edge;
    const door = rooms[from.room].doors.find((d) => d.id === from.door);
    if (!door) throw Error(`Missing ${kind} gate doorway`);
    const visual =
      kind === 'counterweight' || kind === 'pressure'
        ? new PuzzleGateVisual(kind, door.width, DOOR_HEIGHT)
        : null;
    if (visual) {
      visual.object.position.set(door.world[0], 0, door.world[1]);
      visual.object.rotation.y = INTO_ROOM_YAW[door.facing];
      roomGroups[from.room].attach(visual.object);
    }
    const barrier = doorwayCollider(door);
    const sides = [from.room, to.room];
    for (const side of sides) colliders[side].push(barrier);
    const pickBounds = doorwayCollider(door, DOOR_HEIGHT, 0.03);
    return [{ kind, sides, visual, barrier, pickBounds, open: false }];
  });
  const gateRay = new THREE.Ray();
  const gateBox = new THREE.Box3();
  const gateCrossing = new THREE.Vector3();
  function lockedDoorDistance(bounds: Box, ownBarrier: Box): number | null {
    gateBox.min.fromArray(bounds.min);
    gateBox.max.fromArray(bounds.max);
    if (!gateRay.intersectBox(gateBox, gateCrossing)) return null;
    const distance = gateCrossing.distanceTo(gateRay.origin);
    if (distance > 4) return null;
    for (const collider of colliders[world.current]) {
      if (collider === ownBarrier) continue;
      gateBox.min.fromArray(collider.min);
      gateBox.max.fromArray(collider.max);
      if (
        gateRay.intersectBox(gateBox, gateCrossing) &&
        gateCrossing.distanceTo(gateRay.origin) < distance - 0.025
      )
        return null;
    }
    return distance;
  }
  const blockedByPuzzleGate = (from: number, to: number): boolean =>
    puzzleGates.some((gate) => !gate.open && gate.sides.includes(from) && gate.sides.includes(to));

  const world: FloorWorld = {
    group,
    plan,
    rooms,
    roomGroups,
    enemies,
    colliders,
    current: 0,
    nearbyWalkable() {
      const near = nearSet(plan, world.current);
      const walkable = [...near].flatMap((i) => {
        if (i !== world.current && blockedByPuzzleGate(world.current, i)) return [];
        const [ox, oz] = plan.rooms[i]?.position ?? [0, 0];
        return (rooms[i]?.template.walkable ?? []).map(
          (w): Rect => ({
            min: [w.min[0] + ox, w.min[1] + oz],
            max: [w.max[0] + ox, w.max[1] + oz],
          }),
        );
      });
      if (stairOpened && stairEntry && near.has(stairEntry.room)) {
        const [x, z] = stairEntry.world;
        const [fx, fz] = stairEntry.facing;
        const half = STAIR_HALF_WIDTH;
        const ax = x - half * fz;
        const bx = x + half * fz + STAIR_LANDING_END * fx;
        const az = z + half * fx;
        const bz = z - half * fx + STAIR_LANDING_END * fz;
        walkable.push({
          min: [Math.min(ax, bx), Math.min(az, bz)],
          max: [Math.max(ax, bx), Math.max(az, bz)],
        });
      }
      return walkable;
    },
    addFixtureCollider(room, box) {
      const boxes = colliders[room];
      boxes.push(box);
      return () => {
        const index = boxes.indexOf(box);
        if (index >= 0) boxes.splice(index, 1);
      };
    },
    removeRoomFixtureColliders(room, keepFurniture) {
      const r = rooms[room];
      const [ox, oz] = plan.rooms[room].position;
      const retained = keepFurniture
        ? r.template.dressingSockets.filter((s) =>
            r.template.id === 'hall' ? s.id === 'bench-w' || s.id === 'bench-e' : s.id === 'desk',
          )
        : [];
      const boxes = colliders[room];
      for (const c of r.template.colliders) {
        const fp = r.template.footprint;
        if (
          c.min[0] < fp.min[0] ||
          c.min[2] < fp.min[1] ||
          c.max[0] > fp.max[0] ||
          c.max[2] > fp.max[1]
        )
          continue;
        if (
          retained.some(
            ({ position: [x, , z] }) =>
              x >= c.min[0] && x <= c.max[0] && z >= c.min[2] && z <= c.max[2],
          )
        )
          continue;
        const i = boxes.findIndex(
          (b) =>
            b.min[0] === c.min[0] + ox &&
            b.min[1] === c.min[1] &&
            b.min[2] === c.min[2] + oz &&
            b.max[0] === c.max[0] + ox &&
            b.max[1] === c.max[1] &&
            b.max[2] === c.max[2] + oz,
        );
        if (i >= 0) boxes.splice(i, 1);
      }
    },
    nearbyColliders() {
      return [...nearSet(plan, world.current)].flatMap((i) => colliders[i] ?? []);
    },
    update(x, z) {
      let next = roomAt(rooms, x, z, world.current);
      if (next < 0 && stairOpened && stairEntry) {
        const point = stairLocalPoint(stairEntry, x, z);
        if (
          point.depth >= 0 &&
          point.depth <= STAIR_LANDING_END &&
          Math.abs(point.across) <= STAIR_WIDTH / 2
        )
          next = stairEntry.room;
      }
      if (next < 0 || next === world.current) return false;
      world.current = next;
      applyVisibility();
      return true;
    },
    stairGroundHeight(x, z) {
      return stairOpened && stairEntry ? stairGroundHeight(stairEntry, x, z, stairDirection) : null;
    },
    teleportSurfaceHeight(x, z) {
      return stairOpened && stairEntry
        ? stairTeleportHeight(stairEntry, x, z, stairDirection)
        : null;
    },
    releaseGuardedDoor(room, immediate = false) {
      if (
        !door ||
        !passage ||
        passage[0].room !== room ||
        !lockedDoor?.parent ||
        !barrier ||
        doorReleased
      )
        return null;
      for (const side of passage) {
        const boxes = colliders[side.room];
        const index = boxes?.indexOf(barrier) ?? -1;
        if (index >= 0) boxes?.splice(index, 1);
      }
      doorReleased = true;
      doorOpening = true;
      doorAngle = immediate || reducedMotion ? Math.PI / 2 : 0;
      if (doorHinge) doorHinge.rotation.y = doorAngle;
      return new THREE.Vector3(door.world[0], 1.1, door.world[1]);
    },
    dressEncounterDoor(model) {
      if (!guardLeaf || guardSource === model) return;
      const rebate = new THREE.Mesh(guardRebate, guardMaterial);
      rebate.name = 'encounter-lock-rebate';
      guardLeaf.clear().add(model.clone(true), rebate);
      guardSource = model;
    },
    dressPuzzleGates(set, environment) {
      for (const gate of puzzleGates) gate.visual?.dress(set, environment);
    },
    setPuzzleGateOpen(kind, open, immediate = false) {
      const gates = puzzleGates.filter((g) => g.kind === kind && g.open !== open);
      for (const gate of gates) {
        gate.open = open;
        for (const side of gate.sides) {
          const boxes = colliders[side];
          if (open) {
            const index = boxes.indexOf(gate.barrier);
            if (index >= 0) boxes.splice(index, 1);
          } else if (!boxes.includes(gate.barrier)) boxes.push(gate.barrier);
        }
        gate.visual?.setOpen(open, immediate || reducedMotion);
      }
    },
    pickLockedDoor(origin, direction) {
      gateRay.set(origin, direction);
      gateRay.direction.normalize();
      let nearest: ReturnType<FloorWorld['pickLockedDoor']> = null;
      if (
        guardedPick &&
        barrier &&
        !doorReleased &&
        passage?.some((side) => side.room === world.current)
      ) {
        const distance = lockedDoorDistance(guardedPick, barrier);
        if (distance !== null) nearest = { kind: 'encounter', distance };
      }
      for (const [gateIndex, gate] of puzzleGates.entries()) {
        if (gate.open || !gate.sides.includes(world.current)) continue;
        const distance = lockedDoorDistance(gate.pickBounds, gate.barrier);
        if (distance !== null && (!nearest || distance < nearest.distance))
          nearest = { kind: gate.kind, distance, gateIndex };
      }
      return nearest;
    },
    rattlePuzzleGate(kind, gateIndex) {
      const gate =
        gateIndex === undefined
          ? puzzleGates.find((g) => g.kind === kind && !g.open)
          : puzzleGates[gateIndex];
      if (!gate?.visual || gate.kind !== kind || gate.open) return;
      gate.visual.rattle(reducedMotion);
      return gate.visual.handle.getWorldPosition(new THREE.Vector3());
    },
    updateAnimations(dt) {
      for (const gate of puzzleGates)
        if (gate.visual?.object.parent?.visible) gate.visual.update(dt);
      if (!doorOpening || !lockedDoor?.parent || reducedMotion) return;
      doorAngle = Math.min(Math.PI / 2, doorAngle + Math.max(0, dt) * 2.8);
      if (doorHinge) doorHinge.rotation.y = doorAngle;
      if (doorAngle >= Math.PI / 2) doorOpening = false;
    },
    spawnPoint() {
      const entry = rooms[0]?.footprint;
      if (!entry) return new THREE.Vector3();
      // Stand near the middle of the entry, a step back from centre so the room is in view.
      return new THREE.Vector3(
        (entry.min[0] + entry.max[0]) / 2,
        0,
        (entry.min[1] + entry.max[1]) / 2 + 2,
      );
    },
    replaceEnemy(room, body, next) {
      const list = enemies.get(room);
      const index = list?.indexOf(body) ?? -1;
      const parent = body.parent;
      if (!list || index < 0 || !parent) return false;
      next.name = body.name;
      next.userData = { ...body.userData };
      next.position.set(body.position.x, 0, body.position.z);
      next.rotation.copy(body.rotation);
      next.visible = body.visible;
      parent.add(next);
      body.removeFromParent();
      list[index] = next;
      return true;
    },
    sealedDoors,
    stairEntry,
    openStairEntry: openStairSeal,
    coffers,
    dressCoffers(loot) {
      kit.dress(loot);
    },
    hearths,
    dressHearths(materials) {
      hearthKit.dress(materials);
    },
    dressSealedDoors(material, tileMeters) {
      const uv = capGeometry.getAttribute('uv') as THREE.BufferAttribute;
      for (let i = 0; i < capUvMeters.length; i++) uv.array[i] = (capUvMeters[i] ?? 0) / tileMeters;
      uv.needsUpdate = true;
      for (const cap of sealedDoors) cap.material = material;
    },
    dressRoom(room, model) {
      const g = roomGroups[room];
      if (!g) return;
      for (const child of [...g.children]) {
        if (GREYBOX_PART.test(child.name)) child.removeFromParent();
      }
      const walls = new Set(
        plan.sealed.filter((s) => s.room === room && s.style === 'wall').map((s) => s.door),
      );
      const authored = templates.find(({ id }) => id === plan.rooms[room].templateId);
      for (const door of rooms[room]?.doors ?? []) {
        const plug = model.getObjectByName(`door-plug-${door.id}`);
        const frame = model.getObjectByName(`door-frame-${door.id}`);
        const stairOpen = stairOpened && room === stairEntry?.room && door.id === stairEntry.door;
        const closed = walls.has(door.id) && !stairOpen && plug !== undefined;
        if (plug) plug.visible = closed;
        if (frame) {
          fitBakedDoorFrame(frame);
          const facing = authored?.doors.find(({ id }) => id === door.id)?.facing;
          if (facing) insetBakedDoorFrame(frame, facing);
          frame.visible = !closed;
        }
      }
      for (const cap of sealedDoors) {
        if (cap.userData.room !== room || cap.userData.style !== 'wall') continue;
        cap.visible =
          !model.userData.roomStyle &&
          model.getObjectByName(`door-plug-${cap.userData.door}`) === undefined;
      }
      model.userData.room = room;
      g.add(model);
    },
    dispose() {
      for (const gate of puzzleGates) gate.visual?.dispose();
      disposeTableDecor(group);
      group.removeFromParent();
      for (const m of [...Object.values(materials), enemyMaterial, capMaterial, guardMaterial])
        m.dispose();
      capGeometry.dispose();
      fillGeometry.dispose();
      wallFillGeometry.dispose();
      guardGeometry.dispose();
      guardRebate.dispose();
      lockGeometry.dispose();
      lockMaterial.dispose();
      kit.dispose();
      hearthKit.dispose();
    },
  };
  // Only room groups change: a fight's own body hiding is left alone.
  function applyVisibility() {
    const visible = visibleSet(plan, world.current, maxShellDepth);
    roomGroups.forEach((g, i) => {
      g.visible = visible.has(i);
    });
  }
  applyVisibility();
  return world;
}
