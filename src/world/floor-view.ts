import * as THREE from 'three';
import { EncounterDirector } from '../combat/encounter.ts';
import { chooseEncounter } from '../combat/encounter-choice.ts';
import { buildTableGreybox, disposeTable, TABLE_NODES } from '../combat/table-greybox.ts';
import type { RoomTemplate } from '../content/rooms.ts';
import { isValidSeed, normalizeSeed, randomSeed } from '../core/rng.ts';
import type { SentryActor, SentryAsset } from '../enemies/sentry-asset.ts';
import { generateFloor } from '../floor/generate.ts';
import { PALETTE } from '../palette.ts';
import { yawFromMatrix } from '../xr/locomotion.ts';
import { buildFloorWorld, type FloorWorld } from './floor-world.ts';

/** The run seed from `?seed=`, or a fresh random one when it is missing or malformed. */
export function seedFromQuery(search: string): string {
  const raw = new URLSearchParams(search).get('seed');
  if (raw && isValidSeed(raw)) return normalizeSeed(raw);
  if (raw) console.warn(`ignoring invalid seed "${raw}"`);
  return randomSeed();
}

export interface FloorView {
  world: FloorWorld;
  seed: string;
  encounter: EncounterDirector;
  /** True while an encounter holds the player in place. */
  readonly locked: boolean;
  /**
   * Streams rooms around the head and triggers encounters. `head` is the camera; call once per
   * frame before rendering.
   */
  update(head: THREE.Object3D, dt: number): void;
  /**
   * Swaps the greybox table for a loaded asset (the P4-T5 GLB). The asset must expose `leaf-left`
   * and `leaf-right`; its top is `authoredTopHeight` above its origin and is fitted to each
   * encounter's waist height on a parent group, since `setTableUnfold` owns the root's scale.
   */
  useTableAsset(asset: THREE.Object3D, authoredTopHeight: number): void;
  /** True once `useTableAsset` replaced the greybox. */
  readonly realTable: boolean;
  /** The table's dice-tray and sigil-plate sockets (the greybox has no plate socket). */
  tableSockets(): { diceTray: THREE.Object3D | null; sigilPlate: THREE.Object3D | null };
  /**
   * Dresses every room built from `templateId` with `instantiate()`'s baked model in place of its
   * greybox. Rooms keep the greybox when this is never called (the asset failed to load).
   */
  useRoomAsset(templateId: string, instantiate: () => THREE.Object3D): number;
  /**
   * Swaps every Cog Sentry placeholder for a spawned actor, as soon as no fight is running. Bodies
   * already removed (cleared rooms) are skipped. `prepare` runs on each new actor before it is
   * placed. Without this call the capsules stay.
   */
  useSentryAsset(asset: SentryAsset, prepare?: (actor: SentryActor) => void): void;
  /** The actor standing in for an automaton body, or null for a placeholder. */
  actorOf(body: THREE.Object3D): SentryActor | null;
  /** Live sentry actors on this floor. */
  readonly actors: readonly SentryActor[];
  /**
   * While true, `update` still runs the encounter (so a finished fight folds away) but never starts a
   * new one. The game flow sets it outside exploration, so a lost fight cannot re-trigger.
   */
  suspendTriggers: boolean;
  /** Removes `room`'s automatons so its encounter never fires again (resuming a saved run). */
  markCleared(room: number): void;
  /** A standing point about 1 m inside `room` from its first door, or null for an unknown room. */
  standPoint(room: number): THREE.Vector3 | null;
  /** Removes the floor, its lights and the table from the scene and frees their GPU resources. */
  dispose(): void;
}

/** The enemy kind each body will play, in socket order, from the room's seeded encounter. */
function tagEnemyKinds(world: FloorWorld, seed: string): void {
  for (const [room, bodies] of world.enemies) {
    const tier = world.plan.rooms[room]?.encounter?.tier;
    if (!tier || bodies.length === 0) continue;
    const { enemies } = chooseEncounter(seed, room, tier, bodies.length);
    bodies.forEach((body, i) => {
      const kind = enemies[i];
      if (kind) body.userData.enemyKind = kind;
    });
  }
}

export interface FloorViewOptions {
  /** Templates the world is built from (the floor plan always uses the greybox set). */
  templates?: readonly RoomTemplate[];
}

