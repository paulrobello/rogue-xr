import * as THREE from 'three';
import { BatchedText, Text } from 'troika-three-text';
import type { SliceCard } from '../content/cards.ts';
import { PALETTE } from '../palette.ts';
import {
  DEFAULT_FAN,
  type FanOptions,
  type FanRotation,
  type FanSlot,
  fanLayout,
  hitTestFan,
  MAX_HAND,
} from './fan-layout.ts';

/**
 * The off-hand card hand. Rendering is a deliberately flat stand-in for the holo card (a portal
 * card is 6+ draws each): one InstancedMesh of card bodies with per-instance tint, one InstancedMesh
 * of cost gems and one troika BatchedText holding every label. The whole hand is 3 draws at any size.
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

/** Card-local layout, in units of card width (x) and height (y). */
const GEM_DIAMETER = 0.24;
const GEM_AT = [-0.3, 0.41] as const;
const TITLE_AT = [-0.12, 0.41] as const;
const DESC_AT = [-0.43, 0.2] as const;
const TITLE_FONT = 0.088;
const DESC_FONT = 0.07;
const COST_FONT = 0.15;
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

const TYPE_COLOR: Record<SliceCard['type'], string> = {
  attack: PALETTE.ruby,
  skill: PALETTE.emerald,
  sigil: PALETTE.sapphire,
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

  constructor(opts: CardFanOptions = {}) {
    this.options = { ...DEFAULT_FAN, ...opts.layout };
    this.hoverSeconds = opts.hoverSeconds ?? 0.1;
    this.returnSeconds = opts.returnSeconds ?? 0.22;
    this.syncLabels = opts.syncLabels ?? true;
    this.mainGrip = opts.mainGrip;
    this.root.name = 'card-fan';

    this.body = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.FrontSide }),
      MAX_HAND,
    );
    this.body.name = 'card-fan-bodies';
    this.body.count = 0;
    this.body.frustumCulled = false;
    this.body.setColorAt(0, tmpColor.set(PALETTE.walnut));

    this.gems = new THREE.InstancedMesh(
      new THREE.CircleGeometry(0.5, 20),
      new THREE.MeshBasicMaterial({ color: PALETTE.brass, side: THREE.FrontSide }),
      MAX_HAND,
    );
    this.gems.name = 'card-fan-gems';
    this.gems.count = 0;
    this.gems.frustumCulled = false;

    this.labels.name = 'card-fan-labels';
    this.labels.frustumCulled = false;

    this.root.add(this.body, this.gems, this.labels);
  }

  /** Parent the fan to the off-hand grip. */
  attach(grip: THREE.Object3D): void {
    grip.add(this.root);
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
    cards.forEach((card, i) => {
      this.body.setColorAt(i, tmpColor.set(TYPE_COLOR[card.type]));
    });
    if (this.body.instanceColor) this.body.instanceColor.needsUpdate = true;

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
    this.write();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
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
    this.members = this.cards.map((card) => {
      const cost = new Text();
      cost.text = String(card.cost);
      cost.fontSize = COST_FONT * w;
      cost.color = PALETTE.void;
      cost.anchorX = 'center';
      cost.anchorY = 'middle';

      const title = new Text();
      title.text = card.name;
      title.fontSize = TITLE_FONT * w;
      title.maxWidth = (0.5 - TITLE_AT[0] - 0.04) * w;
      title.color = PALETTE.parchment;
      title.anchorX = 'left';
      title.anchorY = 'middle';
      title.textAlign = 'left';
      title.lineHeight = 1.05;

      const desc = new Text();
      desc.text = card.description;
      desc.fontSize = DESC_FONT * w;
      desc.maxWidth = 0.86 * w;
      desc.color = PALETTE.parchment;
      desc.anchorX = 'left';
      desc.anchorY = 'top';
      desc.textAlign = 'left';
      desc.lineHeight = 1.1;
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
    for (let i = 0; i < this.cards.length; i++) {
      const pose = this.poses[i] as Pose;
      const state = this.states[i];
      const s = state === 'released' ? 0 : pose.scale;

      tmpMatrix.compose(pose.position, pose.quaternion, tmpScale.set(w * s, h * s, 1));
      this.body.setMatrixAt(i, tmpMatrix);

      this.place(pose, s, GEM_AT[0] * w, GEM_AT[1] * h, GEM_Z, GEM_DIAMETER * w, tmpMatrix);
      this.gems.setMatrixAt(i, tmpMatrix);

      const member = this.members[i];
      if (!member) continue;
      // The description is only readable on a raised or held card, so a resting fan skips it.
      const detailed =
        state === 'grabbed' || state === 'returning' || (this.hoverT[i] as number) > 0.5;
      this.place(pose, s, GEM_AT[0] * w, GEM_AT[1] * h, TEXT_Z, 1, member.cost.matrix);
      this.place(pose, s, TITLE_AT[0] * w, TITLE_AT[1] * h, TEXT_Z, 1, member.title.matrix);
      this.place(
        pose,
        detailed ? s : 0,
        DESC_AT[0] * w,
        DESC_AT[1] * h,
        TEXT_Z,
        1,
        member.desc.matrix,
      );
    }
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
