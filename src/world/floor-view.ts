import * as THREE from 'three';
import { EncounterDirector } from '../combat/encounter.ts';
import { chooseEncounter } from '../combat/encounter-choice.ts';
import { buildTableGreybox, disposeTable, TABLE_NODES } from '../combat/table-greybox.ts';
import type { RoomTemplate } from '../content/rooms.ts';
import { isValidSeed, normalizeSeed, randomSeed } from '../core/rng.ts';
import type { EnemyActor, EnemyAsset } from '../enemies/enemy-asset.ts';
import { generateFloor } from '../floor/generate.ts';
import { PALETTE } from '../palette.ts';
import type { TreasureLoot } from '../rules/run.ts';
import { yawFromMatrix } from '../xr/locomotion.ts';
import { buildFloorWorld, type FloorWorld } from './floor-world.ts';
import { type Coffer, type LootMaterials, type LootPick, LootToast, pickCoffer } from './loot.ts';
import { type RigidNode, rigidAngle } from './study-room.ts';

/** The run seed from `?seed=`, or a fresh random one when it is missing or malformed. */
export function seedFromQuery(search: string): string {
  const raw = new URLSearchParams(search).get('seed');
  if (raw && isValidSeed(raw)) return normalizeSeed(raw);
  if (raw) console.warn(`ignoring invalid seed "${raw}"`);
  return randomSeed();
}

/** Farthest a pointer reaches a coffer, in metres: the study's desk is about 3.5 m from its door. */
export const LOOT_REACH = 4;
/** Height above a coffer's base where its toast hangs, in metres. */
const TOAST_LIFT = 0.95;

/** The treasure coffers of a floor: picking, opening and the found-item panel. */
export interface FloorLoot {
  readonly coffers: readonly Coffer[];
  /** The nearest unopened coffer in the current room a ray reaches, or null. */
  pick(origin: THREE.Vector3, direction: THREE.Vector3, maxDistance?: number): LootPick | null;
  /** Swings the coffer's lid open and shows `found` on a panel over it. Returns false for an unknown coffer. */
  open(room: number, socketId: string, found: TreasureLoot): boolean;
  /** Shows a coffer already open, with no panel (resuming a saved run). */
  markOpened(room: number, socketId: string): void;
  /** Dresses the coffers in the game's walnut and brass (the flat placeholders stay on a failure). */
  dress(materials: LootMaterials): void;
  /** The panel on screen: its first line (what was found) and the canvas it is drawn on. */
  readonly toast: { readonly text: string; readonly canvas: HTMLCanvasElement } | null;
  /** A floor point `distance` m from the coffer toward its room's centre, for scripted approaches. */
  approachPoint(room: number, socketId: string, distance?: number): THREE.Vector3 | null;
}

