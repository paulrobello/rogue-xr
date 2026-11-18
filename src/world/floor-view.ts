import * as THREE from 'three';
import { EncounterDirector } from '../combat/encounter.ts';
import { chooseEncounter, ENCOUNTER_CONTENT_VERSION } from '../combat/encounter-choice.ts';
import { combatRoom, rigTurnAboutHead } from '../combat/placement.ts';
import { buildTableGreybox, disposeTable, TABLE_NODES } from '../combat/table-greybox.ts';
import type { RoomTemplate } from '../content/rooms.ts';
import { isValidSeed, normalizeSeed, randomSeed, Stream } from '../core/rng.ts';
import { BreakApart } from '../enemies/break-apart.ts';
import type { EnemyActor, EnemyAsset } from '../enemies/enemy-asset.ts';
import { generateFloor } from '../floor/generate.ts';
import { nearSet, shellSet } from '../floor/visibility.ts';
import { PALETTE } from '../palette.ts';
import type { TreasureLoot } from '../rules/run.ts';
import {
  DEFAULT_VIGNETTE,
  moveWithCollision,
  type Vec2,
  validateLanding,
  vignetteStep,
  yawFromMatrix,
} from '../xr/locomotion.ts';
import { animateFires, FIRE_NODE } from './fireplace.ts';
import { buildFloorWorld, type FloorWorld } from './floor-world.ts';
import {
  type Hearth,
  type HearthMaterials,
  type HearthPick,
  hearthLines,
  pickHearth,
} from './hearth.ts';
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
/** Height above a hearth's base where its panel hangs, in metres (over the bowl). */
const HEARTH_TOAST_LIFT = 1.25;
/**
 * Actors in rooms seen only down a corridor step once every this many frames, in turn, with the
 * skipped seconds folded in and no look-at; actors in hidden rooms hold their pose.
 */
export const SHELL_ACTOR_EVERY = 4;

/** The treasure coffers of a floor: picking, opening and the found-item panel. */
export interface FloorLoot {
  readonly coffers: readonly Coffer[];
  /** The nearest unopened coffer in the current room a ray reaches, or null. */
  pick(origin: THREE.Vector3, direction: THREE.Vector3, maxDistance?: number): LootPick | null;
  /** Swings the coffer's lid open and shows `found` on a panel over it. Returns false for an unknown coffer. */
  open(room: number, socketId: string, found: TreasureLoot): boolean;
  /** Shows the lock message if the coffer still belongs to an uncleared encounter. */
  showLock(room: number, socketId: string): boolean;
  /** Shows a coffer already open, with no panel (resuming a saved run). */
  markOpened(room: number, socketId: string): void;
  /** Dresses the coffers in the game's walnut and brass (the flat placeholders stay on a failure). */
  dress(materials: LootMaterials): void;
  /** The panel on screen: its first line (what was found) and the canvas it is drawn on. */
  readonly toast: { readonly text: string; readonly canvas: HTMLCanvasElement } | null;
  /** A floor point `distance` m from the coffer toward its room's centre, for scripted approaches. */
  approachPoint(room: number, socketId: string, distance?: number): THREE.Vector3 | null;
}

/** The rest-room hearths of a floor: picking, using and the hp panel. */
export interface FloorHearths {
  readonly hearths: readonly Hearth[];
  /** The nearest unused hearth in the current room a ray reaches, or null. */
  pick(origin: THREE.Vector3, direction: THREE.Vector3, maxDistance?: number): HearthPick | null;
  /** Dims the hearth's coals and shows '+healed hp' on a panel over it. Returns false for an unknown hearth. */
  use(room: number, socketId: string, healed: number): boolean;
  /** Shows a hearth already spent, with no panel (resuming a saved run). */
  markUsed(room: number, socketId: string): void;
  /** Dresses the hearths' brass (the flat placeholder stays on a failure). */
  dress(materials: HearthMaterials): void;
  /** The panel on screen (shared with the coffers: one at a time) and the canvas it is drawn on. */
  readonly toast: { readonly text: string; readonly canvas: HTMLCanvasElement } | null;
  /** A floor point `distance` m from the hearth toward its room's centre, for scripted approaches. */
  approachPoint(room: number, socketId: string, distance?: number): THREE.Vector3 | null;
}

