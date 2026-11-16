// @vitest-environment node
import type { StandardHand } from '@par/xr-workspace';
import * as THREE from 'three';
import { beforeAll, describe, expect, it } from 'vitest';
import { CARDS, type SliceCard } from '../src/content/cards.ts';
import { CardFan } from '../src/hand/card-fan.ts';
import { DEFAULT_FAN, GRIP_FAN_ORIGIN, MAX_HAND, type Vec3 } from '../src/hand/fan-layout.ts';
import {
  cardQuads,
  contact,
  HELD_POSES,
  type HeldPose,
  handSurface,
  loadStandardHand,
  type Surface,
} from './helpers/off-hand.ts';

/**
 * Quest 3 report 2026-11-15: the off hand's wrist showed through the middle of the fanned cards.
 * The fan is parented to the controller grip, and so is the toolkit hand the XR rig draws, so their
 * relative placement is fixed: this measures the real hand meshes (skin, wrist cap, elastic arm)
 * against every card quad as drawn, for every hand size, hover state and finger curl.
 */

/** Smallest allowed distance from the hand surface to any card face, metres. */
const MIN_CLEARANCE = 0.008;
/** The fan reads as held: some card comes this close to the hand at rest. */
const HELD_WITHIN = 0.03;

const hand = (n: number) =>
  Array.from({ length: n }, (_, i) => CARDS[i % CARDS.length] as SliceCard);
const CURLS = [0, 0.5, 1];

let surfaces: Surface[] = [];
let model: StandardHand;

beforeAll(async () => {
  model = await loadStandardHand();
  // The hand is rigid in grip space apart from the curls, the arm apart from the head pose.
  for (const thumb of CURLS)
    for (const trigger of CURLS)
      for (const squeeze of CURLS)
        surfaces.push(handSurface(model, HELD_POSES[0] as HeldPose, [thumb, trigger, squeeze]));
  for (const pose of HELD_POSES.slice(1)) surfaces.push(handSurface(model, pose, [1, 1, 1]));
  surfaces = surfaces.filter((s) => s.positions.length > 0);
}, 30_000);

interface Sweep {
  minGap: number;
  crossings: string[];
  /** Closest approach of the hand to the resting fan, per hand size. */
  restGap: number[];
}

/** Every card of every hand size, resting, half raised and fully raised, against every hand surface. */
function sweep(origin: Vec3): Sweep {
  const fan = new CardFan({ syncLabels: false, loadArt: false, hoverSeconds: 0.1 });
  fan.attach(new THREE.Group(), origin);
  const out: Sweep = { minGap: Number.POSITIVE_INFINITY, crossings: [], restGap: [] };
  for (let n = 1; n <= MAX_HAND; n++) {
    fan.setHand(hand(n));
    fan.update(1);
    let rest = Number.POSITIVE_INFINITY;
    for (let h = -1; h < n; h++) {
      fan.hover(h < 0 ? null : h);
      for (const [dt, label] of [
        [0.05, 'half'],
        [1, 'full'],
      ] as const) {
        if (h < 0 && label === 'half') continue;
        fan.update(dt);
        for (const quad of cardQuads(fan)) {
          if (h >= 0 && quad.index !== h) continue;
          for (const surface of surfaces) {
            const c = contact(surface, quad);
            out.minGap = Math.min(out.minGap, c.gap);
            if (h < 0) rest = Math.min(rest, c.gap);
            if (c.crosses)
              out.crossings.push(`${n} cards, card ${quad.index}, hover ${h < 0 ? 'none' : label}`);
          }
        }
      }
      fan.hover(null);
      fan.update(1);
    }
    out.restGap.push(rest);
  }
  fan.dispose();
  return out;
}

describe('off-hand card fan vs the off-hand model', () => {
  it('measures a real hand: skin, wrist cap and arm, in grip space', () => {
    expect(surfaces.length).toBe(CURLS.length ** 3 + HELD_POSES.length - 1);
    for (const s of surfaces) {
      expect(s.names).toEqual(
        expect.arrayContaining(['standard-hand-skin-left', 'standard-hand-wrist-cap-left']),
      );
      expect(s.triangles.length).toBeGreaterThan(1000);
    }
  });

  it('the old fan centre ran through the wrist (the reported defect)', () => {
    expect(sweep(DEFAULT_FAN.origin).crossings.length).toBeGreaterThan(0);
  }, 60_000);

  it('the grip fan clears the hand at 1 to 10 cards, resting and raised, at every curl', () => {
    const result = sweep(GRIP_FAN_ORIGIN);
    expect(result.crossings).toEqual([]);
    expect(result.minGap).toBeGreaterThanOrEqual(MIN_CLEARANCE);
    // Still held: at every hand size the resting fan sits right on the hand.
    for (const gap of result.restGap) expect(gap).toBeLessThanOrEqual(HELD_WITHIN);
  }, 60_000);
});
