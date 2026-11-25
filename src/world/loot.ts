import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CanvasLabel, measuredLines } from '../combat-view/canvas-label.ts';
import { getCard } from '../content/cards.ts';
import type { Box, Socket } from '../content/rooms.ts';
import type { LootKind } from '../floor/generate.ts';
import { CARD_FLIGHT_SECONDS, flightGoal, flightPose, flightScale } from '../flow/card-flight.ts';
import { PALETTE } from '../palette.ts';
import { lootKey, type TreasureLoot } from '../rules/run.ts';

/** Coffer footprint: width along its local x, depth along z (its front faces local -z, like a socket yaw 0). */
const WIDTH = 0.7;
const DEPTH = 0.44;
const BODY_HEIGHT = 0.3;
const LID_RADIUS = DEPTH / 2;
/** Thickness of the body's walls and of the barrel lid's shell, metres. */
const WALL = 0.035;
const LID_SHELL = 0.03;
/** How far the inner floor sits below the rim. */
export const COFFER_INNER_DEPTH = 0.235;
const FLOOR_Y = BODY_HEIGHT - COFFER_INNER_DEPTH;
const INNER_W = WIDTH - 2 * WALL;
const INNER_D = DEPTH - 2 * WALL;
/** Height the glow haze rises above the inner floor. */
const HAZE_HEIGHT = COFFER_INNER_DEPTH + 0.225;
/** Lid angle when open, radians about the rear hinge: past upright, so its hollow faces the approach. */
const OPEN_ANGLE = 1.95;
/** Radians per second the lid swings. */
const OPEN_RATE = 4;
/** Lid angle at which the glow shows and the card starts to rise. */
const GLOW_ANGLE = 0.35;
const RISE_ANGLE = 1.2;
/** The card rises this far over `CARD_RISE_TIME` seconds, growing from `CARD_START_SCALE`. */
const CARD_RISE = 0.56;
const CARD_RISE_TIME = 0.9;
const CARD_START_SCALE = 0.3;
/** Card centre height above the inner floor when it starts to rise (it fits under the rim). */
const CARD_START_LIFT = 0.03;
const CARD_BOB = 0.015;
const CARD_BOB_RATE = 2.4;
/** Slow sway about the facing direction, radians, and how fast the card turns to the viewer (1/s). */
const CARD_SWAY = 0.12;
const CARD_TURN_RATE = 3;
/** Cog rewards rise one at a time before the card is released. */
const COG_RISE_TIME = 0.55;
const COG_STAGGER = 0.12;
const COG_RISE = 0.54;
/** Halo size over the card size, and the hit quad's margin around the card. */
const HALO_SCALE = 2.1;
const HIT_SCALE = 1.5;
/** A collider this low and rising from the floor is a surface the coffer stands on (a desk), not a wall. */
const SURFACE_MAX = 1.5;
const FLOOR_EPS = 0.05;

/** The two materials a coffer is dressed in; `wood` is its body and lid, `brass` the bands and latch. */
export interface LootMaterials {
  readonly wood: THREE.Material;
  readonly brass: THREE.Material;
}

/** `inner` is the darker wood lining the hollow body and lid, derived from `wood` by `dress`. */
type Slot = keyof LootMaterials | 'inner';
/** Inner wood brightness relative to the outer wood. */
const INNER_SHADE = 0.42;

/**
 * A card face for a coffer to raise: drawn in its object's local xy plane, centred, facing +z,
 * `width` by `height` metres. The coffer owns it from `showCard` on and calls `dispose` when the card
 * is claimed or the floor goes.
 */
export interface CofferCardFace {
  readonly object: THREE.Object3D;
  readonly width: number;
  readonly height: number;
  dispose(): void;
}

/** Top of the surface under floor point (x, z): the highest low collider covering it, else the floor. */
export function surfaceHeightAt(colliders: readonly Box[], x: number, z: number): number {
  let top = 0;
  for (const c of colliders) {
    if (c.min[1] > FLOOR_EPS || c.max[1] > SURFACE_MAX) continue;
    if (x >= c.min[0] && x <= c.max[0] && z >= c.min[2] && z <= c.max[2])
      top = Math.max(top, c.max[1]);
  }
  return top;
}

export interface Coffer {
  /** Room-local group at the loot socket, named `coffer-<room>-<socketId>`. */
  readonly object: THREE.Group;
  readonly room: number;
  readonly socketId: string;
  readonly kind: LootKind;
  /** The `RunState.openedLoot` key. */
  readonly key: string;
  /** The invisible box a ray tests. */
  readonly hit: THREE.Mesh;
  readonly keyLockHit: THREE.Mesh | null;
  readonly opened: boolean;
  unlock(immediate?: boolean): boolean;
  /** Shows or hides the dedicated brass-key lock without changing encounter locking. */
  syncKeyLock(spent: boolean, immediate?: boolean): void;
  flyKey(model: THREE.Object3D, from: THREE.Vector3, arrive: () => void): boolean;
  /** The card rising or hovering over the open coffer, waiting to be claimed; null once it flies off. */
  readonly card: string | null;
  /** The invisible quad a ray tests to claim the card once it hovers (not while it rises), else null. */
  readonly cardHit: THREE.Mesh | null;
  /** Starts the lid swinging (or jumps it open when `animate` is false). Idempotent. */
  open(animate: boolean): void;
  /**
   * Raises `face` (card `cardId`) out of the coffer once the lid is up, then keeps it hovering, turned
   * toward `viewer`. With `animate` false it hovers at once (a resumed run). Ignored while a card is
   * already shown; the face is then disposed.
   */
  showCard(
    cardId: string,
    face: CofferCardFace,
    animate: boolean,
    viewer: THREE.Object3D | null,
  ): void;
  /** Queues a visible, sequential cog reward reveal before the card rises. */
  showCogs(amount: number): void;
  /**
   * Sends the waiting card to `to` (stopping `standoff` metres short, toward the coffer), shrinking it
   * away and freeing it. Returns false when no card waits.
   */
  claimCard(to: THREE.Object3D, standoff?: number): boolean;
  update(dt: number): void;
}

