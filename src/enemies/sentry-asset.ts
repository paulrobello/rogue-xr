import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { loadPbrSet, type PbrSet } from '../world/materials.ts';

/**
 * Runtime contract of `public/assets/enemies/cog-sentry/` (scripts/assets/build-cog-sentry.py).
 * The root sits at the feet and the sentry faces local -Z, so `rotation.y = -heading` (as
 * src/combat/encounter.ts sets it) turns it toward the heading. Root motion is code-owned: every
 * clip plays in place.
 */
export const SENTRY_ASSET_BASE = '/assets/enemies/cog-sentry';
export const SENTRY_CLIPS = ['idle', 'attack', 'hit', 'death', 'frozen'] as const;
export type SentryClip = (typeof SENTRY_CLIPS)[number];
export const SENTRY_SOCKETS = ['socket-hit', 'socket-eye', 'socket-weapon'] as const;
export type SentrySocket = (typeof SENTRY_SOCKETS)[number];

export interface SentryClipSpec {
  duration: number;
  loop: 'repeat' | 'once';
  events: Record<string, number>;
  held?: boolean;
  endsOnFloor?: boolean;
}

export interface SentryMaterialSlot {
  set: string | null;
  factorOnly?: boolean;
  emissive?: boolean;
  tileMeters?: number;
  normalScale?: number;
}

export interface SentryManifest {
  id: string;
  version: number;
  glb: string;
  frame: { units: string; up: string; forward: string; origin: string };
  root: string;
  mesh: string;
  bounds: { min: number[]; max: number[] };
  skeleton: { root: string; bones: number; joints: string[]; maxInfluences: number };
  rootMotion: string;
  clips: Record<SentryClip, SentryClipSpec>;
  sockets: Record<SentrySocket, { bone: string; parent: string | null; position: number[] }>;
  emissive: { material: string; color: string; intensity: number; nodes: string[] };
  materialSlots: Record<string, SentryMaterialSlot>;
  budget: { tris: number; materials: number; bones: number; influences: number };
}

export function parseSentryManifest(raw: unknown): SentryManifest {
  const m = raw as Partial<SentryManifest>;
  if (typeof m !== 'object' || m === null) throw new Error('sentry manifest: expected an object');
  if (typeof m.glb !== 'string' || typeof m.root !== 'string')
    throw new Error('sentry manifest: glb or root missing');
  if (m.frame?.forward !== '-Z') throw new Error('sentry manifest: forward must be -Z');
  for (const clip of SENTRY_CLIPS) {
    const spec = m.clips?.[clip];
    if (!spec || !(spec.duration > 0) || (spec.loop !== 'repeat' && spec.loop !== 'once')) {
      throw new Error(`sentry manifest: clip ${clip} missing or invalid`);
    }
  }
  for (const socket of SENTRY_SOCKETS) {
    if (m.sockets?.[socket]?.position?.length !== 3)
      throw new Error(`sentry manifest: socket ${socket} missing`);
  }
  if (!m.materialSlots || !m.emissive?.material)
    throw new Error('sentry manifest: materialSlots or emissive missing');
  return m as SentryManifest;
}

/** Radius that covers every clip, the lying death pose included, around (0, 1, 0). */
const CULL_RADIUS = 1.7;
/** Pale rime tint the plates take on while frozen, and how far toward it they move. */
const RIME = new THREE.Color('#cfd8dc');
const RIME_MIX = 0.22;
const RIME_GLOW = 0.3;
const HIT_FLASH = 2.5;
const FLASH_DECAY = 6;

interface Owned {
  materials: THREE.Material[];
  geometries: THREE.BufferGeometry[];
}

/**
 * One loaded sentry: the template scene, its clips, and the resources every actor shares
 * (geometry, skeleton template, the bound slot materials). `spawn()` builds pooled actors;
 * `dispose()` releases the shared resources once no actor uses them.
 */
export class SentryAsset {
  private disposed = false;

  constructor(
    readonly manifest: SentryManifest,
    readonly template: THREE.Object3D,
    readonly clips: ReadonlyMap<SentryClip, THREE.AnimationClip>,
    private readonly owned: Owned,
  ) {}

