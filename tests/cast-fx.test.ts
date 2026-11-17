import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  CAST_FX_POINTS,
  CastFx,
  STEAM_CAPACITY,
  STREAM_CAPACITY,
} from '../src/combat-view/cast-fx.ts';
import { CastReveal } from '../src/combat-view/cast-reveal.ts';
import {
  type CastFxKind,
  castFxSteps,
  castLandSeconds,
  FX_STAGGER_SECONDS,
  MOTE_SECONDS,
  newRevealFrame,
  newShieldFrame,
  REVEAL_EFFECT_AT,
  REVEAL_FACE_FLARE,
  REVEAL_IN_SECONDS,
  REVEAL_SECONDS,
  REVEAL_START_SCALE,
  revealFrame,
  SHIELD_FORM_SECONDS,
  SHIELD_PULSE_SECONDS,
  SHIELD_SECONDS,
  STEAM_PUFFS_MAX,
  STEAM_RISE,
  STEAM_SECONDS,
  shieldFrame,
  shieldGain,
  steamPuffs,
} from '../src/combat-view/cast-timing.ts';
import { CARDS, upgradedCard } from '../src/content/cards.ts';
import { GLYPH_LAUNCH_SECONDS } from '../src/sigil-plate/glyph-timing.ts';

const DT = 1 / 60;
/** The plate hides this long after a cast (combat-session `PLATE_DONE_SECONDS`). */
const PLATE_DONE_SECONDS = 1.6;

const kinds = (id: string, upgraded = false): CastFxKind[] => {
  const card = CARDS.find((c) => c.id === id);
  if (!card) throw new Error(id);
  return castFxSteps(upgraded ? upgradedCard(card) : card).map((s) => s.kind);
};

describe('cast reveal timeline', () => {
  it('grows the card out of the glyph, holds it whole, then burns it away', () => {
    const f = newRevealFrame();
    expect(revealFrame(-0.01, false, f).visible).toBe(false);
    revealFrame(0, false, f);
    expect(f.visible).toBe(true);
    expect(f.burn).toBeCloseTo(1);
    expect(f.scale).toBeCloseTo(REVEAL_START_SCALE);
    expect(f.halo).toBeGreaterThan(0.9);
    revealFrame(REVEAL_IN_SECONDS + 0.05, false, f);
    expect(f.burn).toBe(0);
    expect(f.scale).toBe(1);
    revealFrame(REVEAL_EFFECT_AT + 0.08, false, f);
    expect(f.burn).toBeGreaterThan(0.2);
    expect(f.burn).toBeLessThan(0.8);
    expect(revealFrame(REVEAL_SECONDS, false, f).visible).toBe(false);
    // The card is shown for about half a second, and the effect leaves before it is gone.
    expect(REVEAL_SECONDS).toBeGreaterThanOrEqual(0.4);
    expect(REVEAL_SECONDS).toBeLessThanOrEqual(0.6);
    expect(REVEAL_EFFECT_AT).toBeLessThan(REVEAL_SECONDS);
  });

  it('burns in and out monotonically', () => {
    const f = newRevealFrame();
    let last = 2;
    for (let t = 0; t < REVEAL_IN_SECONDS; t += DT) {
      revealFrame(t, false, f);
      expect(f.burn).toBeLessThanOrEqual(last + 1e-9);
      last = f.burn;
    }
    last = -1;
    for (let t = REVEAL_EFFECT_AT; t < REVEAL_SECONDS; t += DT) {
      revealFrame(t, false, f);
      expect(f.burn).toBeGreaterThanOrEqual(last - 1e-9);
      last = f.burn;
    }
  });

  it('keeps the art clear: the flash glows behind the card, the face tint stays faint', () => {
    const f = newRevealFrame();
    for (let t = 0; t < REVEAL_SECONDS; t += DT / 4) {
      revealFrame(t, false, f);
      expect(f.flare).toBeLessThanOrEqual(REVEAL_FACE_FLARE);
      // No tint at all once the card is whole, through the hold and the burn.
      if (t >= REVEAL_IN_SECONDS) expect(f.flare).toBe(0);
    }
    // A second, shorter flash as the burn starts, below the opening one.
    let burnPeak = 0;
    for (let t = REVEAL_EFFECT_AT; t < REVEAL_SECONDS; t += DT / 4)
      burnPeak = Math.max(burnPeak, revealFrame(t, false, f).halo);
    expect(burnPeak).toBeGreaterThan(0.2);
    expect(burnPeak).toBeLessThan(revealFrame(0, false, f).halo);
  });

  it('keeps full size and a softer flash under reduced motion', () => {
    const f = newRevealFrame();
    const full = revealFrame(0.01, false, newRevealFrame()).halo;
    for (let t = 0; t < REVEAL_SECONDS; t += DT) expect(revealFrame(t, true, f).scale).toBe(1);
    expect(revealFrame(0.01, true, f).halo).toBeLessThan(full);
  });

  it('fits a sigil cast, reveal and the longest bolt inside the plate hold', () => {
    expect(GLYPH_LAUNCH_SECONDS + REVEAL_EFFECT_AT + 0.45).toBeLessThan(PLATE_DONE_SECONDS);
  });
});

