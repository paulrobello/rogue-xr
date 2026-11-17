import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import type { Stream } from '../core/rng.ts';
import { PALETTE } from '../palette.ts';
import { onFirstRender, sharedKtx2Loader } from '../ui/first-render.ts';
import {
  type DieFaceSet,
  dieFace,
  loadUiAtlas,
  UI_ATLAS_BASE,
  type UiAtlasManifest,
} from '../ui/icon-atlas.ts';
import { DICE_GLOW_INTENSITY, type DiceAsset } from './dice-asset.ts';
import { D6_HALF_EXTENT, D8_CIRCUMRADIUS, type DieKind, faceNormals } from './faces.ts';
import { DiceWorld, type DiceWorldOptions } from './world.ts';

/** A die that came to rest showing the engine's face. */
export interface PresentedRoll {
  readonly id: string;
  readonly kind: DieKind;
  /** Face index showing up; always the face the throw was given. */
  readonly face: number;
  /** The value printed on that face. */
  readonly value: number;
  readonly forced: boolean;
  /** True when the die landed off its look-ahead and the settle correction turned the face. */
  readonly fallback: boolean;
}

export type PresentedListener = (roll: PresentedRoll) => void;

export interface DicePresenterOptions {
  /** Inner tray half extents, metres, matching the visible tray. */
  halfX: number;
  halfZ: number;
  /** Values printed on face `i` per kind, for the result label and the d6 face numbers. */
  faces?: Partial<Record<DieKind, readonly number[]>>;
  /**
   * The authored dice models. Null or absent keeps the greybox dice. The presenter never disposes
   * them: the owner loads them once, shares them across fights and calls `models.dispose()`.
   */
  models?: DiceAsset | null;
  /**
   * The room's reflection probe (main.ts `heroEnv`, the one the table and automatons reflect). The
   * dice materials take it at `DICE_ENV_INTENSITY`; `scene.environment` stays unset so the baked
   * rooms are not relit. Absent, the dice fall back to a probe of their own on first render.
   */
  envMap?: THREE.Texture | null;
}

/**
 * Reflection strength of the room probe on the authored dice. At 0 the metal body reads black in the
 * tray (no `scene.environment`); 0.35 puts the brass between the table's ring and gear brass. Each
 * manifest slot's `envMapScale` multiplies it (`DiceAsset.setEnvironment`).
 */
export const DICE_ENV_INTENSITY = 0.35;

const probes = new WeakMap<THREE.WebGLRenderer, THREE.Texture>();

/** A dim neutral room probe per renderer, the same one the table and sentry reflect. */
function roomProbe(renderer: THREE.WebGLRenderer): THREE.Texture {
  let probe = probes.get(renderer);
  if (!probe) {
    const pmrem = new THREE.PMREMGenerator(renderer);
    probe = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();
    probes.set(renderer, probe);
  }
  return probe;
}

/** BoxGeometry material groups are +X, -X, +Y, -Y, +Z, -Z; this is the D6 face index on each. */
const BOX_GROUP_FACE = [1, 4, 0, 5, 2, 3] as const;
const RESULT_LIFT = 0.07;
/** A die waiting to be thrown hovers this high over the tray floor, tray metres. */
export const WAITING_LIFT = 0.05;
/** The waiting die's pulse: one swell of its halo and scale every this many seconds. */
export const WAITING_PULSE_SECONDS = 1.1;
const WAITING_SPIN = 0.9;
const WAITING_SWELL = 0.14;
const HALO_INNER = 0.035;
const HALO_OUTER = 0.06;
/** A die thrown from the hand starts inside this fraction of the tray, and this high at most. */
const HAND_START_INSET = 0.8;
const HAND_START_TOP = 0.25;

function canvas2d(size: number): CanvasRenderingContext2D | null {
  if (typeof document === 'undefined') return null;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    return canvas.getContext('2d');
  } catch {
    return null;
  }
}

/** The UI atlas die each presenter kind wears. */
export const DIE_ATLAS_ID = { d6: 'brass-d6', d8: 'glass-d8' } as const satisfies Record<
  DieKind,
  string
