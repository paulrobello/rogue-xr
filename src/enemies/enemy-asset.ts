import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { ENEMIES, type EnemyKind } from '../content/enemies.ts';
import { loadPbrSet, type PbrSet } from '../world/materials.ts';
import { applyGlowLook, writeGlowIslands } from './glow.ts';
import { HeadLook } from './look-at.ts';
import type { PatrolClipName } from './patrol-visual.ts';

/**
 * Runtime contract of every automaton model, `public/assets/enemies/<id>/<id>.manifest.json` plus
 * its GLB (the schema scripts/assets/build-cog-sentry.py writes). The root sits at the feet and the
 * model faces local -Z, so `rotation.y = -heading` (as src/combat/encounter.ts sets it) turns it
 * toward the heading. Root motion is code-owned: every clip plays in place.
 */
export const ENEMY_ASSET_ROOT = '/assets/enemies';

/** Dedicated models packaged with the game. Shared-kit actors load through their owning kit. */
export const SHIPPED_ENEMY_MODELS = [
  'cog-sentry',
  'spring-hound',
  'bellows-golem',
  'orrery-warden',
  'grand-escapement',
  'glasswing-scrivener',
  'furnace-mite',
  'null-crown-auditor',
] as const satisfies readonly EnemyKind[];
export const ENEMY_CLIPS = ['idle', 'attack', 'hit', 'death', 'frozen'] as const;
export type EnemyClip = (typeof ENEMY_CLIPS)[number];
/**
 * The one-shot clip an enemy with a rules phase 2 plays when it begins (the guardian's case
 * opens). Loaded only for an enemy whose content defines `phaseTwo`, so no other model carries it.
 */
export const PHASE_CLIP = 'phase-change';
type IntentClip = `intent-${string}`;
type MoveActionClip = `action-${string}`;
export type ActorClip =
  | EnemyClip
  | typeof PHASE_CLIP
  | IntentClip
  | MoveActionClip
  | PatrolClipName;
/**
 * Bones the phase-change clip leaves open (the guardian's doors and side plates). Every clip keys
 * every bone, so after the change the actor re-applies the clip's final pose to these each frame
 * and the case stays open under idle, attack, hit, frozen and death.
 */
export const PHASE_HELD_BONES: readonly string[] = ['door.L', 'door.R', 'plate.L', 'plate.R'];

/** Whether the rules give `id` a phase 2, and so whether its model must carry the phase-change clip. */
export function hasPhaseClip(id: string): boolean {
  return (
    (ENEMIES as Record<string, (typeof ENEMIES)[EnemyKind] | undefined>)[id]?.phaseTwo !== undefined
  );
}
export const ENEMY_SOCKETS = ['socket-hit', 'socket-eye', 'socket-weapon'] as const;
export type EnemySocket = (typeof ENEMY_SOCKETS)[number];
/** Sockets the runtime reads (combat-session aims hit sparks at `socket-hit`). */
const REQUIRED_SOCKETS: readonly EnemySocket[] = ['socket-hit'];

export interface EnemyClipSpec {
  duration: number;
  loop: 'repeat' | 'once';
  events: Record<string, number>;
  held?: boolean;
  endsOnFloor?: boolean;
}

export interface EnemyActionTiming {
  duration: number;
  impact: number;
  secondImpact?: number;
}

export interface EnemyMaterialSlot {
  set: string | null;
  factorOnly?: boolean;
  emissive?: boolean;
  tileMeters?: number;
  normalScale?: number;
  /**
   * Linear-RGB multiplier (each component 0..1) on a bound clone's `color`: the shared set's
   * material for a set slot, the GLB's own factor material for a factor-only slot. The shared set
   * and the GLB source are never mutated. Absent: the colour unchanged.
   */
  tint?: [number, number, number];
}

export interface EnemyManifest {
  id: string;
  version: number;
  glb: string;
  frame: { units: string; up: string; forward: string; origin: string };
  root: string;
  mesh: string;
  bounds: { min: number[]; max: number[] };
  skeleton: { root: string; bones: number; joints: string[]; maxInfluences: number };
  rootMotion: string;
  clips: Record<EnemyClip, EnemyClipSpec>;
  intentClips?: Readonly<Record<string, IntentClip>>;
  actionClips?: Readonly<Record<string, MoveActionClip>>;
  actionTimings?: Readonly<Record<string, EnemyActionTiming>>;
  sockets: Partial<
    Record<EnemySocket, { bone: string; parent: string | null; position: number[] }>
  >;
  emissive: { material: string; color: string; intensity: number; nodes: string[] };
  materialSlots: Record<string, EnemyMaterialSlot>;
  budget: { tris: number; materials: number; bones: number; influences: number };
  /** Optional culling sphere covering every clip; derived from `bounds` when absent. */
  cull?: { center: number[]; radius: number };
}

