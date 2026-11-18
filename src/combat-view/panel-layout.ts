/**
 * XR layout of the combat HUD panels seen from the seat: the player's status panel stays where it
 * is, and each enemy readout that would overlap it (or an earlier readout) rises until it clears.
 * Rising only ever moves a readout further from the automaton under it, so it never undoes
 * `readoutCentreY`. Pure math over plain points, no three.js, so the floor's every layout is testable.
 */
import type { ReadoutPoint } from './index.ts';

/** Clear space kept between two panels seen from the seat, in view tangent units (about 1.7 degrees). */
export const PANEL_GAP = 0.03;
/** Most rises one readout takes before it settles (each clears at least one panel). */
const MAX_RISES = 8;

/** A panel's extent seen from an eye looking level along the table heading, in tangent units. */
export interface ViewRect {
  readonly x0: number;
  readonly x1: number;
  readonly y0: number;
  readonly y1: number;
}

/** The seated view the panels are laid out for: the eyes and the table's forward heading. */
export interface SeatView {
  /** Eye positions (both Quest eyes, or one desktop eye). */
  readonly eyes: readonly ReadoutPoint[];
  /** Unit forward on the floor plane (x, z), from the seat toward the enemies. */
  readonly forward: readonly [number, number];
}

/** A readout: a vertical panel facing the seat across the table, centred at `centre`. */
export interface ReadoutPanel {
  readonly centre: ReadoutPoint;
  readonly width: number;
  readonly height: number;
}

/**
 * Tangent-space rectangle of `corners` seen from `eye` looking level along `forward` (right is
 * forward turned clockwise seen from above). Null when a corner is not in front of the eye.
 */
export function viewRect(
  eye: ReadoutPoint,
  forward: readonly [number, number],
  corners: readonly ReadoutPoint[],
): ViewRect | null {
  const [fx, fz] = forward;
  const rx = -fz;
  const rz = fx;
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (const c of corners) {
    const dx = c.x - eye.x;
    const dz = c.z - eye.z;
    const depth = dx * fx + dz * fz;
    if (depth <= 1e-6) return null;
    const x = (dx * rx + dz * rz) / depth;
    const y = (c.y - eye.y) / depth;
    x0 = Math.min(x0, x);
    x1 = Math.max(x1, x);
    y0 = Math.min(y0, y);
    y1 = Math.max(y1, y);
  }
  return { x0, x1, y0, y1 };
}

/** The four corners of a readout, its plane square to `forward`. */
export function readoutCorners(
  panel: ReadoutPanel,
  forward: readonly [number, number],
): ReadoutPoint[] {
  const [fx, fz] = forward;
  const hx = (-fz * panel.width) / 2;
  const hz = (fx * panel.width) / 2;
  const hy = panel.height / 2;
  const { x, y, z } = panel.centre;
  return [
    { x: x - hx, y: y - hy, z: z - hz },
    { x: x + hx, y: y - hy, z: z + hz },
    { x: x - hx, y: y + hy, z: z - hz },
    { x: x + hx, y: y + hy, z: z + hz },
  ];
}

const near = (a: ViewRect, b: ViewRect, gap: number): boolean =>
  a.x0 < b.x1 + gap && a.x1 > b.x0 - gap && a.y0 < b.y1 + gap && a.y1 > b.y0 - gap;

/**
 * Centre heights for `readouts`, each raised (never lowered) until, from every eye of `view`, it
 * keeps `gap` clear of every `fixed` panel (the status panel's corners) and of the readouts before
 * it. A readout keeps its height when nothing is in its way.
 */
export function readoutHeightsClear(
  view: SeatView,
  fixed: readonly (readonly ReadoutPoint[])[],
  readouts: readonly ReadoutPanel[],
  gap = PANEL_GAP,
): number[] {
  const placed: (readonly ReadoutPoint[])[] = [...fixed];
  return readouts.map((panel) => {
    let y = panel.centre.y;
    for (let rise = 0; rise < MAX_RISES; rise++) {
      let need = y;
      for (const eye of view.eyes) {
        const centre = { ...panel.centre, y };
        const mine = viewRect(
          eye,
          view.forward,
          readoutCorners({ ...panel, centre }, view.forward),
        );
        if (!mine) continue;
        const depth =
          (panel.centre.x - eye.x) * view.forward[0] + (panel.centre.z - eye.z) * view.forward[1];
        for (const other of placed) {
          const rect = viewRect(eye, view.forward, other);
          if (!rect || !near(mine, rect, gap)) continue;
          need = Math.max(need, eye.y + (rect.y1 + gap + 1e-6) * depth + panel.height / 2);
        }
      }
      if (need <= y + 1e-9) break;
      y = need;
    }
    placed.push(readoutCorners({ ...panel, centre: { ...panel.centre, y } }, view.forward));
    return y;
  });
}
