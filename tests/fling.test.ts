import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { TablePose } from '../src/combat/placement.ts';
import { CombatController, type ViewUpdate } from '../src/combat-view/controller.ts';
import { getCard } from '../src/content/cards.ts';
import {
  type AimTarget,
  isOverTable,
  pickFlingTarget,
  pickPointTarget,
  throwCrossesTable,
} from '../src/hand/aim.ts';
import { CardFan, type CardFanIntent } from '../src/hand/card-fan.ts';
import { FlingController, type FlingTargetSite } from '../src/hand/fling.ts';
import {
  DEFAULT_WINDOW_SECONDS,
  releaseVelocity,
  SampleWindow,
  type Vec3,
} from '../src/hand/velocity.ts';
import drop90 from './fixtures/fling/drop-90hz.json';
import flick72 from './fixtures/fling/flick-72hz.json';
import flick90 from './fixtures/fling/flick-90hz.json';
import flick120 from './fixtures/fling/flick-120hz.json';
import wobble90 from './fixtures/fling/wobble-90hz.json';

interface Trace {
  name: string;
  hz: number;
  windowSeconds: number;
  expectedVelocity: number[];
  samples: number[][];
}

const FLICKS = [flick72, flick90, flick120] as Trace[];
const DROP = drop90 as Trace;
const WOBBLE = wobble90 as Trace;

const norm = (v: readonly number[]): number => Math.hypot(...(v as [number, number, number]));
const unit = (v: readonly number[]): Vec3 => {
  const l = norm(v);
  return [(v[0] as number) / l, (v[1] as number) / l, (v[2] as number) / l];
};
const angleDeg = (a: readonly number[], b: readonly number[]): number =>
  (Math.acos(
    Math.min(
      1,
      ((a[0] as number) * (b[0] as number) +
        (a[1] as number) * (b[1] as number) +
        (a[2] as number) * (b[2] as number)) /
        (norm(a) * norm(b)),
    ),
  ) *
    180) /
  Math.PI;

function windowOf(trace: Trace, upTo = trace.samples.length): SampleWindow {
  const w = new SampleWindow();
  for (const [t, x, y, z] of trace.samples.slice(0, upTo) as [number, number, number, number][]) {
    w.push(t, x, y, z);
  }
  return w;
}

const relError = (trace: Trace): number => {
  const v = releaseVelocity(windowOf(trace));
  if (!v) throw new Error('no velocity');
  const e = trace.expectedVelocity;
  return (
    Math.hypot(v[0] - (e[0] as number), v[1] - (e[1] as number), v[2] - (e[2] as number)) / norm(e)
  );
};

describe('SampleWindow', () => {
  it('evicts the oldest sample at capacity and keeps time order', () => {
    const w = new SampleWindow(4);
    for (let i = 0; i < 7; i++) w.push(i, i, 0, 0);
    expect(w.size).toBe(4);
    expect([0, 1, 2, 3].map((i) => w.timeAt(i))).toEqual([3, 4, 5, 6]);
    expect(w.coordAt(0, 0)).toBe(3);
  });

  it('ignores a sample that is not newer than the last, and clears', () => {
    const w = new SampleWindow(4);
    w.push(1, 0, 0, 0);
    w.push(1, 9, 9, 9);
    w.push(0.5, 9, 9, 9);
    expect(w.size).toBe(1);
    w.clear();
    expect(w.size).toBe(0);
  });
});

