import * as THREE from 'three';
import type { Stream } from '../core/rng.ts';
import type { EnemyActor, EnemyAsset } from './enemy-asset.ts';
import { applyGlowLook, GLOW_ISLAND_ATTRIBUTE } from './glow.ts';

/**
 * H9: a defeated automaton falls apart. Every enemy GLB is rigidly skinned (one bone per vertex at
 * weight 1), so each bone's vertices form a rigid part. {@link BreakApart.prepare} splits a model
 * once per enemy kind into per-bone geometry in the bone's own bind frame; {@link BreakApart.shatter}
 * hides the actor's meshes and places those parts at the bones' current (death-clip) pose, then a
 * small fixed-step integrator throws them outward, bounces them on the floor, lays them flat and
 * finally sinks them. Part geometry and materials are cached per kind and freed by `dispose()`.
 */

export interface BreakApartOptions {
  /** Pieces per enemy at most; the smallest bones fold into their nearest ancestor piece beyond it. */
  maxPieces: number;
  gravity: number;
  /** Fraction of downward speed kept on a bounce. */
  restitution: number;
  /** Horizontal deceleration on contact, as a fraction of gravity (Coulomb friction). */
  friction: number;
  /** Outward speed range (m/s), biased away from the player (the model's local +Z). */
  outward: readonly [number, number];
  /** Upward kick range (m/s). */
  upward: readonly [number, number];
  /** Spin range per axis (rad/s). */
  spin: number;
  /** Seconds a piece tumbles before its horizontal motion and spin are killed. */
  tumbleSeconds: number;
  /** Seconds the settled pile stays before it sinks. */
  holdSeconds: number;
  sinkSeconds: number;
  /** Loose cogs thrown with the pieces. */
  cogs: number;
  /** Spark particles in the burst. */
  sparks: number;
}

export const BREAK_APART_DEFAULTS: Readonly<BreakApartOptions> = {
  // Draw calls scale with pieces x materials touched (30 pieces cost the spring-hound 73 calls per burst).
  maxPieces: 14,
  gravity: 9.81,
  restitution: 0.32,
  friction: 0.55,
  outward: [0.4, 1.1],
  upward: [1.0, 2.2],
  spin: 6,
  tumbleSeconds: 2.4,
  holdSeconds: 1.4,
  sinkSeconds: 1.0,
  cogs: 5,
  sparks: 12,
};

/** Fixed integrator step: results depend on elapsed time, never on the frame rate. */
export const STEP = 1 / 120;
const MAX_STEPS_PER_UPDATE = 12;
/** A piece rests once it touches the floor this slowly for {@link SLEEP_SECONDS}. */
const SLEEP_SPEED = 0.08;
const SLEEP_SPIN = 0.6;
const SLEEP_SECONDS = 0.2;
/** A resting piece is this close to face-down (|cos| of its most vertical box axis). */
const SLEEP_FLAT = 0.9995;
/** Bounces slower than this stop dead instead of chattering. */
const BOUNCE_FLOOR = 0.35;
/** Spin lost per second on contact, and the rate a touching piece turns toward lying flat. */
const CONTACT_SPIN_DAMP = 6;
const FLATTEN_RATE = 5;
/** Share of the outward direction pointed along the model's +Z (away from the player it faced). */
const BACK_BIAS = 0.6;
const SPARK_LIFE: readonly [number, number] = [0.25, 0.6];
const SPARK_SPEED: readonly [number, number] = [1.5, 3.5];
const SPARK_SIZE = 0.014;
const COG_RADIUS = 0.045;

/** One part of a piece: the triangles of one bone in one source mesh, in that bone's bind frame. */
export interface PartTemplate {
  /** Index of the source mesh in the model's SkinnedMesh traversal order. */
  readonly mesh: number;
  /** Index of the bone in that mesh's `skeleton.bones`. */
  readonly bone: number;
  readonly geometry: THREE.BufferGeometry;
  readonly material: THREE.Material;
  readonly vertices: number;
}

/** One rigid piece: the parts of its anchor bone plus any small bones folded into it. */
export interface PieceTemplate {
  readonly boneName: string;
  readonly parts: readonly PartTemplate[];
  readonly vertices: number;
}

