/**
 * H5 (Quest 3 playtests 2026-11-16): the unfolded combat table sat too close to the seated head and
 * the dice and buttons were a steep look down. The first fix moved the centre from 0.65 m to 0.85 m;
 * the second to 1.2 m, which the next playtest found a little far, so it now sits at 1.1 m (0.95 m
 * comfortable fallback, 0.5 m only when nothing further fits).
 * These pin the distances, the view angles they give and the reach they keep.
 */
import { describe, expect, it } from 'vitest';
import {
  COMFORT_TABLE_DISTANCE,
  type CombatRoom,
  DEFAULT_TABLE_DISTANCE,
  MIN_TABLE_DISTANCE,
  placeTable,
  TABLE_HALF_DEPTH,
  tableHeightFor,
  WAIST_DROP,
} from '../src/combat/placement.ts';
import type { Rect } from '../src/content/rooms.ts';
import { isOverTable } from '../src/hand/aim.ts';

const room = (...walkable: Rect[]): CombatRoom => ({
  footprint: walkable[0] as Rect,
  walkable,
  colliders: [],
});

/** Degrees below level from the eye to a point `ahead` metres away and `drop` metres down. */
const below = (ahead: number, drop = WAIST_DROP): number =>
  (Math.atan2(drop, ahead) * 180) / Math.PI;

/** The table asset's dice-tray socket sits 0.18 m toward the seat (combat-table.manifest.json). */
const TRAY_TOWARD_SEAT = 0.18;
/** End Turn and Throw: 0.28 m toward the seat, 0.55 m aside, 0.02 m up (combat-session.ts). */
const BUTTON = { towardSeat: 0.28, aside: 0.55, lift: 0.02 } as const;

describe('H5 table distance from the seated head', () => {
  it('pins the distances: 1.1 m ideal, 0.95 m comfortable fallback, 0.5 m last resort', () => {
    expect(DEFAULT_TABLE_DISTANCE).toBe(1.1);
    expect(COMFORT_TABLE_DISTANCE).toBe(0.95);
    expect(MIN_TABLE_DISTANCE).toBe(0.5);
    expect(tableHeightFor(1.6)).toBeCloseTo(1.6 - WAIST_DROP);
  });

  it('puts the centre 30 to 35 degrees and the near edge under 48 degrees below the eye', () => {
    const d = DEFAULT_TABLE_DISTANCE;
    expect(below(d)).toBeGreaterThanOrEqual(30);
    expect(below(d)).toBeLessThanOrEqual(35);
    expect(below(d - TABLE_HALF_DEPTH)).toBeLessThanOrEqual(48);
    // The dice tray and the buttons sit in the same comfortable band.
    expect(below(d - TRAY_TOWARD_SEAT)).toBeLessThanOrEqual(40);
    const buttonAhead = Math.hypot(d - BUTTON.towardSeat, BUTTON.aside);
    expect(below(buttonAhead, WAIST_DROP - BUTTON.lift)).toBeLessThanOrEqual(37);
    // The old 0.85 m table had its near edge 59 degrees down and its tray 48.
    expect(below(0.85 - TABLE_HALF_DEPTH)).toBeGreaterThan(58);
    expect(below(0.85 - TRAY_TOWARD_SEAT)).toBeGreaterThan(47);
    // The comfortable fallback still beats the old ideal.
    expect(below(COMFORT_TABLE_DISTANCE - TABLE_HALF_DEPTH)).toBeLessThan(
      below(0.85 - TABLE_HALF_DEPTH),
    );
  });

  it('stands 1.1 m ahead in open space, with the drop zone starting 0.6 m from the head', () => {
    const r = placeTable(
      { x: 0, z: 0, yaw: 0, eyeHeight: 1.6 },
      room({ min: [-5, -5], max: [5, 5] }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.distance).toBeCloseTo(1.1);
    expect(r.pose.z).toBeCloseTo(-1.1);
    expect(r.offsetDeg).toBe(0);
    // A slow card drop needs the hand over the footprint plus its 0.1 m margin: 0.6 m ahead of the
    // eye, within a seated arm's reach. A flick across the table needs no reach.
    const chest = 1.2;
    expect(isOverTable([0, chest, -0.61], r.pose)).toBe(true);
    expect(isOverTable([0, chest, -0.59], r.pose)).toBe(false);
  });

  it('turns to a comfortable heading before it comes closer than 0.95 m', () => {
    // A wall 1.4 m ahead: straight ahead only a 0.5 to 0.9 m table fits, to the side 1.1 m does.
    const r = placeTable({ x: 0, z: 0, yaw: 0 }, room({ min: [-5, -1.4], max: [5, 5] }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.offsetDeg).not.toBe(0);
    expect(r.distance).toBeGreaterThanOrEqual(COMFORT_TABLE_DISTANCE - 1e-9);
  });

  it('still places a close table where nothing further fits, so a cramped fight still opens', () => {
    // A 2.2 m square closet around the player: only close tables fit anywhere.
    const r = placeTable({ x: 0, z: 0, yaw: 0 }, room({ min: [-1.1, -1.1], max: [1.1, 1.1] }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.distance).toBeLessThan(COMFORT_TABLE_DISTANCE);
    expect(r.distance).toBeGreaterThanOrEqual(MIN_TABLE_DISTANCE - 1e-9);
  });
});