/** Validates a manifest against the runtime contract; `id`, when given, must match its `id`. */
export function parseEnemyManifest(raw: unknown, id?: string): EnemyManifest {
  const m = raw as Partial<EnemyManifest>;
  const who = id ?? (typeof m?.id === 'string' ? m.id : 'enemy');
  if (typeof m !== 'object' || m === null) throw new Error(`${who} manifest: expected an object`);
  if (id !== undefined && m.id !== id) throw new Error(`${who} manifest: id is ${String(m.id)}`);
  if (typeof m.glb !== 'string' || typeof m.root !== 'string')
    throw new Error(`${who} manifest: glb or root missing`);
  if (m.frame?.forward !== '-Z') throw new Error(`${who} manifest: forward must be -Z`);
  for (const clip of ENEMY_CLIPS) {
    const spec = m.clips?.[clip];
    if (!spec || !(spec.duration > 0) || (spec.loop !== 'repeat' && spec.loop !== 'once')) {
      throw new Error(`${who} manifest: clip ${clip} missing or invalid`);
    }
  }
  if (m.intentClips) {
    for (const [move, name] of Object.entries(m.intentClips)) {
      if (!move || name !== `intent-${move}`)
        throw new Error(`${who} manifest: invalid intent clip ${name}`);
    }
  }
  for (const [move, name] of Object.entries(m.actionClips ?? {})) {
    if (name !== `action-${move}` || !m.intentClips?.[move])
      throw new Error(`${who} manifest: invalid action clip ${name}`);
  }
  if (
    m.actionTimings !== undefined &&
    (typeof m.actionTimings !== 'object' ||
      m.actionTimings === null ||
      Array.isArray(m.actionTimings))
  )
    throw new Error(`${who} manifest: actionTimings must be a record`);
  for (const [move, timing] of Object.entries(m.actionTimings ?? {})) {
    if (!m.actionClips?.[move])
      throw new Error(`${who} manifest: action timing ${move} has no action clip`);
    if (
      !Number.isFinite(timing?.duration) ||
      !Number.isFinite(timing?.impact) ||
      !(timing.duration > 0) ||
      !(timing.impact > 0 && timing.impact < timing.duration)
    )
      throw new Error(`${who} manifest: invalid action timing ${move}`);
    if (
      timing.secondImpact !== undefined &&
      (!Number.isFinite(timing.secondImpact) ||
        !(timing.impact < timing.secondImpact && timing.secondImpact < timing.duration))
    )
      throw new Error(`${who} manifest: invalid action timing ${move}`);
  }
  for (const socket of ENEMY_SOCKETS) {
    const entry = m.sockets?.[socket];
    if ((entry || REQUIRED_SOCKETS.includes(socket)) && entry?.position?.length !== 3)
      throw new Error(`${who} manifest: socket ${socket} missing`);
  }
  if (!m.materialSlots || !m.emissive?.material)
    throw new Error(`${who} manifest: materialSlots or emissive missing`);
  for (const [name, slot] of Object.entries(m.materialSlots)) {
    const tint: unknown = slot?.tint;
    if (tint === undefined) continue;
    if (
      !Array.isArray(tint) ||
      tint.length !== 3 ||
      !tint.every((c) => typeof c === 'number' && c >= 0 && c <= 1)
    )
      throw new Error(`${who} manifest: slot ${name} tint must be three numbers in 0..1`);
  }
  return m as EnemyManifest;
}

/** The Cog Sentry's hand-fitted sphere: covers every clip, the lying death pose included. */
const SENTRY_CULL = { center: [0, 1, 0], radius: 1.7 };

/**
 * The culling sphere of a manifest: its own `cull`, the sentry's fitted sphere, or one around the
 * standing bounds wide enough for the model to lie its full height along the floor.
 */
function cullSphere(manifest: EnemyManifest): THREE.Sphere {
  const fit = manifest.cull ?? (manifest.id === 'cog-sentry' ? SENTRY_CULL : null);
  if (fit) {
    const [x = 0, y = 0, z = 0] = fit.center;
    return new THREE.Sphere(new THREE.Vector3(x, y, z), fit.radius);
  }
  const [minX = 0, , minZ = 0] = manifest.bounds.min;
  const [maxX = 0, maxY = 2, maxZ = 0] = manifest.bounds.max;
  const reach = Math.max(maxY, maxX - minX, maxZ - minZ);
  return new THREE.Sphere(new THREE.Vector3(0, maxY / 2, 0), reach * 1.15);
}