export interface ModelTemplate {
  readonly pieces: readonly PieceTemplate[];
  /**
   * Triangles whose corners ride different bones (stretched spring or hose geometry). Each joins the
   * bone two of its corners ride; its other corner keeps its bind-pose offset from that bone.
   */
  readonly crossBoneTriangles: number;
  /** Bones that own at least one vertex, before any merge. */
  readonly skinnedBones: number;
  /** Draw calls one shattered enemy costs (parts over all pieces), cogs and sparks excluded. */
  readonly drawCalls: number;
  /** A metal material for the loose cogs. */
  readonly cogMaterial: THREE.Material | null;
  readonly geometries: readonly THREE.BufferGeometry[];
  /** Materials this cache made (the glow clone); the source materials stay their owner's. */
  readonly ownedMaterials: readonly THREE.Material[];
}

export interface PrepareOptions {
  /** Name of the glow material, which gets its own non-skinned clone with the glow look. */
  glowMaterial?: string;
  glowColor?: THREE.ColorRepresentation;
}

const SKIN_ATTRIBUTES = new Set(['skinIndex', 'skinWeight']);

function skinnedMeshesOf(root: THREE.Object3D): THREE.SkinnedMesh[] {
  const out: THREE.SkinnedMesh[] = [];
  root.traverse((o) => {
    if (o instanceof THREE.SkinnedMesh) out.push(o);
  });
  return out;
}

/** The bone slot with the largest weight at vertex `i`. */
function boneOf(skinIndex: THREE.BufferAttribute, skinWeight: THREE.BufferAttribute, i: number) {
  let best = 0;
  let weight = -1;
  for (let k = 0; k < skinIndex.itemSize; k++) {
    const w = skinWeight.getComponent(i, k);
    if (w > weight) {
      weight = w;
      best = skinIndex.getComponent(i, k);
    }
  }
  return best;
}

