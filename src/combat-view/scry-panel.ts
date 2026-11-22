import * as THREE from 'three';
import { rewardCardTexture } from '../flow/panels.ts';
import { RewardCardFaces, type RewardCardSlot } from '../flow/reward-cards.ts';
import { HOLO_CARD_ASPECT } from '../hand/fan-layout.ts';
import { PALETTE } from '../palette.ts';
import type { CombatCard } from '../rules/types.ts';
import { CanvasLabel } from './canvas-label.ts';

type Choice = number | 'confirm';
const CARD_WIDTH = 0.14;
const CARD_HEIGHT = CARD_WIDTH * HOLO_CARD_ASPECT;
const PITCH = 0.157;
const CARD_Y = 0.017;
const STATUS_Y = -0.105;
const CONFIRM_Y = -0.164;

interface Slot {
  readonly card: CombatCard;
  readonly border: THREE.Mesh;
  readonly badge: CanvasLabel | null;
}

function caption(width: number, height: number, text: string, color: string): CanvasLabel | null {
  if (typeof document === 'undefined') return null;
  try {
    const label = new CanvasLabel(768, Math.round((768 * height) / width), width);
    paint(label, text, color);
    return label;
  } catch {
    return null;
  }
}

function paint(label: CanvasLabel, text: string, color: string): void {
  label.draw((ctx, w, h) => {
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = PALETTE.brass;
    ctx.lineWidth = 6;
    ctx.strokeRect(4, 4, w - 8, h - 8);
    ctx.fillStyle = PALETTE.parchment;
    ctx.font = `600 ${Math.min(h * 0.5, 52)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, w / 2, h / 2, w - 34);
  });
}

export class ScryPanel {
  readonly object = new THREE.Group();
  private readonly cards: RewardCardFaces;
  private readonly slots: Slot[];
  private readonly selected = new Set<number>();
  private readonly targets: THREE.Mesh[] = [];
  private readonly geometry: THREE.BufferGeometry[] = [];
  private readonly labels: CanvasLabel[] = [];
  private readonly borderMaterial = new THREE.MeshBasicMaterial({
    color: PALETTE.ruby,
    toneMapped: false,
  });
  private readonly background = new THREE.MeshBasicMaterial({
    color: PALETTE.warmBlack,
    toneMapped: false,
  });
  private readonly targetMaterial = new THREE.MeshBasicMaterial({
    visible: false,
    side: THREE.DoubleSide,
  });
  private readonly hit = new THREE.Raycaster();

  constructor(cards: readonly CombatCard[]) {
    this.object.name = 'scry-panel';
    const width = Math.max(0.47, cards.length * PITCH + 0.024);
    this.plane(width, 0.402, 0, -0.014, -0.013, this.background);
    const cardSlots: RewardCardSlot[] = cards.map((card, index) => ({
      id: card.def.id,
      x: (index - (cards.length - 1) / 2) * PITCH,
      y: CARD_Y,
      width: CARD_WIDTH,
      height: CARD_HEIGHT,
    }));
    this.cards = new RewardCardFaces(
      cardSlots,
      (id, hovered) =>
        typeof document === 'undefined' ? new THREE.Texture() : rewardCardTexture(id, hovered),
      { syncLabels: typeof document !== 'undefined' },
    );
    this.slots = cards.map((card, i) => {
      const x = cardSlots[i].x;
      const border = this.plane(
        CARD_WIDTH + 0.009,
        CARD_HEIGHT + 0.009,
        x,
        CARD_Y,
        -0.003,
        this.borderMaterial,
      );
      border.visible = false;
      border.name = `scry-discard-border-${card.uid}`;
      this.target(card.uid, CARD_WIDTH, CARD_HEIGHT + 0.035, x, CARD_Y - 0.012);
      const badge = this.label(0.125, 0.022, 'Keep', x, STATUS_Y);
      if (badge) badge.mesh.name = `scry-choice-${card.uid}`;
      return { card, border, badge };
    });
    this.object.add(this.cards.root);
    this.label(width - 0.024, 0.042, 'Scry · Select cards to discard', 0, 0.151);
    this.label(0.191, 0.044, 'Confirm', 0, CONFIRM_Y);
    this.target('confirm', 0.204, 0.052, 0, CONFIRM_Y);
  }

  private plane(
    w: number,
    h: number,
    x: number,
    y: number,
    z: number,
    material: THREE.Material,
  ): THREE.Mesh {
    const geometry = new THREE.PlaneGeometry(w, h);
    this.geometry.push(geometry);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x, y, z);
    this.object.add(mesh);
    return mesh;
  }

  private label(
    width: number,
    height: number,
    text: string,
    x: number,
    y: number,
  ): CanvasLabel | null {
    const label = caption(width, height, text, PALETTE.warmBlack);
    if (!label) return null;
    label.mesh.position.set(x, y, 0.008);
    this.object.add(label.mesh);
    this.labels.push(label);
    return label;
  }

  private target(choice: Choice, width: number, height: number, x: number, y: number): void {
    const mesh = this.plane(width, height, x, y, 0.021, this.targetMaterial);
    mesh.name = choice === 'confirm' ? 'scry-confirm' : `scry-card-${choice}`;
    mesh.userData.choice = choice;
    this.targets.push(mesh);
  }

  pick(ray: THREE.Ray): { choice: Choice; distance: number } | null {
    this.object.updateWorldMatrix(true, true);
    this.hit.ray.copy(ray);
    this.hit.far = 4;
    const hit = this.hit.intersectObjects(this.targets, false)[0];
    return hit ? { choice: hit.object.userData.choice as Choice, distance: hit.distance } : null;
  }

  hover(choice: Choice | undefined): void {
    const index = this.slots.findIndex((slot) => slot.card.uid === choice);
    this.cards.hoverAt(index < 0 ? null : index);
  }

  toggle(uid: number): void {
    const slot = this.slots.find((candidate) => candidate.card.uid === uid);
    if (!slot) return;
    const discarded = !this.selected.delete(uid);
    if (discarded) this.selected.add(uid);
    slot.border.visible = discarded;
    if (slot.badge)
      paint(
        slot.badge,
        discarded ? 'Discard' : 'Keep',
        discarded ? PALETTE.ruby : PALETTE.warmBlack,
      );
  }

  discarded(): readonly number[] {
    return this.slots
      .filter((slot) => this.selected.has(slot.card.uid))
      .map((slot) => slot.card.uid);
  }

  worldPoint(choice: Choice): THREE.Vector3 | null {
    return (
      this.targets
        .find((node) => node.userData.choice === choice)
        ?.getWorldPosition(new THREE.Vector3()) ?? null
    );
  }

  dispose(): void {
    this.cards.dispose();
    for (const label of this.labels) label.dispose();
    for (const geometry of this.geometry) geometry.dispose();
    this.targetMaterial.dispose();
    this.borderMaterial.dispose();
    this.background.dispose();
    this.object.removeFromParent();
  }
}