/**
 * Ice hue the plates take on while frozen, and how far toward it they move. Each material moves
 * toward the rime hue at its own luminance, so a frozen plate cools without lifting: a fixed pale
 * target would turn dark gunmetal silver. The hue is a strong ice blue: a near-grey rime lifts green
 * at fixed luminance and pushes brass toward yellow.
 */
const RIME = new THREE.Color('#aab7ff');
const RIME_MIX = 0.22;
const LUMA = [0.2126, 0.7152, 0.0722] as const;
const luma = (c: THREE.Color): number => c.r * LUMA[0] + c.g * LUMA[1] + c.b * LUMA[2];
/** The rime hue at unit luminance, its chroma (distance from grey) scaled by RIME_CHROMA. */
const RIME_CHROMA = 2.3;
const RIME_UNIT = new THREE.Color().setRGB(
  ...(RIME.toArray().map((c) => 1 + RIME_CHROMA * (c / luma(RIME) - 1)) as [
    number,
    number,
    number,
  ]),
  THREE.LinearSRGBColorSpace,
);

/** The frozen colour of `base`: a {@link RIME_MIX} step toward the rime hue at `base`'s own luminance. */
export function rimeColor(base: THREE.Color, out = new THREE.Color()): THREE.Color {
  return out.copy(base).lerp(RIME_UNIT.clone().multiplyScalar(luma(base)), RIME_MIX);
}
const RIME_GLOW = 0.3;
const HIT_FLASH = 2.5;
const FLASH_DECAY = 6;

interface Owned {
  materials: THREE.Material[];
  geometries: THREE.BufferGeometry[];
}

/**
 * One loaded automaton model: the template scene, its clips, and the resources every actor shares
 * (geometry, skeleton template, the bound slot materials). `spawn()` builds pooled actors;
 * `dispose()` stops new spawns and releases the shared resources once the last live actor is gone.
 */
export class EnemyAsset {
  private disposed = false;
  private released = false;
  private readonly live = new Set<EnemyActor>();

  constructor(
    readonly manifest: EnemyManifest,
    readonly template: THREE.Object3D,
    readonly clips: ReadonlyMap<EnemyClip, THREE.AnimationClip>,
    private readonly owned: Owned,
    /** The phase-change clip: set for an enemy with a rules phase 2, null for every other model. */
    readonly phaseClip: THREE.AnimationClip | null = null,
    readonly moveClips: ReadonlyMap<IntentClip | MoveActionClip, THREE.AnimationClip> = new Map(),
  ) {}

  get id(): string {
    return this.manifest.id;
  }

  /** Actors spawned from this asset and not yet disposed. */
  get liveActors(): number {
    return this.live.size;
  }

  spawn(variant = 0): EnemyActor {
    if (this.disposed) throw new Error(`${this.id} asset disposed`);
    const actor = new EnemyActor(this, variant);
    this.live.add(actor);
    return actor;
  }

  dispose(): void {
    this.disposed = true;
    if (this.live.size === 0) this.release();
  }

  /** Called once by each actor's `dispose`. */
  retire(actor: EnemyActor): void {
    this.live.delete(actor);
    if (this.disposed && this.live.size === 0) this.release();
  }

  private release(): void {
    if (this.released) return;
    this.released = true;
    for (const g of this.owned.geometries) g.dispose();
    for (const m of this.owned.materials) m.dispose();
  }
}

/**
 * Builds the asset from GLB bytes. Brass slots take clones of the shared P4-T3 set materials by
 * slot name (their textures stay owned by the set); slots without a set, or a missing set, keep
 * the GLB's factor-only material, which is the load-failure look.
 */