/** Copies `triangles` (vertex indices into `source`) into a compact geometry, moved by `matrix`. */
function extractPart(
  source: THREE.BufferGeometry,
  triangles: readonly number[],
  matrix: THREE.Matrix4,
): THREE.BufferGeometry {
  const position = source.getAttribute('position');
  const remap = new Int32Array(position.count).fill(-1);
  const order: number[] = [];
  const index = new Array<number>(triangles.length);
  for (let t = 0; t < triangles.length; t++) {
    const v = triangles[t] as number;
    let at = remap[v] as number;
    if (at < 0) {
      at = order.length;
      remap[v] = at;
      order.push(v);
    }
    index[t] = at;
  }
  const normalMatrix = new THREE.Matrix3().getNormalMatrix(matrix);
  const v3 = new THREE.Vector3();
  const geometry = new THREE.BufferGeometry();
  for (const [name, attr] of Object.entries(source.attributes)) {
    if (SKIN_ATTRIBUTES.has(name)) continue;
    const size = attr.itemSize;
    const data = new Float32Array(order.length * size);
    for (let n = 0; n < order.length; n++) {
      const v = order[n] as number;
      for (let k = 0; k < size; k++) data[n * size + k] = attr.getComponent(v, k);
      if (size < 3) continue;
      const point = name === 'position' || name === GLOW_ISLAND_ATTRIBUTE;
      const direction = name === 'normal' || name === 'tangent';
      if (!point && !direction) continue;
      v3.set(data[n * size] as number, data[n * size + 1] as number, data[n * size + 2] as number);
      if (point) v3.applyMatrix4(matrix);
      else if (name === 'normal') v3.applyMatrix3(normalMatrix).normalize();
      else v3.transformDirection(matrix);
      data[n * size] = v3.x;
      data[n * size + 1] = v3.y;
      data[n * size + 2] = v3.z;
    }
    geometry.setAttribute(name, new THREE.BufferAttribute(data, size));
  }
  geometry.setIndex(order.length > 65535 ? new THREE.Uint32BufferAttribute(index, 1) : index);
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

/**
 * Splits a rigidly skinned model into per-bone pieces in each bone's bind frame
 * (`boneInverse · bindMatrix · v`), so a piece placed at `bone.matrixWorld` lands exactly on the
 * posed mesh. Beyond `maxPieces`, the piece with the fewest vertices folds into its nearest ancestor
 * piece (its parts keep their own bone, so the fold costs nothing in pose accuracy).
 */
export function splitByBone(
  template: THREE.Object3D,
  maxPieces: number = BREAK_APART_DEFAULTS.maxPieces,
  options: PrepareOptions = {},
): ModelTemplate {
  const meshes = skinnedMeshesOf(template);
  const geometries: THREE.BufferGeometry[] = [];
  const ownedMaterials: THREE.Material[] = [];
  const glowClones = new Map<THREE.Material, THREE.Material>();
  const materialFor = (source: THREE.Material): THREE.Material => {
    if (!options.glowMaterial || source.name !== options.glowMaterial) return source;
    if (!(source instanceof THREE.MeshStandardMaterial)) return source;
    let clone = glowClones.get(source);
    if (!clone) {
      const glow = source.clone();
      applyGlowLook(glow, options.glowColor ?? source.emissive);
      glowClones.set(source, glow);
      ownedMaterials.push(glow);
      clone = glow;
    }
    return clone;
  };

  interface Draft {
    bone: THREE.Bone;
    parts: PartTemplate[];
    vertices: number;
  }
  const drafts = new Map<THREE.Bone, Draft>();
  let crossBoneTriangles = 0;
  const bindFrame = new THREE.Matrix4();
  meshes.forEach((mesh, meshIndex) => {
    const geometry = mesh.geometry;
    const skinIndex = geometry.getAttribute('skinIndex') as THREE.BufferAttribute | undefined;
    const skinWeight = geometry.getAttribute('skinWeight') as THREE.BufferAttribute | undefined;
    const position = geometry.getAttribute('position');
    if (!skinIndex || !skinWeight || !position) return;
    const source = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    if (!source) return;
    const material = materialFor(source);
    const bones = new Int32Array(position.count);
    for (let i = 0; i < position.count; i++) bones[i] = boneOf(skinIndex, skinWeight, i);
    const index = geometry.getIndex();
    const triangleCount = index ? index.count / 3 : position.count / 3;
    const byBone = new Map<number, number[]>();
    for (let t = 0; t < triangleCount; t++) {
      const a = index ? index.getX(t * 3) : t * 3;
      const b = index ? index.getX(t * 3 + 1) : t * 3 + 1;
      const c = index ? index.getX(t * 3 + 2) : t * 3 + 2;
      const ba = bones[a] as number;
      const bb = bones[b] as number;
      // A stretched triangle (a spring between two bones) rides the bone most of its corners ride.
      const bone = bb === bones[c] ? bb : ba;
      if (ba !== bb || bb !== bones[c]) crossBoneTriangles++;
      let list = byBone.get(bone);
      if (!list) {
        list = [];
        byBone.set(bone, list);
      }
      list.push(a, b, c);
    }
    for (const [boneIndex, triangles] of [...byBone].sort((x, y) => x[0] - y[0])) {
      const bone = mesh.skeleton.bones[boneIndex];
      const inverse = mesh.skeleton.boneInverses[boneIndex];
      if (!bone || !inverse) continue;
      bindFrame.multiplyMatrices(inverse, mesh.bindMatrix);
      const part = extractPart(geometry, triangles, bindFrame);
      geometries.push(part);
      const vertices = part.getAttribute('position').count;
      let draft = drafts.get(bone);
      if (!draft) {
        draft = { bone, parts: [], vertices: 0 };
        drafts.set(bone, draft);
      }
      draft.parts.push({ mesh: meshIndex, bone: boneIndex, geometry: part, material, vertices });
      draft.vertices += vertices;
    }
  });

  const skinnedBones = drafts.size;
  const pieces = [...drafts.values()];
  const ancestorOf = (draft: Draft): Draft | null => {
    for (let b = draft.bone.parent; b; b = b.parent) {
      const found = b instanceof THREE.Bone ? drafts.get(b) : undefined;
      if (found && pieces.includes(found)) return found;
    }
    return null;
  };
  while (pieces.length > Math.max(1, maxPieces)) {
    let pick: Draft | null = null;
    let into: Draft | null = null;
    for (const draft of pieces) {
      if (pick && draft.vertices >= pick.vertices) continue;
      const ancestor = ancestorOf(draft);
      if (!ancestor) continue;
      pick = draft;
      into = ancestor;
    }
    if (!pick || !into) break;
    into.parts.push(...pick.parts);
    into.vertices += pick.vertices;
    pieces.splice(pieces.indexOf(pick), 1);
  }

  let cogMaterial: THREE.Material | null = null;
  for (const mesh of meshes) {
    const m = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    if (!m || m.name === options.glowMaterial) continue;
    if (!cogMaterial || /brass/.test(m.name)) cogMaterial = m;
    if (/brass/.test(m.name)) break;
  }
  return {
    pieces: pieces.map((d) => ({ boneName: d.bone.name, parts: d.parts, vertices: d.vertices })),
    crossBoneTriangles,
    skinnedBones,
    drawCalls: pieces.reduce((sum, d) => sum + d.parts.length, 0),
    cogMaterial,
    geometries,
    ownedMaterials,
  };
}

/** A loose gear: a toothed disc, built once per {@link BreakApart}. */
function cogGeometry(): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  const teeth = 8;
  for (let i = 0; i < teeth * 2; i++) {
    const r = i % 2 === 0 ? COG_RADIUS : COG_RADIUS * 0.72;
    const a0 = (i / (teeth * 2)) * Math.PI * 2;
    const a1 = ((i + 1) / (teeth * 2)) * Math.PI * 2;
    if (i === 0) shape.moveTo(Math.cos(a0) * r, Math.sin(a0) * r);
    else shape.lineTo(Math.cos(a0) * r, Math.sin(a0) * r);
    shape.lineTo(Math.cos(a1) * r, Math.sin(a1) * r);
  }
  const hole = new THREE.Path();
  hole.absarc(0, 0, COG_RADIUS * 0.28, 0, Math.PI * 2, true);
  shape.holes.push(hole);
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: COG_RADIUS * 0.35,
    bevelEnabled: false,
    curveSegments: 6,
  });
  geometry.center();
  geometry.computeBoundingBox();
  return geometry;
}