>;

/**
 * UVs for a `BoxGeometry` (4 vertices per group, groups +X, -X, +Y, -Y, +Z, -Z, each spanning 0..1)
 * that put the atlas face of `BOX_GROUP_FACE[group]` on each side, so face index `i` of
 * `faces.ts` shows the atlas face with index `i`.
 */
export function d6FaceUvs(set: DieFaceSet, unit: ArrayLike<number>): Float32Array {
  const out = new Float32Array(unit.length);
  BOX_GROUP_FACE.forEach((face, group) => {
    const uv = set.faces.find((f) => f.index === face)?.uv;
    if (!uv) throw new RangeError(`${set.kind} atlas has no face ${face}`);
    for (let v = group * 4; v < group * 4 + 4; v++) {
      out[v * 2] = uv.u0 + (unit[v * 2] as number) * (uv.u1 - uv.u0);
      out[v * 2 + 1] = uv.v0 + (unit[v * 2 + 1] as number) * (uv.v1 - uv.v0);
    }
  });
  return out;
}

/**
 * UVs for a non-indexed octahedron (3 vertices per triangle, counter-clockwise from outside): each
 * triangle is matched to its `faces.ts` face by normal and gets that face's atlas triangle, corners
 * assigned apex, bottom-left, bottom-right so the UV winding matches the mesh and numerals are not
 * mirrored.
 */
export function d8FaceUvs(set: DieFaceSet, positions: ArrayLike<number>): Float32Array {
  const corners = set.triangle;
  if (corners?.length !== 3) throw new RangeError('d8 atlas needs a face triangle');
  const [apex, right, left] = corners as readonly (readonly [number, number])[];
  const order = [apex, left, right] as const;
  const normals = faceNormals('d8');
  const out = new Float32Array((positions.length / 3) * 2);
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  for (let t = 0; t < positions.length / 9; t++) {
    a.fromArray(positions as number[], t * 9);
    b.fromArray(positions as number[], t * 9 + 3);
    c.fromArray(positions as number[], t * 9 + 6);
    const n = b.clone().sub(a).cross(c.clone().sub(a)).normalize();
    let face = 0;
    let best = Number.NEGATIVE_INFINITY;
    normals.forEach((m, i) => {
      const d = n.x * m.x + n.y * m.y + n.z * m.z;
      if (d > best) {
        best = d;
        face = i;
      }
    });
    const uv = set.faces.find((f) => f.index === face)?.uv;
    if (!uv) throw new RangeError(`d8 atlas has no face ${face}`);
    order.forEach(([tx, ty], k) => {
      out[(t * 3 + k) * 2] = uv.u0 + tx * (uv.u1 - uv.u0);
      out[(t * 3 + k) * 2 + 1] = uv.v1 - ty * (uv.v1 - uv.v0);
    });
  }
  return out;
}

/** The face index of `kind` that `faces.ts` maps to `value`, and its atlas entry. */
export function atlasFaceFor(manifest: UiAtlasManifest, kind: DieKind, faceIndex: number) {
  return dieFace(manifest, DIE_ATLAS_ID[kind], faceIndex);
}

/** The dice colour pages and their optional glow (emissive mask) pages. */
export interface DiePages {
  manifest: UiAtlasManifest;
  d6: THREE.Texture;
  d8: THREE.Texture;
  d6Glow?: THREE.Texture | null;
  d8Glow?: THREE.Texture | null;
}

let diePages: Promise<DiePages> | null = null;

/**
 * Loads the UI atlas manifest and both dice pages once (KTX2), shared by every presenter. A glow
 * page that is missing or fails to load leaves its die unlit rather than dropping the faces.
 */