/** Greybox exploration view: the generated floor, flat greybox lighting, the rig at the entry. */
export function mountFloorView(
  scene: THREE.Scene,
  rig: THREE.Object3D,
  seed: string,
  options: FloorViewOptions = {},
): FloorView {
  const world = buildFloorWorld(generateFloor(seed), options.templates);
  tagEnemyKinds(world, seed);
  scene.add(world.group);
  // Greybox lighting is two global lights; per-room sockets get real lights with the lightmaps (P4-T7).
  const sun = new THREE.DirectionalLight(PALETTE.candle, 1.4);
  sun.position.set(6, 12, 4);
  const sky = new THREE.HemisphereLight(PALETTE.candle, PALETTE.void, 0.8);
  scene.add(sun, sky);
  // x/z only: in XR the rig's y holds the seated-height lift, and floors rebuild mid-session.
  const spawn = world.spawnPoint();
  rig.position.set(spawn.x, rig.position.y, spawn.z);

  let locked = false;
  let suspended = false;
  // The director keeps this host for its life; the greybox or the real asset hangs under it.
  const tableHost = new THREE.Group();
  tableHost.name = 'combat-table-host';
  let greybox: THREE.Object3D | null = buildTableGreybox();
  tableHost.add(greybox);
  let fit: THREE.Group | null = null;
  let authoredTop = 1;
  const encounter = new EncounterDirector({
    world,
    table: tableHost,
    lockLocomotion: (l) => {
      locked = l;
    },
  });
  const at = new THREE.Vector3();
  const actors = new Map<THREE.Object3D, SentryActor>();
  let sentry: { asset: SentryAsset; prepare?: ((actor: SentryActor) => void) | undefined } | null =
    null;
  const dressSentries = (): void => {
    if (!sentry || encounter.phase !== 'idle') return;
    const { asset, prepare } = sentry;
    sentry = null;
    for (const [room, bodies] of world.enemies) {
      for (const body of [...bodies]) {
        const placeholder = body.userData.enemyKind === 'cog-sentry' && !actors.has(body);
        if (!placeholder || body.userData.tier === 'guardian' || !body.parent) continue;
        const actor = asset.spawn();
        prepare?.(actor);
        if (world.replaceEnemy(room, body, actor.object)) actors.set(actor.object, actor);
        else actor.dispose();
      }
    }
  };
  const disposeActor = (actor: SentryActor): void => {
    actors.delete(actor.object);
    actor.dispose();
  };
  return {
    world,
    seed,
    encounter,
    get suspendTriggers() {
      return suspended;
    },
    set suspendTriggers(value) {
      suspended = value;
    },
    markCleared(room) {
      for (const body of world.enemies.get(room) ?? []) body.removeFromParent();
    },
    standPoint(room) {
      const r = world.rooms[room];
      if (!r) return null;
      const { min, max } = r.footprint;
      const cx = (min[0] + max[0]) / 2;
      const cz = (min[1] + max[1]) / 2;
      const door = r.doors[0]?.world;
      if (!door) return new THREE.Vector3(cx, 0, cz);
      const dx = cx - door[0];
      const dz = cz - door[1];
      const len = Math.hypot(dx, dz) || 1;
      return new THREE.Vector3(door[0] + dx / len, 0, door[1] + dz / len);
    },
    get actors() {
      return [...actors.values()];
    },
    actorOf(body) {
      return actors.get(body) ?? null;
    },
    useSentryAsset(asset, prepare) {
      sentry = { asset, prepare };
      dressSentries();
    },
    useRoomAsset(templateId, instantiate) {
      let dressed = 0;
      world.plan.rooms.forEach((room, index) => {
        if (room.templateId !== templateId) return;
        world.dressRoom(index, instantiate());
        dressed++;
      });
      return dressed;
    },
    dispose() {
      for (const actor of [...actors.values()]) disposeActor(actor);
      sentry = null;
      encounter.dispose();
      if (greybox) disposeTable(greybox);
      greybox = null;
      tableHost.removeFromParent();
      sun.removeFromParent();
      sky.removeFromParent();
      sun.dispose();
      sky.dispose();
      world.dispose();
    },
    get locked() {
      return locked;
    },
    get realTable() {
      return fit !== null;
    },
    useTableAsset(asset, authoredTopHeight) {
      if (greybox) {
        greybox.removeFromParent();
        disposeTable(greybox);
        greybox = null;
      }
      fit?.removeFromParent();
      fit = new THREE.Group();
      fit.name = 'combat-table-fit';
      fit.add(asset);
      authoredTop = authoredTopHeight;
      tableHost.add(fit);
      const pose = encounter.tablePose;
      if (pose) fit.scale.set(1, pose.height / authoredTop, 1);
    },
    tableSockets() {
      return {
        diceTray:
          tableHost.getObjectByName('socket-dice-tray') ??
          tableHost.getObjectByName(TABLE_NODES.diceTray) ??
          null,
        sigilPlate: tableHost.getObjectByName('socket-sigil-plate') ?? null,
      };
    },
    update(head, dt) {
      encounter.update(dt);
      dressSentries();
      // Clips run on real seconds; the freeze is a pose, not a slowed clock.
      for (const actor of [...actors.values()]) {
        if (!actor.object.parent) {
          disposeActor(actor);
          continue;
        }
        if (encounter.frozen) {
          if (!actor.frozen && !actor.dead && actor.state === 'idle') actor.freeze();
        } else if (actor.frozen) actor.unfreeze();
        actor.update(dt);
      }
      head.getWorldPosition(at);
      // The fight owns the room until it ends, so streaming holds still meanwhile.
      if (encounter.phase !== 'idle') return;
      world.update(at.x, at.z);
      if (suspended) return;
      const hit = encounter.checkTrigger({ x: at.x, z: at.z });
      if (!hit) return;
      const began = encounter.begin(hit.room, {
        x: at.x,
        z: at.z,
        yaw: yawFromMatrix(head.matrixWorld.elements),
        eyeHeight: at.y,
      });
      if (began.ok && fit) fit.scale.set(1, began.table.pose.height / authoredTop, 1);
    },
  };
}