export async function parseEnemyAsset(
  glb: ArrayBuffer,
  manifest: EnemyManifest,
  set: PbrSet | null = null,
): Promise<EnemyAsset> {
  const who = manifest.id;
  const gltf = await new GLTFLoader().parseAsync(glb, '');
  const clips = new Map<EnemyClip, THREE.AnimationClip>();
  for (const name of ENEMY_CLIPS) {
    const clip = gltf.animations.find((a) => a.name === name);
    if (!clip) throw new Error(`${who} glb: clip ${name} missing`);
    clips.set(name, clip);
  }
  let phaseClip: THREE.AnimationClip | null = null;
  if (hasPhaseClip(who)) {
    phaseClip = gltf.animations.find((a) => a.name === PHASE_CLIP) ?? null;
    if (!phaseClip) throw new Error(`${who} glb: clip ${PHASE_CLIP} missing`);
  }
  if (!gltf.scene.getObjectByName(manifest.root)) throw new Error(`${who} glb: root node missing`);
  for (const socket of ENEMY_SOCKETS) {
    if (!manifest.sockets[socket]) continue;
    if (!gltf.scene.getObjectByName(socket)) throw new Error(`${who} glb: ${socket} missing`);
  }

  const bound = new Map<THREE.Material, THREE.Material>();
  const geometries = new Set<THREE.BufferGeometry>();
  const bind = (source: THREE.Material): THREE.Material => {
    const cached = bound.get(source);
    if (cached) return cached;
    const slot = manifest.materialSlots[source.name];
    const shared = slot?.set ? set?.materials.get(slot.set) : undefined;
    const tint = slot?.tint
      ? new THREE.Color().setRGB(...slot.tint, THREE.LinearSRGBColorSpace)
      : null;
    let material: THREE.Material = source;
    if (shared) {
      const clone = shared.clone();
      const s = slot?.normalScale ?? 1;
      clone.normalScale.set(s, s);
      if (tint) clone.color.multiply(tint);
      clone.name = source.name;
      material = clone;
    } else if (tint && source instanceof THREE.MeshStandardMaterial) {
      const clone = source.clone();
      clone.color.multiply(tint);
      material = clone;
    }
    bound.set(source, material);
    return material;
  };
  const glowName = manifest.emissive.material;
  gltf.scene.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    geometries.add(o.geometry);
    if (!Array.isArray(o.material) && o.material.name === glowName) writeGlowIslands(o.geometry);
    o.material = Array.isArray(o.material) ? o.material.map(bind) : bind(o.material);
  });
  const materials = new Set<THREE.Material>([...bound.keys(), ...bound.values()]);
  const moveClips = new Map<IntentClip | MoveActionClip, THREE.AnimationClip>();
  for (const name of [
    ...Object.values(manifest.intentClips ?? {}),
    ...Object.values(manifest.actionClips ?? {}),
  ]) {
    const clip = gltf.animations.find((a) => a.name === name);
    if (!clip) throw new Error(`${who} glb: intent clip ${name} missing`);
    moveClips.set(name, clip);
  }
  for (const [move, timing] of Object.entries(manifest.actionTimings ?? {})) {
    const clip = moveClips.get(manifest.actionClips?.[move] as MoveActionClip);
    if (clip && Math.abs(clip.duration - timing.duration) > 1 / 30)
      throw new Error(`${who} glb: action clip ${move} duration differs from manifest timing`);
  }
  return new EnemyAsset(
    manifest,
    gltf.scene,
    clips,
    { materials: [...materials], geometries: [...geometries] },
    phaseClip,
    moveClips,
  );
}

export interface EnemyLoadOptions {
  /** Directory holding `<id>/<id>.manifest.json`; defaults to {@link ENEMY_ASSET_ROOT}. */
  root?: string;
  /** The shared brass sets, or null to skip them; loaded from `materialsBase` when omitted. */
  materials?: PbrSet | null;
  materialsBase?: string;
  anisotropy?: number;
}

/** Thrown when an id has no model on the server; the caller keeps its capsule without an error. */
export class EnemyAssetMissing extends Error {
  constructor(
    readonly id: string,
    what: string,
  ) {
    super(`${id}: ${what} not shipped`);
    this.name = 'EnemyAssetMissing';
  }
}

const GLB_MAGIC = 0x46546c67;

/**
 * Fetches `<root>/<id>/<id>.manifest.json` and its GLB and binds the shared sets. Throws
 * {@link EnemyAssetMissing} when either file is absent: a 404, or the dev server's HTML fallback
 * for an unknown path. Any other failure (bad JSON contract, corrupt GLB) throws as itself.
 */