/** One rigid body: the holder object sits at the piece's box centre. */
export class DebrisBody {
  readonly velocity = new THREE.Vector3();
  readonly spin = new THREE.Vector3();
  /** Half extents of the piece's local box, before the holder's scale. */
  readonly half = new THREE.Vector3();
  /** Holder scale at the split (the bone's world scale). */
  readonly baseScale = new THREE.Vector3(1, 1, 1);
  /** Lowest point of the rotated box after the last step (parent-local y). */
  lowest = 0;
  asleep = false;
  quiet = 0;
  restY = 0;

  constructor(readonly object: THREE.Object3D) {}
}

interface Spark {
  readonly position: THREE.Vector3;
  readonly velocity: THREE.Vector3;
  life: number;
  readonly span: number;
}

export type BurstPhase = 'tumble' | 'hold' | 'sink' | 'done';

const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _up = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _identity = new THREE.Quaternion();

/** Lowest y of a box with half extents `h` (already scaled), centred at `y`, rotated by `q`. */
export function lowestPoint(y: number, q: THREE.Quaternion, h: THREE.Vector3): number {
  const { x, y: qy, z, w } = q;
  const r10 = 2 * (x * qy + w * z);
  const r11 = 1 - 2 * (x * x + z * z);
  const r12 = 2 * (qy * z - w * x);
  return y - (Math.abs(r10) * h.x + Math.abs(r11) * h.y + Math.abs(r12) * h.z);
}

/** One shattered enemy: its pieces, cogs and sparks, alive until the sink ends. */
export class Burst {
  readonly root = new THREE.Group();
  readonly bodies: DebrisBody[] = [];
  phase: BurstPhase = 'tumble';
  age = 0;
  private phaseAge = 0;
  private readonly sparks: Spark[] = [];
  private readonly sparkMesh: THREE.InstancedMesh | null;

  constructor(
    readonly floorY: number,
    private readonly options: BreakApartOptions,
    sparkGeometry: THREE.BufferGeometry,
    sparkMaterial: THREE.Material,
    sparkCount: number,
  ) {
    this.root.name = 'break-apart';
    this.sparkMesh =
      sparkCount > 0 ? new THREE.InstancedMesh(sparkGeometry, sparkMaterial, sparkCount) : null;
    if (this.sparkMesh) {
      this.sparkMesh.frustumCulled = false;
      this.root.add(this.sparkMesh);
    }
  }

  addSpark(position: THREE.Vector3, velocity: THREE.Vector3, life: number): void {
    this.sparks.push({ position, velocity, life, span: life });
  }

