import * as THREE from 'three';
import { BatchedText, Text } from 'troika-three-text';
import { type CardAtlas, frameToCard } from '../cards/card-atlas.ts';
import {
  addCardFaceAttributes,
  applyCardFaceArt,
  type CardFaceArt,
  cardFaceInstance,
  createCardFaceMaterial,
  loadedCardFaceArt,
  requestCardFaceArt,
  writeCardFace,
  writeCardTint,
} from '../cards/card-face-material.ts';
import { configureTextTexture } from '../combat-view/canvas-label.ts';
import { getCard, type SliceCard } from '../content/cards.ts';
import { PALETTE } from '../palette.ts';
import { onFirstRender, sharedKtx2Loader } from '../ui/first-render.ts';
import { CARD_FLIGHT_SECONDS } from './card-flight.ts';

/** One offered card: its id and where its menu cell sits, cell-local metres. */
export interface RewardCardSlot {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface RewardCardFacesOptions {
  /** Art to draw with. Default: the shared hand atlas when it has loaded already. */
  art?: CardFaceArt | null;
  /** Load the shared atlas on the first render when no art is given. Default true. */
  loadArt?: boolean;
  /** Run troika typesetting for the labels. Off in tests, where no font can be fetched. */
  syncLabels?: boolean;
  /** Offered card ids that are not already in the run deck. These receive a permanent NEW cue. */
  newCardIds?: readonly string[];
}

/**
 * The flat fallback face drawn until the atlas is ready: family colour in a brass frame, name, kind,
 * cost and rules text on canvas. `hovered` draws the candle frame.
 */
export type FallbackFace = (id: string, hovered: boolean) => THREE.Texture;

/**
 * Card-local text layout from the atlas frame's `textRegions`, in units of card width (x) and
 * height (y), the same regions the hand's labels use (`hand/card-fan.ts`).
 */
interface TextLayout {
  gemAt: readonly [number, number];
  gemDiameter: number;
  titleAt: readonly [number, number];
  titleWidth: number;
  descAt: readonly [number, number];
  descWidth: number;
}

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

/** Font sizes over card width and the title's glyph advance, as the hand sets them. */
const TITLE_FONT = 0.092;
const DESC_FONT = 0.066;
const COST_FONT = 0.115;
const TITLE_ADVANCE = 0.55;
/** BatchedText writes member colours out as linear, so they are decoded once (see `card-fan.ts`). */
const inkColor = new THREE.Color('#2a1a0e').convertSRGBToLinear();
const costColor = new THREE.Color(PALETTE.candle).convertSRGBToLinear();

/**
 * Depths above the cell, metres. The cards sit at 1.25 m, so the layers are a millimetre apart
 * rather than the hand's tenths. The fallback face covers the atlas face until the art arrives.
 */
const HALO_Z = 0.001;
const FACE_Z = 0.003;
const FALLBACK_Z = 0.004;
const GEM_Z = 0.001;
const TEXT_Z = 0.002;
/** A hovered card comes this far toward the player and grows by this fraction. */
export const REWARD_HOVER_LIFT = 0.012;
export const REWARD_HOVER_GROW = 0.05;
/** Candle frame around the hovered card, as a fraction of its width. */
const HALO_BORDER = 0.035;
/** Once a card is claimed, the others drop this far and shrink away over `CARD_FLIGHT_SECONDS`. */
const LEAVE_DROP = 0.12;

const TYPE_COLOR: Record<SliceCard['type'], string> = {
  attack: PALETTE.ruby,
  skill: PALETTE.emerald,
  sigil: PALETTE.sapphire,
};

const tmpMatrix = new THREE.Matrix4();
const tmpPosition = new THREE.Vector3();
const tmpScale = new THREE.Vector3();
const tmpColor = new THREE.Color();
const IDENTITY = new THREE.Quaternion();

/**
 * The reward board's card faces, drawn like the hand's (`hand/card-fan.ts`): one InstancedMesh of
 * atlas card faces with the portal window, dark discs behind the cost numbers and one troika
 * BatchedText of cost, name and rules text on the frame's text regions. The shared hand atlas is
 * used as soon as it is loaded; until then each card shows its canvas fallback face. Hit testing
 * stays with the board's menu cells; this only draws.
 */
export class RewardCardFaces {
  readonly root = new THREE.Group();
  readonly slots: readonly RewardCardSlot[];
  private readonly cards: readonly SliceCard[];
  private readonly syncLabels: boolean;
  private readonly fallbackFace: FallbackFace;
  private readonly body: THREE.InstancedMesh;
  private readonly gems: THREE.InstancedMesh;
  private readonly labels = new BatchedText();
  private readonly halo: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private readonly newHalos: (THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial> | null)[];
  private readonly newBadges: (THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial> | null)[];
  private readonly newCardIds: ReadonlySet<string>;
  private readonly fallbacks: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>[];
  /** The material's own 1x1 blank page, bound until the art arrives; `applyCardFaceArt` unbinds it. */
  private readonly blankPage: THREE.Texture;
  private members: { cost: Text; title: Text; desc: Text }[] = [];
  private art: CardFaceArt | null = null;
  private text: TextLayout | null = null;
  private hoveredIndex: number | null = null;
  /** The claimed card and the others' drop-away progress (0..1), once `claim` ran. */
  private leaving: { index: number; t: number } | null = null;
  private disposed = false;