export interface FloorView {
  world: FloorWorld;
  loot: FloorLoot;
  hearth: FloorHearths;
  seed: string;
  readonly contentVersion: number;
  encounter: EncounterDirector;
  /** True while an encounter holds the player in place. */
  readonly locked: boolean;
  /**
   * Comfort vignette strength (0 to `DEFAULT_VIGNETTE.maxStrength`) from the snap that turned the
   * rig to face a fight's table; it fades on the locomotion release ramp. 0 when nothing turned.
   */
  readonly turnVignette: number;
  /**
   * Streams rooms around the head and triggers encounters. `head` is the camera; call once per
   * frame before rendering. A fight whose table had to turn off the head's heading snaps the rig
   * about the head by that turn as the fight starts, so the player faces the table.
   */
  update(head: THREE.Object3D, dt: number): void;
  /** Updates the preference and repositions the rig during a fight when the path is clear. */
  setTableDistance(distance: number, head: THREE.Object3D): boolean;
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
function tagEnemyKinds(world: FloorWorld, seed: string, contentVersion: number): void {
  for (const [room, bodies] of world.enemies) {
    const tier = world.plan.rooms[room]?.encounter?.tier;
    if (!tier || bodies.length === 0) continue;
    const { enemies } = chooseEncounter(seed, room, tier, bodies.length, contentVersion);
    bodies.forEach((body, i) => {
      const kind = enemies[i];
      if (kind) body.userData.enemyKind = kind;
    });
  }
}

export interface FloorViewOptions {
  /** Templates the world is built from (the floor plan always uses the greybox set). */
  templates?: readonly RoomTemplate[];
  /** Encounter content generation used to build this floor. */
  contentVersion?: number;
}

/** Greybox exploration view: the generated floor, flat greybox lighting, the rig at the entry. */
export function mountFloorView(
  scene: THREE.Scene,
  rig: THREE.Object3D,
  seed: string,
  options: FloorViewOptions = {},
): FloorView {
  const contentVersion = options.contentVersion ?? ENCOUNTER_CONTENT_VERSION;
  const world = buildFloorWorld(generateFloor(seed), options.templates);
  tagEnemyKinds(world, seed, contentVersion);
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
  let turnVignette = 0;
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
    onCleared: (room) => {
      world.releaseGuardedDoor(room);
      for (const coffer of world.coffers) if (coffer.room === room) coffer.unlock();
    },
    lockLocomotion: (l) => {
      locked = l;
    },
  });
  const at = new THREE.Vector3();
  const actors = new Map<THREE.Object3D, EnemyActor>();
  /** Per actor: its turn among shell-room steps and the seconds not yet stepped. */
  const paces = new Map<EnemyActor, { slot: number; pending: number }>();
  let slots = 0;
  let frame = 0;
  let tiersFor = -1;
  let near = new Set<number>();
  let shell = new Set<number>();
  // H9: an automaton whose death clip has ended falls apart into its parts, under the floor group
  // so a cleared room (which unparents and disposes the actor) never takes the pieces with it.
  const debris = new BreakApart(world.group);
  const shattered = new WeakSet<EnemyActor>();
  let shatters = 0;
  const models = new Map<
    string,
    { asset: EnemyAsset; prepare?: ((actor: EnemyActor) => void) | undefined }
  >();
  let undressed = false;
  const dressEnemies = (): void => {
    if (!undressed || encounter.phase !== 'idle') return;
    undressed = false;
    for (const [room, bodies] of world.enemies) {
      for (const [index, body] of [...bodies].entries()) {
        const kind = body.userData.enemyKind;
        const model = typeof kind === 'string' ? models.get(kind) : undefined;
        if (!model || actors.has(body) || !body.parent) continue;
        const actor = model.asset.spawn(index);
        model.prepare?.(actor);
        if (world.replaceEnemy(room, body, actor.object)) {
          actors.set(actor.object, actor);
          paces.set(actor, { slot: slots++, pending: 0 });
          // Poses the idle clip now, so a hidden room's actor never shows its bind pose.
          actor.update(0);
        } else actor.dispose();
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
  /** Live fireplace fires (the hall's); instances of one template share the material and its clock. */
  const fires: { material: THREE.ShaderMaterial; room: THREE.Object3D }[] = [];
  let clock = 0;
  const spin = (dt: number): void => {
    clock += dt;
    for (const s of spinners) {
      if (s.room.visible)
        s.node.quaternion.setFromAxisAngle(s.axis, rigidAngle(s.radPerSec, clock));
    }
    animateFires(fires, clock);
  };
  const disposeActor = (actor: EnemyActor): void => {
    actors.delete(actor.object);
    paces.delete(actor);
    actor.dispose();
  };
  let toast: LootToast | null = null;
  const dropToast = (): void => {
    toast?.dispose();
    toast = null;
  };
  const cofferOf = (room: number, socketId: string): Coffer | undefined =>
    world.coffers.find((c) => c.room === room && c.socketId === socketId);
  const lootLocked = (room: number): boolean =>
    world.plan.rooms[room]?.role === 'combat' && !encounter.isCleared(room);
  const loot: FloorLoot = {
    coffers: world.coffers,
    pick(origin, direction, maxDistance = LOOT_REACH) {
      const here = world.coffers.filter((c) => c.room === world.current);
      return pickCoffer(here, origin, direction, maxDistance);
    },
    open(room, socketId, found) {
      const coffer = cofferOf(room, socketId);
      if (!coffer || lootLocked(room)) return false;
      coffer.open(true);
      if (found.kind === 'cogs') coffer.showCogs(found.cogs);
      dropToast();
      const at = coffer.object.getWorldPosition(new THREE.Vector3());
      toast = new LootToast(found, at.setY(at.y + TOAST_LIFT));
      world.group.add(toast.root);
      return true;
    },
    showLock(room, socketId) {
      const coffer = cofferOf(room, socketId);
      if (!coffer || !lootLocked(room)) return false;
      dropToast();
      const at = coffer.object.getWorldPosition(new THREE.Vector3());
      toast = new LootToast(
        { text: 'Locked', caption: 'Defeat this room’s automatons' },
        at.setY(at.y + TOAST_LIFT),
      );
      world.group.add(toast.root);
      return true;
    },
    markOpened(room, socketId) {
      const coffer = cofferOf(room, socketId);
      coffer?.unlock();
      coffer?.open(false);
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
  const hearthOf = (room: number, socketId: string): Hearth | undefined =>
    world.hearths.find((h) => h.room === room && h.socketId === socketId);
  const hearth: FloorHearths = {
    hearths: world.hearths,
    pick(origin, direction, maxDistance = LOOT_REACH) {
      const here = world.hearths.filter((h) => h.room === world.current);
      return pickHearth(here, origin, direction, maxDistance);
    },
    use(room, socketId, healed) {
      const found = hearthOf(room, socketId);
      if (!found) return false;
      found.use(true);
      dropToast();
      const at = found.object.getWorldPosition(new THREE.Vector3());
      toast = new LootToast(hearthLines(healed), at.setY(at.y + HEARTH_TOAST_LIFT));
      world.group.add(toast.root);
      return true;
    },
    markUsed(room, socketId) {
      hearthOf(room, socketId)?.use(false);
    },
    dress(materials) {
      world.dressHearths(materials);
    },
    get toast() {
      return toast ? { text: toast.text, canvas: toast.canvas } : null;
    },
    approachPoint(room, socketId, distance = 2.2) {
      const found = hearthOf(room, socketId);
      const footprint = world.rooms[room]?.footprint;
      if (!found || !footprint) return null;
      const base = found.object.getWorldPosition(new THREE.Vector3());
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
    hearth,
    seed,
    contentVersion,
    encounter,
    get suspendTriggers() {
      return suspended;
    },
    set suspendTriggers(value) {
      suspended = value;
    },
    markCleared(room) {
      encounter.markCleared(room);
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
      for (const [kind, asset] of assets) {
        models.set(kind, { asset, prepare });
        // Splits each kind once now, so the first death does not pay for it.
        debris.prepareAsset(asset);
      }
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
        const fire = model.getObjectByName(FIRE_NODE) as THREE.Mesh | undefined;
        if (fire && group && fire.material instanceof THREE.ShaderMaterial)
          fires.push({ material: fire.material, room: group });
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
      fires.length = 0;
      debris.dispose();
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
    get turnVignette() {
      return turnVignette;
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
    setTableDistance(distance, head) {
      if (encounter.phase === 'idle') {
        encounter.tableDistance = distance;
        return true;
      }
      const delta = encounter.adjustTableDistance(distance, (shift) => {
        const room = world.rooms[encounter.activeRoom];
        if (!room) return false;
        const colliders = world.colliders[encounter.activeRoom] ?? [];
        head.getWorldPosition(at);
        const from: Vec2 = [at.x, at.z];
        const target: Vec2 = [at.x + shift[0], at.z + shift[1]];
        const moved = moveWithCollision(from, shift, colliders);
        return (
          Math.hypot(moved[0] - target[0], moved[1] - target[1]) < 1e-4 &&
          validateLanding(target, { colliders, walkable: combatRoom(room).walkable }) === 'ok'
        );
      });
      if (!delta)
        return (
          encounter.tableDistance === distance &&
          (encounter.seatDistance === null || Math.abs(encounter.seatDistance - distance) < 1e-6)
        );
      rig.position.x += delta[0];
      rig.position.z += delta[1];
      rig.updateMatrixWorld(true);
      return true;
    },
    update(head, dt) {
      turnVignette = vignetteStep(turnVignette, 0, dt, DEFAULT_VIGNETTE);
      spin(dt);
      for (const coffer of world.coffers) coffer.update(dt);
      for (const lit of world.hearths) lit.update(dt);
      if (toast) {
        head.getWorldPosition(at);
        if (!toast.update(dt, at)) dropToast();
      }
      encounter.update(dt);
      dressEnemies();
      head.getWorldPosition(at);
      if (tiersFor !== world.current) {
        tiersFor = world.current;
        near = nearSet(world.plan, tiersFor);
        shell = shellSet(world.plan, tiersFor);
      }
      frame++;
      // Clips run on real seconds; the freeze is a pose, not a slowed clock.
      for (const actor of [...actors.values()]) {
        if (!actor.object.parent) {
          disposeActor(actor);
          continue;
        }
        if (encounter.frozen) {
          if (!actor.frozen && !actor.dead && actor.state === 'idle') actor.freeze();
        } else if (actor.frozen) actor.unfreeze();
        const room = actor.object.userData.room as number;
        const pace = paces.get(actor);
        if (!pace || near.has(room) || room === encounter.activeRoom) {
          actor.update(dt + (pace?.pending ?? 0), at);
          if (pace) pace.pending = 0;
        } else if (shell.has(room)) {
          pace.pending += dt;
          if ((frame + pace.slot) % SHELL_ACTOR_EVERY === 0) {
            actor.update(pace.pending, null);
            pace.pending = 0;
          }
        }
        if (actor.dead && !shattered.has(actor) && !actor.action('death').isRunning()) {
          shattered.add(actor);
          debris.shatterActor(actor, Stream.fromKey(`${world.plan.seed}:shatter:${shatters++}`));
        }
      }
      debris.update(dt);
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
      if (!began.ok) return;
      if (fit) fit.scale.set(1, began.table.pose.height / authoredTop, 1);
      // Snapped during the freeze while the table is still folded (invisible), behind the vignette.
      if (began.table.offsetDeg !== 0) {
        const turn = rigTurnAboutHead(
          [rig.position.x, rig.position.z],
          [at.x, at.z],
          began.table.offsetDeg,
        );
        rig.position.x = turn.x;
        rig.position.z = turn.z;
        rig.rotation.y += turn.rotationY;
        rig.updateMatrixWorld(true);
        turnVignette = DEFAULT_VIGNETTE.maxStrength;
      }
    },
  };
}
