import * as THREE from 'three';
import { BatchedText, Text } from 'troika-three-text';
import { type CardAtlas, frameToCard } from '../cards/card-atlas.ts';
import { BurnPool, burnFrame, newBurnFrame } from '../cards/card-burn.ts';
import {
  addCardFaceAttributes,
  applyCardFaceArt,
  type CardFaceArt,
  cardFaceInstance,
  createCardFaceMaterial,
  loadedCardFaceArt,
  requestCardFaceArt,
  writeCardBurn,
  writeCardFace,
  writeCardTint,
} from '../cards/card-face-material.ts';
import type { SliceCard } from '../content/cards.ts';
import { PALETTE } from '../palette.ts';
import { onFirstRender, sharedKtx2Loader } from '../ui/first-render.ts';
import {
  DEFAULT_FAN,
  type FanOptions,
  type FanRotation,
  type FanSlot,
  fanLayout,
  hitTestFan,
  MAX_HAND,
  type Vec3,
} from './fan-layout.ts';

/**
 * The off-hand card hand. Rendering is a single-pass version of the holo card (a portal card is 8
 * draws each): one InstancedMesh of card faces whose shader samples the card atlas (frame plus the
 * art layers, offset by the view angle so the window reads as a recessed portal), one InstancedMesh
 * of dark discs behind the cost numbers and one troika BatchedText holding every label. The whole
 * hand is 3 draws at any size, hovered or held. The atlas loads (KTX2) the first time the fan is
 * drawn; until then cards are flat tints.
 *
 * A played card (`playOut`) burns away in world space as one of `BURN_SLOTS` spare instances after
 * the hand slots of the same mesh, so the burn costs no extra draw and outlives `setHand`.
 *
 * The fan owns no game rules. It reports intents (hover, grab, release, returned) and the combat
 * controller decides what they mean.
 */

export type CardFanIntent =
  | { type: 'hover'; index: number | null; uid: number | null; card: SliceCard | null }
  | { type: 'grab'; index: number; uid: number; card: SliceCard }
  | { type: 'release'; index: number; uid: number; card: SliceCard }
  | { type: 'returned'; index: number; uid: number; card: SliceCard };

export interface GrabbedCard {
  readonly index: number;
  readonly uid: number;
  readonly card: SliceCard;
}

export interface ReleasedCard extends GrabbedCard {
  /** World-space pose of the card at the moment of release. */
  readonly position: THREE.Vector3;
  readonly quaternion: THREE.Quaternion;
}

export interface CardFanOptions {
  layout?: Partial<FanOptions>;
  /** Main-hand grip a grabbed card follows. Can also be set later or passed to `grab`. */
  mainGrip?: THREE.Object3D;
  /** Run troika typesetting after `setHand`. Off in tests, where no font can be fetched. */
  syncLabels?: boolean;
  /** Load the card atlas on the first render. Default true; tests pass art with `setArt`. */
  loadArt?: boolean;
  hoverSeconds?: number;
  returnSeconds?: number;
}

type CardState = 'fan' | 'grabbed' | 'returning' | 'released';

interface Pose {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  scale: number;
}

const newPose = (): Pose => ({
  position: new THREE.Vector3(),
  quaternion: new THREE.Quaternion(),
  scale: 1,
});

const copyPose = (to: Pose, from: Pose): void => {
  to.position.copy(from.position);
  to.quaternion.copy(from.quaternion);
  to.scale = from.scale;
};

/**
 * Card-local text layout, in units of card width (x) and height (y), from the slice atlas frame's
 * `textRegions` (672 x 1016 px frame): the cost gem medallion at (66, 70) r 40, the name band
 * (88, 722, 496, 60) and the description panel (88, 786, 496, 196). `setArt` re-derives them from
 * the loaded atlas.
 */
