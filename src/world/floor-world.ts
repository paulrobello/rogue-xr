import * as THREE from 'three';
import {
  type Box,
  DOOR_WIDTH,
  type Facing,
  GREYBOX_TEMPLATES,
  type Rect,
  type RoomTemplate,
} from '../content/rooms.ts';
import {
  type FloorPlan,
  guardedConnection,
  type WorldRoom,
  worldRooms,
} from '../floor/generate.ts';
import { nearSet, visibleSet } from '../floor/visibility.ts';
import { PALETTE } from '../palette.ts';
import { enemyHeading, enemyLocalRotationY } from './enemy-facing.ts';
import { buildGreyboxRoom, createGreyboxMaterials, type GreyboxMaterials } from './greybox.ts';
import { type Hearth, HearthKit, type HearthMaterials, hearthSocket } from './hearth.ts';
import { type Coffer, CofferKit, type LootMaterials, surfaceHeightAt } from './loot.ts';
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
  /** World-space walkable rects of the current room and its neighbours (teleport landings). */
  nearbyWalkable(): readonly Rect[];
  /** Re-evaluates the current room from a world-space floor point; returns true when it changed. */
  update(x: number, z: number): boolean;
  /** Opens the forward door held by a defeated encounter. */
  releaseGuardedDoor(room: number): void;
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

function doorwayCollider(door: WorldRoom['doors'][number]): Box {
  const [x, z] = door.world;
  const depth = WALL_THICKNESS / 2;
  const width = door.width / 2;
  const acrossX = door.facing === 'N' || door.facing === 'S';
  const [hx, hz] = acrossX ? [width, depth] : [depth, width];
  return { min: [x - hx, 0, z - hz], max: [x + hx, WALL_HEIGHT, z + hz] };
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
  if (placed.role === 'treasure' || placed.role === 'combat') {
    for (const pickup of placed.loot) {
      const s = t.lootSockets.find((socket) => socket.id === pickup.socketId);
      if (!s) continue;
      const surface = surfaceHeightAt(t.colliders, s.position[0], s.position[2]);
      const coffer = kit.build(index, s, pickup.kind, surface);
      group.add(coffer.object);
      group.getObjectByName(`socket-${s.id}`)?.removeFromParent();
      coffers.push(coffer);
    }
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
    return r.template.colliders.map((c) => ({
      min: [c.min[0] + ox, c.min[1], c.min[2] + oz],
      max: [c.max[0] + ox, c.max[1], c.max[2] + oz],
    }));
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

  const passage = guardedConnection(plan);
  const guard = passage?.[0];
  const door = rooms[guard?.room ?? -1]?.doors.find((d) => d.id === guard?.door);
  const guardMaterial = new THREE.MeshStandardMaterial({
    color: PALETTE.walnut,
    side: THREE.DoubleSide,
    roughness: 0.72,
  });
  const lockMaterial = new THREE.MeshBasicMaterial({
    color: PALETTE.candle,
    side: THREE.DoubleSide,
  });
  const lockGeometry = new THREE.CircleGeometry(0.1, 4);
  const lockedDoor = passage && door ? new THREE.Mesh(capGeometry, guardMaterial) : null;
  const barrier = door ? doorwayCollider(door) : null;
  if (passage && door && lockedDoor && barrier) {
    lockedDoor.name = `encounter-lock-${passage[0].room}-${door.id}`;
    lockedDoor.position.set(door.world[0], 0, door.world[1]);
    lockedDoor.rotation.y = INTO_ROOM_YAW[door.facing];
    const badge = new THREE.Mesh(lockGeometry, lockMaterial);
    badge.position.set(0, 1.15, 0.012);
    lockedDoor.add(badge);
    roomGroups[passage[0].room]?.attach(lockedDoor);
    for (const side of passage) colliders[side.room]?.push(barrier);
  }

  const world: FloorWorld = {
    group,
    plan,
    rooms,
    roomGroups,
    enemies,
    colliders,
    current: 0,
    nearbyWalkable() {
      return [...nearSet(plan, world.current)].flatMap((i) => {
        const [ox, oz] = plan.rooms[i]?.position ?? [0, 0];
        return (rooms[i]?.template.walkable ?? []).map(
          (w): Rect => ({
            min: [w.min[0] + ox, w.min[1] + oz],
            max: [w.max[0] + ox, w.max[1] + oz],
          }),
        );
      });
    },
    nearbyColliders() {
      return [...nearSet(plan, world.current)].flatMap((i) => colliders[i] ?? []);
    },
    update(x, z) {
      const next = roomAt(rooms, x, z, world.current);
      if (next < 0 || next === world.current) return false;
      world.current = next;
      applyVisibility();
      return true;
    },
    releaseGuardedDoor(room) {
      if (!passage || passage[0].room !== room || !lockedDoor?.parent || !barrier) return;
      lockedDoor.removeFromParent();
      for (const side of passage) {
        const boxes = colliders[side.room];
        const index = boxes?.indexOf(barrier) ?? -1;
        if (index >= 0) boxes?.splice(index, 1);
      }
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
      for (const door of rooms[room]?.doors ?? []) {
        const plug = model.getObjectByName(`door-plug-${door.id}`);
        const frame = model.getObjectByName(`door-frame-${door.id}`);
        const closed = walls.has(door.id) && plug !== undefined;
        if (plug) plug.visible = closed;
        if (frame) frame.visible = !closed;
      }
      for (const cap of sealedDoors) {
        if (cap.userData.room !== room || cap.userData.style !== 'wall') continue;
        cap.visible = model.getObjectByName(`door-plug-${cap.userData.door}`) === undefined;
      }
      model.userData.room = room;
      g.add(model);
    },
    dispose() {
      disposeTableDecor(group);
      group.removeFromParent();
      for (const m of [
        ...Object.values(materials),
        enemyMaterial,
        capMaterial,
        guardMaterial,
        lockMaterial,
      ])
        m.dispose();
      capGeometry.dispose();
      fillGeometry.dispose();
      wallFillGeometry.dispose();
      lockGeometry.dispose();
      kit.dispose();
      hearthKit.dispose();
    },
  };
  // Only room groups change: a fight's own body hiding is left alone.
  function applyVisibility() {
    const visible = visibleSet(plan, world.current);
    roomGroups.forEach((g, i) => {
      g.visible = visible.has(i);
    });
  }
  applyVisibility();
  return world;
}