function loadDiePages(renderer: THREE.WebGLRenderer) {
  if (!diePages) {
    diePages = (async () => {
      const manifest = await loadUiAtlas();
      const loader = sharedKtx2Loader(renderer);
      const page = async (name: string) => {
        const entry = manifest.pages[name];
        if (!entry?.ktx2) throw new Error(`UI atlas page ${name} has no KTX2`);
        const texture = await loader.loadAsync(`${UI_ATLAS_BASE}/${entry.ktx2}`);
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.anisotropy = 4;
        texture.minFilter = THREE.LinearMipmapLinearFilter;
        return texture;
      };
      const glow = (set: DieFaceSet | undefined) => {
        const name = set?.glowPage;
        if (!name) return Promise.resolve(null);
        return page(name).catch((error: unknown) => {
          console.warn(`dice glow page ${name} failed to load`, error);
          return null;
        });
      };
      const [d6, d8, d6Glow, d8Glow] = await Promise.all([
        page('dice-d6'),
        page('dice-d8'),
        glow(manifest.dice['brass-d6']),
        glow(manifest.dice['glass-d8']),
      ]);
      return { manifest, d6, d8, d6Glow, d8Glow };
    })();
    diePages.catch(() => {
      diePages = null;
    });
  }
  return diePages;
}

const whitePixel = (): THREE.Texture => {
  const texture = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  texture.needsUpdate = true;
  return texture;
};

/** A small floating number above a settled die, so the result reads from the seat. */
function resultSprite(value: number): THREE.Sprite | null {
  const ctx = canvas2d(128);
  if (!ctx) return null;
  ctx.fillStyle = 'rgba(18,12,7,0.85)';
  ctx.beginPath();
  ctx.arc(64, 64, 58, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = PALETTE.candle;
  ctx.font = 'bold 76px serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(value), 64, 70);
  const texture = new THREE.CanvasTexture(ctx.canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: texture, depthTest: false, toneMapped: false }),
  );
  sprite.scale.setScalar(0.06);
  sprite.renderOrder = 10;
  return sprite;
}

function buildD8Geometry(): THREE.BufferGeometry {
  const geometry = new THREE.OctahedronGeometry(D8_CIRCUMRADIUS, 0);
  geometry.computeVertexNormals();
  return geometry;
}

/** The die that sits in the tray waiting for the player, before its throw. */
interface Waiting {
  readonly mesh: THREE.Mesh;
  readonly kind: DieKind;
  /** Seconds since it appeared, the pulse clock. */
  age: number;
  /** Tray-local point the hand holds it at, or null while it rests in the tray. */
  held: THREE.Vector3 | null;
}

interface Entry {
  mesh: THREE.Mesh;
  kind: DieKind;
  face: number;
  value: number;
  label: THREE.Sprite | null;
}

/**
 * Renders the physical dice in the tray. The rules have already rolled (D1); `throw` only presents
 * that face: a seeded impulse from `stream` (never `Math.random`) throws the die into a `DiceWorld`,
 * which numbers the die at the throw so the face it comes to rest on shows the engine's face. `root` is tray-local metres
 * with the tray floor at y = 0 and -Z toward the enemies; the caller places it on the table.
 */
export class DicePresenter {
  readonly root = new THREE.Group();
  private readonly world: DiceWorld;
  private readonly stream: Stream;
  private readonly options: DicePresenterOptions;
  private readonly dice = new Map<string, Entry>();
  private readonly listeners = new Set<PresentedListener>();
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly materials: THREE.Material[] = [];
  private readonly textures: THREE.Texture[] = [];
  private readonly blank: THREE.Texture;
  private readonly d6Material: THREE.MeshStandardMaterial;
  private readonly d8Material: THREE.MeshStandardMaterial;
  private facesRequested = false;
  private readonly d6Geometry: THREE.BufferGeometry;
  private readonly d8Geometry: THREE.BufferGeometry;
  private readonly offSettled: () => void;
  private readonly halo: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  private waitingDie: Waiting | null = null;
  private count = 0;
  private disposed = false;