const easeOut = (t: number): number => 1 - (1 - t) ** 3;

/** Writes a `color` attribute: the candle colour scaled by `glow(position)`, clamped to [0, 1]. */
function glowing<T extends THREE.BufferGeometry>(
  geometry: T,
  glow: (x: number, y: number, z: number) => number,
): T {
  const candle = new THREE.Color(PALETTE.candle);
  const position = geometry.getAttribute('position');
  const colors = new Float32Array(position.count * 3);
  for (let i = 0; i < position.count; i++) {
    const k = Math.max(0, Math.min(1, glow(position.getX(i), position.getY(i), position.getZ(i))));
    colors.set([candle.r * k, candle.g * k, candle.b * k], i * 3);
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geometry;
}

/** Turns an indexed geometry inside out: reversed winding and normals, so its inside is the front. */
function inward<T extends THREE.BufferGeometry>(geometry: T): T {
  const index = geometry.getIndex();
  if (index) {
    for (let i = 0; i < index.count; i += 3) {
      const a = index.getX(i);
      index.setX(i, index.getX(i + 2));
      index.setX(i + 2, a);
    }
  }
  const normal = geometry.getAttribute('normal');
  for (let i = 0; i < normal.count; i++)
    normal.setXYZ(i, -normal.getX(i), -normal.getY(i), -normal.getZ(i));
  return geometry;
}

function merged(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const geometry = mergeGeometries(parts);
  for (const part of parts) part.dispose();
  if (!geometry) throw new Error('coffer parts do not merge');
  return geometry;
}

/** A brass padlock with an open shackle loop and a cut-through keyhole. */
function padlockGeometry(): THREE.BufferGeometry {
  const outline = new THREE.Shape();
  outline.moveTo(-0.073, 0.035);
  outline.lineTo(0.073, 0.035);
  outline.lineTo(0.073, -0.041);
  outline.lineTo(0.057, -0.058);
  outline.lineTo(-0.057, -0.058);
  outline.lineTo(-0.073, -0.041);
  outline.closePath();
  const keyhole = new THREE.Path();
  keyhole.absarc(0, 0, 0.016, -Math.PI / 3, (4 * Math.PI) / 3, false);
  keyhole.lineTo(-0.013, -0.035);
  keyhole.lineTo(0.013, -0.035);
  keyhole.closePath();
  outline.holes.push(keyhole);
  // Keep the whole silhouette in one extrusion, with a brass arch behind the lock body.
  const arch = new THREE.Shape();
  arch.moveTo(-0.052, 0.029);
  arch.lineTo(-0.052, 0.066);
  arch.absarc(0, 0.066, 0.052, Math.PI, 0, true);
  arch.lineTo(0.052, 0.029);
  arch.lineTo(0.033, 0.029);
  arch.absarc(0, 0.066, 0.033, 0, Math.PI, false);
  arch.lineTo(-0.033, 0.029);
  arch.closePath();
  return merged([
    new THREE.ExtrudeGeometry(outline, { depth: 0.03, bevelEnabled: false, curveSegments: 10 }),
    new THREE.ExtrudeGeometry(arch, {
      depth: 0.014,
      bevelEnabled: false,
      curveSegments: 10,
    }).translate(0, 0, 0.011),
  ]);
}

/** Hollow body: a solid base up to the inner floor and four walls up to the rim. */
function bodyGeometry(): THREE.BufferGeometry {
  const wallY = FLOOR_Y + COFFER_INNER_DEPTH / 2;
  return merged([
    new THREE.BoxGeometry(WIDTH, FLOOR_Y, DEPTH).translate(0, FLOOR_Y / 2, 0),
    new THREE.BoxGeometry(WIDTH, COFFER_INNER_DEPTH, WALL).translate(0, wallY, -(DEPTH - WALL) / 2),
    new THREE.BoxGeometry(WIDTH, COFFER_INNER_DEPTH, WALL).translate(0, wallY, (DEPTH - WALL) / 2),
    new THREE.BoxGeometry(WALL, COFFER_INNER_DEPTH, INNER_D).translate(
      -(WIDTH - WALL) / 2,
      wallY,
      0,
    ),
    new THREE.BoxGeometry(WALL, COFFER_INNER_DEPTH, INNER_D).translate(
      (WIDTH - WALL) / 2,
      wallY,
      0,
    ),
  ]);
}

/** The inner floor and the inner faces of the four walls, a millimetre proud of the wood. */
function innerGeometry(): THREE.BufferGeometry {
  const y = FLOOR_Y + COFFER_INNER_DEPTH / 2;
  const e = 0.001;
  return merged([
    new THREE.PlaneGeometry(INNER_W, INNER_D).rotateX(-Math.PI / 2).translate(0, FLOOR_Y + e, 0),
    new THREE.PlaneGeometry(INNER_W, COFFER_INNER_DEPTH).translate(0, y, -INNER_D / 2 + e),
    new THREE.PlaneGeometry(INNER_W, COFFER_INNER_DEPTH)
      .rotateY(Math.PI)
      .translate(0, y, INNER_D / 2 - e),
    new THREE.PlaneGeometry(INNER_D, COFFER_INNER_DEPTH)
      .rotateY(Math.PI / 2)
      .translate(-INNER_W / 2 + e, y, 0),
    new THREE.PlaneGeometry(INNER_D, COFFER_INNER_DEPTH)
      .rotateY(-Math.PI / 2)
      .translate(INNER_W / 2 - e, y, 0),
  ]);
}

/**
 * The light inside an open coffer, additive vertex colour: a warm pool on the inner floor, the inner
 * walls lit from below and fading to the rim, and a haze rising from the opening.
 */
function glowGeometry(): THREE.BufferGeometry {
  const e = 0.002;
  const pool = (x: number, z: number): number =>
    1 - 0.65 * Math.hypot((2 * x) / INNER_W, (2 * z) / INNER_D) ** 2;
  const wall = (y: number): number => 0.75 * (1 - (y - FLOOR_Y) / COFFER_INNER_DEPTH) ** 1.5;
  const haze = (x: number, y: number, span: number): number =>
    0.55 * (1 - (y - FLOOR_Y) / HAZE_HEIGHT) ** 2 * (1 - ((2 * x) / span) ** 2);
  const y = FLOOR_Y + COFFER_INNER_DEPTH / 2;
  const hazeY = FLOOR_Y + HAZE_HEIGHT / 2;
  return merged([
    glowing(
      new THREE.PlaneGeometry(INNER_W, INNER_D, 6, 4)
        .rotateX(-Math.PI / 2)
        .translate(0, FLOOR_Y + e, 0),
      (x, _y, z) => pool(x, z),
    ),
    glowing(
      new THREE.PlaneGeometry(INNER_W, COFFER_INNER_DEPTH, 1, 3).translate(0, y, -INNER_D / 2 + e),
      (_x, py) => wall(py),
    ),
    glowing(
      new THREE.PlaneGeometry(INNER_W, COFFER_INNER_DEPTH, 1, 3)
        .rotateY(Math.PI)
        .translate(0, y, INNER_D / 2 - e),
      (_x, py) => wall(py),
    ),
    glowing(
      new THREE.PlaneGeometry(INNER_D, COFFER_INNER_DEPTH, 1, 3)
        .rotateY(Math.PI / 2)
        .translate(-INNER_W / 2 + e, y, 0),
      (_x, py) => wall(py),
    ),
    glowing(
      new THREE.PlaneGeometry(INNER_D, COFFER_INNER_DEPTH, 1, 3)
        .rotateY(-Math.PI / 2)
        .translate(INNER_W / 2 - e, y, 0),
      (_x, py) => wall(py),
    ),
    glowing(new THREE.PlaneGeometry(INNER_W, HAZE_HEIGHT, 6, 4).translate(0, hazeY, 0), (x, py) =>
      haze(x, py, INNER_W),
    ),
    glowing(
      new THREE.PlaneGeometry(INNER_D, HAZE_HEIGHT, 4, 4)
        .rotateY(Math.PI / 2)
        .translate(0, hazeY, 0),
      (_x, py, z) => haze(z, py, INNER_D),
    ),
  ]);
}

/** Half a barrel (the upper half), its axis along x, `radius` round and `length` long, open-ended. */
function vault(radius: number, length: number): THREE.CylinderGeometry {
  return new THREE.CylinderGeometry(radius, radius, length, 14, 1, true, 0, Math.PI).rotateZ(
    Math.PI / 2,
  );
}

/** The barrel lid's outer shell with solid wooden ends, hinge-local about z = 0. */
function lidGeometry(): THREE.BufferGeometry {
  const end = (side: 1 | -1): THREE.BufferGeometry =>
    new THREE.CircleGeometry(LID_RADIUS, 14, 0, Math.PI)
      .rotateY((side * Math.PI) / 2)
      .translate((side * WIDTH) / 2, 0, 0);
  return merged([vault(LID_RADIUS, WIDTH), end(1), end(-1)]);
}

function rewardCogGeometry(): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  const segments = 32;
  for (let i = 0; i < segments; i++) {
    const angle = (i * 2 * Math.PI) / segments;
    const radius = i % 4 === 1 || i % 4 === 2 ? 0.047 : 0.036;
    const x = Math.cos(angle) * radius;
    const y = Math.sin(angle) * radius;
    if (i === 0) shape.moveTo(x, y);
    else shape.lineTo(x, y);
  }
  shape.closePath();
  const hole = new THREE.Path();
  hole.absarc(0, 0, 0.015, 0, 2 * Math.PI, true);
  shape.holes.push(hole);
  return new THREE.ExtrudeGeometry(shape, {
    bevelEnabled: false,
    curveSegments: 10,
    depth: 0.012,
  }).center();
}