describe('effect to FX mapping', () => {
  it('maps every card in content, base and upgraded, by its effects', () => {
    const expected: Record<string, CastFxKind[]> = {
      strike: ['bolt'],
      'cog-toss': ['bolt'],
      'ratchet-flurry': ['bolt'],
      'rivet-volley': ['bolt'],
      'escapement-hammer': ['bolt', 'motes'],
      defend: ['shield'],
      'lucky-rivets': ['shield'],
      'release-valve': ['steam', 'draw'],
      overwind: ['motes'],
      'spanner-jam': ['motes', 'motes'],
      cogstorm: ['bolt'],
      'furnace-brand': ['bolt', 'motes'],
      'warding-glyph': ['shield'],
      'arc-bolt': ['bolt'],
      'time-spiral': ['draw', 'motes'],
    };
    for (const card of CARDS) {
      expect(expected[card.id], card.id).toBeDefined();
      expect(kinds(card.id), card.id).toEqual(expected[card.id]);
      expect(kinds(card.id, true), `${card.id}+`).toEqual(expected[card.id]);
      for (const step of castFxSteps(card)) expect(step.amount).toBeGreaterThan(0);
    }
    expect(Object.keys(expected).sort()).toEqual(CARDS.map((c) => c.id).sort());
  });

  it('rides enemy motes with the bolt, staggers the rest, and sends self statuses to the player', () => {
    const hammer = castFxSteps({
      effects: [
        { type: 'damage', amount: 11, target: 'target' },
        { type: 'apply-status', status: 'vulnerable', stacks: 1, target: 'target' },
      ],
    });
    expect(hammer.map((s) => s.at)).toEqual([0, 0]);
    expect(hammer[1]).toMatchObject({ status: 'vulnerable', toward: 'enemy' });
    const valve = castFxSteps({
      effects: [
        { type: 'gain-steam', amount: 1 },
        { type: 'draw', amount: 1 },
      ],
    });
    expect(valve.map((s) => s.at)).toEqual([0, FX_STAGGER_SECONDS]);
    expect(castLandSeconds(valve)).toBeCloseTo(FX_STAGGER_SECONDS + 0.34);
    const wind = castFxSteps({
      effects: [{ type: 'apply-status', status: 'wound-up', stacks: 2, target: 'self' }],
    });
    expect(wind[0]).toMatchObject({ kind: 'motes', toward: 'player', amount: 2 });
    expect(castLandSeconds(wind)).toBeCloseTo(MOTE_SECONDS);
    expect(castFxSteps({ effects: [{ type: 'lose-steam', amount: 1 }] })).toEqual([]);
    expect(castLandSeconds(castFxSteps({ effects: [{ type: 'block', amount: 5 }] }))).toBe(
      SHIELD_FORM_SECONDS,
    );
    // An attack's readout waits on its bolt only.
    expect(castLandSeconds(hammer)).toBe(0);
  });
});

