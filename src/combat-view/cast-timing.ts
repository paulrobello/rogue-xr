/**
 * Timing of a played card's cast (pure, no three.js): the card art reveal over the sigil plate once
 * the cast glyph collapses, and the effect FX that follow it, chosen from the card's rules effects.
 * The session holds the play's effects (HP, block, steam, statuses) until the FX land; the rules
 * resolve the play at once as before.
 */

import { resolveAmount } from '../rules/index.ts';
import type { Amount, CardDef, Effect, StatusId } from '../rules/types.ts';

/** The card art grows out of the collapsed glyph over this long. */
export const REVEAL_IN_SECONDS = 0.12;
/** It holds whole this long. */
export const REVEAL_HOLD_SECONDS = 0.24;
/** It burns away over this long. */
export const REVEAL_OUT_SECONDS = 0.16;
export const REVEAL_SECONDS = REVEAL_IN_SECONDS + REVEAL_HOLD_SECONDS + REVEAL_OUT_SECONDS;
/** The effect leaves the card as it starts to burn away, this long after the reveal starts. */
export const REVEAL_EFFECT_AT = REVEAL_IN_SECONDS + REVEAL_HOLD_SECONDS;
/** Size the card grows from, as a fraction of its full size (full size under reduced motion). */
export const REVEAL_START_SCALE = 0.55;

/** Effect FX kinds for attack, defense, steam, status, draw, and healing. */
export type CastFxKind = 'bolt' | 'shield' | 'steam' | 'motes' | 'draw' | 'heal';

/** One FX of a cast, `at` seconds after the effect starts. */
export interface CastFxStep {
  readonly kind: CastFxKind;
  readonly at: number;
  /** Block or steam gained, status stacks, cards drawn (the dice part counts as 1). */
  readonly amount: number;
  /** Motes: the status they carry, and who they fly to. */
  readonly status?: StatusId;
  readonly toward?: 'enemy' | 'player';
}

/** Later FX of one card start this long after the one before (a bolt does not delay the rest). */
export const FX_STAGGER_SECONDS = 0.14;

/** The shield forms over this long (spinning in and settling), holds, then fades. */
export const SHIELD_FORM_SECONDS = 0.36;
export const SHIELD_HOLD_SECONDS = 0.5;
export const SHIELD_FADE_SECONDS = 0.34;
export const SHIELD_SECONDS = SHIELD_FORM_SECONDS + SHIELD_HOLD_SECONDS + SHIELD_FADE_SECONDS;
/** Turns the rune ring makes while it forms, at full motion. */
export const SHIELD_SPIN_TURNS = 0.6;
/** The bright pulse when the rune rings lock, seconds after the shield has formed. */
export const SHIELD_PULSE_SECONDS = 0.22;
/** Reduced motion: the shield fades in place over this fraction of the timeline. */
export const REDUCED_SHIELD_SCALE = 0.7;

/** A steam puff rises, billows and thins out over this long. */
export const STEAM_SECONDS = 1.2;
/** Puffs per steam gained, and the most per cast. */
export const STEAM_PUFFS_PER = 5;
export const STEAM_PUFFS_MAX = 12;
/** Rise of a puff over its life, metres (reduced motion: a third). */
export const STEAM_RISE = 0.34;

/** Motes travel to their target over this long when no bolt carries them. */
export const MOTE_SECONDS = 0.38;
/** The draw shimmer travels to the hand over this long. */
export const DRAW_SECONDS = 0.34;
export const HEAL_SECONDS = 0.32;

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
function amountOf(a: Amount, steamSpent: number): number {
  if (typeof a === 'number') return a;
  if ('perSteam' in a) return resolveAmount(a, null, steamSpent);
  return 'atLeast' in a ? a.high : (a.base ?? 0) + a.dice;
}