/** The brass frame round the lid's open face, sitting on the rim when it is shut. */
function lidRimGeometry(): THREE.BufferGeometry {
  const h = 0.012;
  const y = h / 2 + 0.001;
  const proud = 0.003;
  const strip = LID_SHELL + 0.006;
  const width = WIDTH + 2 * proud;
  const depth = DEPTH + 2 * proud;
  const endZ = (depth - strip) / 2;
  const sideX = (width - strip) / 2;
  // The rails meet edge to edge and stand proud of the wooden end caps.
  return merged([
    new THREE.BoxGeometry(width - 2 * strip, h, strip).translate(0, y, -endZ),
    new THREE.BoxGeometry(width - 2 * strip, h, strip).translate(0, y, endZ),
    new THREE.BoxGeometry(strip, h, depth).translate(-sideX, y, 0),
    new THREE.BoxGeometry(strip, h, depth).translate(sideX, y, 0),
  ]);
}

const BAND_X = 0.22;
const BAND_W = 0.06;
const BAND_PROUD = 0.012;

/** The two brass straps down the body's front and back. */
function bodyBandGeometry(): THREE.BufferGeometry {
  const h = BODY_HEIGHT + BAND_PROUD;
  const z = DEPTH / 2 + BAND_PROUD / 2;
  return merged(
    [-BAND_X, BAND_X].flatMap((x) => [
      new THREE.BoxGeometry(BAND_W, h, BAND_PROUD).translate(x, BODY_HEIGHT / 2, -z),
      new THREE.BoxGeometry(BAND_W, h, BAND_PROUD).translate(x, BODY_HEIGHT / 2, z),
    ]),
  );
}