  /** Advances one fixed step. */
  step(h: number): void {
    if (this.phase === 'done') return;
    this.age += h;
    this.phaseAge += h;
    if (this.phase === 'tumble') {
      let awake = 0;
      for (const body of this.bodies) {
        if (!body.asleep) {
          this.integrate(body, h);
          if (!body.asleep) awake++;
        }
      }
      if (awake === 0) this.enter('hold');
    } else if (this.phase === 'hold') {
      if (this.phaseAge >= this.options.holdSeconds) this.enter('sink');
    } else if (this.phase === 'sink') {
      const k = Math.min(1, this.phaseAge / Math.max(this.options.sinkSeconds, 1e-6));
      const s = k * k * (3 - 2 * k);
      for (const body of this.bodies) {
        const o = body.object;
        const depth = body.restY - body.lowest;
        o.position.y = body.restY - s * depth;
        o.scale.copy(body.baseScale).multiplyScalar(Math.max(1e-4, 1 - s));
      }
      if (k >= 1) this.enter('done');
    }
    this.stepSparks(h);
  }

  /** Writes the bodies' and sparks' transforms to the scene graph (once per frame). */
  sync(): void {
    for (const body of this.bodies) body.object.updateMatrix();
    const mesh = this.sparkMesh;
    if (!mesh) return;
    let n = 0;
    for (const spark of this.sparks) {
      if (spark.life <= 0) continue;
      const s = spark.life / spark.span;
      _v.setScalar(s);
      _m.compose(spark.position, _identity, _v);
      mesh.setMatrixAt(n++, _m);
    }
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.phase = 'done';
    this.root.removeFromParent();
    this.sparkMesh?.dispose();
    this.bodies.length = 0;
    this.sparks.length = 0;
  }

  private enter(phase: BurstPhase): void {
    this.phase = phase;
    this.phaseAge = 0;
    if (phase === 'sink') for (const body of this.bodies) body.restY = body.object.position.y;
  }

  private integrate(body: DebrisBody, h: number): void {
    const o = body.object;
    const { gravity, restitution, friction, tumbleSeconds } = this.options;
    if (this.age > tumbleSeconds) {
      body.velocity.x = 0;
      body.velocity.z = 0;
      body.spin.set(0, 0, 0);
    }
    body.velocity.y -= gravity * h;
    o.position.addScaledVector(body.velocity, h);
    const w = body.spin.length();
    if (w > 1e-9) {
      _q.setFromAxisAngle(_axis.copy(body.spin).divideScalar(w), w * h);
      o.quaternion.premultiply(_q).normalize();
    }
    _v2.copy(body.half).multiply(o.scale);
    let lowest = lowestPoint(o.position.y, o.quaternion, _v2);
    if (lowest < this.floorY) {
      if (body.velocity.y < 0) {
        body.velocity.y = -body.velocity.y * restitution;
        if (body.velocity.y < BOUNCE_FLOOR) body.velocity.y = 0;
      }
      const horizontal = Math.hypot(body.velocity.x, body.velocity.z);
      if (horizontal > 0) {
        const keep = Math.max(0, horizontal - friction * gravity * h) / horizontal;
        body.velocity.x *= keep;
        body.velocity.z *= keep;
      }
      body.spin.multiplyScalar(Math.max(0, 1 - CONTACT_SPIN_DAMP * h));
      const flat = this.flatten(o.quaternion, h);
      lowest = lowestPoint(o.position.y, o.quaternion, _v2);
      o.position.y += this.floorY - lowest;
      lowest = this.floorY;
      const still =
        body.velocity.lengthSq() < SLEEP_SPEED * SLEEP_SPEED &&
        body.spin.lengthSq() < SLEEP_SPIN * SLEEP_SPIN &&
        flat >= SLEEP_FLAT;
      body.quiet = still ? body.quiet + h : 0;
      if (body.quiet >= SLEEP_SECONDS) {
        body.asleep = true;
        body.velocity.set(0, 0, 0);
        body.spin.set(0, 0, 0);
      }
    } else {
      body.quiet = 0;
    }
    body.lowest = lowest;
  }

  /**
   * Turns a touching piece a step toward resting on its nearest box face; returns how vertical its
   * most vertical box axis was before the step (1 when flat).
   */
  private flatten(q: THREE.Quaternion, h: number): number {
    const { x, y, z, w } = q;
    // World y of each local box axis (row 1 of the rotation): the most vertical one goes upright.
    const r0 = 2 * (x * y + w * z);
    const r1 = 1 - 2 * (x * x + z * z);
    const r2 = 2 * (y * z - w * x);
    let best = r0;
    _axis.set(1, 0, 0);
    if (Math.abs(r1) > Math.abs(best)) {
      best = r1;
      _axis.set(0, 1, 0);
    }
    if (Math.abs(r2) > Math.abs(best)) {
      best = r2;
      _axis.set(0, 0, 1);
    }
    _axis.applyQuaternion(q);
    _up.set(0, Math.sign(best) || 1, 0);
    _q2.setFromUnitVectors(_axis, _up);
    _q.identity().slerp(_q2, Math.min(1, FLATTEN_RATE * h));
    q.premultiply(_q).normalize();
    return Math.abs(best);
  }