interface TextLayout {
  gemAt: readonly [number, number];
  gemDiameter: number;
  titleAt: readonly [number, number];
  titleWidth: number;
  descAt: readonly [number, number];
  descWidth: number;
}
const DEFAULT_TEXT: TextLayout = {
  gemAt: [66 / 672 - 0.5, 0.5 - 70 / 1016],
  gemDiameter: 76 / 672,
  titleAt: [0, 0.5 - 752 / 1016],
  titleWidth: 496 / 672,
  descAt: [88 / 672 - 0.5, 0.5 - 790 / 1016],
  descWidth: 496 / 672,
};
function textLayout(atlas: CardAtlas): TextLayout {
  const frame = atlas.frames.attack;
  const { cost, name, description } = frame.textRegions;
  const [gx, gy] = frameToCard(frame, cost.centre[0], cost.centre[1]);
  const [tx, ty] = frameToCard(
    frame,
    name.rect[0] + name.rect[2] / 2,
    name.rect[1] + name.rect[3] / 2,
  );
  const [dx, dy] = frameToCard(frame, description.rect[0], description.rect[1] + 4);
  return {
    gemAt: [gx, gy],
    gemDiameter: (cost.radius * 2 * 0.95) / frame.rect[2],
    titleAt: [tx, ty],
    titleWidth: name.rect[2] / frame.rect[2],
    descAt: [dx, dy],
    descWidth: description.rect[2] / frame.rect[2],
  };
}
const TITLE_FONT = 0.092;
const DESC_FONT = 0.066;
const COST_FONT = 0.115;
/** Dark ink for text on the parchment panel. */
const INK = '#2a1a0e';
/** Average glyph advance over font size; a long name shrinks until its estimated width fits the band. */
const TITLE_ADVANCE = 0.55;
/**
 * A colour for troika's batched text. BatchedText packs each member colour with `Color.getHex()`,
 * which returns sRGB bytes, but its shader writes them out as linear `diffuse`. The output encode
 * then lifts every colour (the dark ink came out mid grey), so the colour is decoded once more here
 * and the two cancel.
 */
const batchedInk = (css: string): THREE.Color => new THREE.Color(css).convertSRGBToLinear();
const inkColor = batchedInk(INK);
const costColor = batchedInk(PALETTE.candle);
/** Depth offsets above the card face, metres, so layers never z-fight. */
const GEM_Z = 0.0003;
const TEXT_Z = 0.0007;

/** Hover: how far the card rises along its own up, comes toward the face, and grows. */
const HOVER_RISE = 0.38;
const HOVER_FORWARD = 0.012;
const HOVER_GROW = 0.14;
/** A held card sits ahead of the grip, tilted to the eyes and enlarged for reading. */
const HOLD_POSITION = new THREE.Vector3(0, 0.05, -0.06);
const HOLD_PITCH = -0.7;
const HOLD_SCALE = 1.3;
/** Hit-test slack so a card's edge is easy to point at, metres. */
const HIT_MARGIN = 0.004;
/** Cards that can burn at once; a fourth play reuses the oldest slot. */
export const BURN_SLOTS = 3;
/** A burning card drifts this far toward its target (at most half the way), metres. */
const BURN_DRIFT = 0.2;
/** With no target (a table drop) it sinks this far, metres. */
const BURN_SINK = 0.05;
/** Roll about the card normal over the burn, radians. */
const BURN_SPIN = 0.35;

const TYPE_COLOR: Record<SliceCard['type'], string> = {
  attack: PALETTE.ruby,
  skill: PALETTE.emerald,
  sigil: PALETTE.sapphire,
  mechanism: PALETTE.brass,
};

const easeOutBack = (u: number): number => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * (u - 1) ** 3 + c1 * (u - 1) ** 2;
};

const smooth = (t: number): number => t * t * (3 - 2 * t);

const euler = new THREE.Euler(0, 0, 0, 'YXZ');
const tmpMatrix = new THREE.Matrix4();
const tmpLocal = new THREE.Matrix4();
const tmpScale = new THREE.Vector3();
const tmpVec = new THREE.Vector3();
const tmpQuat = new THREE.Quaternion();
const tmpColor = new THREE.Color();
const tmpPose = newPose();
const tmpInverse = new THREE.Matrix4();
const tmpBurnPos = new THREE.Vector3();
const tmpBurnQuat = new THREE.Quaternion();
const ZERO_MATRIX = new THREE.Matrix4().makeScale(0, 0, 0);
const NORMAL_AXIS = new THREE.Vector3(0, 0, 1);
const burnState = newBurnFrame();

/** A burning card's world-space start pose and drift. */
interface Burn {
  card: SliceCard | null;
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  scale: number;
  /** Unit drift direction (world) and the distance covered by the end of the burn. */
  direction: THREE.Vector3;
  distance: number;
}

function slotPose(slot: FanSlot, out: Pose): Pose {
  const r: FanRotation = slot.rotation;
  euler.set(r.pitch, r.yaw, r.roll, 'YXZ');
  out.position.set(slot.position[0], slot.position[1], slot.position[2]);
  out.quaternion.setFromEuler(euler);
  out.scale = slot.scale;
  return out;
}