describe('releaseVelocity against synthetic traces', () => {
  it.each(FLICKS.map((t) => [t.name, t] as const))(
    '%s recovers the flick velocity within 10%',
    (_name, trace) => {
      const v = releaseVelocity(windowOf(trace)) as [number, number, number];
      expect(relError(trace)).toBeLessThan(0.1);
      expect(angleDeg(v, trace.expectedVelocity)).toBeLessThan(3);
    },
  );

  it('gives the same answer at 72, 90 and 120 Hz', () => {
    const speeds = FLICKS.map((t) => norm(releaseVelocity(windowOf(t)) as number[]));
    const spread = (Math.max(...speeds) - Math.min(...speeds)) / Math.max(...speeds);
    expect(spread).toBeLessThan(0.05);
  });

  it('beats a two-sample difference on the sagged final frame', () => {
    const trace = flick90 as Trace;
    const [a, b] = trace.samples.slice(-2) as [number[], number[]];
    const dt = (b[0] as number) - (a[0] as number);
    const naive = [1, 2, 3].map((i) => ((b[i] as number) - (a[i] as number)) / dt);
    const naiveError =
      Math.hypot(
        ...(naive.map((n, i) => n - (trace.expectedVelocity[i] as number)) as [
          number,
          number,
          number,
        ]),
      ) / norm(trace.expectedVelocity);
    expect(naiveError).toBeGreaterThan(0.5);
    expect(relError(trace)).toBeLessThan(0.1);
  });

  it('keeps a release-frame drop out of the fit', () => {
    const trace = flick120 as Trace;
    const clean = { ...trace, samples: trace.samples.slice(0, -1) };
    const withJitter = norm(releaseVelocity(windowOf(trace)) as number[]);
    const without = norm(releaseVelocity(windowOf(clean)) as number[]);
    expect(Math.abs(withJitter - without) / without).toBeLessThan(0.05);
  });

  it.each([
    ['slow drop', DROP],
    ['lateral wobble', WOBBLE],
  ])('reads a %s as far below flick speed', (_label, trace) => {
    const v = releaseVelocity(windowOf(trace)) as [number, number, number];
    expect(norm(v)).toBeLessThan(0.5);
    expect(norm(v)).toBeCloseTo(norm(trace.expectedVelocity), 1);
  });

  it('needs three samples inside the window', () => {
    const w = new SampleWindow();
    w.push(0, 0, 0, 0);
    w.push(0.05, 0, 0, 0);
    expect(releaseVelocity(w)).toBeNull();
    w.push(0.1, 0, 0, 0);
    expect(releaseVelocity(w)).toBeNull();
    expect(DEFAULT_WINDOW_SECONDS).toBeGreaterThan(0.05);
    w.push(0.12, 0, 0, 0);
    expect(releaseVelocity(w)).toEqual([0, 0, 0]);
  });

  it('does not allocate a result when given an out vector', () => {
    const out: [number, number, number] = [9, 9, 9];
    expect(releaseVelocity(windowOf(FLICKS[0] as Trace), { out })).toBe(out);
    expect(out[2]).toBeLessThan(-2);
  });
});

const target = (id: string, position: Vec3, valid = true): AimTarget => ({ id, position, valid });
const rotated = (deg: number, distance: number): Vec3 => [
  Math.sin((deg * Math.PI) / 180) * distance,
  0,
  -Math.cos((deg * Math.PI) / 180) * distance,
];
const ORIGIN: Vec3 = [0, 0, 0];
const THROW: Vec3 = [0, 0, -3];

