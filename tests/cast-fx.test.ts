import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { parseCardAtlas } from '../src/cards/card-atlas.ts';
import { cardFaceInstance } from '../src/cards/card-face-material.ts';
import {
  CAST_FX_POINTS,
  CastFx,
  STEAM_CAPACITY,
  STREAM_CAPACITY,
} from '../src/combat-view/cast-fx.ts';
import { ART_ONLY_WINDOW, artWindowTexels, CastReveal } from '../src/combat-view/cast-reveal.ts';
import {
  type CastFxKind,
  castFxSteps,
  castLandSeconds,
  FX_STAGGER_SECONDS,
  HEAL_SECONDS,
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
  return castFxSteps(upgraded ? upgradedCard(card) : card, 0, 3).map((s) => s.kind);
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
      'echo-glyph': [],
      'lens-focus': ['motes'],
      'rivet-plate': ['motes'],
      'shear-pin': ['bolt'],
      'rust-spray': ['motes'],
      'iron-knuckle': ['bolt'],
      'brass-bulwark': ['shield'],
      'anchor-glyph': ['shield', 'motes'],
      counterstroke: ['bolt'],
      'quench-seal': ['shield'],
      'torque-wrench': ['bolt', 'motes'],
      counterweight: ['shield'],
      'tension-coil': ['shield', 'motes'],
      'spare-parts': ['draw'],
      'flywheel-swing': ['bolt'],
      'patch-kit': ['heal'],
      'field-dressing': ['shield', 'heal'],
      'redline-shot': ['bolt'],
      'boiler-gamble': ['steam', 'draw'],
      'grease-gun': [],
      'escapement-break': ['bolt'],
      'lucky-strike': ['bolt'],
      capacitor: ['motes', 'draw'],
      'copper-coil': ['bolt', 'motes'],
      'flash-boiler': [],
      'overdrive-piston': [],
      'loaded-die': ['draw'],
      'reroll-lever': [],
      'gyro-stabilizer': [],
      'pressure-gauge': [],
      'clockwork-turret': [],
      'furnace-heart': [],
      'arc-chain': ['bolt', 'bolt'],
      'gear-grinder': ['bolt'],
      'pendulum-ward': ['shield', 'motes'],
      'crystal-gambit': ['bolt'],
    };
    const upgradeEffects: Partial<Record<string, CastFxKind[]>> = {
      'escapement-break': ['shield', 'bolt'],
      'reroll-lever': ['draw'],
    };
    for (const card of CARDS) {
      expect(expected[card.id], card.id).toBeDefined();
      expect(kinds(card.id), card.id).toEqual(expected[card.id]);
      const upgraded = upgradeEffects[card.id] ?? expected[card.id];
      expect(kinds(card.id, true), `${card.id}+`).toEqual(upgraded);
      for (const step of castFxSteps(card)) expect(step.amount).toBeGreaterThan(0);
    }
    expect(Object.keys(expected).sort()).toEqual(CARDS.map((c) => c.id).sort());
  });

  it('uses the committed Steam for a bolt and the resolved Block after modifiers', () => {
    const boiler = CARDS.find((c) => c.id === 'flash-boiler');
    const piston = CARDS.find((c) => c.id === 'overdrive-piston');
    if (!piston || !boiler) throw Error('Missing Overdrive cards');
    expect(castFxSteps(boiler, 0, 0, 0)).toEqual([]);
    expect(castFxSteps(piston, 0, 0, 0)).toEqual([]);
    // Two Steam with Rust grants 4 Block after halving the base 8.
    expect(castFxSteps(boiler, 4, 0, 2)).toEqual([{ kind: 'shield', amount: 4, at: 0 }]);
    expect(castFxSteps(upgradedCard(piston), 0, 0, 2)).toEqual([
      { kind: 'bolt', amount: 18, at: 0 },
    ]);
  });

  it('shows only the health actually restored and waits for the repair to land', () => {
    const patch = CARDS.find((card) => card.id === 'patch-kit');
    if (!patch) throw Error('Missing Patch Kit');
    expect(castFxSteps(patch)).toEqual([]);
    const shown = castFxSteps(patch, 0, 2);
    expect(shown).toEqual([{ kind: 'heal', amount: 2, at: 0 }]);
    expect(castLandSeconds(shown)).toBe(HEAL_SECONDS);
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
    const reveal = new CastReveal();
    const right = { x: 1, y: 0, z: 0 };
    const up = { x: 0, y: 1, z: 0 };
    reveal.show('warding-glyph', { x: 0, y: 1, z: -0.6 }, right, up, 0.1, GLYPH_LAUNCH_SECONDS);
    expect(reveal.cardId).toBe('warding-glyph');
    expect(reveal.visible).toBe(false);
    reveal.update(GLYPH_LAUNCH_SECONDS + 0.01);
    expect(reveal.visible).toBe(true);
    // The art disc and the flash glowing behind it: allocated once, no labels.
    expect(reveal.children).toHaveLength(2);
    for (let t = 0; t < REVEAL_SECONDS; t += DT) reveal.update(DT);
    expect(reveal.visible).toBe(false);
    expect(reveal.active).toBe(false);
    reveal.dispose();
  });

  // Playtest 2026-11-17: "when the glyph is complete i just want it to show the top graphic from
  // the card, not the entire card".
  it('shows only the round art window: a square disc quad, no frame, no name or cost text', () => {
    const atlas = parseCardAtlas(
      JSON.parse(readFileSync(resolve('public/assets/cards/atlas/card-atlas.json'), 'utf8')),
    );
    const pages = atlas.pages.map(() => new THREE.Texture());
    const reveal = new CastReveal({ art: { atlas, pages } });
    const right = { x: 1, y: 0, z: 0 };
    const up = { x: 0, y: 1, z: 0 };
    reveal.show('warding-glyph', { x: 0, y: 1, z: -0.6 }, right, up, 0.12);
    reveal.update(REVEAL_IN_SECONDS + 0.01);
    expect(reveal.visible).toBe(true);
    const mesh = reveal.getObjectByName('cast-reveal-card') as THREE.InstancedMesh;
    const material = mesh.material as THREE.ShaderMaterial;
    // A square quad the disc's diameter across, not a card-shaped one.
    expect(mesh.scale.x).toBeCloseTo(0.12);
    expect(mesh.scale.y).toBeCloseTo(mesh.scale.x);
    // Frameless reveals retain the atlas page binding so it can also serve illustration layers.
    const win = material.uniforms.uWindow?.value as THREE.Vector4;
    expect(win.toArray()).toEqual([...ART_ONLY_WINDOW]);
    expect(material.uniforms.uFrame?.value).toBe(pages[atlas.frames.sigil.page]);
    const texels = artWindowTexels({ atlas, pages }, 'warding-glyph');
    expect(texels).toBeGreaterThan(400);
    expect(material.uniforms.uArtOnlyTexels?.value).toBe(texels);
    const geometry = mesh.geometry;
    // The art layers are the hand card's own atlas rects.
    const face = cardFaceInstance(atlas, 'warding-glyph');
    const back = geometry.getAttribute('aBackUv');
    expect([back.getX(0), back.getY(0), back.getZ(0), back.getW(0)]).toEqual(
      face.backUv.map((v) => Math.fround(v)),
    );
    // No text anywhere.
    let texts = 0;
    reveal.traverse((o) => {
      if ((o as { isTroikaText?: boolean }).isTroikaText || o.name.includes('label')) texts++;
    });
    expect(texts).toBe(0);
    reveal.dispose();
  });
});