  spawn(): SentryActor {
    if (this.disposed) throw new Error('sentry asset disposed');
    return new SentryActor(this);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const g of this.owned.geometries) g.dispose();
    for (const m of this.owned.materials) m.dispose();
  }
}

/**
 * Builds the asset from GLB bytes. Brass slots take clones of the shared P4-T3 set materials by
 * slot name (their textures stay owned by the set); slots without a set, or a missing set, keep
 * the GLB's factor-only material, which is the load-failure look.
 */
export async function parseSentry(
  glb: ArrayBuffer,
  manifest: SentryManifest,
  set: PbrSet | null = null,
): Promise<SentryAsset> {
  const gltf = await new GLTFLoader().parseAsync(glb, '');
  const clips = new Map<SentryClip, THREE.AnimationClip>();
  for (const name of SENTRY_CLIPS) {
    const clip = gltf.animations.find((a) => a.name === name);
    if (!clip) throw new Error(`sentry glb: clip ${name} missing`);
    clips.set(name, clip);
  }
  if (!gltf.scene.getObjectByName(manifest.root)) throw new Error('sentry glb: root node missing');
  for (const socket of SENTRY_SOCKETS) {
    if (!gltf.scene.getObjectByName(socket)) throw new Error(`sentry glb: ${socket} missing`);
  }

  const bound = new Map<THREE.Material, THREE.Material>();
  const geometries = new Set<THREE.BufferGeometry>();
  const bind = (source: THREE.Material): THREE.Material => {
    const cached = bound.get(source);
    if (cached) return cached;
    const slot = manifest.materialSlots[source.name];
    const shared = slot?.set ? set?.materials.get(slot.set) : undefined;
    let material: THREE.Material = source;
    if (shared) {
      const clone = shared.clone();
      const s = slot?.normalScale ?? 1;
      clone.normalScale.set(s, s);
      clone.name = source.name;
      material = clone;
    }
    bound.set(source, material);
    return material;
  };
  gltf.scene.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    geometries.add(o.geometry);
    o.material = Array.isArray(o.material) ? o.material.map(bind) : bind(o.material);
  });
  const materials = new Set<THREE.Material>([...bound.keys(), ...bound.values()]);
  return new SentryAsset(manifest, gltf.scene, clips, {
    materials: [...materials],
    geometries: [...geometries],
  });
}

/** Fetches the manifest and GLB and binds the shared sets (pass `materials: null` to skip them). */
export async function loadSentry(
  options: {
    base?: string;
    materials?: PbrSet | null;
    materialsBase?: string;
    anisotropy?: number;
  } = {},
): Promise<SentryAsset> {
  const base = options.base ?? SENTRY_ASSET_BASE;
  const manifest = parseSentryManifest(
    await (await fetch(`${base}/cog-sentry.manifest.json`)).json(),
  );
  const [glb, set] = await Promise.all([
    fetch(`${base}/${manifest.glb}`).then((r) => {
      if (!r.ok) throw new Error(`sentry glb: HTTP ${r.status}`);
      return r.arrayBuffer();
    }),
    options.materials !== undefined
      ? Promise.resolve(options.materials)
      : loadPbrSet(options.materialsBase ?? '/assets/materials', {
          anisotropy: options.anisotropy ?? 4,
        }).catch(() => null),
  ]);
  return parseSentry(glb, manifest, set);
}

export interface SentryPlayOptions {
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
 * One sentry instance: a skinned clone with its own mixer and its own material clones (for the
 * hit flash and the freeze rime). Fades are stepped here rather than by `AnimationAction.fadeIn`,
 * so an interrupted fade blends on from its current weight instead of popping.
 */
export class SentryActor {
  readonly object: THREE.Object3D;
  readonly mixer: THREE.AnimationMixer;
  /** Called when a clip passes one of its manifest events, such as the attack's `impact`. */
  onEvent: ((event: string, clip: SentryClip) => void) | null = null;
  private readonly asset: SentryAsset;
  private readonly actions = new Map<SentryClip, THREE.AnimationAction>();
  private readonly fades = new Map<SentryClip, Fade>();
  private readonly materials: MaterialState[] = [];
  private currentClip: SentryClip | null = null;
  private frozenFlag = false;
  private deadFlag = false;
  private disposedFlag = false;
  private flash = 0;
  private death: { promise: Promise<void>; resolve: () => void } | null = null;
  private readonly onFinished = (e: { action: THREE.AnimationAction }): void => {
    const clip = this.clipOf(e.action);
    if (clip === 'death') {
      this.death?.resolve();
    } else if (
      (clip === 'attack' || clip === 'hit') &&
      clip === this.currentClip &&
      !this.deadFlag
    ) {
      this.play(this.frozenFlag ? 'frozen' : 'idle', { fade: 0.25 });
    }
  };