export async function loadEnemyAsset(
  id: string,
  options: EnemyLoadOptions = {},
): Promise<EnemyAsset> {
  const base = `${options.root ?? ENEMY_ASSET_ROOT}/${id}`;
  const res = await fetch(`${base}/${id}.manifest.json`);
  const text = res.ok ? await res.text() : '';
  if (!res.ok || !(res.headers.get('content-type') ?? '').includes('json') || /^\s*</.test(text))
    throw new EnemyAssetMissing(id, 'manifest');
  const manifest = parseEnemyManifest(JSON.parse(text), id);
  const [glb, set] = await Promise.all([
    fetch(`${base}/${manifest.glb}`).then(async (r) => {
      const bytes = r.ok ? await r.arrayBuffer() : new ArrayBuffer(0);
      const magic = bytes.byteLength >= 4 ? new DataView(bytes).getUint32(0, true) : 0;
      if (!r.ok || (magic !== GLB_MAGIC && /html/.test(r.headers.get('content-type') ?? '')))
        throw new EnemyAssetMissing(id, 'glb');
      return bytes;
    }),
    options.materials !== undefined
      ? Promise.resolve(options.materials)
      : loadPbrSet(options.materialsBase ?? '/assets/materials', {
          anisotropy: options.anisotropy ?? 4,
        }).catch(() => null),
  ]);
  return parseEnemyAsset(glb, manifest, set);
}

/**
 * {@link loadEnemyAsset} that never rejects: an id that is not shipped logs one `console.info`, one
 * that fails logs one `console.warn`, and either resolves to null so its capsules stay.
 */
export function tryLoadEnemyAsset(
  id: string,
  options: EnemyLoadOptions = {},
): Promise<EnemyAsset | null> {
  return loadEnemyAsset(id, options).catch((error: unknown) => {
    if (error instanceof EnemyAssetMissing) console.info(`${error.message}; capsules kept`);
    else console.warn(`${id} model unavailable, capsules kept`, error);
    return null;
  });
}

/**
 * One {@link tryLoadEnemyAsset} per distinct id, all in parallel, each failing on its own. Every
 * call fetches again, so keep the returned promises for the session.
 */
export function loadEnemyAssets(
  ids: readonly string[],
  options: EnemyLoadOptions = {},
): Map<string, Promise<EnemyAsset | null>> {
  return new Map([...new Set(ids)].map((id) => [id, tryLoadEnemyAsset(id, options)]));
}

export interface EnemyPlayOptions {
  /** Cross-fade seconds from whatever is playing. */
  fade?: number;
  timeScale?: number;
}

interface Fade {
  from: number;
  to: number;
  t: number;
  duration: number;
}

interface MaterialState {
  material: THREE.MeshStandardMaterial;
  color: THREE.Color;
  emissiveIntensity: number;
  glow: boolean;
}

/**
 * One automaton instance: a skinned clone with its own mixer and its own material clones (for the
 * hit flash and the freeze rime). Fades are stepped here rather than by `AnimationAction.fadeIn`,
 * so an interrupted fade blends on from its current weight instead of popping.
 */
export class EnemyActor {
  readonly object: THREE.Object3D;
  readonly mixer: THREE.AnimationMixer;
  /** Called when a clip passes one of its manifest events, such as the attack's `impact`. */
  onEvent: ((event: string, clip: ActorClip) => void) | null = null;
  readonly asset: EnemyAsset;
  /** The head look-at toward the player, or null for a rig without a `head` bone. */
  readonly headLook: HeadLook | null;
  private readonly actions = new Map<ActorClip, THREE.AnimationAction>();
  private readonly fades = new Map<ActorClip, Fade>();
  private readonly materials: MaterialState[] = [];
  private currentClip: ActorClip | null = null;
  private intentPose: IntentClip | null = null;
  /** The case's state: closed until the phase-change clip plays, `changing` while it runs, then open. */
  private casePhase: 'closed' | 'changing' | 'open' = 'closed';
  private phaseChangeCount = 0;
  /** An attack asked for while the case was opening; it plays when the opening ends. */
  private deferredAttack = false;
  private readonly heldBones: { bone: THREE.Object3D; pose: THREE.Quaternion }[] = [];
  private frozenFlag = false;
  private deadFlag = false;
  private disposedFlag = false;
  private flash = 0;
  private death: { promise: Promise<void>; resolve: () => void } | null = null;
  private readonly onFinished = (e: { action: THREE.AnimationAction }): void => {
    const clip = this.clipOf(e.action);
    if (clip === 'death') {
      this.death?.resolve();
    } else if (clip === PHASE_CLIP && clip === this.currentClip && !this.deadFlag) {
      this.casePhase = 'open';
      const attack = this.deferredAttack;
      this.deferredAttack = false;
      this.play(attack ? 'attack' : this.frozenFlag ? 'frozen' : 'idle', { fade: 0.25 });
    } else if (
      (clip === 'attack' || clip === 'hit' || clip?.startsWith('action-')) &&
      clip === this.currentClip &&
      !this.deadFlag
    ) {
      this.play(this.intentPose ?? (this.frozenFlag ? 'frozen' : 'idle'), { fade: 0.25 });
    }
  };