  constructor(
    slots: readonly RewardCardSlot[],
    fallbackFace: FallbackFace,
    opts: RewardCardFacesOptions = {},
  ) {
    this.slots = slots;
    this.cards = slots.map((s) => getCard(s.id));
    this.fallbackFace = fallbackFace;
    this.syncLabels = opts.syncLabels ?? true;
    this.newCardIds = new Set(opts.newCardIds ?? []);
    this.root.name = 'reward-card-faces';

    const geometry = new THREE.PlaneGeometry(1, 1);
    addCardFaceAttributes(geometry, slots.length);
    this.body = new THREE.InstancedMesh(geometry, createCardFaceMaterial(), slots.length);
    this.blankPage = (this.body.material as THREE.ShaderMaterial).uniforms.uFrame
      ?.value as THREE.Texture;
    this.body.name = 'reward-card-bodies';
    this.body.frustumCulled = false;
    this.cards.forEach((card, i) => {
      writeCardTint(geometry, i, tmpColor.set(TYPE_COLOR[card.type]));
    });

    this.gems = new THREE.InstancedMesh(
      new THREE.CircleGeometry(0.5, 20),
      new THREE.MeshBasicMaterial({ color: '#1a0f08', toneMapped: false }),
      slots.length,
    );
    this.gems.name = 'reward-card-gems';
    this.gems.frustumCulled = false;
    this.gems.visible = false;

    this.labels.name = 'reward-card-labels';
    this.labels.frustumCulled = false;

    this.halo = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ color: PALETTE.candle, toneMapped: false }),
    );
    this.halo.name = 'reward-card-halo';
    this.halo.visible = false;

    this.newHalos = slots.map((slot) => {
      if (!this.newCardIds.has(slot.id)) return null;
      const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(
          slot.width + HALO_BORDER * slot.width * 2,
          slot.height + HALO_BORDER * slot.width * 2,
        ),
        new THREE.MeshBasicMaterial({ color: PALETTE.brass, toneMapped: false }),
      );
      mesh.name = `reward-card-new-frame-${slot.id}`;
      mesh.visible = this.newCardIds.has(slot.id);
      mesh.position.set(slot.x, slot.y, HALO_Z);
      return mesh;
    });
    this.newBadges = slots.map((slot) => {
      if (!this.newCardIds.has(slot.id)) return null;
      const canvas = document.createElement('canvas');
      canvas.width = 256;
      canvas.height = 64;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.fillStyle = PALETTE.brass;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = PALETTE.warmBlack;
        ctx.font = '700 42px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('NEW', canvas.width / 2, canvas.height / 2);
      }
      const texture = new THREE.CanvasTexture(canvas);
      configureTextTexture(texture);
      const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(slot.width * 0.38, slot.width * 0.095),
        new THREE.MeshBasicMaterial({ map: texture, toneMapped: false }),
      );
      mesh.name = `reward-card-new-badge-${slot.id}`;
      mesh.userData.semanticName = 'new-card-marker';
      mesh.userData.cardId = slot.id;
      mesh.visible = true;
      return mesh;
    });

    this.fallbacks = slots.map((slot) => {
      const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(slot.width, slot.height),
        new THREE.MeshBasicMaterial({ map: fallbackFace(slot.id, false), toneMapped: false }),
      );
      mesh.name = `reward-card-fallback-${slot.id}`;
      mesh.position.set(slot.x, slot.y, FALLBACK_Z);
      return mesh;
    });

    for (const object of [
      this.body,
      this.gems,
      this.labels,
      this.halo,
      ...this.newHalos.filter((mesh) => mesh !== null),
      ...this.newBadges.filter((mesh) => mesh !== null),
      ...this.fallbacks,
    ]) {
      object.raycast = () => undefined;
      this.root.add(object);
    }
    this.write();

    const ready = opts.art === undefined ? loadedCardFaceArt() : opts.art;
    if (ready) this.setArt(ready);
    else if (opts.loadArt ?? true) {
      onFirstRender(this.body, (renderer) => {
        requestCardFaceArt(sharedKtx2Loader(renderer)).then(
          (art) => {
            if (!this.disposed) this.setArt(art);
          },
          (error: unknown) =>
            console.warn('card atlas failed to load; reward cards stay flat', error),
        );
      });
    }
  }

  /** True once the faces sample the atlas; until then the canvas fallbacks show. */
  get hasArt(): boolean {
    return this.art !== null;
  }

  /** Index of the hovered card, or null. */
  get hovered(): number | null {
    return this.hoveredIndex;
  }

  /** Swaps the fallbacks for the atlas faces and their labels. */
  setArt(art: CardFaceArt): void {
    if (this.disposed) return;
    this.art = art;
    this.text = textLayout(art.atlas);
    applyCardFaceArt(this.body.material as THREE.ShaderMaterial, art);
    this.cards.forEach((card, i) => {
      writeCardFace(this.body.geometry, i, cardFaceInstance(art.atlas, card.id));
    });
    for (const mesh of this.fallbacks) mesh.visible = false;
    this.gems.visible = true;
    this.rebuildLabels();
    this.write();
  }

  /** The card `claim` took, or null. */
  get claimed(): string | null {
    return this.leaving ? (this.slots[this.leaving.index]?.id ?? null) : null;
  }

  /**
   * Takes card `id` off the board (its flying copy is drawn elsewhere) and starts the others
   * dropping away; `update` plays it. Returns false for an unknown card or a second claim.
   */
  claim(id: string): boolean {
    const index = this.slots.findIndex((s) => s.id === id);
    if (index < 0 || this.leaving) return false;
    if (this.hoveredIndex !== null) this.paintFallback(this.hoveredIndex, false);
    this.hoveredIndex = null;
    this.leaving = { index, t: 0 };
    this.write();
    return true;
  }

  /** Advances the drop-away after a `claim` by `dt` seconds. */
  update(dt: number): void {
    const leave = this.leaving;
    if (!leave || leave.t >= 1 || !(dt > 0)) return;
    leave.t = Math.min(1, leave.t + dt / CARD_FLIGHT_SECONDS);
    this.write();
  }

  /** Lifts, grows and frames the card `id` (or drops the highlight with `on` false). */
  /** The slot of the card with `id`, or the `index`th slot; undefined when there is none. */
  slot(key: string | number): RewardCardSlot | undefined {
    return typeof key === 'number' ? this.slots[key] : this.slots.find((s) => s.id === key);
  }

  hover(id: string, on: boolean): void {
    const index = this.slots.findIndex((s) => s.id === id);
    if (index < 0 || this.leaving) return;
    if (on) {
      if (this.hoveredIndex !== null && this.hoveredIndex !== index)
        this.paintFallback(this.hoveredIndex, false);
      this.hoveredIndex = index;
    } else if (this.hoveredIndex === index) this.hoveredIndex = null;
    else return;
    this.paintFallback(index, on);
    this.write();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.root.removeFromParent();
    this.clearMembers();
    this.labels.dispose();
    const material = this.body.material as THREE.ShaderMaterial;
    // The atlas pages are shared with the hand; only the blank placeholder is this material's own.
    this.blankPage.dispose();
    this.body.geometry.dispose();
    material.dispose();
    this.body.dispose();
    this.gems.geometry.dispose();
    (this.gems.material as THREE.Material).dispose();
    this.gems.dispose();
    this.halo.geometry.dispose();
    this.halo.material.dispose();
    for (const mesh of [...this.newHalos, ...this.newBadges]) {
      if (!mesh) continue;
      mesh.geometry.dispose();
      mesh.material.map?.dispose();
      mesh.material.dispose();
    }
    for (const mesh of this.fallbacks) {
      mesh.geometry.dispose();
      mesh.material.map?.dispose();
      mesh.material.dispose();
    }
  }

  private paintFallback(index: number, on: boolean): void {
    const mesh = this.fallbacks[index];
    const slot = this.slots[index];
    if (!mesh || !slot) return;
    mesh.material.map?.dispose();
    mesh.material.map = this.fallbackFace(slot.id, on);
    mesh.position.z = FALLBACK_Z + (on ? REWARD_HOVER_LIFT : 0);
  }

  private rebuildLabels(): void {
    this.clearMembers();
    const layout = this.text;
    if (!layout) return;
    this.members = this.cards.map((card, i) => {
      const w = (this.slots[i] as RewardCardSlot).width;
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

  /** Instance, gem, label and halo matrices from the slots and the hover. */
  private write(): void {
    const layout = this.text;
    const leave = this.leaving;
    this.slots.forEach((slot, i) => {
      const on = i === this.hoveredIndex;
      // The claimed card leaves the board at once; the others drop and shrink as the flight plays.
      const gone = leave ? (i === leave.index ? 1 : leave.t) : 0;
      const s = (on ? 1 + REWARD_HOVER_GROW : 1) * (1 - gone);
      const y = slot.y - (leave && i !== leave.index ? LEAVE_DROP * gone : 0);
      const fallback = this.fallbacks[i];
      if (fallback) {
        fallback.position.y = y;
        fallback.scale.setScalar(Math.max(1e-3, 1 - gone));
        fallback.visible = !this.art && gone < 1;
      }
      const lift = on ? REWARD_HOVER_LIFT : 0;
      const w = slot.width * s;
      const h = slot.height * s;
      const z = FACE_Z + lift;
      const newFrame = this.newHalos[i];
      if (newFrame) {
        newFrame.position.set(slot.x, y, HALO_Z + lift * 0.5);
        newFrame.scale.setScalar(Math.max(1e-3, 1 - gone));
        newFrame.visible = gone < 1;
      }
      const badge = this.newBadges[i];
      if (badge) {
        badge.position.set(slot.x + w * 0.31, y + h * 0.45, z + TEXT_Z);
        badge.scale.setScalar(Math.max(1e-3, 1 - gone));
        badge.visible = gone < 1;
      }
      tmpMatrix.compose(tmpPosition.set(slot.x, y, z), IDENTITY, tmpScale.set(w, h, 1));
      this.body.setMatrixAt(i, tmpMatrix);
      if (on) {
        const border = HALO_BORDER * slot.width * 2;
        this.halo.position.set(slot.x, slot.y, HALO_Z + lift);
        this.halo.scale.set(w + border, h + border, 1);
      }
      if (!layout) return;
      const at = (u: number, v: number, dz: number, size: number, out: THREE.Matrix4): void => {
        out.compose(
          tmpPosition.set(slot.x + u * w, y + v * h, z + dz),
          IDENTITY,
          tmpScale.setScalar(size),
        );
      };
      at(layout.gemAt[0], layout.gemAt[1], GEM_Z, layout.gemDiameter * w, tmpMatrix);
      this.gems.setMatrixAt(i, tmpMatrix);
      const member = this.members[i];
      if (!member) return;
      at(layout.gemAt[0], layout.gemAt[1], TEXT_Z, s, member.cost.matrix);
      at(layout.titleAt[0], layout.titleAt[1], TEXT_Z, s, member.title.matrix);
      at(layout.descAt[0], layout.descAt[1], TEXT_Z, s, member.desc.matrix);
    });
    this.halo.visible = this.hoveredIndex !== null && this.art !== null;
    this.body.instanceMatrix.needsUpdate = true;
    this.gems.instanceMatrix.needsUpdate = true;
  }
}