describe('pickFlingTarget', () => {
  it('picks a target inside the 20 degree cone and rejects one outside', () => {
    expect(pickFlingTarget(ORIGIN, THROW, [target('in', rotated(19.5, 4))])?.id).toBe('in');
    expect(pickFlingTarget(ORIGIN, THROW, [target('out', rotated(20.5, 4))])).toBeNull();
  });

  it('includes a target exactly on the cone edge', () => {
    expect(pickFlingTarget(ORIGIN, THROW, [target('edge', rotated(20, 4))])?.id).toBe('edge');
  });

  it('honours a different cone', () => {
    const t = [target('a', rotated(30, 4))];
    expect(pickFlingTarget(ORIGIN, THROW, t, { coneDeg: 35 })?.id).toBe('a');
    expect(pickFlingTarget(ORIGIN, THROW, t, { coneDeg: 25 })).toBeNull();
  });

  it('picks the nearest target in the cone', () => {
    const t = [
      target('far', rotated(2, 5)),
      target('near', rotated(10, 3)),
      target('off', rotated(40, 1)),
    ];
    expect(pickFlingTarget(ORIGIN, THROW, t)?.id).toBe('near');
  });

  it('skips invalid targets even when they are nearest and dead centre', () => {
    const t = [target('dead', rotated(0, 2), false), target('live', rotated(15, 4))];
    expect(pickFlingTarget(ORIGIN, THROW, t)?.id).toBe('live');
    expect(pickFlingTarget(ORIGIN, THROW, [target('dead', rotated(0, 2), false)])).toBeNull();
  });

  it('breaks near-ties by the smaller angle, but never overrides a clearly nearer target', () => {
    const tied = [target('wide', rotated(15, 3.0)), target('centred', rotated(2, 3.1))];
    expect(pickFlingTarget(ORIGIN, THROW, tied)?.id).toBe('centred');
    const apart = [target('wide', rotated(15, 3.0)), target('centred', rotated(2, 3.6))];
    expect(pickFlingTarget(ORIGIN, THROW, apart)?.id).toBe('wide');
  });

  it('returns nothing below the speed threshold or with no targets', () => {
    const t = [target('a', rotated(0, 4))];
    expect(pickFlingTarget(ORIGIN, [0, 0, -1], t)).toBeNull();
    expect(pickFlingTarget(ORIGIN, [0, 0, -1], t, { minSpeed: 0.5 })?.id).toBe('a');
    expect(pickFlingTarget(ORIGIN, [0, 0, 0], t, { minSpeed: 0 })).toBeNull();
    expect(pickFlingTarget(ORIGIN, THROW, [])).toBeNull();
  });

  it('aims in three dimensions and ignores targets behind the throw', () => {
    const high = target('high', [0, 3, -3]);
    expect(pickFlingTarget(ORIGIN, [0, 3, -3], [high])?.id).toBe('high');
    expect(pickFlingTarget(ORIGIN, THROW, [high])).toBeNull();
    expect(pickFlingTarget(ORIGIN, THROW, [target('behind', [0, 0, 4])])).toBeNull();
  });

  it('aims a recorded flick at the enemy it was thrown toward', () => {
    for (const trace of FLICKS) {
      const v = releaseVelocity(windowOf(trace)) as [number, number, number];
      const last = trace.samples[trace.samples.length - 1] as number[];
      const from: Vec3 = [last[1] as number, last[2] as number, last[3] as number];
      const dir = unit(trace.expectedVelocity);
      const at = (deg: number): Vec3 => {
        // Rotate the true throw direction about the vertical axis.
        const r = (deg * Math.PI) / 180;
        const x = dir[0] * Math.cos(r) + dir[2] * Math.sin(r);
        const z = -dir[0] * Math.sin(r) + dir[2] * Math.cos(r);
        return [from[0] + x * 3, from[1] + dir[1] * 3, from[2] + z * 3];
      };
      const pick = pickFlingTarget(from, v, [
        target('ahead', at(3)),
        target('side', at(35)),
        target('behind-left', at(-60)),
      ]);
      expect(pick?.id, trace.name).toBe('ahead');
    }
  });
});

describe('pickPointTarget', () => {
  const ray = { origin: [0, 1, 0] as Vec3, direction: [0, 0, -2] as Vec3 };

  it('picks the target the ray passes closest to, within the radius', () => {
    const t = [target('a', [0.5, 1, -3]), target('b', [0.1, 1, -4]), target('c', [3, 1, -3])];
    const pick = pickPointTarget(ray, t, 0.6);
    expect(pick?.id).toBe('b');
    expect(pick?.miss).toBeCloseTo(0.1, 6);
    expect(pick?.along).toBeCloseTo(4, 6);
  });

  it('rejects targets beyond the radius, behind the ray and invalid ones', () => {
    expect(pickPointTarget(ray, [target('wide', [0.7, 1, -3])], 0.6)).toBeNull();
    expect(pickPointTarget(ray, [target('behind', [0, 1, 3])], 0.6)).toBeNull();
    expect(pickPointTarget(ray, [target('dead', [0, 1, -3], false)], 0.6)).toBeNull();
    expect(
      pickPointTarget({ origin: ORIGIN, direction: [0, 0, 0] }, [target('a', [0, 0, -1])]),
    ).toBeNull();
  });

  it('lets a target carry its own radius', () => {
    const big: AimTarget = { id: 'golem', position: [1, 1, -3], valid: true, radius: 1.2 };
    expect(pickPointTarget(ray, [big], 0.6)?.id).toBe('golem');
  });
});

