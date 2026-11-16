import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { CombatController } from '../src/combat-view/controller.ts';
import {
  foldEvents,
  playerHit,
  segmentEvents,
  type TurnSegment,
} from '../src/combat-view/enemy-turn.ts';
import {
  FLASH_FADE_SECONDS,
  FLASH_RISE_SECONDS,
  HIT_PEAK,
  HitFeedback,
  hapticFor,
  pulseHaptics,
  REDUCED_PEAK_SCALE,
} from '../src/combat-view/hit-feedback.ts';
import { getCard } from '../src/content/cards.ts';
import { ENCOUNTERS, encounterSetups } from '../src/content/enemies.ts';
import type { CombatEvent, CombatState } from '../src/rules/index.ts';

const fighters = (s: CombatState) => ({
  turn: s.turn,
  outcome: s.outcome,
  player: s.player,
  enemies: s.enemies.map(({ id, hp, block, statuses, intent }) => ({
    id,
    hp,
    block,
    statuses,
    intent: intent?.id ?? null,
  })),
});

/** Plays one plain card if one is affordable (attack first), then ends the turn. */
function playTurn(c: CombatController): void {
  const state = c.state;
  const plain = state.piles.hand.filter((card) => {
    const info = getCard(card.def.id);
    return info.dice === undefined && info.sigil === undefined && info.cost <= state.player.steam;
  });
  const card = plain.find((p) => getCard(p.def.id).type === 'attack') ?? plain[0];
  if (card) {
    c.select(card.uid);
    if (getCard(card.def.id).target === 'enemy') {
      const foe = c.state.enemies.find((e) => e.hp > 0);
      if (foe) c.target(foe.id);
    } else c.table();
  }
  c.endTurn();
}

const multi = [...ENCOUNTERS.regular, ...ENCOUNTERS.elite].filter((e) => e.enemies.length >= 2);
const SEEDS = ['SPIRE001', 'SPIRE002', 'SPIRE003', 'K7Q2M9XA'];

describe('enemy turn segmentation', () => {
  it('has multi-enemy encounters to test', () => {
    expect(multi.length).toBeGreaterThanOrEqual(2);
  });

  it('cuts every turn into one beat per acting enemy, in rules order, losing no event', () => {
    for (const seed of SEEDS) {
      for (const encounter of multi) {
        const c = new CombatController({ seed, setups: encounterSetups(encounter) });
        c.drainEvents();
        for (let turn = 0; turn < 8 && c.outcome === null; turn++) {
          playTurn(c);
          const events = c.drainEvents();
          const segments = segmentEvents(events);
          expect(segments.flatMap(eventsOf)).toEqual(events);
          const beats = segments.filter((s) => s.kind === 'enemy');
          const acted = events.flatMap((e) => (e.type === 'enemy-acted' ? [e.enemyId] : []));
          expect(beats.filter((b) => b.moveId !== null).map((b) => b.enemyId)).toEqual(acted);
          // Rules order is the enemies' array order; no enemy gets two beats in one turn.
          const order = c.state.enemies.map((e) => e.id);
          const ids = beats.map((b) => b.enemyId);
          expect([...ids].sort((a, b) => order.indexOf(a) - order.indexOf(b))).toEqual(ids);
          expect(new Set(ids).size).toBe(ids.length);
          for (const beat of beats) {
            const touched = [...beat.lead, ...beat.act].flatMap((e) =>
              'target' in e && e.target !== 'player' && e.target !== beat.enemyId ? [e] : [],
            );
            expect(touched).toEqual([]);
          }
        }
      }
    }
  });

  it('folding each beat onto the shown state ends at the rules state', () => {
    for (const seed of SEEDS) {
      for (const encounter of multi) {
        const c = new CombatController({
          seed,
          setups: encounterSetups(encounter),
          deck: Array(10).fill('defend'),
        });
        c.drainEvents();
        let shown = c.state;
        for (let turn = 0; turn < 8 && c.outcome === null; turn++) {
          playTurn(c);
          for (const seg of segmentEvents(c.drainEvents())) {
            shown = foldEvents(shown, eventsOf(seg));
          }
          expect(fighters(shown)).toEqual(fighters(c.state));
        }
      }
    }
  });
});

function eventsOf(seg: TurnSegment): readonly CombatEvent[] {
  return seg.kind === 'instant' ? seg.events : [...seg.lead, ...seg.act];
}

describe('player hit classification', () => {
  const dmg = (
    amount: number,
    blocked: number,
    hpLost: number,
    target = 'player',
  ): CombatEvent => ({
    type: 'damage-dealt',
    source: 'cog-sentry-1',
    target,
    kind: 'attack',
    amount,
    blocked,
    hpLost,
  });
  it('tells a clean hit, a full block and a partial block apart and sums multi-hits', () => {
    expect(playerHit([dmg(8, 0, 8)])).toEqual({ kind: 'hit', amount: 8, blocked: 0, hpLost: 8 });
    expect(playerHit([dmg(8, 8, 0)])).toEqual({
      kind: 'blocked',
      amount: 8,
      blocked: 8,
      hpLost: 0,
    });
    expect(playerHit([dmg(3, 3, 0), dmg(3, 1, 2)])).toEqual({
      kind: 'partial',
      amount: 6,
      blocked: 4,
      hpLost: 2,
    });
    expect(playerHit([dmg(0, 0, 0)])).toBeNull();
    expect(playerHit([dmg(5, 0, 5, 'cog-sentry-1')])).toBeNull();
  });
});