describe('defense FX timing', () => {
  it('spins the shield in, settles it, then fades it', () => {
    const f = newShieldFrame();
    shieldFrame(0.02, false, f);
    expect(f.radius).toBeLessThan(0.75);
    expect(f.lock).toBeLessThan(0.2);
    expect(f.pulse).toBe(0);
    const early = f.spin;
    shieldFrame(SHIELD_FORM_SECONDS, false, f);
    expect(f.radius).toBeCloseTo(1);
    expect(f.level).toBeCloseTo(1);
    expect(f.lock).toBeCloseTo(1);
    // The rings lock with a bright pulse that dies away.
    expect(f.pulse).toBeCloseTo(1);
    expect(
      shieldFrame(SHIELD_FORM_SECONDS + SHIELD_PULSE_SECONDS / 2, false, f).pulse,
    ).toBeLessThan(0.5);
    expect(shieldFrame(SHIELD_FORM_SECONDS + SHIELD_PULSE_SECONDS, false, f).pulse).toBeCloseTo(0);
    shieldFrame(SHIELD_FORM_SECONDS, false, f);
    expect(f.spin).toBeGreaterThan(early);
    expect(shieldFrame(SHIELD_SECONDS - 0.01, false, f).level).toBeLessThan(0.1);
    expect(shieldFrame(SHIELD_SECONDS, false, f).level).toBe(0);
  });

  it('fades the shield in place under reduced motion, shorter', () => {
    const f = newShieldFrame();
    for (let t = 0; t < SHIELD_SECONDS; t += DT) {
      shieldFrame(t, true, f);
      expect(f.spin).toBe(0);
      expect(f.radius).toBe(1);
      expect(f.lock).toBe(1);
      expect(f.pulse).toBe(0);
    }
    expect(shieldFrame(SHIELD_SECONDS * 0.9, true, f).level).toBe(0);
  });

  it('scales shield brightness with block and puffs with steam', () => {
    expect(shieldGain(11)).toBeGreaterThan(shieldGain(5));
    expect(shieldGain(100)).toBeCloseTo(1);
    expect(steamPuffs(2)).toBeGreaterThan(steamPuffs(1));
    expect(steamPuffs(99)).toBe(STEAM_PUFFS_MAX);
    expect(STEAM_PUFFS_MAX).toBeLessThanOrEqual(STEAM_CAPACITY);
  });
});