  private stepSparks(h: number): void {
    for (const spark of this.sparks) {
      if (spark.life <= 0) continue;
      spark.life -= h;
      spark.velocity.y -= this.options.gravity * h;
      spark.position.addScaledVector(spark.velocity, h);
      if (spark.position.y < this.floorY) {
        spark.position.y = this.floorY;
        spark.velocity.y = Math.abs(spark.velocity.y) * 0.3;
      }
    }
  }
}

const range = (rng: Stream, [lo, hi]: readonly [number, number]): number =>
  lo + (hi - lo) * rng.next();

/** A random level direction, pulled toward `back` so loose bits fly away from the seated player. */
function awayFromPlayer(rng: Stream, back: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
  const a = rng.next() * Math.PI * 2;
  out.set(Math.cos(a), 0, Math.sin(a)).multiplyScalar(1 - BACK_BIAS);
  out.addScaledVector(back, BACK_BIAS);
  return out.lengthSq() > 1e-9 ? out.normalize() : out.set(Math.cos(a), 0, Math.sin(a));
}

/**
 * Owns every live shatter under one parent (the floor group) plus the per-kind part caches. The
 * parent must be level (no tilt), since gravity and the floor plane are taken along its local y.
 */
export class BreakApart {
  readonly options: BreakApartOptions;
  private readonly cache = new Map<object, ModelTemplate>();
  private readonly live: Burst[] = [];
  private accumulator = 0;
  private sparkGeometry: THREE.BufferGeometry | null = null;
  private sparkMaterial: THREE.MeshBasicMaterial | null = null;
  private cogShape: THREE.BufferGeometry | null = null;

  constructor(
    readonly parent: THREE.Object3D,
    options: Partial<BreakApartOptions> = {},
  ) {
    this.options = { ...BREAK_APART_DEFAULTS, ...options };
  }

  /** Live shatters. */
  get bursts(): readonly Burst[] {
    return this.live;
  }

  /** The cached split for `key`, or undefined before {@link prepare}. */
  templateOf(key: object): ModelTemplate | undefined {
    return this.cache.get(key);
  }

  /** Splits `template` once for `key` (an enemy kind); later calls return the cache. */
  prepare(key: object, template: THREE.Object3D, options: PrepareOptions = {}): ModelTemplate {
    let model = this.cache.get(key);
    if (!model) {
      model = splitByBone(template, this.options.maxPieces, options);
      this.cache.set(key, model);
    }
    return model;
  }

  /** {@link prepare} for an enemy asset: its template, its glow material and colour. */
  prepareAsset(asset: EnemyAsset): ModelTemplate {
    return this.prepare(asset, asset.template, {
      glowMaterial: asset.manifest.emissive.material,
      glowColor: asset.manifest.emissive.color,
    });
  }

  /** Shatters an actor at its current pose (call when its death clip has finished). */
  shatterActor(actor: EnemyActor, rng: Stream): Burst | null {
    this.prepareAsset(actor.asset);
    return this.shatter(actor.asset, actor.object, rng);
  }