  constructor(asset: EnemyAsset, variant = 0) {
    this.asset = asset;
    this.object = cloneSkinned(asset.template);
    this.object.name = asset.manifest.id;
    if (asset.id === 'furnace-mite') {
      const stripe = this.object.getObjectByName('furnace-mark-extra');
      if (stripe) stripe.visible = variant % 2 !== 0;
    }
    const clones = new Map<THREE.Material, THREE.MeshStandardMaterial>();
    const glowName = asset.manifest.emissive.material;
    const cull = cullSphere(asset.manifest);
    this.object.traverse((o) => {
      if (o instanceof THREE.SkinnedMesh) o.boundingSphere = cull.clone();
      if (!(o instanceof THREE.Mesh) || !(o.material instanceof THREE.MeshStandardMaterial)) return;
      let clone = clones.get(o.material);
      if (!clone) {
        clone = o.material.clone();
        if (asset.id === 'furnace-mite' && clone.name === 'foundry-mark') {
          clone.color.set(variant % 2 === 0 ? '#a52533' : '#fff1c7');
        }
        clones.set(o.material, clone);
        const glow = clone.name === glowName;
        if (glow) applyGlowLook(clone, asset.manifest.emissive.color);
        this.materials.push({
          material: clone,
          color: clone.color.clone(),
          emissiveIntensity: clone.emissiveIntensity,
          glow,
        });
      }
      o.material = clone;
    });
    this.headLook = HeadLook.find(this.object);
    this.mixer = new THREE.AnimationMixer(this.object);
    for (const name of ENEMY_CLIPS) {
      const clip = asset.clips.get(name);
      if (!clip) throw new Error(`${asset.id} clip ${name} missing`);
      const action = this.mixer.clipAction(clip);
      const once = asset.manifest.clips[name].loop === 'once';
      action.setLoop(once ? THREE.LoopOnce : THREE.LoopRepeat, Infinity);
      action.clampWhenFinished = once;
      this.actions.set(name, action);
    }
    for (const [name, clip] of asset.moveClips) {
      const action = this.mixer.clipAction(clip);
      action.setLoop(THREE.LoopOnce, 1);
      action.clampWhenFinished = true;
      this.actions.set(name, action);
    }
    const phase = asset.phaseClip;
    if (phase) {
      const action = this.mixer.clipAction(phase);
      action.setLoop(THREE.LoopOnce, Infinity);
      action.clampWhenFinished = true;
      this.actions.set(PHASE_CLIP, action);
      this.captureHeldPose(phase);
    }
    this.mixer.addEventListener('finished', this.onFinished);
    this.play('idle', { fade: 0 });
  }

  /** The enemy kind this actor plays, its manifest id. */
  get kind(): string {
    return this.asset.manifest.id;
  }
  get state(): ActorClip | null {
    return this.currentClip;
  }
  /** True once the phase-change clip has finished (or the actor died mid-change): the case stays open. */
  get caseOpen(): boolean {
    return this.casePhase === 'open';
  }
  /** True while the phase-change clip is playing. */
  get caseOpening(): boolean {
    return this.casePhase === 'changing';
  }
  /** How many times the phase-change clip has been started on this actor since its last reset. */
  get phaseChanges(): number {
    return this.phaseChangeCount;
  }
  get frozen(): boolean {
    return this.frozenFlag;
  }
  get dead(): boolean {
    return this.deadFlag;
  }
  get disposed(): boolean {
    return this.disposedFlag;
  }

  action(clip: ActorClip): THREE.AnimationAction {
    const action = this.actions.get(clip);
    if (!action) throw new Error(`${this.kind} clip ${clip} missing`);
    return action;
  }

  /** External locomotion clips participate in the same fades and interruptions as combat actions. */
  bindPatrolClip(name: PatrolClipName, clip: THREE.AnimationClip): void {
    this.actions.set(name, this.mixer.clipAction(clip));
  }

  /** Hold the advertised move between reactions, until the next intent is revealed. */
  showIntent(id: string | null): void {
    const pose = (id && this.asset.manifest.intentClips?.[id]) || null;
    if (this.intentPose === pose) return;
    this.intentPose = pose;
    if (
      this.deadFlag ||
      this.currentClip === 'attack' ||
      this.currentClip === 'hit' ||
      this.currentClip?.startsWith('action-')
    )
      return;
    this.play(pose ?? (this.frozenFlag ? 'frozen' : 'idle'), { fade: 0.15 });
  }