/** The two brass straps over the lid, open-ended so the lid's hollow shows from below. */
function lidBandGeometry(): THREE.BufferGeometry {
  return merged(
    [-BAND_X, BAND_X].map((x) => vault(LID_RADIUS + BAND_PROUD, BAND_W).translate(x, 0, 0)),
  );
}

/** A unit quad whose additive colour falls off from its centre: the soft halo behind a card. */
function haloGeometry(): THREE.BufferGeometry {
  return glowing(
    new THREE.PlaneGeometry(1, 1, 8, 8),
    (x, y) => 0.85 * Math.max(0, 1 - 2 * Math.hypot(x, y)) ** 2,
  );
}

/**
 * Shared geometry and the placeholder materials for every coffer on one floor: a hollow walnut
 * chest with a barrel lid, brass bands and an amber latch gem, lit from inside when open, and the
 * card a card coffer raises. The kit owns what it creates (and the card faces handed to `showCard`);
 * materials handed to `dress` stay the caller's. No lights: the glowing parts are unlit, additive or
 * basic materials.
 */
export class CofferKit {
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly ownedMaterials: THREE.Material[] = [];
  private readonly slotted: { mesh: THREE.Mesh; slot: Slot }[] = [];
  private readonly liveCards = new Set<() => void>();
  private readonly wood = new THREE.MeshStandardMaterial({
    color: PALETTE.walnut,
    roughness: 0.75,
    metalness: 0.05,
  });
  private readonly brass = new THREE.MeshStandardMaterial({
    color: PALETTE.brass,
    roughness: 0.4,
    metalness: 0.55,
  });
  private inner: THREE.Material = new THREE.MeshStandardMaterial({
    color: new THREE.Color(PALETTE.walnut).multiplyScalar(INNER_SHADE),
    roughness: 0.85,
    metalness: 0,
  });
  private readonly amber = new THREE.MeshBasicMaterial({
    color: PALETTE.candle,
    toneMapped: false,
  });
  private readonly light = new THREE.MeshBasicMaterial({
    vertexColors: true,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
  private readonly invisible = new THREE.MeshBasicMaterial({ visible: false });
  private readonly body = this.geometry(bodyGeometry());
  private readonly innerShell = this.geometry(innerGeometry());
  private readonly lid = this.geometry(lidGeometry());
  private readonly rewardCog = this.geometry(rewardCogGeometry());
  private readonly lidInner = this.geometry(inward(vault(LID_RADIUS - LID_SHELL, WIDTH)));
  private readonly lidInnerEnds = ([-1, 1] as const).map((side) =>
    this.geometry(
      inward(
        new THREE.CircleGeometry(LID_RADIUS - LID_SHELL, 14, 0, Math.PI).rotateY(
          (side * Math.PI) / 2,
        ),
      ),
    ),
  );
  private readonly lidRim = this.geometry(lidRimGeometry());
  private readonly bodyBand = this.geometry(bodyBandGeometry());
  private readonly lidBand = this.geometry(lidBandGeometry());
  private readonly latch = this.geometry(new THREE.BoxGeometry(0.1, 0.12, 0.035));
  private readonly lock = this.geometry(padlockGeometry());
  private readonly lockHitBox = this.geometry(new THREE.BoxGeometry(0.17, 0.24, 0.07));
  private readonly gem = this.geometry(new THREE.SphereGeometry(0.032, 10, 8));
  private readonly glow = this.geometry(glowGeometry());
  private readonly halo = this.geometry(haloGeometry());
  private readonly cardHitBox = this.geometry(new THREE.BoxGeometry(1, 1, 0.06));
  private readonly hitBox = this.geometry(new THREE.BoxGeometry(WIDTH + 0.2, 0.62, DEPTH + 0.2));
  private dressing: LootMaterials | null = null;

  constructor() {
    this.ownedMaterials.push(this.wood, this.brass, this.amber, this.light, this.invisible);
  }

  private geometry<T extends THREE.BufferGeometry>(g: T): T {
    this.geometries.push(g);
    return g;
  }

  private material(slot: Slot): THREE.Material {
    if (slot === 'inner') return this.inner;
    return this.dressing?.[slot] ?? (slot === 'wood' ? this.wood : this.brass);
  }

  private part(
    geometry: THREE.BufferGeometry,
    slot: Slot,
    parent: THREE.Object3D,
    name: string,
  ): THREE.Mesh {
    const mesh = new THREE.Mesh(geometry, this.material(slot));
    mesh.name = name;
    parent.add(mesh);
    this.slotted.push({ mesh, slot });
    return mesh;
  }

  /**
   * Swaps the wood and brass of every coffer built so far (and later ones) to `materials`; the inner
   * lining becomes a darkened clone of `materials.wood`, owned by the kit.
   */
  dress(materials: LootMaterials): void {
    this.dressing = materials;
    this.inner.dispose();
    const inner = materials.wood.clone();
    inner.name = `${materials.wood.name || 'wood'}-inner`;
    const tinted = inner as THREE.Material & { color?: THREE.Color };
    tinted.color?.multiplyScalar(INNER_SHADE);
    this.inner = inner;
    for (const { mesh, slot } of this.slotted) mesh.material = this.material(slot);
  }

  /** Builds the coffer for `socket` of `room`, standing `surface` metres above the room floor. */
  build(
    room: number,
    socket: Socket,
    kind: LootKind,
    surface: number,
    locked = false,
    keyLocked = false,
  ): Coffer {
    const object = new THREE.Group();
    object.name = `coffer-${room}-${socket.id}`;
    object.position.set(socket.position[0], socket.position[1] + surface, socket.position[2]);
    object.rotation.y = (-socket.yaw * Math.PI) / 180;
    this.part(this.body, 'wood', object, 'coffer-body');
    this.part(this.innerShell, 'inner', object, 'coffer-inner');
    this.part(this.bodyBand, 'brass', object, 'coffer-band');
    const hinge = new THREE.Group();
    hinge.name = 'coffer-lid';
    hinge.position.set(0, BODY_HEIGHT, DEPTH / 2);
    object.add(hinge);
    this.part(this.lid, 'wood', hinge, 'coffer-lid-top').position.z = -DEPTH / 2;
    this.part(this.lidInner, 'inner', hinge, 'coffer-lid-inner').position.z = -DEPTH / 2;
    for (const [index, side] of [-1, 1].entries()) {
      const end = this.part(
        this.lidInnerEnds[index] as THREE.BufferGeometry,
        'inner',
        hinge,
        `coffer-lid-inner-end-${side}`,
      );
      end.position.set(side * (WIDTH / 2 - LID_SHELL), 0, -DEPTH / 2);
    }
    this.part(this.lidRim, 'brass', hinge, 'coffer-lid-rim').position.z = -DEPTH / 2;
    this.part(this.lidBand, 'brass', hinge, 'coffer-lid-band').position.z = -DEPTH / 2;
    const latch = this.part(this.latch, 'brass', object, 'coffer-latch');
    latch.position.set(0, BODY_HEIGHT - 0.03, -DEPTH / 2 - 0.012);
    const gem = new THREE.Mesh(this.gem, this.amber);
    gem.name = 'coffer-gem';
    gem.position.set(0, BODY_HEIGHT - 0.03, -DEPTH / 2 - 0.04);
    object.add(gem);
    const padlock =
      locked || keyLocked ? this.part(this.lock, 'brass', object, 'coffer-padlock') : null;
    if (padlock) {
      padlock.position.set(0, BODY_HEIGHT - 0.068, -DEPTH / 2 - 0.061);
      gem.visible = false;
    }
    const padlockStart = padlock?.position.clone() ?? null;
    const lockHit = keyLocked && padlock ? new THREE.Mesh(this.lockHitBox, this.invisible) : null;
    if (lockHit && padlock) {
      lockHit.name = 'coffer-key-lock-hit';
      lockHit.position.z = -0.026;
      padlock.add(lockHit);
    }
    const glow = new THREE.Mesh(this.glow, this.light);
    glow.name = 'coffer-glow';
    glow.visible = false;
    glow.raycast = () => undefined;
    object.add(glow);
    const hit = new THREE.Mesh(this.hitBox, this.invisible);
    hit.name = 'coffer-hit';
    hit.position.y = 0.3;
    object.add(hit);

    let angle = 0;
    let target = 0;
    let unlockProgress = padlock ? 0 : 1;
    let unlocking = false;
    let secured = locked || keyLocked;
    let clock = 0;
    let keyFlight: {
      object: THREE.Object3D;
      from: THREE.Vector3;
      to: THREE.Vector3;
      elapsed: number;
      arrive: () => void;
    } | null = null;
    const cogs = this.cogSlot(object, () => angle >= RISE_ANGLE);
    const card = this.cardSlot(object, () => angle >= RISE_ANGLE && cogs.done());
    const coffer: Coffer = {
      object,
      room,
      socketId: socket.id,
      kind,
      key: lootKey(room, socket.id),
      hit,
      get keyLockHit() {
        return secured ? lockHit : null;
      },
      get opened() {
        return target === OPEN_ANGLE;
      },
      unlock(immediate = false) {
        if (!padlock || !secured) return false;
        secured = false;
        if (immediate) {
          padlock.visible = false;
          gem.visible = true;
          unlockProgress = 1;
        } else {
          unlocking = true;
        }
        return true;
      },
      syncKeyLock(spent, immediate = false) {
        if (keyLocked && spent) this.unlock(immediate);
      },
      flyKey(model, from, arrive) {
        if (!keyLocked || !secured || keyFlight || !padlockStart) return false;
        const key = model.clone(true);
        key.name = 'coffer-flying-key';
        const start = object.worldToLocal(from.clone());
        key.position.copy(start);
        key.rotation.set(0, 0, 0);
        object.add(key);
        keyFlight = {
          object: key,
          from: start,
          to: padlockStart.clone().add(new THREE.Vector3(0, 0, -0.096)),
          elapsed: 0,
          arrive,
        };
        return true;
      },
      get card() {
        return card.waiting();
      },
      get cardHit() {
        return card.hovering() ? card.hit : null;
      },
      open(animate) {
        if (secured) return;
        target = OPEN_ANGLE;
        if (!animate) {
          angle = OPEN_ANGLE;
          hinge.rotation.x = angle;
          glow.visible = true;
        }
      },
      showCard(cardId, face, animate, viewer) {
        card.show(cardId, face, animate, viewer);
      },
      showCogs(amount) {
        cogs.show(amount);
      },
      claimCard(to, standoff = 0.3) {
        return card.claim(to, standoff);
      },
      update(dt) {
        clock += dt;
        if (keyFlight) {
          const flight = keyFlight;
          flight.elapsed += dt;
          const travel = Math.min(1, flight.elapsed / 0.55);
          const turn = THREE.MathUtils.clamp((flight.elapsed - 0.55) / 0.22, 0, 1);
          flight.object.position.lerpVectors(flight.from, flight.to, travel);
          flight.object.position.y += Math.sin(travel * Math.PI) * 0.14;
          flight.object.rotation.set((-travel * Math.PI) / 2, 0, (turn * Math.PI) / 2, 'ZYX');
          if (turn === 1) {
            keyFlight = null;
            flight.object.removeFromParent();
            flight.arrive();
          }
        }
        if (unlocking && padlock && padlockStart) {
          unlockProgress = Math.min(1, unlockProgress + Math.max(0, dt) * 5);
          padlock.position.y = padlockStart.y - 0.08 * unlockProgress;
          padlock.rotation.z = 0.55 * unlockProgress;
          if (unlockProgress >= 1) {
            padlock.visible = false;
            unlocking = false;
            gem.visible = true;
          }
        }
        if (angle < target) {
          angle = Math.min(target, angle + OPEN_RATE * dt);
          hinge.rotation.x = angle;
          glow.visible = angle > GLOW_ANGLE;
        }
        const pulse = target > 0 ? 0.6 : 1 + 0.22 * Math.sin(clock * 2.4);
        gem.scale.setScalar(pulse);
        cogs.update(dt);
        card.update(dt, clock);
      },
    };
    object.userData.coffer = coffer;
    return coffer;
  }

  /** Sequentially lifts the visible cog reward from the open coffer. */
  private cogSlot(coffer: THREE.Group, lidUp: () => boolean) {
    const root = new THREE.Group();
    root.name = 'coffer-cogs';
    coffer.add(root);
    const cogs: THREE.Mesh[] = [];
    let elapsed = 0;
    let state: 'none' | 'waiting' | 'rising' | 'done' = 'none';
    const show = (amount: number): void => {
      if (state !== 'none') return;
      const count = Math.max(0, Math.floor(amount));
      if (count === 0) {
        state = 'done';
        return;
      }
      for (let i = 0; i < count; i++) {
        const cog = new THREE.Mesh(this.rewardCog, this.material('brass'));
        cog.name = `coffer-cog-${i}`;
        cog.rotation.x = -0.35;
        cog.position.set(((i % 3) - 1) * 0.09, FLOOR_Y + 0.02, 0);
        cog.visible = false;
        root.add(cog);
        cogs.push(cog);
      }
      elapsed = 0;
      state = 'waiting';
    };
    return {
      show,
      done: (): boolean => state === 'none' || state === 'done',
      update: (dt: number): void => {
        if (state === 'waiting' && lidUp()) state = 'rising';
        if (state !== 'rising') return;
        elapsed += dt;
        for (let i = 0; i < cogs.length; i++) {
          const t = Math.max(0, Math.min(1, (elapsed - i * COG_STAGGER) / COG_RISE_TIME));
          const cog = cogs[i];
          if (!cog) continue;
          cog.visible = t > 0 && t < 1;
          cog.position.y = FLOOR_Y + 0.02 + COG_RISE * easeOut(t);
          cog.position.z = -0.08 * t;
          cog.scale.setScalar(Math.min(1, (1 - t) * 3));
          cog.rotation.z += dt * 3;
        }
        if (elapsed >= (cogs.length - 1) * COG_STAGGER + COG_RISE_TIME) {
          for (const cog of cogs) cog.removeFromParent();
          cogs.length = 0;
          state = 'done';
        }
      },
    };
  }

  /**
   * The card one coffer raises: rising once `lidUp()`, hovering with a bob turned to the viewer,
   * then flying to whoever claimed it. Its group is added on `show` and removed when it is gone.
   */
  private cardSlot(coffer: THREE.Group, lidUp: () => boolean) {
    const root = new THREE.Group();
    root.name = 'coffer-card';
    const hit = new THREE.Mesh(this.cardHitBox, this.invisible);
    hit.name = 'coffer-card-hit';
    root.add(hit);
    const haloMaterial = new THREE.MeshBasicMaterial({
      vertexColors: true,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
      toneMapped: false,
    });
    this.ownedMaterials.push(haloMaterial);
    const halo = new THREE.Mesh(this.halo, haloMaterial);
    halo.name = 'coffer-card-halo';
    halo.raycast = () => undefined;
    root.add(halo);
    const back = this.part(this.cardHitBox, 'brass', root, 'coffer-card-back');
    back.raycast = () => undefined;

    const startY = FLOOR_Y + CARD_START_LIFT;
    const hoverY = startY + CARD_RISE;
    const viewerAt = new THREE.Vector3();
    const from = new THREE.Vector3();
    const goal = new THREE.Vector3();
    let id: string | null = null;
    let face: CofferCardFace | null = null;
    let viewer: THREE.Object3D | null = null;
    let state: 'none' | 'waiting' | 'rising' | 'hovering' | 'flying' = 'none';
    let t = 0;
    let yaw = Math.PI;
    let flyTo: THREE.Object3D | null = null;
    let standoff = 0;

    const release = (): void => {
      root.removeFromParent();
      face?.object.removeFromParent();
      face?.dispose();
      face = null;
      id = null;
      state = 'none';
      this.liveCards.delete(release);
    };
    /** The viewer's position in coffer space, or null. */
    const viewerLocal = (of: THREE.Object3D | null): THREE.Vector3 | null => {
      if (!of) return null;
      of.getWorldPosition(viewerAt);
      coffer.updateWorldMatrix(true, false);
      return coffer.worldToLocal(viewerAt);
    };
    const turnToViewer = (clock: number, dt: number): void => {
      const at = viewerLocal(viewer);
      const want = at ? Math.atan2(at.x - root.position.x, at.z - root.position.z) : Math.PI;
      let delta = want - yaw;
      delta = Math.atan2(Math.sin(delta), Math.cos(delta));
      yaw += delta * Math.min(1, dt * CARD_TURN_RATE);
      root.rotation.set(0, yaw + CARD_SWAY * Math.sin(clock * 0.7), 0, 'YXZ');
      if (at) {
        const across = Math.hypot(at.x - root.position.x, at.z - root.position.z);
        root.rotation.x = -Math.max(
          -0.4,
          Math.min(0.4, Math.atan2(at.y - root.position.y, across)),
        );
      }
    };

    return {
      hit,
      hovering: (): boolean => state === 'hovering',
      waiting: (): string | null =>
        state === 'waiting' || state === 'rising' || state === 'hovering' ? id : null,
      show: (
        cardId: string,
        next: CofferCardFace,
        animate: boolean,
        seen: THREE.Object3D | null,
      ): void => {
        if (state !== 'none') {
          next.dispose();
          return;
        }
        id = cardId;
        face = next;
        viewer = seen;
        root.add(next.object);
        const { width, height } = next;
        hit.scale.set(width * HIT_SCALE, height * HIT_SCALE, 1);
        halo.scale.set(width * HALO_SCALE, height * HALO_SCALE * 0.8, 1);
        halo.position.z = -0.006;
        back.scale.set(width, height, 0.05);
        back.position.z = -0.0025;
        haloMaterial.opacity = 1;
        coffer.add(root);
        this.liveCards.add(release);
        t = 0;
        state = animate || !lidUp() ? 'waiting' : 'hovering';
        root.position.set(0, animate ? startY : hoverY, 0);
        root.scale.setScalar(animate ? CARD_START_SCALE : 1);
        root.visible = state === 'hovering';
      },
      claim: (to: THREE.Object3D, gap: number): boolean => {
        if (state === 'none' || state === 'flying') return false;
        state = 'flying';
        t = 0;
        flyTo = to;
        standoff = gap;
        root.visible = true;
        from.copy(root.position);
        return true;
      },
      update: (dt: number, clock: number): void => {
        if (state === 'waiting' && lidUp()) {
          state = 'rising';
          root.visible = true;
        }
        if (state === 'rising') {
          t = Math.min(1, t + dt / CARD_RISE_TIME);
          const k = easeOut(t);
          root.position.y = startY + CARD_RISE * k;
          root.scale.setScalar(CARD_START_SCALE + (1 - CARD_START_SCALE) * k);
          turnToViewer(clock, dt);
          if (t >= 1) state = 'hovering';
        } else if (state === 'hovering') {
          root.position.y = hoverY + CARD_BOB * Math.sin(clock * CARD_BOB_RATE);
          turnToViewer(clock, dt);
        } else if (state === 'flying') {
          t = Math.min(1, t + dt / CARD_FLIGHT_SECONDS);
          const at = viewerLocal(flyTo);
          if (at) flightGoal(from, at, standoff, goal);
          else goal.copy(from);
          const k = flightPose(from, goal, t, root.position);
          root.scale.setScalar(flightScale(k));
          haloMaterial.opacity = 1 - k;
          if (t >= 1) release();
        }
      },
    };
  }

  dispose(): void {
    for (const release of [...this.liveCards]) release();
    for (const g of this.geometries) g.dispose();
    for (const m of this.ownedMaterials) m.dispose();
    this.inner.dispose();
    this.slotted.length = 0;
  }
}

/** What a ray found: the coffer's identity for `RunFlow.openLoot` (or `claimLoot`), and how far away it is. */
export interface LootPick {
  readonly room: number;
  readonly socketId: string;
  readonly kind: LootKind;
  readonly distance: number;
  /** True when the ray found the card waiting over an open coffer (claim it), false for a shut coffer (open it). */
  readonly claim: boolean;
  readonly lock?: true;
}

/**
 * First thing in `coffers` the ray reaches within `maxDistance`: a shut coffer to open or the card
 * waiting over an open one to claim; null when none.
 */
export function pickCoffer(
  coffers: readonly Coffer[],
  origin: THREE.Vector3,
  direction: THREE.Vector3,
  maxDistance: number,
): LootPick | null {
  const raycaster = new THREE.Raycaster(origin, direction.clone().normalize(), 0, maxDistance);
  let best: LootPick | null = null;
  for (const coffer of coffers) {
    const target = coffer.opened ? coffer.cardHit : coffer.hit;
    if (!target) continue;
    target.updateWorldMatrix(true, false);
    const lock = coffer.keyLockHit;
    const lockFromFront = lock && lock.worldToLocal(origin.clone()).z < 0;
    const lockHit = lockFromFront ? raycaster.intersectObject(lock, false)[0] : undefined;
    const hit = lockHit ?? raycaster.intersectObject(target, false)[0];
    if (hit && (best === null || hit.distance < best.distance)) {
      best = {
        room: coffer.room,
        socketId: coffer.socketId,
        kind: coffer.kind,
        distance: hit.distance,
        claim: coffer.opened,
        ...(lockHit ? { lock: true } : {}),
      };
    }
  }
  return best;
}

/** The coffer in `coffers` whose waiting card is nearest `point` and within `reach` metres (a hand grab), or null. */
export function nearestCard(
  coffers: readonly Coffer[],
  point: THREE.Vector3,
  reach: number,
): Coffer | null {
  let best: Coffer | null = null;
  let bestDistance = reach;
  const at = new THREE.Vector3();
  for (const coffer of coffers) {
    const hit = coffer.cardHit;
    if (!hit || coffer.card === null) continue;
    const distance = hit.getWorldPosition(at).distanceTo(point);
    if (distance <= bestDistance) {
      best = coffer;
      bestDistance = distance;
    }
  }
  return best;
}

/** The two lines the in-scene panel shows. The first is what was found or gained. */
export interface ToastLines {
  readonly text: string;
  readonly caption: string;
}

/** The two lines the toast shows for a pickup. The first is what was found. */
export function lootLines(loot: TreasureLoot): ToastLines {
  return loot.kind === 'cogs'
    ? { text: `+${loot.cogs} cogs`, caption: 'Added to your purse' }
    : { text: `New card: ${getCard(loot.card).name}`, caption: 'Added to your deck' };
}

/** Drawn at 768 x 256 and stored at 2x: the panel is read from 1-2 m, where 640 px/m magnified. */
const TOAST_PX = { w: 1536, h: 512 };
const TOAST_DRAW_SCALE = 2;
const TOAST_WIDTH = 1.2;
const TOAST_LIFE = 4.2;
const TOAST_FADE = 0.25;
const TOAST_RISE = 0.12;

/** An in-scene panel over an opened coffer or a used hearth: shows the result, faces the head and fades out. */
export class LootToast {
  readonly root = new THREE.Group();
  readonly text: string;
  private readonly label: CanvasLabel;
  private readonly base = new THREE.Vector3();
  private age = 0;

  constructor(found: TreasureLoot | ToastLines, at: THREE.Vector3) {
    const { text, caption } = 'caption' in found ? found : lootLines(found);
    this.text = text;
    const measure = document.createElement('canvas').getContext('2d');
    if (!measure) throw new Error('2D canvas is not available');
    const captionFont = '500 38px system-ui, sans-serif';
    measure.font = captionFont;
    const innerWidth = TOAST_PX.w / TOAST_DRAW_SCALE - 92;
    const captionLines = measuredLines(measure, caption, innerWidth);
    const leading = 47;
    const extraHeight = Math.max(0, captionLines.length - 1) * leading * TOAST_DRAW_SCALE;
    this.label = new CanvasLabel(TOAST_PX.w, TOAST_PX.h + extraHeight, TOAST_WIDTH);
    this.label.draw((ctx, pw, ph) => {
      ctx.scale(TOAST_DRAW_SCALE, TOAST_DRAW_SCALE);
      const w = pw / TOAST_DRAW_SCALE;
      const h = ph / TOAST_DRAW_SCALE;
      ctx.fillStyle = PALETTE.warmBlack;
      ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = PALETTE.brass;
      ctx.lineWidth = 8;
      ctx.strokeRect(4, 4, w - 8, h - 8);
      ctx.strokeStyle = PALETTE.brassDark;
      ctx.lineWidth = 3;
      ctx.strokeRect(18, 18, w - 36, h - 36);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = PALETTE.candle;
      let size = 92;
      do {
        ctx.font = `700 ${size}px system-ui, sans-serif`;
        size -= 4;
      } while (ctx.measureText(text).width > w - 90 && size > 28);
      ctx.fillText(text, w / 2, 102, innerWidth);
      ctx.font = captionFont;
      ctx.fillStyle = PALETTE.parchment;
      for (const [i, line] of captionLines.entries())
        ctx.fillText(line, w / 2, 191 + i * leading, innerWidth);
    });
    const { mesh } = this.label;
    mesh.name = 'loot-toast';
    mesh.renderOrder = 20;
    mesh.material.depthTest = false;
    mesh.material.depthWrite = false;
    mesh.raycast = () => undefined;
    this.root.name = 'loot-toast-root';
    this.root.add(mesh);
    this.base.copy(at);
    this.root.position.copy(at);
  }

  /** The canvas the text is drawn on (the scripted checks read what it drew). */
  get canvas(): HTMLCanvasElement {
    return this.label.canvas;
  }

  /** Advances the panel: turns it to `head`, lifts and fades it. Returns false once it has expired. */
  update(dt: number, head: THREE.Vector3): boolean {
    this.age += dt;
    const k = Math.min(1, this.age / TOAST_LIFE);
    this.root.position.set(this.base.x, this.base.y + TOAST_RISE * k, this.base.z);
    this.root.lookAt(head);
    const left = TOAST_LIFE - this.age;
    this.label.mesh.material.opacity = Math.max(0, Math.min(1, left / TOAST_FADE));
    return this.age < TOAST_LIFE;
  }

  dispose(): void {
    this.root.removeFromParent();
    this.label.dispose();
  }
}