  /**
   * Hides `root`'s meshes and replaces them with the cached pieces of `key` at the bones' current
   * pose. The floor is `root`'s own height (the model's origin sits at its feet). Hides meshes
   * rather than `root`, so code that re-shows the body never brings the whole model back.
   */
  shatter(key: object, root: THREE.Object3D, rng: Stream): Burst | null {
    const model = this.cache.get(key);
    if (!model || model.pieces.length === 0) return null;
    const meshes = skinnedMeshesOf(root);
    // updateMatrixWorld, not updateWorldMatrix: only the former refreshes an attached
    // SkinnedMesh's bindMatrixInverse, which goes stale once the actor has moved since binding.
    root.parent?.updateWorldMatrix(true, false);
    root.updateMatrixWorld(true);
    this.parent.updateWorldMatrix(true, false);
    const toParent = new THREE.Matrix4().copy(this.parent.matrixWorld).invert();
    const floor = new THREE.Vector3()
      .setFromMatrixPosition(root.matrixWorld)
      .applyMatrix4(toParent);
    const back = new THREE.Vector3(0, 0, 1)
      .transformDirection(root.matrixWorld)
      .transformDirection(toParent);
    back.y = 0;
    if (back.lengthSq() > 1e-9) back.normalize();

    if (!this.sparkGeometry) {
      this.sparkGeometry = new THREE.BoxGeometry(SPARK_SIZE, SPARK_SIZE, SPARK_SIZE * 2.5);
      this.sparkMaterial = new THREE.MeshBasicMaterial({ color: '#ffb347', toneMapped: false });
      this.sparkMaterial.name = 'break-apart-spark';
    }
    const burst = new Burst(
      floor.y,
      this.options,
      this.sparkGeometry,
      this.sparkMaterial as THREE.MeshBasicMaterial,
      this.options.sparks,
    );

    // Place every piece at its anchor bone, with its parts at their own bones relative to it.
    const anchor = new THREE.Matrix4();
    const anchorInverse = new THREE.Matrix4();
    const relative = new THREE.Matrix4();
    const box = new THREE.Box3();
    const partBox = new THREE.Box3();
    const centre = new THREE.Vector3();
    const boneWorld = (mesh: number, bone: number, out: THREE.Matrix4): boolean => {
      const m = meshes[mesh];
      const b = m?.skeleton.bones[bone];
      if (!m || !b) return false;
      // Skinned world space is matrixWorld · bindMatrixInverse · bone.matrixWorld (identity
      // prefix in the attached bind mode every GLB uses).
      out.multiplyMatrices(m.matrixWorld, m.bindMatrixInverse).multiply(b.matrixWorld);
      out.premultiply(toParent);
      return true;
    };
    const holders: { body: DebrisBody; centre: THREE.Vector3 }[] = [];
    for (const piece of model.pieces) {
      const first = piece.parts[0];
      if (!first || !boneWorld(first.mesh, first.bone, anchor)) continue;
      anchorInverse.copy(anchor).invert();
      const holder = new THREE.Group();
      holder.name = `piece-${piece.boneName}`;
      holder.matrixAutoUpdate = false;
      box.makeEmpty();
      const children: { mesh: THREE.Mesh; matrix: THREE.Matrix4 }[] = [];
      for (const part of piece.parts) {
        if (!boneWorld(part.mesh, part.bone, relative)) continue;
        relative.premultiply(anchorInverse);
        const bounds = part.geometry.boundingBox;
        if (bounds) box.union(partBox.copy(bounds).applyMatrix4(relative));
        const mesh = new THREE.Mesh(part.geometry, part.material);
        const source = meshes[part.mesh];
        mesh.castShadow = source?.castShadow ?? false;
        mesh.receiveShadow = source?.receiveShadow ?? false;
        mesh.matrixAutoUpdate = false;
        children.push({ mesh, matrix: relative.clone() });
      }
      if (children.length === 0 || box.isEmpty()) continue;
      box.getCenter(centre);
      for (const { mesh, matrix } of children) {
        mesh.matrix.makeTranslation(-centre.x, -centre.y, -centre.z).multiply(matrix);
        holder.add(mesh);
      }
      const body = new DebrisBody(holder);
      box.getSize(body.half).multiplyScalar(0.5);
      anchor.decompose(holder.position, holder.quaternion, holder.scale);
      body.baseScale.copy(holder.scale);
      holder.position.copy(centre).applyMatrix4(anchor);
      holders.push({ body, centre: holder.position.clone() });
    }
    if (holders.length === 0) return null;

    const middle = new THREE.Vector3();
    for (const { centre: c } of holders) middle.add(c);
    middle.divideScalar(holders.length);
    const dir = new THREE.Vector3();
    for (const { body, centre: c } of holders) {
      dir.set(c.x - middle.x, 0, c.z - middle.z);
      if (dir.lengthSq() < 1e-6) {
        const a = rng.next() * Math.PI * 2;
        dir.set(Math.cos(a), 0, Math.sin(a));
      }
      dir
        .normalize()
        .multiplyScalar(1 - BACK_BIAS)
        .addScaledVector(back, BACK_BIAS);
      if (dir.lengthSq() > 1e-9) dir.normalize();
      body.velocity.copy(dir).multiplyScalar(range(rng, this.options.outward));
      body.velocity.y = range(rng, this.options.upward);
      const s = this.options.spin;
      body.spin.set((rng.next() * 2 - 1) * s, (rng.next() * 2 - 1) * s, (rng.next() * 2 - 1) * s);
      this.settleAboveFloor(body, burst.floorY);
      body.object.updateMatrix();
      burst.bodies.push(body);
      burst.root.add(body.object);
    }

    if (model.cogMaterial && this.options.cogs > 0) {
      this.cogShape ??= cogGeometry();
      const size = (this.cogShape.boundingBox as THREE.Box3).getSize(new THREE.Vector3());
      for (let i = 0; i < this.options.cogs; i++) {
        const from = holders[rng.int(0, holders.length - 1)]?.centre ?? middle;
        const cog = new THREE.Mesh(this.cogShape, model.cogMaterial);
        cog.name = 'loose-cog';
        cog.matrixAutoUpdate = false;
        cog.position.copy(from);
        cog.quaternion.setFromEuler(
          new THREE.Euler(rng.next() * Math.PI, rng.next() * Math.PI, rng.next() * Math.PI),
        );
        const body = new DebrisBody(cog);
        body.half.copy(size).multiplyScalar(0.5);
        awayFromPlayer(rng, back, dir);
        const speed = range(rng, this.options.outward) * 1.4;
        body.velocity.set(dir.x * speed, range(rng, this.options.upward) * 1.2, dir.z * speed);
        const s = this.options.spin * 2;
        body.spin.set((rng.next() * 2 - 1) * s, (rng.next() * 2 - 1) * s, (rng.next() * 2 - 1) * s);
        this.settleAboveFloor(body, burst.floorY);
        cog.updateMatrix();
        burst.bodies.push(body);
        burst.root.add(cog);
      }
    }

    for (let i = 0; i < this.options.sparks; i++) {
      const from = holders[rng.int(0, holders.length - 1)]?.centre ?? middle;
      awayFromPlayer(rng, back, dir);
      const speed = range(rng, SPARK_SPEED);
      const lift = 0.4 + rng.next() * 0.6;
      const velocity = new THREE.Vector3(dir.x * speed, lift * speed, dir.z * speed);
      burst.addSpark(from.clone(), velocity, range(rng, SPARK_LIFE));
    }

    root.traverse((o) => {
      if (o instanceof THREE.Mesh) o.visible = false;
    });
    burst.sync();
    this.parent.add(burst.root);
    this.live.push(burst);
    return burst;
  }