  private constructor(world: DiceWorld, stream: Stream, options: DicePresenterOptions) {
    this.world = world;
    this.stream = stream;
    this.options = options;
    this.root.name = 'dice-presenter';
    this.d6Geometry = new THREE.BoxGeometry(
      D6_HALF_EXTENT * 2,
      D6_HALF_EXTENT * 2,
      D6_HALF_EXTENT * 2,
    );
    // One material per die (one draw): the faces are regions of the UI atlas dice pages, mapped
    // by UV. Until the pages load, the dice are plain brass and sapphire with a white map, so the
    // texture swap does not recompile the program.
    this.d6Geometry.clearGroups();
    this.d8Geometry = buildD8Geometry();
    this.geometries.push(this.d6Geometry, this.d8Geometry);
    const blank = whitePixel();
    this.blank = blank;
    this.textures.push(blank);
    this.d6Material = new THREE.MeshStandardMaterial({
      color: PALETTE.brass,
      map: blank,
      emissiveMap: blank,
      emissive: '#000000',
      metalness: 0.6,
      roughness: 0.35,
    });
    this.d8Material = new THREE.MeshStandardMaterial({
      color: PALETTE.sapphire,
      map: blank,
      emissiveMap: blank,
      emissive: '#000000',
      metalness: 0.1,
      roughness: 0.15,
      flatShading: true,
    });
    this.materials.push(this.d6Material, this.d8Material);
    // The waiting die's pulsing ring, drawn flat on the tray floor; its own resources, so the
    // shared dice materials never change.
    const haloGeometry = new THREE.RingGeometry(HALO_INNER, HALO_OUTER, 40);
    haloGeometry.rotateX(-Math.PI / 2);
    const haloMaterial = new THREE.MeshBasicMaterial({
      color: PALETTE.candle,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    });
    this.halo = new THREE.Mesh(haloGeometry, haloMaterial);
    this.halo.name = 'dice-waiting-halo';
    this.halo.position.y = 0.002;
    this.halo.visible = false;
    this.root.add(this.halo);
    this.geometries.push(haloGeometry);
    this.materials.push(haloMaterial);
    const env = options.envMap;
    if (env) {
      for (const material of [this.d6Material, this.d8Material]) {
        material.envMap = env;
        material.envMapIntensity = DICE_ENV_INTENSITY;
      }
      options.models?.setEnvironment(env, DICE_ENV_INTENSITY);
    }
    this.offSettled = world.onSettled((event) => {
      const entry = this.dice.get(event.id);
      if (!entry) return;
      this.copyPose(event.id);
      const label = resultSprite(entry.value);
      if (label) {
        label.position.copy(entry.mesh.position).setY(entry.mesh.position.y + RESULT_LIFT);
        this.root.add(label);
        entry.label = label;
      }
      const roll: PresentedRoll = {
        id: event.id,
        kind: event.kind,
        face: event.face,
        value: entry.value,
        forced: event.forced,
        fallback: event.fallback,
      };
      for (const listener of [...this.listeners]) listener(roll);
    });
  }

  static async create(
    stream: Stream,
    options: DicePresenterOptions,
    world?: Partial<DiceWorldOptions>,
  ): Promise<DicePresenter> {
    const physics = await DiceWorld.create({
      halfX: options.halfX,
      halfZ: options.halfZ,
      ...world,
    });
    return new DicePresenter(physics, stream, options);
  }

