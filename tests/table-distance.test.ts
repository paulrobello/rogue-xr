/**
 * H5 (Quest 3 playtest 2026-11-16): the unfolded combat table sat too close to the seated head. The
 * table centre moved from 0.65 m (0.5 m fallback) to 0.85 m ahead (0.65 m comfortable fallback,
 * 0.5 m only when no heading fits further out). These pin the distances and the reach they keep.
 */
import { describe, expect, it } from 'vitest';
import {
  COMFORT_TABLE_DISTANCE,
  type CombatRoom,
  DEFAULT_TABLE_DISTANCE,
  MIN_TABLE_DISTANCE,
  placeTable,
  TABLE_HALF_DEPTH,
} from '../src/combat/placement.ts';
import type { Rect } from '../src/content/rooms.ts';
import { isOverTable } from '../src/hand/aim.ts';

const room = (...walkable: Rect[]): CombatRoom => ({
  footprint: walkable[0] as Rect,
  walkable,
  colliders: [],
});

describe('H5 table distance from the seated head', () => {
  it('pins the distances: 0.85 m ideal, 0.65 m comfortable fallback, 0.5 m last resort', () => {
    expect(DEFAULT_TABLE_DISTANCE).toBe(0.85);
    expect(COMFORT_TABLE_DISTANCE).toBe(0.65);
    expect(MIN_TABLE_DISTANCE).toBe(0.5);
    // Near edge of the 0.8 m deep table: 0.45 m ahead of the head (it was 0.25 m).
    expect(DEFAULT_TABLE_DISTANCE - TABLE_HALF_DEPTH).toBeCloseTo(0.45);
  });

  it('stands 0.85 m ahead in open space, with the drop zone starting 0.35 m from the head', () => {
    const r = placeTable(
      { x: 0, z: 0, yaw: 0, eyeHeight: 1.6 },
      room({ min: [-5, -5], max: [5, 5] }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.distance).toBeCloseTo(0.85);
    expect(r.pose.z).toBeCloseTo(-0.85);
    // A card let go at chest height (0.4 m below the 1.6 m eye) is a table drop from 0.35 m ahead,
    // well inside a seated arm's reach, and not at 0.3 m (right against the chest).
    const chest = 1.2;
    expect(isOverTable([0, chest, -0.36], r.pose)).toBe(true);
    expect(isOverTable([0, chest, -0.3], r.pose)).toBe(false);
  });

  it('turns to a comfortable heading before it comes closer than 0.65 m', () => {
    // A wall 1.1 m ahead: straight ahead only a 0.5 to 0.6 m table fits, to the side 0.85 m does.
    const r = placeTable({ x: 0, z: 0, yaw: 0 }, room({ min: [-5, -1.1], max: [5, 5] }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.offsetDeg).not.toBe(0);
    expect(r.distance).toBeGreaterThanOrEqual(COMFORT_TABLE_DISTANCE - 1e-9);
  });

  it('still places a 0.5 m table where nothing further fits, so a cramped fight still opens', () => {
    // A 2.2 m square closet around the player: only close tables fit anywhere.
    const r = placeTable({ x: 0, z: 0, yaw: 0 }, room({ min: [-1.1, -1.1], max: [1.1, 1.1] }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.distance).toBeLessThan(COMFORT_TABLE_DISTANCE);
    expect(r.distance).toBeGreaterThanOrEqual(MIN_TABLE_DISTANCE - 1e-9);
  });
});
