import * as THREE from 'three';
import type { Stream } from '../core/rng.ts';
import { PALETTE } from '../palette.ts';
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

function faceTexture(value: number): THREE.CanvasTexture | null {
  const ctx = canvas2d(64);
  if (!ctx) return null;
  ctx.fillStyle = PALETTE.brass;
  ctx.fillRect(0, 0, 64, 64);
  ctx.fillStyle = PALETTE.warmBlack;
  ctx.font = 'bold 40px serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(value), 32, 35);
  const texture = new THREE.CanvasTexture(ctx.canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

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
  private readonly d6Materials: THREE.Material[];
  private readonly d8Material: THREE.Material;
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
    this.d8Geometry = buildD8Geometry();
    this.geometries.push(this.d6Geometry, this.d8Geometry);
    const d6Values = options.faces?.d6 ?? [1, 2, 3, 4, 5, 6];
    this.d6Materials = BOX_GROUP_FACE.map((face) => {
      const map = faceTexture(d6Values[face] ?? face + 1);
      if (map) this.textures.push(map);
      return new THREE.MeshStandardMaterial({
        color: map ? '#ffffff' : PALETTE.brass,
        map,
        metalness: 0.6,
        roughness: 0.35,
      });
    });
    this.d8Material = new THREE.MeshStandardMaterial({
      color: PALETTE.sapphire,
      metalness: 0.1,
      roughness: 0.1,
      transparent: true,
      opacity: 0.85,
      flatShading: true,
    });
    this.materials.push(...this.d6Materials, this.d8Material);
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
      kind === 'd6'
        ? new THREE.Mesh(this.d6Geometry, this.d6Materials)
        : new THREE.Mesh(this.d8Geometry, this.d8Material);
    mesh.name = id;
    mesh.castShadow = true;
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