describe('CastFx', () => {
  const at = { x: 0, y: 1, z: -0.5 };
  const toward = { x: 0, y: 0, z: 1 };

  it('forms a shield after its delay and goes idle when it has faded', () => {
    const fx = new CastFx();
    fx.shield(at, toward, 8, 0.2);
    expect(fx.active).toBe(true);
    expect(fx.shielding).toBe(true);
    const run = (seconds: number) => {
      for (let t = 0; t < seconds - 1e-9; t += DT) fx.update(DT);
    };
    run(0.1);
    expect(fx.lit).toBe(false);
    expect(fx.shieldDrawn).toBe(0);
    run(0.2);
    expect(fx.lit).toBe(true);
    expect(fx.shieldDrawn).toBeGreaterThan(0);
    // One disc mesh for the shield, the same object every time.
    const disc = fx.getObjectByName('cast-fx-shield');
    expect(disc?.visible).toBe(true);
    for (let t = 0; t < SHIELD_SECONDS + 0.2; t += DT) fx.update(DT);
    expect(fx.shielding).toBe(false);
    expect(fx.active).toBe(false);
    expect(fx.shieldDrawn).toBe(0);
    expect(disc?.visible).toBe(false);
    fx.shield(at, toward, 3);
    fx.update(DT);
    expect(fx.getObjectByName('cast-fx-shield')).toBe(disc);
    fx.dispose();
  });

  it('fades the shield in place under reduced motion, with no swirl', () => {
    const fx = new CastFx({ reducedMotion: true });
    fx.shield(at, toward, 8);
    const disc = fx.getObjectByName('cast-fx-shield') as THREE.Mesh;
    const size = () => disc.scale.x;
    fx.update(DT);
    const first = size();
    for (let t = 0; t < 0.3; t += DT) {
      fx.update(DT);
      expect(size()).toBeCloseTo(first);
    }
    expect(fx.shieldDrawn).toBeGreaterThan(0);
    fx.dispose();
  });

  it('draws steam as alpha-blended puffs that rise ~0.3 m, billow and thin out', () => {
    const fx = new CastFx();
    const puffs = fx.getObjectByName('cast-fx-steam') as THREE.Mesh<
      THREE.BufferGeometry,
      THREE.ShaderMaterial
    >;
    expect(puffs.material.blending).toBe(THREE.NormalBlending);
    expect(puffs.material.depthWrite).toBe(false);
    fx.steam(at, 1);
    const [, , , data, look] = fx.buffers as Float32Array[];
    let top = 0;
    let biggest = 0;
    let firstSize = 0;
    const rots = new Set<number>();
    for (let t = 0; t < STEAM_SECONDS + 0.3; t += DT) {
      fx.update(DT);
      for (let p = 0; p < STEAM_CAPACITY; p++) {
        if ((look?.[p * 2] as number) <= 0) continue;
        const size = data?.[p * 4 + 3] as number;
        if (firstSize === 0) firstSize = size;
        top = Math.max(top, (data?.[p * 4 + 1] as number) - at.y);
        biggest = Math.max(biggest, size);
        rots.add(Math.round((look?.[p * 2 + 1] as number) * 100));
      }
    }
    expect(top).toBeGreaterThan(0.25);
    expect(top).toBeLessThan(STEAM_RISE * 1.3);
    expect(biggest).toBeGreaterThan(2 * firstSize);
    expect(rots.size).toBeGreaterThan(steamPuffs(1));
    expect(fx.puffs).toBe(0);
    expect(puffs.visible).toBe(false);
    fx.dispose();
  });

  it('puffs steam that rises, and streams motes and the draw shimmer to their targets', () => {
    const fx = new CastFx();
    fx.steam(at, 2);
    fx.motes(at, { x: 0.5, y: 1.2, z: -1.5 }, 'weak', 0.1);
    fx.draw(at, { x: 0, y: 0.9, z: 0 });
    expect(fx.puffs).toBe(steamPuffs(2));
    expect(fx.streams).toBe(2);
    const puff = fx.buffers[3] as Float32Array;
    const look = fx.buffers[4] as Float32Array;
    for (let t = 0; t < 0.3; t += DT) fx.update(DT);
    let rose = 0;
    for (let p = 0; p < STEAM_CAPACITY; p++)
      if ((look[p * 2] as number) > 0) rose = Math.max(rose, (puff[p * 4 + 1] as number) - at.y);
    expect(rose).toBeGreaterThan(0.02);
    expect(fx.buffers[1]?.some((v) => v > 0)).toBe(true);
    for (let t = 0; t < 2; t += DT) fx.update(DT);
    expect(fx.active).toBe(false);
    expect(fx.puffs).toBe(0);
    expect(fx.streams).toBe(0);
    fx.dispose();
  });

  it('never grows: many casts reuse the same slots, buffers and one draw', () => {
    const fx = new CastFx();
    const buffers = fx.buffers;
    const children = fx.children.length;
    for (let n = 0; n < 200; n++) {
      fx.shield(at, toward, n % 12);
      fx.steam(at, 3);
      fx.motes(at, toward, 'vulnerable');
      fx.draw(at, toward);
      fx.update(DT);
    }
    expect(fx.puffs).toBeLessThanOrEqual(STEAM_CAPACITY);
    expect(fx.streams).toBeLessThanOrEqual(STREAM_CAPACITY);
    expect(fx.children.length).toBe(children);
    expect(fx.buffers).toEqual(buffers);
    expect(fx.buffers.every((b, i) => b === buffers[i])).toBe(true);
    fx.dispose();
  });

  it('keeps reduced-motion motes at the target and steam low', () => {
    const fx = new CastFx({ reducedMotion: true });
    const to = { x: 1, y: 1, z: -1 };
    fx.motes(at, to, 'overheat');
    fx.steam(at, 1);
    for (let t = 0; t < 0.2; t += DT) fx.update(DT);
    const pos = fx.buffers[0] as Float32Array;
    const col = fx.buffers[1] as Float32Array;
    let motes = 0;
    for (let i = 0; i < CAST_FX_POINTS; i++) {
      if ((col[i * 3] as number) <= 0) continue;
      motes++;
      expect(pos[i * 3]).toBeCloseTo(to.x, 1);
      expect(pos[i * 3 + 1]).toBeCloseTo(to.y, 1);
    }
    expect(motes).toBeGreaterThan(0);
    const puff = fx.buffers[3] as Float32Array;
    const look = fx.buffers[4] as Float32Array;
    let topSteam = 0;
    let puffs = 0;
    for (let p = 0; p < STEAM_CAPACITY; p++) {
      if ((look[p * 2] as number) <= 0) continue;
      puffs++;
      topSteam = Math.max(topSteam, (puff[p * 4 + 1] as number) - at.y);
    }
    expect(puffs).toBeGreaterThan(0);
    expect(topSteam).toBeLessThan(0.1);
    fx.dispose();
  });
});

describe('CastReveal', () => {
  it('shows the card after its delay for the reveal, then hides, in one draw', () => {
    const reveal = new CastReveal({ syncLabels: false });
    const right = { x: 1, y: 0, z: 0 };
    const up = { x: 0, y: 1, z: 0 };
    reveal.show('warding-glyph', { x: 0, y: 1, z: -0.6 }, right, up, 0.1, GLYPH_LAUNCH_SECONDS);
    expect(reveal.cardId).toBe('warding-glyph');
    expect(reveal.visible).toBe(false);
    reveal.update(GLYPH_LAUNCH_SECONDS + 0.01);
    expect(reveal.visible).toBe(true);
    // The card, the flash glowing behind it, and the name and cost labels: allocated once.
    expect(reveal.children).toHaveLength(3);
    for (let t = 0; t < REVEAL_SECONDS; t += DT) reveal.update(DT);
    expect(reveal.visible).toBe(false);
    expect(reveal.active).toBe(false);
    reveal.dispose();
  });
});