export interface FloorView {
  world: FloorWorld;
  loot: FloorLoot;
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
   * greybox. Rooms keep the greybox when this is never called (the asset failed to load). Each
   * instance's `rigidNodes` turn from then on while their room is shown, until `dispose`.
   */
  useRoomAsset(
    templateId: string,
    instantiate: () => THREE.Object3D,
    rigidNodes?: readonly RigidNode[],
  ): number;
  /** Rigid nodes (the gear-shaft crown gear) this floor turns each frame. */
  readonly spinnerCount: number;
  /**
   * Adds loaded models, keyed by enemy kind, and swaps each placeholder of that kind for a spawned
   * actor as soon as no fight is running. Calls accumulate, so models can arrive one at a time;
   * kinds never given keep their capsules. Bodies already removed (cleared rooms) are skipped.
   * `prepare` runs on each new actor before it is placed. The assets stay the caller's: disposing
   * the floor disposes its actors, never the shared assets.
   */
  useEnemyAssets(
    assets: ReadonlyMap<string, EnemyAsset>,
    prepare?: (actor: EnemyActor) => void,
  ): void;
  /** The actor standing in for an automaton body, or null for a placeholder. */
  actorOf(body: THREE.Object3D): EnemyActor | null;
  /** Live automaton actors on this floor. */
  readonly actors: readonly EnemyActor[];
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
  const actors = new Map<THREE.Object3D, EnemyActor>();
  const models = new Map<
    string,
    { asset: EnemyAsset; prepare?: ((actor: EnemyActor) => void) | undefined }
  >();
  let undressed = false;
  const dressEnemies = (): void => {
    if (!undressed || encounter.phase !== 'idle') return;
    undressed = false;
    for (const [room, bodies] of world.enemies) {
      for (const body of [...bodies]) {
        const kind = body.userData.enemyKind;
        const model = typeof kind === 'string' ? models.get(kind) : undefined;
        if (!model || actors.has(body) || !body.parent) continue;
        const actor = model.asset.spawn();
        model.prepare?.(actor);
        if (world.replaceEnemy(room, body, actor.object)) actors.set(actor.object, actor);
        else actor.dispose();
      }
    }
  };
  interface Spinner {
    node: THREE.Object3D;
    axis: THREE.Vector3;
    radPerSec: number;
    room: THREE.Object3D;
  }
  const spinners: Spinner[] = [];
  let clock = 0;
  const spin = (dt: number): void => {
    clock += dt;
    for (const s of spinners) {
      if (s.room.visible)
        s.node.quaternion.setFromAxisAngle(s.axis, rigidAngle(s.radPerSec, clock));
    }
  };
  const disposeActor = (actor: EnemyActor): void => {
    actors.delete(actor.object);
    actor.dispose();
  };
  let toast: LootToast | null = null;
  const dropToast = (): void => {
    toast?.dispose();
    toast = null;
  };
  const cofferOf = (room: number, socketId: string): Coffer | undefined =>
    world.coffers.find((c) => c.room === room && c.socketId === socketId);
  const loot: FloorLoot = {
    coffers: world.coffers,
    pick(origin, direction, maxDistance = LOOT_REACH) {
      const here = world.coffers.filter((c) => c.room === world.current);
      return pickCoffer(here, origin, direction, maxDistance);
    },
    open(room, socketId, found) {
      const coffer = cofferOf(room, socketId);
      if (!coffer) return false;
      coffer.open(true);
      dropToast();
      const at = coffer.object.getWorldPosition(new THREE.Vector3());
      toast = new LootToast(found, at.setY(at.y + TOAST_LIFT));
      world.group.add(toast.root);
      return true;
    },
    markOpened(room, socketId) {
      cofferOf(room, socketId)?.open(false);
    },
    dress(materials) {
      world.dressCoffers(materials);
    },
    get toast() {
      return toast ? { text: toast.text, canvas: toast.canvas } : null;
    },
    approachPoint(room, socketId, distance = 2.2) {
      const coffer = cofferOf(room, socketId);
      const footprint = world.rooms[room]?.footprint;
      if (!coffer || !footprint) return null;
      const base = coffer.object.getWorldPosition(new THREE.Vector3());
      const toCentre = new THREE.Vector3(
        (footprint.min[0] + footprint.max[0]) / 2 - base.x,
        0,
        (footprint.min[1] + footprint.max[1]) / 2 - base.z,
      );
      if (toCentre.lengthSq() < 1e-6) toCentre.set(0, 0, 1);
      return new THREE.Vector3(base.x, 0, base.z).addScaledVector(toCentre.normalize(), distance);
    },
  };
  return {
    world,
    loot,
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
    useEnemyAssets(assets, prepare) {
      for (const [kind, asset] of assets) models.set(kind, { asset, prepare });
      undressed = true;
      dressEnemies();
    },
    useRoomAsset(templateId, instantiate, rigidNodes = []) {
      let dressed = 0;
      world.plan.rooms.forEach((room, index) => {
        if (room.templateId !== templateId) return;
        const model = instantiate();
        world.dressRoom(index, model);
        const group = world.roomGroups[index];
        for (const rigid of rigidNodes) {
          const node = model.getObjectByName(rigid.node);
          if (!node || !group) {
            console.warn(`${templateId}: rigid node ${rigid.node} missing; it stays still`);
            continue;
          }
          const axis = new THREE.Vector3(...rigid.axis).normalize();
          spinners.push({ node, axis, radPerSec: rigid.radPerSec, room: group });
        }
        dressed++;
      });
      return dressed;
    },
    get spinnerCount() {
      return spinners.length;
    },
    dispose() {
      dropToast();
      spinners.length = 0;
      for (const actor of [...actors.values()]) disposeActor(actor);
      models.clear();
      undressed = false;
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
      spin(dt);
      for (const coffer of world.coffers) coffer.update(dt);
      if (toast) {
        head.getWorldPosition(at);
        if (!toast.update(dt, at)) dropToast();
      }
      encounter.update(dt);
      dressEnemies();
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