  socket(name: EnemySocket): THREE.Object3D | undefined {
    return this.object.getObjectByName(name);
  }

  /** Starts `clip`, cross-fading every other running clip out from its current weight. */
  play(clip: ActorClip, options: EnemyPlayOptions = {}): THREE.AnimationAction {
    const next = this.action(clip);
    if (this.disposedFlag) return next;
    const fade = Math.max(0, options.fade ?? 0.2);
    if (clip !== 'frozen' && this.frozenFlag) this.setRime(false);
    for (const [name, action] of this.actions) {
      if (name === clip || !action.isScheduled()) continue;
      const w = action.getEffectiveWeight();
      if (fade === 0 || w === 0) {
        action.stop();
        this.fades.delete(name);
      } else {
        this.fades.set(name, { from: w, to: 0, t: 0, duration: fade });
      }
    }
    next.reset();
    next.setEffectiveTimeScale(options.timeScale ?? 1);
    next.setEffectiveWeight(fade === 0 ? 1 : 0);
    next.play();
    if (fade === 0) this.fades.delete(clip);
    else this.fades.set(clip, { from: 0, to: 1, t: 0, duration: fade });
    this.currentClip = clip;
    return next;
  }

  attack(moveId?: string): void {
    if (this.deadFlag) return;
    // The case finishes opening first; the swing follows it.
    if (this.casePhase === 'changing') this.deferredAttack = true;
    else this.play(this.clipForMove(moveId ?? null), { fade: 0.15 });
  }

  hasAction(moveId: string | null): boolean {
    return moveId !== null && this.asset.manifest.actionClips?.[moveId] !== undefined;
  }

  clipForMove(moveId: string | null): ActorClip {
    return (moveId && this.asset.manifest.actionClips?.[moveId]) || 'attack';
  }

  timingForMove(moveId: string | null): EnemyActionTiming {
    const authored = moveId ? this.asset.manifest.actionTimings?.[moveId] : undefined;
    if (authored) return authored;
    const attack = this.asset.manifest.clips.attack;
    return { duration: attack.duration, impact: attack.events.impact ?? attack.duration / 2 };
  }

  /** Hit reaction: interrupts anything but death, flashes the emissive core. The case opening is never cut short. */
  hit(): void {
    if (this.deadFlag) return;
    if (this.casePhase !== 'changing') this.play('hit', { fade: 0.06 });
    this.flash = 1;
  }

  /**
   * Starts phase 2: plays the phase-change clip once, after which the case stays open. Does nothing
   * for a model without the clip, a dead actor, or a case already opening or open.
   */
  openCase(): void {
    if (!this.asset.phaseClip || this.deadFlag || this.casePhase !== 'closed') return;
    if (this.frozenFlag) this.setRime(false);
    this.casePhase = 'changing';
    this.phaseChangeCount += 1;
    this.play(PHASE_CLIP, { fade: 0.2 });
  }

  /** The time-freeze pose: blends into the held `frozen` clip and rimes the plates. */
  freeze(): void {
    if (this.deadFlag || this.frozenFlag) return;
    if (this.casePhase === 'changing') this.casePhase = 'open';
    this.play('frozen', { fade: 0.35 });
    this.setRime(true);
  }

  unfreeze(): void {
    if (!this.frozenFlag) return;
    this.setRime(false);
    if (!this.deadFlag) this.play('idle', { fade: 0.35 });
  }

  /** Plays death once; resolves when the clip ends, lying on the floor (or on reset/dispose). */
  die(): Promise<void> {
    if (this.death) return this.death.promise;
    let resolve: () => void = () => {};
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    this.death = { promise, resolve };
    if (this.frozenFlag) this.setRime(false);
    if (this.casePhase === 'changing') this.casePhase = 'open';
    this.deadFlag = true;
    this.play('death', { fade: 0.15 });
    return promise;
  }