/**
 * Number of draw calls the objects under `root` produce: one per visible mesh-like object, one
 * more for a batched text with an outline pass. Batched text members are not scene children.
 */
export function countDraws(root: THREE.Object3D): number {
  let draws = 0;
  root.traverseVisible((object) => {
    if (object instanceof BatchedText) {
      // The toolkit's ambient troika typings omit hasOutline.
      draws += (object as unknown as { hasOutline(): boolean }).hasOutline() ? 2 : 1;
    } else if (object instanceof THREE.InstancedMesh) {
      if (object.count > 0) draws += 1;
    } else if (object instanceof THREE.Mesh || object instanceof THREE.Line) {
      draws += 1;
    }
  });
  return draws;
}

export class CardFan {
  readonly root = new THREE.Group();

  private readonly options: FanOptions;
  private readonly hoverSeconds: number;
  private readonly returnSeconds: number;
  private readonly syncLabels: boolean;
  private text: TextLayout = DEFAULT_TEXT;
  private art: CardFaceArt | null = null;
  private mainGrip: THREE.Object3D | undefined;

  private readonly body: THREE.InstancedMesh;
  private readonly gems: THREE.InstancedMesh;
  private readonly labels = new BatchedText();
  private members: { cost: Text; title: Text; desc: Text }[] = [];
  private readonly listeners = new Set<(intent: CardFanIntent) => void>();

  private cards: readonly SliceCard[] = [];
  private uids: readonly number[] = [];
  private slots: FanSlot[] = [];
  private states: CardState[] = [];
  private hoverT: number[] = [];
  private poses: Pose[] = [];
  private returnStart: Pose[] = [];
  private returnElapsed: number[] = [];
  private hoverIndex: number | null = null;
  private grabbedIndex: number | null = null;
  private disposed = false;
  private readonly burns = new BurnPool(BURN_SLOTS);
  private readonly burning: Burn[] = Array.from({ length: BURN_SLOTS }, () => ({
    card: null,
    position: new THREE.Vector3(),
    quaternion: new THREE.Quaternion(),
    scale: 1,
    direction: new THREE.Vector3(),
    distance: 0,
  }));

  constructor(opts: CardFanOptions = {}) {
    this.options = { ...DEFAULT_FAN, ...opts.layout };
    this.hoverSeconds = opts.hoverSeconds ?? 0.1;
    this.returnSeconds = opts.returnSeconds ?? 0.22;
    this.syncLabels = opts.syncLabels ?? true;
    this.mainGrip = opts.mainGrip;
    this.root.name = 'card-fan';

    const bodyGeometry = new THREE.PlaneGeometry(1, 1);
    addCardFaceAttributes(bodyGeometry, MAX_HAND + BURN_SLOTS);
    this.body = new THREE.InstancedMesh(
      bodyGeometry,
      createCardFaceMaterial(),
      MAX_HAND + BURN_SLOTS,
    );
    this.body.name = 'card-fan-bodies';
    this.body.count = 0;
    this.body.frustumCulled = false;

    // A dark disc inside the painted cost medallion so the light cost number reads over the gem.
    this.gems = new THREE.InstancedMesh(
      new THREE.CircleGeometry(0.5, 20),
      new THREE.MeshBasicMaterial({ color: '#1a0f08', side: THREE.FrontSide, toneMapped: false }),
      MAX_HAND,
    );
    this.gems.name = 'card-fan-gems';
    this.gems.count = 0;
    this.gems.frustumCulled = false;

    this.labels.name = 'card-fan-labels';
    this.labels.frustumCulled = false;

    this.root.add(this.body, this.gems, this.labels);

    // Art the boot prefetch already loaded applies now, so the first hand never shows flat cards.
    const ready = (opts.loadArt ?? true) ? loadedCardFaceArt() : null;
    if (ready) this.setArt(ready);
    else if (opts.loadArt ?? true) {
      onFirstRender(this.body, (renderer) => {
        requestCardFaceArt(sharedKtx2Loader(renderer)).then(
          (art) => {
            if (!this.disposed) this.setArt(art);
          },
          (error: unknown) => console.warn('card atlas failed to load; flat cards stay', error),
        );
      });
    }
  }