describe('isOverTable and throwCrossesTable', () => {
  const table: TablePose = { x: 1, z: -2, yaw: 0, height: 0.9 };

  it('accepts a point above the table top and rejects one beside or far above it', () => {
    expect(isOverTable([1, 1.1, -2], table)).toBe(true);
    expect(isOverTable([1.7, 1.1, -2.3], table)).toBe(true);
    expect(isOverTable([1.95, 1.1, -2], table)).toBe(false);
    expect(isOverTable([1, 1.1, -2.6], table)).toBe(false);
    expect(isOverTable([1, 2.0, -2], table)).toBe(false);
    expect(isOverTable([1, 0.4, -2], table)).toBe(false);
  });

  it('follows the table heading', () => {
    const turned: TablePose = { ...table, yaw: 90 };
    // Heading 90 faces +X: the long axis runs along Z, the short one along X.
    expect(isOverTable([1, 1.1, -2.7], turned)).toBe(true);
    expect(isOverTable([1.7, 1.1, -2], turned)).toBe(false);
  });

  it('sees a throw that crosses the footprint from off the table', () => {
    expect(throwCrossesTable([0, 1.2, 0], [0.2, 0.5, -3], table)).toBe(true);
    expect(throwCrossesTable([0, 1.2, 0], [-1, 0, -3], table)).toBe(false);
    expect(throwCrossesTable([0, 1.2, 0], [0, 0, 3], table)).toBe(false);
  });
});

/** A seated player facing -Z, a table in front and one enemy straight down the throw line. */
function rig(options: { deck?: string[]; table?: TablePose | null; pointAtEnemy?: boolean } = {}) {
  const combat = new CombatController({
    seed: 'FLING001',
    enemy: 'cog-sentry',
    deck: options.deck ?? ['strike', 'defend', 'furnace-brand', 'warding-glyph', 'cogstorm'],
  });
  const hand = combat.state.piles.hand;
  const fan = new CardFan({ syncLabels: false });
  fan.setHand(
    hand.map((c) => getCard(c.def.id)),
    hand.map((c) => c.uid),
  );
  const grip = new THREE.Object3D();
  fan.setMainGrip(grip);
  const enemyId = (combat.state.enemies[0] as { id: string }).id;

  const intents: CardFanIntent[] = [];
  fan.on((i) => intents.push(i));
  const updates: ViewUpdate[] = [];
  combat.subscribe((u) => updates.push(u));

  const sites: FlingTargetSite[] = [];
  const pointer = { current: null as { origin: Vec3; direction: Vec3 } | null };
  const fling = new FlingController({
    fan,
    combat,
    mainGrip: grip,
    targets: () => sites,
    table: () => (options.table === null ? null : { pose: options.table ?? DEFAULT_TABLE }),
    pointRay: () => pointer.current,
  });

  const indexOf = (cardId: string): number => hand.findIndex((c) => c.def.id === cardId);
  const hp = (): number => (combat.state.enemies[0] as { hp: number }).hp;

  /** Plays a recorded trace through the grip, one `update` per recorded frame. */
  function replay(trace: Trace, cardId: string) {
    const first = trace.samples[0] as number[];
    grip.position.set(first[1] as number, first[2] as number, first[3] as number);
    const grabbed = fling.grab(indexOf(cardId));
    let prev = first[0] as number;
    for (const s of trace.samples.slice(1)) {
      grip.position.set(s[1] as number, s[2] as number, s[3] as number);
      const dt = (s[0] as number) - prev;
      fling.update(dt);
      fan.update(dt);
      prev = s[0] as number;
    }
    return { grabbed, last: trace.samples[trace.samples.length - 1] as number[] };
  }

  const place = (from: number[], trace: Trace, distance: number, id = enemyId): void => {
    const d = unit(trace.expectedVelocity);
    sites.push({
      id,
      position: [
        (from[1] as number) + d[0] * distance,
        (from[2] as number) + d[1] * distance,
        (from[3] as number) + d[2] * distance,
      ],
    });
  };

  const returned = (): number => {
    fan.update(0.5);
    return intents.filter((i) => i.type === 'returned').length;
  };

  return {
    combat,
    fan,
    grip,
    fling,
    enemyId,
    intents,
    updates,
    sites,
    pointer,
    replay,
    place,
    indexOf,
    hp,
    returned,
  };
}