/** The FX step for one effect, without its start time; null for an effect with no FX. */
function stepOf(
  effect: Effect,
  gainedBlock: number,
  healed: number,
  steamSpent: number,
): Omit<CastFxStep, 'at'> | null {
  switch (effect.type) {
    case 'damage': {
      const amount = amountOf(effect.amount, steamSpent) * (effect.hits ?? 1);
      return amount > 0 ? { kind: 'bolt', amount } : null;
    }
    case 'damage-from-block':
      return { kind: 'bolt', amount: 1 };
    case 'scry':
    case 'load-die':
    case 'allow-reroll':
      return null;
    case 'block':
      if (typeof effect.amount === 'object' && 'perSteam' in effect.amount)
        return gainedBlock > 0 ? { kind: 'shield', amount: gainedBlock } : null;
      return { kind: 'shield', amount: amountOf(effect.amount, steamSpent) };
    case 'gain-steam':
      return { kind: 'steam', amount: amountOf(effect.amount, steamSpent) };
    case 'lose-steam':
      // No player card spends steam as an effect; a loss shows only on the readout.
      return null;
    case 'apply-status':
      return {
        kind: 'motes',
        amount: amountOf(effect.stacks, steamSpent),
        status: effect.status,
        toward: effect.target === 'self' ? 'player' : 'enemy',
      };
    case 'draw':
      return { kind: 'draw', amount: amountOf(effect.amount, steamSpent) };
    case 'heal':
      return healed > 0 ? { kind: 'heal', amount: healed } : null;
    case 'block-from-status':
      return { kind: 'shield', amount: effect.base + effect.perStack * effect.maxStacks };
    case 'conditional-block':
      return gainedBlock > 0 ? { kind: 'shield', amount: gainedBlock } : null;
    default: {
      const never: never = effect;
      return never;
    }
  }
}

/**
 * The FX of `card`, in effect order. Bolts start at 0; every other FX starts `FX_STAGGER_SECONDS`
 * after the previous non-bolt one, except enemy motes on a card that also strikes, which ride with
 * the bolt (so the damage never waits for them).
 */
export function castFxSteps(
  card: Pick<CardDef, 'effects'>,
  gainedBlock = 0,
  healed = 0,
  steamSpent = 0,
): CastFxStep[] {
  const strikes = card.effects.some((e) => e.type === 'damage' || e.type === 'damage-from-block');
  const steps: CastFxStep[] = [];
  let next = 0;
  for (const effect of card.effects) {
    const step = stepOf(effect, gainedBlock, healed, steamSpent);
    if (!step) continue;
    if (step.kind === 'bolt' || (strikes && step.kind === 'motes' && step.toward === 'enemy')) {
      steps.push({ ...step, at: 0 });
      continue;
    }
    steps.push({ ...step, at: next });
    next += FX_STAGGER_SECONDS;
  }
  return steps;
}

/** When an FX lands (its effect shows on the readouts), seconds after it starts. */
export function fxLandSeconds(kind: Exclude<CastFxKind, 'bolt'>): number {
  switch (kind) {
    case 'shield':
      return SHIELD_FORM_SECONDS;
    case 'steam':
      return 0.3;
    case 'motes':
      return MOTE_SECONDS;
    case 'draw':
      return DRAW_SECONDS;
    case 'heal':
      return HEAL_SECONDS;
  }
}

/**
 * When a cast's effects show, seconds after the effect starts, by its FX other than the bolt: the
 * latest landing among them. Enemy motes riding a bolt land with it, so they do not count. 0 for a
 * card with no such FX.
 */
export function castLandSeconds(steps: readonly CastFxStep[]): number {
  const strikes = steps.some((s) => s.kind === 'bolt');
  let land = 0;
  for (const s of steps) {
    if (s.kind === 'bolt' || (strikes && s.kind === 'motes' && s.toward === 'enemy')) continue;
    land = Math.max(land, s.at + fxLandSeconds(s.kind));
  }
  return land;
}

export interface RevealFrame {
  /** Burn front for the card face shader: 1 is all burnt, 0 is whole. */
  burn: number;
  /** Amber flare tinting the face, 0..1: kept faint so the art always reads. */
  flare: number;
  /** White-gold flash glowing around and behind the card, 0..1. */
  halo: number;
  /** Size multiplier. */
  scale: number;
  /** False before the reveal starts and once it is over. */
  visible: boolean;
}

export const newRevealFrame = (): RevealFrame => ({
  burn: 1,
  flare: 0,
  halo: 0,
  scale: 1,
  visible: false,
});

/** Peak face tint of the reveal: low, so the flash never washes out the card art. */
export const REVEAL_FACE_FLARE = 0.12;

/**
 * The reveal `t` seconds after it starts: the card grows out of the glyph from its centre with a
 * white-gold flash behind it, holds, then burns away from its edges with a short second flash. The
 * face itself only takes a faint tint as it appears, so the art stays visible throughout. Reduced
 * motion keeps the full size and a softer flash.
 */