  /**
   * Parents the fan, centred on `origin` in the parent's space (default: the layout origin). The
   * layout is unchanged; the root moves, so hit tests and released poses follow it.
   */
  attach(parent: THREE.Object3D, origin: Vec3 = this.options.origin): void {
    const o = this.options.origin;
    this.root.position.set(origin[0] - o[0], origin[1] - o[1], origin[2] - o[2]);
    parent.add(this.root);
  }

  detach(): void {
    this.root.removeFromParent();
  }

  setVisible(visible: boolean): void {
    this.root.visible = visible;
  }

  setMainGrip(grip: THREE.Object3D | undefined): void {
    this.mainGrip = grip;
  }

  on(listener: (intent: CardFanIntent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get count(): number {
    return this.cards.length;
  }

  get grabbed(): GrabbedCard | null {
    return this.grabbedIndex === null ? null : this.describe(this.grabbedIndex);
  }

  get hovered(): number | null {
    return this.hoverIndex;
  }

  /** Draw calls the fan costs right now. */
  get drawCalls(): number {
    return countDraws(this.root);
  }

  /** Cards burning away right now. */
  get burningCount(): number {
    return this.burns.active;
  }

  /** True once the faces sample the atlas; until then cards are flat tints. */
  get hasArt(): boolean {
    return this.art !== null;
  }

  /** Gives the faces their atlas pages and moves the labels onto the frame's text regions. */
  setArt(art: CardFaceArt): void {
    this.art = art;
    this.text = textLayout(art.atlas);
    applyCardFaceArt(this.body.material as THREE.ShaderMaterial, art);
    this.writeFaces();
    this.rebuildLabels();
    this.write();
  }

  /** Layout slot per card, grip-local, for the current hand. */
  get layout(): readonly FanSlot[] {
    return this.slots;
  }

  /** Replaces the hand. `uids` default to the hand index; they are echoed back in every intent. */
  setHand(cards: readonly SliceCard[], uids?: readonly number[]): void {
    if (cards.length > MAX_HAND) {
      throw new RangeError(`hand holds at most ${MAX_HAND} cards, got ${cards.length}`);
    }
    if (uids && uids.length !== cards.length) {
      throw new RangeError('uids must match cards in length');
    }
    this.cards = [...cards];
    this.uids = uids ? [...uids] : cards.map((_, i) => i);
    this.slots = fanLayout(cards.length, this.options);
    this.states = cards.map(() => 'fan');
    this.hoverT = cards.map(() => 0);
    this.poses = cards.map((_, i) => slotPose(this.slots[i] as FanSlot, newPose()));
    this.returnStart = cards.map(() => newPose());
    this.returnElapsed = cards.map(() => 0);
    this.hoverIndex = null;
    this.grabbedIndex = null;

    this.body.count = cards.length;
    this.gems.count = cards.length;
    this.writeFaces();

    this.rebuildLabels();
    this.write();
  }

  /** Highlights one card (lift and glow), or none. Cards that are not in the fan cannot be hovered. */
  hover(index: number | null): void {
    const next =
      index !== null && this.states[index] === 'fan' && this.grabbedIndex === null ? index : null;
    if (next === this.hoverIndex) return;
    this.hoverIndex = next;
    this.emit({
      type: 'hover',
      index: next,
      uid: next === null ? null : (this.uids[next] as number),
      card: next === null ? null : (this.cards[next] as SliceCard),
    });
  }

  /** Hover from a world-space pointer ray. Returns the card under it and applies the highlight. */
  pointerHover(ray: THREE.Ray): number | null {
    this.root.updateWorldMatrix(true, false);
    const local = ray.clone().applyMatrix4(tmpMatrix.copy(this.root.matrixWorld).invert());
    const dir = local.direction.normalize();
    const hit = hitTestFan(
      this.slots.map((slot, i) => (this.states[i] === 'fan' ? slot : null)),
      this.options.cardWidth,
      this.options.cardHeight,
      [local.origin.x, local.origin.y, local.origin.z],
      [dir.x, dir.y, dir.z],
      HIT_MARGIN,
    );
    const index = hit?.index ?? null;
    this.hover(index);
    return this.hoverIndex;
  }

  /** Detaches the card to follow the main-hand grip. Null when it cannot be grabbed. */
  grab(index: number, grip: THREE.Object3D | undefined = this.mainGrip): GrabbedCard | null {
    if (!grip || this.grabbedIndex !== null || this.states[index] !== 'fan') return null;
    this.mainGrip = grip;
    this.hover(null);
    this.grabbedIndex = index;
    this.states[index] = 'grabbed';
    const grabbed = this.describe(index);
    this.emit({ type: 'grab', ...grabbed });
    return grabbed;
  }

  /**
   * Lets go of the grabbed card. It disappears from the fan (the combat view owns it now) until
   * `returnToFan` springs it back. Null when nothing is held.
   */
  release(): ReleasedCard | null {
    const index = this.grabbedIndex;
    if (index === null) return null;
    this.grabbedIndex = null;
    this.states[index] = 'released';
    const pose = this.poses[index] as Pose;
    const released: ReleasedCard = {
      ...this.describe(index),
      position: this.root.localToWorld(pose.position.clone()),
      quaternion: this.root.getWorldQuaternion(new THREE.Quaternion()).multiply(pose.quaternion),
    };
    this.emit({ type: 'release', ...this.describe(index) });
    return released;
  }

  /**
   * Burns a released card away: it flares and burns from its edges inward over `BURN_SECONDS`
   * while drifting toward `target` (world space; an enemy) or sinking when there is none (a table
   * drop). The slot stays released (hidden) until `setHand` or `returnToFan`; the burn is separate
   * and outlives both. False when the card is not released.
   */
  playOut(index: number, target: THREE.Vector3 | null = null): boolean {
    if (this.states[index] !== 'released') return false;
    const slot = this.burns.start();
    const burn = this.burning[slot] as Burn;
    const pose = this.poses[index] as Pose;
    this.root.updateWorldMatrix(true, false);
    burn.card = this.cards[index] as SliceCard;
    burn.position.copy(pose.position).applyMatrix4(this.root.matrixWorld);
    this.root.getWorldQuaternion(burn.quaternion).multiply(pose.quaternion);
    this.root.getWorldScale(tmpScale);
    burn.scale = pose.scale * tmpScale.x;
    if (target) {
      burn.direction.subVectors(target, burn.position);
      const length = burn.direction.length();
      burn.distance = Math.min(BURN_DRIFT, length / 2);
      if (length > 1e-6) burn.direction.divideScalar(length);
      else burn.distance = 0;
    } else {
      burn.direction.set(0, -1, 0);
      burn.distance = BURN_SINK;
    }
    this.writeBurnFace(slot);
    this.write();
    return true;
  }

  /** Springs a held or released card back into its slot. */
  returnToFan(index: number): void {
    const state = this.states[index];
    if (state !== 'grabbed' && state !== 'released') return;
    if (this.grabbedIndex === index) this.grabbedIndex = null;
    this.states[index] = 'returning';
    copyPose(this.returnStart[index] as Pose, this.poses[index] as Pose);
    this.returnElapsed[index] = 0;
  }

  /** Advances hover and return tweens by `dt` seconds and writes the GPU data. */
  update(dt: number): void {
    const step = Math.max(0, dt);
    const grip = this.grabbedIndex !== null ? this.mainGrip : undefined;
    if (grip) {
      this.root.updateWorldMatrix(true, false);
      grip.updateWorldMatrix(true, false);
    }
    for (let i = 0; i < this.cards.length; i++) {
      const wanted = i === this.hoverIndex && this.states[i] === 'fan' ? 1 : 0;
      const rate = this.hoverSeconds > 0 ? step / this.hoverSeconds : 1;
      const t = this.hoverT[i] as number;
      this.hoverT[i] = wanted > t ? Math.min(wanted, t + rate) : Math.max(wanted, t - rate);

      const pose = this.poses[i] as Pose;
      const state = this.states[i];
      if (state === 'fan') {
        this.fanPose(i, pose);
      } else if (state === 'grabbed' && grip) {
        this.heldPose(grip, pose);
      } else if (state === 'returning') {
        this.returnElapsed[i] = (this.returnElapsed[i] as number) + step;
        const u = Math.min(1, (this.returnElapsed[i] as number) / this.returnSeconds);
        this.fanPose(i, tmpPose, 0);
        const start = this.returnStart[i] as Pose;
        const e = easeOutBack(u);
        pose.position.lerpVectors(start.position, tmpPose.position, e);
        pose.quaternion.slerpQuaternions(start.quaternion, tmpPose.quaternion, smooth(u));
        pose.scale = start.scale + (tmpPose.scale - start.scale) * e;
        if (u >= 1) {
          this.states[i] = 'fan';
          this.fanPose(i, pose);
          this.emit({ type: 'returned', ...this.describe(i) });
        }
      }
    }
    this.burns.update(step);
    this.write();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.burns.clear();
    this.detach();
    this.clearMembers();
    this.labels.dispose();
    this.body.geometry.dispose();
    (this.body.material as THREE.Material).dispose();
    this.body.dispose();
    this.gems.geometry.dispose();
    (this.gems.material as THREE.Material).dispose();
    this.gems.dispose();
    this.listeners.clear();
  }

  /** Per-instance face data: atlas rects when the art is loaded, and the flat tint either way. */
  private writeFaces(): void {
    const geometry = this.body.geometry;
    this.cards.forEach((card, i) => {
      writeCardTint(geometry, i, tmpColor.set(TYPE_COLOR[card.type]));
      if (this.art) writeCardFace(geometry, i, cardFaceInstance(this.art.atlas, card.id));
    });
    for (let slot = 0; slot < BURN_SLOTS; slot++) {
      if (this.burns.isLive(slot)) this.writeBurnFace(slot);
    }
  }

  /** Face data for the burn instance in `slot`. */
  private writeBurnFace(slot: number): void {
    const card = (this.burning[slot] as Burn).card;
    if (!card) return;
    const geometry = this.body.geometry;
    const index = MAX_HAND + slot;
    writeCardTint(geometry, index, tmpColor.set(TYPE_COLOR[card.type]));
    if (this.art) writeCardFace(geometry, index, cardFaceInstance(this.art.atlas, card.id));
  }

  /**
   * Burn instances after the hand slots. While any card burns the mesh draws every slot up to the
   * last burn instance; unused hand slots in between get a zero matrix.
   */
  private writeBurns(): void {
    const geometry = this.body.geometry;
    if (this.burns.active === 0) {
      if (this.body.count !== this.cards.length) {
        for (let slot = 0; slot < BURN_SLOTS; slot++)
          writeCardBurn(geometry, MAX_HAND + slot, false);
      }
      this.body.count = this.cards.length;
      return;
    }
    const { cardWidth: w, cardHeight: h } = this.options;
    for (let i = this.cards.length; i < MAX_HAND; i++) this.body.setMatrixAt(i, ZERO_MATRIX);
    this.root.updateWorldMatrix(true, false);
    tmpInverse.copy(this.root.matrixWorld).invert();
    for (let slot = 0; slot < BURN_SLOTS; slot++) {
      const index = MAX_HAND + slot;
      if (!this.burns.isLive(slot)) {
        this.body.setMatrixAt(index, ZERO_MATRIX);
        writeCardBurn(geometry, index, false);
        continue;
      }
      const burn = this.burning[slot] as Burn;
      const frame = burnFrame(this.burns.progress(slot), burnState);
      tmpBurnPos.copy(burn.position).addScaledVector(burn.direction, burn.distance * frame.travel);
      tmpBurnQuat.setFromAxisAngle(NORMAL_AXIS, BURN_SPIN * frame.u);
      tmpBurnQuat.premultiply(burn.quaternion);
      const s = burn.scale * frame.scale;
      tmpMatrix.compose(tmpBurnPos, tmpBurnQuat, tmpScale.set(w * s, h * s, 1));
      this.body.setMatrixAt(index, tmpMatrix.premultiply(tmpInverse));
      writeCardBurn(geometry, index, true, frame.burn, this.burns.seed(slot), frame.flare);
    }
    this.body.count = MAX_HAND + BURN_SLOTS;
  }

  private describe(index: number): GrabbedCard {
    return {
      index,
      uid: this.uids[index] as number,
      card: this.cards[index] as SliceCard,
    };
  }

  private emit(intent: CardFanIntent): void {
    for (const listener of this.listeners) listener(intent);
  }

  /** Slot pose with the hover rise applied; `hover` overrides the card's own hover amount. */
  private fanPose(index: number, out: Pose, hover = this.hoverT[index] as number): void {
    slotPose(this.slots[index] as FanSlot, out);
    const h = smooth(hover);
    if (h > 0) {
      tmpVec.set(0, HOVER_RISE * this.options.cardHeight * h, HOVER_FORWARD * h);
      out.position.add(tmpVec.applyQuaternion(out.quaternion));
      out.scale *= 1 + HOVER_GROW * h;
    }
  }

  /** Pose of a held card in fan-root space, from the main grip's current world transform. */
  private heldPose(grip: THREE.Object3D, out: Pose): void {
    euler.set(HOLD_PITCH, 0, 0, 'YXZ');
    tmpQuat.setFromEuler(euler);
    tmpLocal.compose(HOLD_POSITION, tmpQuat, tmpScale.set(1, 1, 1));
    tmpMatrix.copy(this.root.matrixWorld).invert().multiply(grip.matrixWorld).multiply(tmpLocal);
    tmpMatrix.decompose(out.position, out.quaternion, tmpScale);
    out.scale = HOLD_SCALE;
  }

  private rebuildLabels(): void {
    this.clearMembers();
    const w = this.options.cardWidth;
    const layout = this.text;
    this.members = this.cards.map((card) => {
      const cost = new Text();
      cost.text = String(card.cost);
      cost.fontSize = COST_FONT * w;
      cost.color = costColor;
      cost.anchorX = 'center';
      cost.anchorY = 'middle';

      const title = new Text();
      title.text = card.name;
      title.fontSize =
        Math.min(TITLE_FONT, layout.titleWidth / (card.name.length * TITLE_ADVANCE)) * w;
      title.maxWidth = layout.titleWidth * w;
      title.color = inkColor;
      title.anchorX = 'center';
      title.anchorY = 'middle';
      title.textAlign = 'center';
      title.whiteSpace = 'nowrap';

      const desc = new Text();
      desc.text = card.description;
      desc.fontSize = DESC_FONT * w;
      desc.maxWidth = layout.descWidth * w;
      desc.color = inkColor;
      desc.anchorX = 'left';
      desc.anchorY = 'top';
      desc.textAlign = 'left';
      desc.lineHeight = 1.15;
      for (const text of [cost, title, desc]) {
        text.matrixAutoUpdate = false;
        this.labels.addText(text);
      }
      return { cost, title, desc };
    });
    if (this.syncLabels && this.members.length > 0) this.labels.sync();
  }

  private clearMembers(): void {
    for (const { cost, title, desc } of this.members) {
      for (const text of [cost, title, desc]) {
        this.labels.removeText(text);
        text.dispose();
      }
    }
    this.members = [];
  }

  /** Writes instance matrices, gem matrices and label matrices from the current poses. */
  private write(): void {
    const { cardWidth: w, cardHeight: h } = this.options;
    const { gemAt, gemDiameter, titleAt, descAt } = this.text;
    for (let i = 0; i < this.cards.length; i++) {
      const pose = this.poses[i] as Pose;
      const state = this.states[i];
      const s = state === 'released' ? 0 : pose.scale;

      tmpMatrix.compose(pose.position, pose.quaternion, tmpScale.set(w * s, h * s, 1));
      this.body.setMatrixAt(i, tmpMatrix);

      this.place(pose, s, gemAt[0] * w, gemAt[1] * h, GEM_Z, gemDiameter * w, tmpMatrix);
      this.gems.setMatrixAt(i, tmpMatrix);

      const member = this.members[i];
      if (!member) continue;
      // The description is only readable on a raised or held card, so a resting fan skips it.
      const detailed =
        state === 'grabbed' || state === 'returning' || (this.hoverT[i] as number) > 0.5;
      this.place(pose, s, gemAt[0] * w, gemAt[1] * h, TEXT_Z, 1, member.cost.matrix);
      this.place(pose, s, titleAt[0] * w, titleAt[1] * h, TEXT_Z, 1, member.title.matrix);
      this.place(
        pose,
        detailed ? s : 0,
        descAt[0] * w,
        descAt[1] * h,
        TEXT_Z,
        1,
        member.desc.matrix,
      );
    }
    this.writeBurns();
    this.body.instanceMatrix.needsUpdate = true;
    this.gems.instanceMatrix.needsUpdate = true;
  }

  /** Matrix for a point at card-local metres (x, y, z) scaled by the card scale, sized `size` x card scale. */
  private place(
    pose: Pose,
    scale: number,
    x: number,
    y: number,
    z: number,
    size: number,
    out: THREE.Matrix4,
  ): void {
    tmpVec
      .set(x * scale, y * scale, z * scale)
      .applyQuaternion(pose.quaternion)
      .add(pose.position);
    const k = size * scale;
    out.compose(tmpVec, pose.quaternion, tmpScale.set(k, k, k));
  }
}