  constructor(asset: SentryAsset) {
    this.asset = asset;
    this.object = cloneSkinned(asset.template);
    this.object.name = asset.manifest.id;
    const clones = new Map<THREE.Material, THREE.MeshStandardMaterial>();
    const glowName = asset.manifest.emissive.material;
    this.object.traverse((o) => {
      if (o instanceof THREE.SkinnedMesh) {
        o.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 1, 0), CULL_RADIUS);
      }
      if (!(o instanceof THREE.Mesh) || !(o.material instanceof THREE.MeshStandardMaterial)) return;
      let clone = clones.get(o.material);
      if (!clone) {
        clone = o.material.clone();
        clones.set(o.material, clone);
        this.materials.push({
          material: clone,
          color: clone.color.clone(),
          emissiveIntensity: clone.emissiveIntensity,
          glow: clone.name === glowName,
        });
      }
      o.material = clone;
    });
    this.mixer = new THREE.AnimationMixer(this.object);
    for (const name of SENTRY_CLIPS) {
      const clip = asset.clips.get(name);
      if (!clip) throw new Error(`sentry clip ${name} missing`);
      const action = this.mixer.clipAction(clip);
      const once = asset.manifest.clips[name].loop === 'once';
      action.setLoop(once ? THREE.LoopOnce : THREE.LoopRepeat, Infinity);
      action.clampWhenFinished = once;
      this.actions.set(name, action);
    }
    this.mixer.addEventListener('finished', this.onFinished);
    this.play('idle', { fade: 0 });
  }

  get state(): SentryClip | null {
    return this.currentClip;
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

  action(clip: SentryClip): THREE.AnimationAction {
    const action = this.actions.get(clip);
    if (!action) throw new Error(`sentry clip ${clip} missing`);
    return action;
  }

  socket(name: SentrySocket): THREE.Object3D | undefined {
    return this.object.getObjectByName(name);
  }

  /** Starts `clip`, cross-fading every other running clip out from its current weight. */
  play(clip: SentryClip, options: SentryPlayOptions = {}): THREE.AnimationAction {
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

  attack(): void {
    if (!this.deadFlag) this.play('attack', { fade: 0.15 });
  }

  /** Hit reaction: interrupts anything but death, flashes the amber core and eyes. */
  hit(): void {
    if (this.deadFlag) return;
    this.play('hit', { fade: 0.06 });
    this.flash = 1;
  }

  /** The time-freeze pose: blends into the held `frozen` clip and rimes the brass. */
  freeze(): void {
    if (this.deadFlag || this.frozenFlag) return;
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
    this.deadFlag = true;
    this.play('death', { fade: 0.15 });
    return promise;
  }

  update(dt: number): void {
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
    if (current && this.currentClip && this.onEvent) {
      const events = this.asset.manifest.clips[this.currentClip].events;
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
    this.flash = 0;
    this.setRime(false);
    this.applyGlow();
    this.currentClip = null;
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
    for (const m of this.materials) m.material.dispose();
    this.materials.length = 0;
    this.object.removeFromParent();
    this.death?.resolve();
    this.death = null;
    this.onEvent = null;
    this.currentClip = null;
    this.disposedFlag = true;
  }

  private clipOf(action: THREE.AnimationAction): SentryClip | null {
    for (const [name, a] of this.actions) if (a === action) return name;
    return null;
  }

  private setRime(on: boolean): void {
    this.frozenFlag = on;
    for (const m of this.materials) {
      if (m.glow) continue;
      m.material.color.copy(m.color);
      if (on) m.material.color.lerp(RIME, RIME_MIX);
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
