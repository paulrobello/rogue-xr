import * as THREE from 'three';
import { PALETTE } from '../palette.ts';
import { CanvasLabel } from './canvas-label.ts';
import { HIT_RED } from './hit-feedback.ts';

/** A floating damage number rises and fades over this long. */
export const HIT_NUMBER_SECONDS = 1.1;
/** How far a number rises over its life, metres. */
export const HIT_NUMBER_RISE = 0.12;
/** Numbers alive at once; a new one takes the oldest slot when all are busy. */
export const HIT_NUMBER_SLOTS = 6;
/**
 * World width of a number's label, metres: about 9 cm tall digits, a little over 2 degrees at the
 * 2 to 3 m an automaton stands from the seat, which a Quest 3 reads clearly.
 */
export const HIT_NUMBER_WIDTH = 0.4;
const CANVAS = { w: 384, h: 192 } as const;

/** What one number shows: lost health, blocked damage, or restored health. */
export interface HitAmount {
  readonly hpLost: number;
  readonly blocked: number;
  readonly healed?: number;
}

/** One pooled number, for checks: its slot, what it shows, where it started and its age. */
export interface HitNumberSlot {
  readonly index: number;
  active: boolean;
  age: number;
  amount: HitAmount;
  readonly start: THREE.Vector3;
  scale: number;
}

function safeLabel(): CanvasLabel | null {
  try {
    return new CanvasLabel(CANVAS.w, CANVAS.h, HIT_NUMBER_WIDTH);
  } catch {
    return null;
  }
}

/** Paints `-5` in red, `Blocked 3` in brass, or both (a partial block). */
export function drawHitAmount(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  amount: HitAmount,
): void {
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 10;
  ctx.strokeStyle = 'rgba(18,12,7,0.9)';
  const line = (text: string, color: string, y: number, size: number) => {
    ctx.font = `bold ${size}px system-ui, sans-serif`;
    ctx.strokeText(text, w / 2, y);
    ctx.fillStyle = color;
    ctx.fillText(text, w / 2, y);
  };
  if (amount.healed) line(`+${amount.healed}`, '#8bf1a1', h / 2, 110);
  else if (amount.hpLost === 0) line(`Blocked ${amount.blocked}`, PALETTE.brass, h / 2, 64);
  else if (amount.blocked === 0) line(`-${amount.hpLost}`, HIT_RED, h / 2, 110);
  else {
    line(`-${amount.hpLost}`, HIT_RED, h * 0.36, 96);
    line(`Blocked ${amount.blocked}`, PALETTE.brass, h * 0.8, 48);
  }
}

/**
 * The floating damage numbers of a fight: a fixed pool of `HIT_NUMBER_SLOTS` canvas labels made
 * once and reused (a hit only redraws a canvas), each rising `HIT_NUMBER_RISE` and fading over
 * `HIT_NUMBER_SECONDS` while it turns to face the camera. Spawn points are world space, whatever
 * the group's parent.
 */
export class HitNumbers extends THREE.Group {
  readonly slots: readonly HitNumberSlot[];
  private readonly labels: (CanvasLabel | null)[];
  private readonly face = new THREE.Quaternion();
  /** The inverse of the group's world turn, so a number's world turn is the camera's. */
  private readonly turn = new THREE.Quaternion();

  constructor() {
    super();
    this.name = 'hit-numbers';
    this.labels = Array.from({ length: HIT_NUMBER_SLOTS }, () => safeLabel());
    this.slots = this.labels.map((label, index) => {
      if (label) {
        label.mesh.name = 'hit-number';
        label.mesh.visible = false;
        label.mesh.renderOrder = 3;
        // Never hidden inside the automaton it hit.
        label.mesh.material.depthTest = false;
        this.add(label.mesh);
      }
      return {
        index,
        active: false,
        age: 0,
        amount: { hpLost: 0, blocked: 0 },
        start: new THREE.Vector3(),
        scale: 1,
      };
    });
  }

  /** Numbers on screen now. */
  get active(): HitNumberSlot[] {
    return this.slots.filter((s) => s.active);
  }

  /**
   * Shows `amount` rising from world point `at`, drawn `scale` times `HIT_NUMBER_WIDTH` wide. Takes
   * a free slot, else the oldest. Nothing shows for an amount of zero.
   */
  spawn(at: THREE.Vector3, amount: HitAmount, scale = 1): HitNumberSlot | null {
    if (amount.hpLost <= 0 && amount.blocked <= 0 && !amount.healed) return null;
    let slot = this.slots.find((s) => !s.active);
    if (!slot) {
      slot = this.slots[0] as HitNumberSlot;
      for (const s of this.slots) if (s.age > slot.age) slot = s;
    }
    slot.active = true;
    slot.age = 0;
    slot.amount = {
      hpLost: amount.hpLost,
      blocked: amount.blocked,
      ...(amount.healed ? { healed: amount.healed } : {}),
    };
    slot.start.copy(at);
    slot.scale = scale;
    this.labels[slot.index]?.draw((ctx, w, h) => drawHitAmount(ctx, w, h, amount));
    return slot;
  }

  /** Rises, fades and turns every live number to face `camera`. */
  update(dt: number, camera: THREE.Camera): void {
    camera.getWorldQuaternion(this.face);
    this.updateWorldMatrix(true, false);
    this.getWorldQuaternion(this.turn).invert();
    for (const slot of this.slots) {
      if (!slot.active) continue;
      slot.age += dt;
      const k = slot.age / HIT_NUMBER_SECONDS;
      if (k >= 1) slot.active = false;
      const mesh = this.labels[slot.index]?.mesh;
      if (!mesh) continue;
      mesh.visible = slot.active;
      if (!slot.active) continue;
      mesh.position.copy(slot.start);
      mesh.position.y += HIT_NUMBER_RISE * (1 - (1 - k) * (1 - k));
      this.worldToLocal(mesh.position);
      mesh.quaternion.copy(this.turn).multiply(this.face);
      mesh.scale.setScalar(slot.scale);
      mesh.material.opacity = 1 - k * k;
    }
  }

  /** Hides every number. */
  hideAll(): void {
    for (const slot of this.slots) {
      slot.active = false;
      const mesh = this.labels[slot.index]?.mesh;
      if (mesh) mesh.visible = false;
    }
  }

  dispose(): void {
    for (const label of this.labels) label?.dispose();
    this.removeFromParent();
  }
}