export function revealFrame(t: number, reducedMotion: boolean, out: RevealFrame): RevealFrame {
  out.visible = t >= 0 && t < REVEAL_SECONDS;
  if (!out.visible) {
    out.burn = 1;
    out.flare = 0;
    out.halo = 0;
    out.scale = 1;
    return out;
  }
  const peak = reducedMotion ? 0.4 : 1;
  if (t < REVEAL_IN_SECONDS) {
    const k = t / REVEAL_IN_SECONDS;
    const e = 1 - (1 - k) ** 3;
    out.burn = 1 - e;
    out.flare = peak * REVEAL_FACE_FLARE * (1 - k);
    out.halo = peak * (1 - 0.7 * k);
    out.scale = reducedMotion ? 1 : REVEAL_START_SCALE + (1 - REVEAL_START_SCALE) * e;
  } else if (t < REVEAL_EFFECT_AT) {
    const k = (t - REVEAL_IN_SECONDS) / REVEAL_HOLD_SECONDS;
    out.burn = 0;
    out.flare = 0;
    out.halo = peak * 0.3 * (1 - k);
    out.scale = 1;
  } else {
    const k = clamp01((t - REVEAL_EFFECT_AT) / REVEAL_OUT_SECONDS);
    out.burn = k * k * (3 - 2 * k);
    out.flare = 0;
    out.halo = peak * 0.55 * Math.sin(Math.PI * Math.min(1, 2 * k)) * (1 - k);
    out.scale = 1;
  }
  return out;
}

export interface ShieldFrame {
  /** Ring radius multiplier. */
  radius: number;
  /** Ring rotation about its axis, radians. */
  spin: number;
  /** Brightness 0..1 before the block gain. */
  level: number;
  /** How far the rune rings have swirled in and closed, 0..1 (1: locked). */
  lock: number;
  /** The flash as the rings lock, 0..1. */
  pulse: number;
}

export const newShieldFrame = (): ShieldFrame => ({
  radius: 1,
  spin: 0,
  level: 0,
  lock: 1,
  pulse: 0,
});

/**
 * The shield `t` seconds after it starts: the rune rings swirl in from small and lock with a bright
 * pulse, the ward holds with a slow drift, then fades. Reduced motion: no swirl, growth or pulse, a
 * shorter fade in and out.
 */
export function shieldFrame(t: number, reducedMotion: boolean, out: ShieldFrame): ShieldFrame {
  const total = reducedMotion ? SHIELD_SECONDS * REDUCED_SHIELD_SCALE : SHIELD_SECONDS;
  out.pulse = 0;
  if (t < 0 || t >= total) {
    out.radius = 1;
    out.spin = 0;
    out.level = 0;
    out.lock = 1;
    return out;
  }
  if (reducedMotion) {
    const form = SHIELD_FORM_SECONDS * REDUCED_SHIELD_SCALE;
    const fade = SHIELD_FADE_SECONDS * REDUCED_SHIELD_SCALE;
    out.radius = 1;
    out.spin = 0;
    out.lock = 1;
    out.level = t < form ? t / form : t > total - fade ? (total - t) / fade : 1;
    return out;
  }
  const k = clamp01(t / SHIELD_FORM_SECONDS);
  const settle = 1 - (1 - k) ** 3;
  out.lock = settle;
  const since = t - SHIELD_FORM_SECONDS;
  if (since >= 0 && since < SHIELD_PULSE_SECONDS)
    out.pulse = (1 - since / SHIELD_PULSE_SECONDS) ** 2;
  out.radius = 0.6 + 0.4 * settle;
  out.spin = 2 * Math.PI * SHIELD_SPIN_TURNS * settle + 0.4 * Math.max(0, t - SHIELD_FORM_SECONDS);
  const fadeAt = SHIELD_FORM_SECONDS + SHIELD_HOLD_SECONDS;
  out.level =
    t < SHIELD_FORM_SECONDS
      ? k + 0.35 * Math.sin(Math.PI * k)
      : t < fadeAt
        ? 1
        : 1 - (t - fadeAt) / SHIELD_FADE_SECONDS;
  return out;
}

/** Shield brightness for `block` gained: a bigger ward burns brighter. */
export function shieldGain(block: number): number {
  return 0.45 + 0.55 * clamp01(block / 12);
}

/** Steam puffs for `steam` gained. */
export function steamPuffs(steam: number): number {
  return Math.min(STEAM_PUFFS_MAX, Math.max(STEAM_PUFFS_PER, Math.round(steam * STEAM_PUFFS_PER)));
}

/** A puff's opacity at life fraction `u`: a soft swell, then a long thinning. */
export function puffLevel(u: number): number {
  if (u <= 0 || u >= 1) return 0;
  return u < 0.15 ? u / 0.15 : (1 - (u - 0.15) / 0.85) ** 1.5;
}

/** A puff's size multiplier at life fraction `u`: it billows out as it rises. */
export function puffSize(u: number): number {
  return 1 + 2 * clamp01(u) ** 0.5;
}