const DEFAULT_TABLE: TablePose = { x: 0.25, z: -1.6, yaw: 0, height: 0.85 };
const invalids = (updates: ViewUpdate[]) => updates.filter((u) => u.type === 'invalid');

describe('FlingController: targeted cards', () => {
  it.each(FLICKS.map((t) => [t.name, t] as const))(
    '%s plays a flicked attack at the enemy',
    (_n, trace) => {
      const r = rig();
      const before = r.hp();
      const grab = r.replay(trace, 'strike');
      expect(grab.grabbed?.card.id).toBe('strike');
      r.place(grab.last, trace, 3.2);
      // A nearer decoy in the cone that the rules do not know is not a valid target.
      r.place(grab.last, trace, 1.5, 'ghost');
      const decision = r.fling.release();
      expect(decision).toMatchObject({
        outcome: 'played',
        via: 'flick',
        targetId: r.enemyId,
        reason: null,
      });
      expect(decision?.speed).toBeGreaterThan(2.5);
      expect(decision?.angleDeg).toBeLessThan(6);
      expect(r.hp()).toBeLessThan(before);
      expect(r.combat.selectedUid).toBeNull();
      expect(r.fling.lastDecision).toBe(decision);
      expect(r.fling.debugText()).toContain('played flick strike');
    },
  );

  it('falls back to the pointing ray when the card is let go slowly', () => {
    const r = rig();
    const before = r.hp();
    const grab = r.replay(DROP, 'strike');
    r.sites.push({ id: r.enemyId, position: [0.2, 1.3, -3] });
    r.pointer.current = { origin: [0.25, 1, -0.4], direction: [-0.05, 0.3, -2.6] };
    expect(grab.last).toBeDefined();
    const decision = r.fling.release();
    expect(decision).toMatchObject({ outcome: 'played', via: 'point', targetId: r.enemyId });
    expect(decision?.speed).toBeLessThan(0.5);
    expect(r.hp()).toBeLessThan(before);
  });

  it('uses the pointing ray when a flick has no enemy in its cone', () => {
    const r = rig();
    const grab = r.replay(FLICKS[1] as Trace, 'strike');
    r.sites[0] = {
      id: r.enemyId,
      position: [(grab.last[1] as number) + 3, 1.3, grab.last[3] as number],
    };
    r.pointer.current = { origin: [0, 1.3, grab.last[3] as number], direction: [1, 0, 0] };
    const decision = r.fling.release();
    expect(decision).toMatchObject({ outcome: 'played', via: 'point', targetId: r.enemyId });
  });

  it('springs the card back with no target and no pointing ray', () => {
    const r = rig();
    const before = r.hp();
    r.replay(DROP, 'strike');
    r.sites.push({ id: r.enemyId, position: [0.2, 1.3, -3] });
    const decision = r.fling.release();
    expect(decision).toMatchObject({ outcome: 'sprung-back', via: 'none', targetId: null });
    expect(decision?.reason).toMatch(/target/i);
    expect(r.hp()).toBe(before);
    expect(r.combat.selectedUid).toBeNull();
    expect(r.returned()).toBe(1);
    expect(r.fan.grabbed).toBeNull();
  });

  it('does not play at an enemy the rules say is dead', () => {
    const r = rig();
    const grab = r.replay(FLICKS[0] as Trace, 'strike');
    r.place(grab.last, FLICKS[0] as Trace, 3.2);
    const state = r.combat.state;
    r.combat.state = {
      ...state,
      enemies: state.enemies.map((e) => ({ ...e, hp: 0 })),
    };
    const decision = r.fling.release();
    expect(decision?.outcome).toBe('sprung-back');
    expect(r.returned()).toBe(1);
  });
});