  /** Steps every live shatter at the fixed rate and drops the finished ones. */
  update(dt: number): void {
    if (this.live.length === 0) {
      this.accumulator = 0;
      return;
    }
    if (!(dt > 0)) return;
    this.accumulator += dt;
    let steps = 0;
    while (this.accumulator >= STEP && steps < MAX_STEPS_PER_UPDATE) {
      for (const burst of this.live) burst.step(STEP);
      this.accumulator -= STEP;
      steps++;
    }
    if (steps === MAX_STEPS_PER_UPDATE) this.accumulator = Math.min(this.accumulator, STEP);
    for (let i = this.live.length - 1; i >= 0; i--) {
      const burst = this.live[i] as Burst;
      if (burst.phase === 'done') {
        burst.dispose();
        this.live.splice(i, 1);
      } else {
        burst.sync();
      }
    }
  }

  /** Removes every live shatter (the floor's teardown); cached parts stay for the next one. */
  clear(): void {
    for (const burst of this.live) burst.dispose();
    this.live.length = 0;
    this.accumulator = 0;
  }

  /** {@link clear}, then frees every cached part geometry and the materials this system made. */
  dispose(): void {
    this.clear();
    for (const model of this.cache.values()) {
      for (const g of model.geometries) g.dispose();
      for (const m of model.ownedMaterials) m.dispose();
    }
    this.cache.clear();
    this.sparkGeometry?.dispose();
    this.sparkMaterial?.dispose();
    this.cogShape?.dispose();
    this.sparkGeometry = null;
    this.sparkMaterial = null;
    this.cogShape = null;
  }

  /** Lifts a body that starts below the floor (a piece lying flat at the split) onto it. */
  private settleAboveFloor(body: DebrisBody, floorY: number): void {
    const o = body.object;
    _v2.copy(body.half).multiply(o.scale);
    const lowest = lowestPoint(o.position.y, o.quaternion, _v2);
    if (lowest < floorY) o.position.y += floorY - lowest;
    body.lowest = Math.max(lowest, floorY);
  }
}