describe('haptics', () => {
  it('pulses every controller that has an actuator', () => {
    const left = vi.fn(() => Promise.resolve(true));
    const right = vi.fn(() => true);
    const n = pulseHaptics(
      [
        { gamepad: { hapticActuators: [{ pulse: left }] } },
        { gamepad: { hapticActuators: [{ pulse: right }] } },
      ],
      0.7,
      110,
    );
    expect(n).toBe(2);
    expect(left).toHaveBeenCalledWith(0.7, 110);
    expect(right).toHaveBeenCalledWith(0.7, 110);
  });

  it('is a safe no-op without sources, gamepads or actuators, and survives a refusing actuator', async () => {
    expect(pulseHaptics(null, 1, 100)).toBe(0);
    expect(pulseHaptics(undefined, 1, 100)).toBe(0);
    expect(
      pulseHaptics(
        [
          {},
          { gamepad: null },
          { gamepad: {} },
          { gamepad: { hapticActuators: [] } },
          { gamepad: { hapticActuators: [{}] } },
        ],
        1,
        100,
      ),
    ).toBe(0);
    const throwing = {
      pulse: () => {
        throw new Error('busy');
      },
    };
    const rejecting = { pulse: () => Promise.reject(new Error('busy')) };
    expect(() =>
      pulseHaptics(
        [
          { gamepad: { hapticActuators: [throwing] } },
          { gamepad: { hapticActuators: [rejecting] } },
        ],
        2,
        100,
      ),
    ).not.toThrow();
    await Promise.resolve();
    const clamp = vi.fn(() => true);
    pulseHaptics([{ gamepad: { hapticActuators: [{ pulse: clamp }] } }], 5, 10);
    expect(clamp).toHaveBeenCalledWith(1, 10);
  });

  it('pulses harder for more damage and faintly for a full block', () => {
    const small = hapticFor({ kind: 'hit', amount: 3, blocked: 0, hpLost: 3 });
    const big = hapticFor({ kind: 'hit', amount: 12, blocked: 0, hpLost: 12 });
    const block = hapticFor({ kind: 'blocked', amount: 8, blocked: 8, hpLost: 0 });
    expect(big.intensity).toBeGreaterThan(small.intensity);
    expect(block.intensity).toBeLessThan(small.intensity);
    expect(big.intensity).toBeLessThanOrEqual(1);
  });
});

describe('hit edge flash', () => {
  const camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.05, 100);
  const run = (fx: HitFeedback, seconds: number): number[] => {
    const out: number[] = [];
    for (let t = 0; t < seconds; t += 1 / 60) {
      fx.update(1 / 60, camera, { x: 1.2, y: 0.7 });
      out.push(fx.opacity);
    }
    return out;
  };

  it('flashes red briefly at the edges and fades out completely', () => {
    const fx = new HitFeedback();
    expect(fx.active).toBe(false);
    fx.trigger({ kind: 'hit', amount: 8, blocked: 0, hpLost: 8 });
    const curve = run(fx, FLASH_RISE_SECONDS + FLASH_FADE_SECONDS + 0.2);
    expect(Math.max(...curve)).toBeGreaterThan(HIT_PEAK * 0.8);
    expect(Math.max(...curve)).toBeLessThanOrEqual(HIT_PEAK + 1e-9);
    expect(curve.at(-1)).toBe(0);
    expect(fx.active).toBe(false);
    expect(fx.last?.kind).toBe('hit');
  });

  it('shows brass shimmer for a full block and stays locked to the camera', () => {
    const fx = new HitFeedback();
    camera.position.set(1, 2, 3);
    camera.updateMatrixWorld(true);
    fx.trigger({ kind: 'blocked', amount: 6, blocked: 6, hpLost: 0 });
    run(fx, 0.06);
    expect(fx.kind).toBe('block');
    const at = fx.quad.getWorldPosition(new THREE.Vector3());
    expect(at.distanceTo(camera.position)).toBeCloseTo(0.1, 3);
    fx.trigger({ kind: 'partial', amount: 9, blocked: 4, hpLost: 5 });
    run(fx, 0.06);
    expect(fx.kind).toBe('damage');
  });

  it('is softer with reduced motion', () => {
    const full = new HitFeedback();
    const soft = new HitFeedback({ reducedMotion: true });
    const hit = { kind: 'hit' as const, amount: 8, blocked: 0, hpLost: 8 };
    full.trigger(hit);
    soft.trigger(hit);
    const a = Math.max(...run(full, 1));
    const b = Math.max(...run(soft, 1));
    expect(b).toBeCloseTo(a * REDUCED_PEAK_SCALE, 1);
  });
});