describe('FlingController: invalid plays spring back', () => {
  const noSteam = (r: ReturnType<typeof rig>): void => {
    r.combat.state = { ...r.combat.state, player: { ...r.combat.state.player, steam: 0 } };
  };

  it('refuses to pick up a card the player cannot afford and cancels the selection', () => {
    const r = rig();
    noSteam(r);
    const grab = r.replay(FLICKS[0] as Trace, 'strike');
    expect(grab.grabbed).toBeNull();
    expect(r.fling.holding).toBeNull();
    const rejected = invalids(r.updates);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({ subject: { kind: 'card' } });
    expect(r.fling.lastDecision).toMatchObject({ outcome: 'sprung-back', via: 'none' });
    expect(r.fling.lastDecision?.reason).toMatch(/costs/);
    expect(r.combat.selectedUid).toBeNull();
    expect(r.returned()).toBe(1);
    expect(r.fling.release()).toBeNull();
  });

  it('springs back and cancels when the rules refuse the play at release', () => {
    const r = rig();
    const grab = r.replay(FLICKS[0] as Trace, 'strike');
    r.place(grab.last, FLICKS[0] as Trace, 3.2);
    expect(r.combat.selectedUid).not.toBeNull();
    noSteam(r);
    const hpBefore = r.hp();
    const decision = r.fling.release();
    expect(decision).toMatchObject({ outcome: 'sprung-back', via: 'flick', targetId: r.enemyId });
    expect(decision?.reason).toMatch(/costs/);
    expect(invalids(r.updates)).toHaveLength(1);
    expect(r.combat.selectedUid).toBeNull();
    expect(r.hp()).toBe(hpBefore);
    expect(r.returned()).toBe(1);
  });

  it('springs an unaffordable untargeted card back when dropped on the table', () => {
    const r = rig({ table: { x: 0.25, z: -0.45, yaw: 0, height: 0.8 } });
    const grab = r.replay(DROP, 'defend');
    expect(grab.grabbed).not.toBeNull();
    noSteam(r);
    const decision = r.fling.release();
    expect(decision).toMatchObject({ outcome: 'sprung-back', via: 'drop' });
    expect(decision?.reason).toMatch(/costs/);
    expect(r.combat.selectedUid).toBeNull();
    expect(r.returned()).toBe(1);
  });
});

