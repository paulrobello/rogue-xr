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
import type { DiceAsset } from './dice-asset.ts';
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
 * tray (no `scene.environment`); 0.35 puts the brass between the table's ring and gear brass.
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

let diePages: Promise<{ manifest: UiAtlasManifest; d6: THREE.Texture; d8: THREE.Texture }> | null =
  null;

/** Loads the UI atlas manifest and both dice pages once (KTX2), shared by every presenter. */
function loadDiePages(renderer: THREE.WebGLRenderer) {
  if (!diePages) {
    diePages = (async () => {
      const manifest = await loadUiAtlas();
      const loader = sharedKtx2Loader(renderer);
      const page = async (name: 'dice-d6' | 'dice-d8') => {
        const entry = manifest.pages[name];
        if (!entry?.ktx2) throw new Error(`UI atlas page ${name} has no KTX2`);
        const texture = await loader.loadAsync(`${UI_ATLAS_BASE}/${entry.ktx2}`);
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.anisotropy = 4;
        texture.minFilter = THREE.LinearMipmapLinearFilter;
        return texture;
      };
      const [d6, d8] = await Promise.all([page('dice-d6'), page('dice-d8')]);
      return { manifest, d6, d8 };
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

interface Entry {
  mesh: THREE.Mesh;
  kind: DieKind;
  face: number;
  value: number;
  label: THREE.Sprite | null;
}

/**
 * Renders the physical dice in the tray. The rules have already rolled (D1); `throw` only presents
 * that face: a seeded impulse from `stream` (never `Math.random`) throws the die into a `DiceWorld`
 * and the world's face correction makes it land on the engine's face. `root` is tray-local metres
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
  private readonly d6Material: THREE.MeshStandardMaterial;
  private readonly d8Material: THREE.MeshStandardMaterial;
  private facesRequested = false;
  private readonly d6Geometry: THREE.BufferGeometry;
  private readonly d8Geometry: THREE.BufferGeometry;
  private readonly offSettled: () => void;
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

  /** Clears the tray of previous dice. */
  clear(): void {
    for (const [id, entry] of this.dice) {
      this.world.removeDie(id);
      entry.mesh.removeFromParent();
      if (entry.label) this.disposeLabel(entry.label);
    }
    this.dice.clear();
  }

  /**
   * Throws a die that will land on `face` (showing `value`), with a randomized seeded impulse from
   * the player's side of the tray toward the far wall. Returns the die id.
   */
  throw(kind: DieKind, face: number, value: number): string {
    if (this.disposed) throw new Error('DicePresenter is disposed');
    this.clear();
    const s = this.stream;
    const span = (k: number) => (s.next() * 2 - 1) * k;
    const { halfX, halfZ } = this.options;
    const id = `die-${++this.count}`;
    const position = { x: span(halfX * 0.5), y: 0.1 + s.next() * 0.04, z: halfZ * 0.55 };
    const linvel = { x: span(0.25), y: -0.1 - s.next() * 0.2, z: -(0.5 + s.next() * 0.5) };
    const angvel = { x: span(18), y: span(18), z: span(18) };
    this.world.throwDie(id, kind, position, linvel, angvel, face);
    const mesh =
      this.options.models?.spawn(kind) ??
      (kind === 'd6'
        ? new THREE.Mesh(this.d6Geometry, this.d6Material)
        : new THREE.Mesh(this.d8Geometry, this.d8Material));
    mesh.name = id;
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
    if (this.disposed || this.dice.size === 0) return;
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

  /** Maps the atlas dice faces onto both geometries and swaps the pages in. */
  applyFaces(pages: { manifest: UiAtlasManifest; d6: THREE.Texture; d8: THREE.Texture }): void {
    this.options.models?.bindFaceMaps({ d6: pages.d6, d8: pages.d8 });
    const d6Uv = this.d6Geometry.getAttribute('uv') as THREE.BufferAttribute;
    d6Uv.set(d6FaceUvs(pages.manifest.dice['brass-d6'], d6Uv.array));
    d6Uv.needsUpdate = true;
    const d8Uv = this.d8Geometry.getAttribute('uv') as THREE.BufferAttribute;
    d8Uv.set(
      d8FaceUvs(pages.manifest.dice['glass-d8'], this.d8Geometry.getAttribute('position').array),
    );
    d8Uv.needsUpdate = true;
    for (const [material, page, glow] of [
      [this.d6Material, pages.d6, '#3a2a12'],
      [this.d8Material, pages.d8, '#5a4a30'],
    ] as const) {
      material.map = page;
      material.emissiveMap = page;
      material.emissive.set(glow);
      material.color.set('#ffffff');
    }
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