  /**
   * Steps fades, clips and the hit flash by `dt` seconds. `lookAt`, the player's head in world
   * space, turns the head toward it while it stands in front of the body; null eases the head back
   * to the animated pose, as death and the freeze always do.
   */
  update(dt: number, lookAt: THREE.Vector3 | null = null): void {
    if (this.disposedFlag || !(dt >= 0)) return;
    for (const [name, f] of this.fades) {
      const action = this.action(name);
      f.t = Math.min(f.duration, f.t + dt);
      const k = f.t / f.duration;
      const s = k * k * (3 - 2 * k);
      action.setEffectiveWeight(f.from + (f.to - f.from) * s);
      if (f.t >= f.duration) {
        this.fades.delete(name);
        if (f.to === 0) action.stop();
      }
    }
    const current = this.currentClip ? this.action(this.currentClip) : null;
    const before = current ? current.time : 0;
    this.mixer.update(dt);
    this.holdCaseOpen();
    this.headLook?.update(dt, lookAt, !this.deadFlag && !this.frozenFlag);
    if (current && this.currentClip && this.onEvent) {
      const events = this.eventsOf(this.currentClip);
      for (const [event, at] of Object.entries(events)) {
        if (before < at && current.time >= at) this.onEvent(event, this.currentClip);
      }
    }
    if (this.flash > 0) {
      this.flash = Math.max(0, this.flash - dt * FLASH_DECAY);
      this.applyGlow();
    }
  }

  /** Returns the actor to a fresh idle state for pool reuse; the transform is the caller's. */
  reset(): void {
    if (this.disposedFlag) return;
    this.mixer.stopAllAction();
    this.fades.clear();
    this.death?.resolve();
    this.death = null;
    this.deadFlag = false;
    this.casePhase = 'closed';
    this.phaseChangeCount = 0;
    this.deferredAttack = false;
    this.flash = 0;
    this.setRime(false);
    this.applyGlow();
    this.currentClip = null;
    this.intentPose = null;
    this.headLook?.reset();
    this.play('idle', { fade: 0 });
    this.mixer.update(0);
  }

  /** Releases the mixer, its listener and this instance's materials; shared geometry stays. */
  dispose(): void {
    if (this.disposedFlag) return;
    this.mixer.stopAllAction();
    this.mixer.removeEventListener('finished', this.onFinished);
    for (const clip of this.asset.clips.values()) this.mixer.uncacheClip(clip);
    this.mixer.uncacheRoot(this.object);
    this.fades.clear();
    this.object.traverse((o) => {
      if (o instanceof THREE.SkinnedMesh) o.skeleton.dispose();
    });
    for (const m of this.materials) m.material.dispose();
    this.materials.length = 0;
    this.object.removeFromParent();
    this.death?.resolve();
    this.death = null;
    this.onEvent = null;
    this.currentClip = null;
    this.disposedFlag = true;
    this.asset.retire(this);
  }

  private eventsOf(clip: ActorClip): Record<string, number> {
    if (clip.startsWith('action-')) {
      const move = clip.slice('action-'.length);
      const timing = this.asset.manifest.actionTimings?.[move];
      return timing ? { impact: timing.impact } : this.asset.manifest.clips.attack.events;
    }
    const specs = this.asset.manifest.clips as Partial<Record<ActorClip, EnemyClipSpec>>;
    return specs[clip]?.events ?? {};
  }

  /** Reads each held bone's rotation at the phase-change clip's last keyframe. */
  private captureHeldPose(phase: THREE.AnimationClip): void {
    for (const name of PHASE_HELD_BONES) {
      const bone =
        this.object.getObjectByName(THREE.PropertyBinding.sanitizeNodeName(name)) ??
        this.object.getObjectByName(name);
      const track = bone && phase.tracks.find((t) => t.name === `${bone.name}.quaternion`);
      if (!bone || !track || track.values.length < 4) continue;
      const pose = new THREE.Quaternion().fromArray(track.values, track.values.length - 4);
      this.heldBones.push({ bone, pose: pose.normalize() });
    }
  }

  /** After the mixer, keeps the case's hinge bones in the phase-change pose (see `PHASE_HELD_BONES`). */
  private holdCaseOpen(): void {
    if (this.casePhase !== 'open') return;
    for (const { bone, pose } of this.heldBones) bone.quaternion.copy(pose);
  }

  private clipOf(action: THREE.AnimationAction): ActorClip | null {
    for (const [name, a] of this.actions) if (a === action) return name;
    return null;
  }

  private setRime(on: boolean): void {
    this.frozenFlag = on;
    for (const m of this.materials) {
      if (m.glow) continue;
      if (on) rimeColor(m.color, m.material.color);
      else m.material.color.copy(m.color);
    }
    this.applyGlow();
  }

  private applyGlow(): void {
    for (const m of this.materials) {
      if (!m.glow) continue;
      const base = m.emissiveIntensity * (this.frozenFlag ? RIME_GLOW : 1);
      m.material.emissiveIntensity = base + this.flash * HIT_FLASH;
    }
  }
}