describe('FlingController: untargeted cards', () => {
  const underDrop = (): TablePose => {
    const last = DROP.samples[DROP.samples.length - 1] as number[];
    return { x: last[1] as number, z: (last[3] as number) - 0.1, yaw: 0, height: 0.8 };
  };

  it('plays when dropped on the table', () => {
    const r = rig({ table: underDrop() });
    const handBefore = r.combat.state.piles.hand.length;
    r.replay(DROP, 'defend');
    const decision = r.fling.release();
    expect(decision).toMatchObject({ outcome: 'played', via: 'drop', targetId: null });
    expect(r.combat.state.piles.hand).toHaveLength(handBefore - 1);
    expect(r.combat.state.player.block).toBeGreaterThan(0);
  });

  it('springs back when dropped away from the table', () => {
    const r = rig({ table: { x: 4, z: -4, yaw: 0, height: 0.8 } });
    const handBefore = r.combat.state.piles.hand.length;
    r.replay(DROP, 'defend');
    const decision = r.fling.release();
    expect(decision).toMatchObject({ outcome: 'sprung-back', via: 'none' });
    expect(decision?.reason).toMatch(/table/i);
    expect(r.combat.state.piles.hand).toHaveLength(handBefore);
    expect(r.combat.selectedUid).toBeNull();
    expect(r.returned()).toBe(1);
  });

  it('springs back while no table is unfolded', () => {
    const r = rig({ table: null });
    r.replay(DROP, 'defend');
    expect(r.fling.release()?.outcome).toBe('sprung-back');
  });

  it('plays an untargeted card flicked across the table', () => {
    const r = rig({ table: { x: 0.3, z: -1.6, yaw: 0, height: 0.8 } });
    r.replay(FLICKS[1] as Trace, 'defend');
    const decision = r.fling.release();
    expect(decision).toMatchObject({ outcome: 'played', via: 'flick' });
  });
});

describe('FlingController: sigil cards', () => {
  it('stages a flicked sigil attack for the plate and leaves the card out of the fan', () => {
    const r = rig();
    const grab = r.replay(FLICKS[0] as Trace, 'furnace-brand');
    r.place(grab.last, FLICKS[0] as Trace, 3.2);
    const decision = r.fling.release();
    expect(decision).toMatchObject({ outcome: 'staged', via: 'flick', targetId: r.enemyId });
    expect(r.fling.stage).toBe('sigil');
    expect(r.combat.awaitedSigil).toBe('flame');
    expect(r.returned()).toBe(0);
  });

  it('stages an untargeted sigil card dropped on the table without a refusal', () => {
    const last = DROP.samples[DROP.samples.length - 1] as number[];
    const r = rig({ table: { x: last[1] as number, z: last[3] as number, yaw: 0, height: 0.8 } });
    r.replay(DROP, 'warding-glyph');
    const decision = r.fling.release();
    expect(decision).toMatchObject({ outcome: 'staged', via: 'drop' });
    expect(invalids(r.updates)).toHaveLength(0);
    expect(r.fling.stage).toBe('sigil');
  });

  it('springs a staged card back when another card is grabbed', () => {
    const r = rig();
    const grab = r.replay(FLICKS[0] as Trace, 'furnace-brand');
    r.place(grab.last, FLICKS[0] as Trace, 3.2);
    expect(r.fling.release()?.outcome).toBe('staged');
    expect(r.fling.grab(r.indexOf('strike'))?.card.id).toBe('strike');
    expect(r.combat.selectedUid).toBe(r.fan.grabbed?.uid);
    expect(r.returned()).toBe(1);
    const back = r.intents.filter((i) => i.type === 'returned');
    expect(back[0]).toMatchObject({ card: { id: 'furnace-brand' } });
  });

  it('springs a staged card back when the cast is abandoned', () => {
    const r = rig();
    const grab = r.replay(FLICKS[0] as Trace, 'furnace-brand');
    r.place(grab.last, FLICKS[0] as Trace, 3.2);
    r.fling.release();
    r.fling.abortStaged();
    expect(r.combat.selectedUid).toBeNull();
    expect(r.returned()).toBe(1);
    r.fling.abortStaged();
    expect(r.returned()).toBe(1);
  });
});

describe('FlingController: bookkeeping', () => {
  it('keeps a bounded decision history and ignores release with nothing held', () => {
    const r = rig();
    expect(r.fling.release()).toBeNull();
    expect(r.fling.debugText()).toBe('fling: idle');
    for (let i = 0; i < 25; i++) {
      r.fan.setHand([getCard('strike')], [100 + i]);
      r.fling.setMainGrip(r.grip);
      r.combat.state = { ...r.combat.state, player: { ...r.combat.state.player, steam: 0 } };
      r.fling.grab(0);
    }
    expect(r.fling.history.length).toBeLessThanOrEqual(20);
  });
});