  onSettled(listener: PresentedListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** True while any thrown die is still rolling or correcting. */
  get rolling(): boolean {
    return this.dice.size > 0 && !this.world.allDone;
  }

  /** The die's mesh, for tests and effects. */
  mesh(id: string): THREE.Mesh | undefined {
    return this.dice.get(id)?.mesh;
  }

  /** The die waiting to be thrown, or null. */
  get waiting(): THREE.Object3D | null {
    return this.waitingDie?.mesh ?? null;
  }

  /** The waiting die's pulse, 0 to 1 (0 when none waits): its halo opacity, for checks. */
  get pulse(): number {
    return this.waitingDie ? this.halo.material.opacity : 0;
  }

  /**
   * Clears the tray and sets a die of `kind` hovering in it, pulsing, until `throw` (or `clear`):
   * the cue that the player must throw it.
   */
  showWaiting(kind: DieKind): void {
    if (this.disposed) return;
    this.clear();
    const mesh = this.spawnMesh(kind, 'die-waiting');
    mesh.position.set(0, WAITING_LIFT, 0);
    this.root.add(mesh);
    this.waitingDie = { mesh, kind, age: 0, held: null };
    this.halo.visible = true;
    this.stepWaiting(0);
  }

  /**
   * Holds the waiting die at tray-local `point` (the main hand), or back in the tray for null. A
   * throw then starts from where the hand let go.
   */
  holdWaiting(point: THREE.Vector3 | null): void {
    const waiting = this.waitingDie;
    if (!waiting) return;
    waiting.held = point ? (waiting.held ?? new THREE.Vector3()).copy(point) : null;
    this.stepWaiting(0);
  }

  /** Clears the tray of previous dice and any waiting die. */
  clear(): void {
    if (this.waitingDie) {
      this.waitingDie.mesh.removeFromParent();
      this.waitingDie = null;
      this.halo.visible = false;
      this.halo.material.opacity = 0;
    }
    for (const [id, entry] of this.dice) {
      this.world.removeDie(id);
      entry.mesh.removeFromParent();
      if (entry.label) this.disposeLabel(entry.label);
    }
    this.dice.clear();
  }

  /**
   * Throws a die that will land on `face` (showing `value`), with a randomized seeded impulse from
   * the player's side of the tray toward the far wall. A die held in the hand (`holdWaiting`) starts
   * from there instead, kept inside the tray; the seeded draws are the same either way, so a run
   * replays whatever the hand did. Returns the die id.
   */
  throw(kind: DieKind, face: number, value: number): string {
    if (this.disposed) throw new Error('DicePresenter is disposed');
    const held = this.waitingDie?.held?.clone() ?? null;
    this.clear();
    const s = this.stream;
    const span = (k: number) => (s.next() * 2 - 1) * k;
    const { halfX, halfZ } = this.options;
    const id = `die-${++this.count}`;
    const position = { x: span(halfX * 0.5), y: 0.1 + s.next() * 0.04, z: halfZ * 0.55 };
    const linvel = { x: span(0.25), y: -0.1 - s.next() * 0.2, z: -(0.5 + s.next() * 0.5) };
    const angvel = { x: span(18), y: span(18), z: span(18) };
    if (held) {
      const clamp = (v: number, k: number) => Math.min(k, Math.max(-k, v));
      position.x = clamp(held.x, halfX * HAND_START_INSET);
      position.y = Math.min(HAND_START_TOP, Math.max(position.y, held.y));
      position.z = clamp(held.z, halfZ * HAND_START_INSET);
    }
    this.world.throwDie(id, kind, position, linvel, angvel, face);
    const mesh = this.spawnMesh(kind, id);
    this.root.add(mesh);
    this.dice.set(id, { mesh, kind, face, value, label: null });
    this.copyPose(id);
    return id;
  }

  /** The face index showing up on the die's mesh right now. */
  upFace(id: string): number | null {
    const entry = this.dice.get(id);
    if (!entry) return null;
    const q = entry.mesh.quaternion;
    let best = -1;
    let bestY = Number.NEGATIVE_INFINITY;
    faceNormals(entry.kind).forEach((n, i) => {
      const y = new THREE.Vector3(n.x, n.y, n.z).applyQuaternion(q).y;
      if (y > bestY) {
        bestY = y;
        best = i;
      }
    });
    return best;
  }

  /** Steps the physics by one rendered frame and copies the poses onto the meshes. */
  update(dt: number): void {
    if (this.disposed) return;
    if (this.waitingDie) this.stepWaiting(dt);
    if (this.dice.size === 0) return;
    this.world.step(dt);
    for (const id of this.dice.keys()) this.copyPose(id);
  }

  dispose(): void {
    if (this.disposed) return;
    this.clear();
    this.disposed = true;
    this.offSettled();
    this.listeners.clear();
    this.world.dispose();
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
    for (const t of this.textures) t.dispose();
    this.root.removeFromParent();
  }

  /**
   * Maps the atlas dice faces onto both geometries and swaps the pages in: the colour pages as
   * `map`, the glow pages (when present) as `emissiveMap`, so only pips and numerals emit.
   */
  applyFaces(pages: DiePages): void {
    const glow = { d6: pages.d6Glow ?? null, d8: pages.d8Glow ?? null };
    this.options.models?.bindFaceMaps({ d6: pages.d6, d8: pages.d8 }, glow);
    const d6Uv = this.d6Geometry.getAttribute('uv') as THREE.BufferAttribute;
    d6Uv.set(d6FaceUvs(pages.manifest.dice['brass-d6'], d6Uv.array));
    d6Uv.needsUpdate = true;
    const d8Uv = this.d8Geometry.getAttribute('uv') as THREE.BufferAttribute;
    d8Uv.set(
      d8FaceUvs(pages.manifest.dice['glass-d8'], this.d8Geometry.getAttribute('position').array),
    );
    d8Uv.needsUpdate = true;
    for (const [material, page, lit] of [
      [this.d6Material, pages.d6, glow.d6],
      [this.d8Material, pages.d8, glow.d8],
    ] as const) {
      material.map = page;
      // Without a glow page the blank map stays bound (emissive black), so nothing recompiles.
      material.emissiveMap = lit ?? this.blank;
      material.emissive.set(lit ? '#ffffff' : '#000000');
      material.emissiveIntensity = lit ? DICE_GLOW_INTENSITY : 1;
      material.color.set('#ffffff');
    }
  }

  private spawnMesh(kind: DieKind, name: string): THREE.Mesh {
    const mesh =
      this.options.models?.spawn(kind) ??
      (kind === 'd6'
        ? new THREE.Mesh(this.d6Geometry, this.d6Material)
        : new THREE.Mesh(this.d8Geometry, this.d8Material));
    mesh.name = name;
    if (!this.facesRequested) {
      this.facesRequested = true;
      onFirstRender(mesh, (renderer) => {
        if (!this.options.envMap)
          this.options.models?.setEnvironment(roomProbe(renderer), DICE_ENV_INTENSITY);
        loadDiePages(renderer).then(
          (pages) => {
            if (!this.disposed) this.applyFaces(pages);
          },
          (error: unknown) => console.warn('dice face atlas failed to load', error),
        );
      });
    }
    if (!this.options.models) mesh.castShadow = true;
    return mesh;
  }

  /** Spins and swells the waiting die and pulses its halo; a held die follows the hand. */
  private stepWaiting(dt: number): void {
    const waiting = this.waitingDie;
    if (!waiting) return;
    waiting.age += dt;
    const wave = 0.5 - 0.5 * Math.cos((2 * Math.PI * waiting.age) / WAITING_PULSE_SECONDS);
    const { mesh } = waiting;
    if (waiting.held) mesh.position.copy(waiting.held);
    else mesh.position.set(0, WAITING_LIFT + 0.01 * wave, 0);
    mesh.rotation.set(0.5, waiting.age * WAITING_SPIN, 0.3);
    mesh.scale.setScalar(1 + WAITING_SWELL * wave);
    this.halo.position.x = waiting.held ? waiting.held.x : 0;
    this.halo.position.z = waiting.held ? waiting.held.z : 0;
    this.halo.material.opacity = 0.25 + 0.75 * wave;
  }

  private copyPose(id: string): void {
    const pose = this.world.pose(id);
    const entry = this.dice.get(id);
    if (!pose || !entry) return;
    entry.mesh.position.set(pose.position.x, pose.position.y, pose.position.z);
    entry.mesh.quaternion.set(
      pose.quaternion.x,
      pose.quaternion.y,
      pose.quaternion.z,
      pose.quaternion.w,
    );
  }

  private disposeLabel(label: THREE.Sprite): void {
    label.removeFromParent();
    label.material.map?.dispose();
    label.material.dispose();
  }
}
