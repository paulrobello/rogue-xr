import type { CardCost, CardDef, Effect } from '../rules/index.ts';
import type { SigilId } from '../sigil/types.ts';
import type { DieId } from './dice.ts';

export { SIGIL_IDS, type SigilId } from '../sigil/types.ts';
export { DIE_IDS, type DieId } from './dice.ts';

export type CardType = 'attack' | 'skill' | 'sigil' | 'mechanism';

/** Fields an upgrade replaces. Everything it leaves out is kept from the base card. */
export interface CardUpgrade {
  readonly name?: string;
  readonly cost?: CardCost;
  readonly effects?: readonly Effect[];
  readonly exhaust?: boolean;
  readonly dice?: DieId;
  readonly diceCount?: number;
  readonly sigil?: SigilId;
  readonly mechanism?: CardDef['mechanism'];
  readonly description: string;
}

/**
 * A slice card. `dice` names the die rolled for a dice amount or a risk threshold, and the result
 * is passed as `play-card.dice`. `sigil` is set exactly on sigil
 * spells; the sigil hook scales the base effects by the trace's power multiplier.
 */
export interface SliceCard extends CardDef {
  readonly name: string;
  readonly type: CardType;
  readonly description: string;
  readonly dice?: DieId;
  readonly diceCount?: number;
  readonly sigil?: SigilId;
  /** The upgraded variant. Absent on an already upgraded card. */
  readonly upgrade?: CardUpgrade;
  readonly upgraded?: boolean;
}

/** Suffix that marks an upgraded card id, e.g. `strike+`. */
export const UPGRADE_SUFFIX = '+';

export const CARDS: readonly SliceCard[] = [
  // Attacks
  {
    id: 'strike',
    name: 'Piston Strike',
    type: 'attack',
    cost: 1,
    target: 'enemy',
    effects: [{ type: 'damage', amount: 6, target: 'target' }],
    description: 'Deal 6 damage.',
    upgrade: {
      effects: [{ type: 'damage', amount: 9, target: 'target' }],
      description: 'Deal 9 damage.',
    },
  },
  {
    id: 'cog-toss',
    name: 'Cog Toss',
    type: 'attack',
    cost: 1,
    target: 'enemy',
    dice: 'brass-d6',
    effects: [{ type: 'damage', amount: { base: 2, dice: 1 }, target: 'target' }],
    description: 'Roll a d6. Deal 2 + roll damage.',
    upgrade: {
      effects: [{ type: 'damage', amount: { base: 4, dice: 1 }, target: 'target' }],
      description: 'Roll a d6. Deal 4 + roll damage.',
    },
  },
  {
    id: 'ratchet-flurry',
    name: 'Ratchet Flurry',
    type: 'attack',
    cost: 1,
    target: 'enemy',
    effects: [{ type: 'damage', amount: 2, hits: 3, target: 'target' }],
    description: 'Deal 2 damage 3 times.',
    upgrade: {
      effects: [{ type: 'damage', amount: 3, hits: 3, target: 'target' }],
      description: 'Deal 3 damage 3 times.',
    },
  },
  {
    id: 'rivet-volley',
    name: 'Rivet Volley',
    type: 'attack',
    cost: 1,
    target: 'none',
    effects: [{ type: 'damage', amount: 4, target: 'all-opponents' }],
    description: 'Deal 4 damage to all enemies.',
    upgrade: {
      effects: [{ type: 'damage', amount: 6, target: 'all-opponents' }],
      description: 'Deal 6 damage to all enemies.',
    },
  },
  {
    id: 'escapement-hammer',
    name: 'Escapement Hammer',
    type: 'attack',
    cost: 3,
    target: 'enemy',
    effects: [
      { type: 'damage', amount: 11, target: 'target' },
      { type: 'apply-status', status: 'vulnerable', stacks: 1, target: 'target' },
    ],
    description: 'Deal 11 damage. Apply 1 Vulnerable.',
    upgrade: {
      effects: [
        { type: 'damage', amount: 14, target: 'target' },
        { type: 'apply-status', status: 'vulnerable', stacks: 2, target: 'target' },
      ],
      description: 'Deal 14 damage. Apply 2 Vulnerable.',
    },
  },
  // Skills
  {
    id: 'defend',
    name: 'Brass Guard',
    type: 'skill',
    cost: 1,
    target: 'none',
    effects: [{ type: 'block', amount: 5 }],
    description: 'Gain 5 Block.',
    upgrade: {
      effects: [{ type: 'block', amount: 8 }],
      description: 'Gain 8 Block.',
    },
  },
  {
    id: 'lucky-rivets',
    name: 'Lucky Rivets',
    type: 'skill',
    cost: 1,
    target: 'none',
    dice: 'brass-d6',
    effects: [{ type: 'block', amount: { base: 2, dice: 1 } }],
    description: 'Roll a d6. Gain 2 + roll Block.',
    upgrade: {
      effects: [{ type: 'block', amount: { base: 4, dice: 1 } }],
      description: 'Roll a d6. Gain 4 + roll Block.',
    },
  },
  {
    id: 'release-valve',
    name: 'Release Valve',
    type: 'skill',
    cost: 0,
    target: 'none',
    exhaust: true,
    effects: [
      { type: 'gain-steam', amount: 1 },
      { type: 'draw', amount: 1 },
    ],
    description: 'Gain 1 Steam. Draw 1 card. Exhaust.',
    upgrade: {
      effects: [
        { type: 'gain-steam', amount: 2 },
        { type: 'draw', amount: 1 },
      ],
      description: 'Gain 2 Steam. Draw 1 card. Exhaust.',
    },
  },
  {
    id: 'overwind',
    name: 'Overwind',
    type: 'skill',
    cost: 1,
    target: 'none',
    exhaust: true,
    effects: [{ type: 'apply-status', status: 'wound-up', stacks: 2, target: 'self' }],
    description: 'Gain 2 Wound-up. Exhaust.',
    upgrade: {
      effects: [{ type: 'apply-status', status: 'wound-up', stacks: 3, target: 'self' }],
      description: 'Gain 3 Wound-up. Exhaust.',
    },
  },
  {
    id: 'spanner-jam',
    name: 'Spanner Jam',
    type: 'skill',
    cost: 1,
    target: 'enemy',
    effects: [
      { type: 'apply-status', status: 'weak', stacks: 1, target: 'target' },
      { type: 'apply-status', status: 'vulnerable', stacks: 1, target: 'target' },
    ],
    description: 'Apply 1 Weak. Apply 1 Vulnerable.',
    upgrade: {
      effects: [
        { type: 'apply-status', status: 'weak', stacks: 2, target: 'target' },
        { type: 'apply-status', status: 'vulnerable', stacks: 2, target: 'target' },
      ],
      description: 'Apply 2 Weak. Apply 2 Vulnerable.',
    },
  },
  // Sigil spells
  {
    id: 'cogstorm',
    name: 'Cogstorm',
    type: 'sigil',
    sigil: 'gear',
    cost: 3,
    target: 'none',
    effects: [{ type: 'damage', amount: 4, hits: 2, target: 'all-opponents' }],
    description: 'Deal 4 damage to all enemies 2 times.',
    upgrade: {
      effects: [{ type: 'damage', amount: 6, hits: 2, target: 'all-opponents' }],
      sigil: 'gear-plus',
      description: 'Deal 6 damage to all enemies 2 times.',
    },
  },
  {
    id: 'furnace-brand',
    name: 'Furnace Brand',
    type: 'sigil',
    sigil: 'flame',
    cost: 1,
    target: 'enemy',
    dice: 'brass-d6',
    effects: [
      { type: 'damage', amount: 4, target: 'target' },
      { type: 'apply-status', status: 'overheat', stacks: { dice: 1 }, target: 'target' },
    ],
    description: 'Roll a d6. Deal 4 damage. Apply roll Overheat.',
    upgrade: {
      effects: [
        { type: 'damage', amount: 6, target: 'target' },
        {
          type: 'apply-status',
          status: 'overheat',
          stacks: { base: 1, dice: 1 },
          target: 'target',
        },
      ],
      sigil: 'flame-plus',
      description: 'Roll a d6. Deal 6 damage. Apply 1 + roll Overheat.',
    },
  },
  {
    id: 'warding-glyph',
    name: 'Warding Glyph',
    type: 'sigil',
    sigil: 'ward',
    cost: 1,
    target: 'none',
    effects: [{ type: 'block', amount: 8 }],
    description: 'Gain 8 Block.',
    upgrade: {
      effects: [{ type: 'block', amount: 11 }],
      sigil: 'ward-plus',
      description: 'Gain 11 Block.',
    },
  },
  {
    id: 'arc-bolt',
    name: 'Arc Bolt',
    type: 'sigil',
    sigil: 'bolt',
    cost: 1,
    target: 'enemy',
    dice: 'glass-d8',
    effects: [{ type: 'damage', amount: { base: 3, dice: 1 }, target: 'target' }],
    description: 'Roll a d8. Deal 3 + roll damage.',
    upgrade: {
      effects: [{ type: 'damage', amount: { base: 5, dice: 1 }, target: 'target' }],
      sigil: 'bolt-plus',
      description: 'Roll a d8. Deal 5 + roll damage.',
    },
  },
  {
    id: 'time-spiral',
    name: 'Time Spiral',
    type: 'sigil',
    sigil: 'spiral',
    cost: 1,
    target: 'none',
    effects: [
      { type: 'draw', amount: 2 },
      { type: 'apply-status', status: 'weak', stacks: 1, target: 'all-opponents' },
    ],
    description: 'Draw 2 cards. Apply 1 Weak to all enemies.',
    upgrade: {
      effects: [
        { type: 'draw', amount: 3 },
        { type: 'apply-status', status: 'weak', stacks: 2, target: 'all-opponents' },
      ],
      sigil: 'spiral-plus',
      description: 'Draw 3 cards. Apply 2 Weak to all enemies.',
    },
  },
  {
    id: 'echo-glyph',
    name: 'Echo Glyph',
    type: 'sigil',
    sigil: 'spiral',
    echoSigil: true,
    cost: 2,
    target: 'none',
    effects: [],
    description: 'Replay the last successful sigil at its strength.',
    upgrade: {
      cost: 1,
      description: 'Replay the last successful sigil at its strength.',
    },
  },
  {
    id: 'lens-focus',
    name: 'Lens Focus',
    type: 'sigil',
    sigil: 'eye',
    cost: 1,
    target: 'enemy',
    effects: [
      { type: 'apply-status', status: 'vulnerable', stacks: 3, target: 'target' },
      { type: 'scry', count: 2 },
    ],
    description: 'Apply 3 Vulnerable. Scry 2.',
    upgrade: {
      effects: [
        { type: 'apply-status', status: 'vulnerable', stacks: 4, target: 'target' },
        { type: 'scry', count: 2 },
      ],
      sigil: 'eye',
      description: 'Apply 4 Vulnerable. Scry 2.',
    },
  },
  {
    id: 'rivet-plate',
    name: 'Rivet Plate',
    type: 'skill',
    cost: 1,
    target: 'none',
    effects: [{ type: 'apply-status', status: 'plating', stacks: 3, target: 'self' }],
    description: 'Gain 3 Plating.',
    upgrade: {
      effects: [{ type: 'apply-status', status: 'plating', stacks: 4, target: 'self' }],
      description: 'Gain 4 Plating.',
    },
  },
  {
    id: 'shear-pin',
    name: 'Shear Pin',
    type: 'attack',
    cost: 1,
    target: 'enemy',
    pinned: true,
    effects: [{ type: 'damage', amount: 7, target: 'target' }],
    description: 'Deal 7 damage. Pinned.',
    upgrade: {
      effects: [{ type: 'damage', amount: 9, target: 'target' }],
      description: 'Deal 9 damage. Pinned.',
    },
  },
  {
    id: 'rust-spray',
    name: 'Rust Spray',
    type: 'skill',
    cost: 1,
    target: 'none',
    effects: [{ type: 'apply-status', status: 'rust', stacks: 2, target: 'all-opponents' }],
    description: 'Apply 2 Rust to all enemies.',
    upgrade: {
      effects: [{ type: 'apply-status', status: 'rust', stacks: 3, target: 'all-opponents' }],
      description: 'Apply 3 Rust to all enemies.',
    },
  },
  {
    id: 'iron-knuckle',
    name: 'Iron Knuckle',
    type: 'attack',
    cost: 2,
    target: 'enemy',
    dice: 'iron-d4',
    effects: [{ type: 'damage', amount: { base: 3, dice: 1 }, hits: 2, target: 'target' }],
    description: 'Roll an iron d4. Deal 3 + roll damage 2 times.',
    upgrade: {
      effects: [{ type: 'damage', amount: { base: 5, dice: 1 }, hits: 2, target: 'target' }],
      description: 'Roll an iron d4. Deal 5 + roll damage 2 times.',
    },
  },
  {
    id: 'brass-bulwark',
    name: 'Brass Bulwark',
    type: 'skill',
    cost: 3,
    target: 'none',
    effects: [{ type: 'block', amount: 14 }],
    description: 'Gain 14 Block.',
    upgrade: { effects: [{ type: 'block', amount: 18 }], description: 'Gain 18 Block.' },
  },
  {
    id: 'anchor-glyph',
    name: 'Anchor Glyph',
    type: 'sigil',
    sigil: 'anchor' as SigilId,
    cost: 1,
    target: 'none',
    effects: [
      { type: 'block', amount: 8 },
      { type: 'apply-status', status: 'plating', stacks: 2, target: 'self' },
    ],
    description: 'Gain 8 Block. Gain 2 Plating.',
    upgrade: {
      effects: [
        { type: 'block', amount: 11 },
        { type: 'apply-status', status: 'plating', stacks: 3, target: 'self' },
      ],
      sigil: 'anchor-plus',
      description: 'Gain 11 Block. Gain 3 Plating.',
    },
  },
  {
    id: 'counterstroke',
    name: 'Counterstroke',
    type: 'attack',
    cost: 2,
    target: 'enemy',
    effects: [
      { type: 'damage', amount: 10, target: 'target' },
      { type: 'conditional-block', amount: 6, target: 'self', minTargetHits: 2 },
    ],
    description: 'Deal 10 damage. If its intent hits twice or more, gain 6 Block.',
    upgrade: {
      effects: [
        { type: 'damage', amount: 13, target: 'target' },
        { type: 'conditional-block', amount: 8, target: 'self', minTargetHits: 2 },
      ],
      description: 'Deal 13 damage. If its intent hits twice or more, gain 8 Block.',
    },
  },
  {
    id: 'quench-seal',
    name: 'Quench Seal',
    type: 'sigil',
    sigil: 'quench',
    cost: 1,
    target: 'enemy',
    effects: [
      {
        type: 'block-from-status',
        status: 'overheat',
        maxStacks: 3,
        base: 4,
        perStack: 2,
        target: 'self',
        removeFrom: 'target',
      },
    ],
    description: 'Trace Quench. Remove up to 3 enemy Overheat. Gain 4 Block + 2 per stack spent.',
    upgrade: {
      effects: [
        {
          type: 'block-from-status',
          status: 'overheat',
          maxStacks: 4,
          base: 5,
          perStack: 2,
          target: 'self',
          removeFrom: 'target',
        },
      ],
      sigil: 'quench-plus',
      description: 'Trace Quench. Remove up to 4 enemy Overheat. Gain 5 Block + 2 per stack spent.',
    },
  },
  {
    id: 'torque-wrench',
    name: 'Torque Wrench',
    type: 'attack',
    cost: 1,
    target: 'enemy',
    effects: [
      { type: 'damage', amount: 6, target: 'target' },
      { type: 'apply-status', status: 'rust', stacks: 1, target: 'target' },
    ],
    description: 'Deal 6 damage. Apply 1 Rust.',
    upgrade: {
      effects: [
        { type: 'damage', amount: 9, target: 'target' },
        { type: 'apply-status', status: 'rust', stacks: 2, target: 'target' },
      ],
      description: 'Deal 9 damage. Apply 2 Rust.',
    },
  },
  {
    id: 'counterweight',
    name: 'Counterweight',
    type: 'skill',
    cost: 2,
    target: 'none',
    pinned: true,
    effects: [{ type: 'block', amount: 12 }],
    description: 'Gain 12 Block. Pinned.',
    upgrade: {
      effects: [{ type: 'block', amount: 16 }],
      description: 'Gain 16 Block. Pinned.',
    },
  },
  {
    id: 'tension-coil',
    name: 'Tension Coil',
    type: 'skill',
    cost: 1,
    target: 'none',
    effects: [
      { type: 'block', amount: 4 },
      { type: 'apply-status', status: 'wound-up', stacks: 1, target: 'self' },
    ],
    description: 'Gain 4 Block. Gain 1 Wound-up.',
    upgrade: {
      effects: [
        { type: 'block', amount: 6 },
        { type: 'apply-status', status: 'wound-up', stacks: 1, target: 'self' },
      ],
      description: 'Gain 6 Block. Gain 1 Wound-up.',
    },
  },
  {
    id: 'spare-parts',
    name: 'Spare Parts',
    type: 'skill',
    cost: 1,
    target: 'none',
    effects: [{ type: 'draw', amount: 2 }],
    description: 'Draw 2 cards.',
    upgrade: {
      effects: [{ type: 'draw', amount: 3 }],
      description: 'Draw 3 cards.',
    },
  },
  {
    id: 'flywheel-swing',
    name: 'Flywheel Swing',
    type: 'attack',
    cost: 2,
    target: 'enemy',
    effects: [
      { type: 'damage', amount: 12, target: 'target', bonusIfSelfBlock: { min: 1, amount: 4 } },
    ],
    description: 'Deal 12 damage. If you have Block, deal 4 more damage.',
    upgrade: {
      effects: [
        { type: 'damage', amount: 15, target: 'target', bonusIfSelfBlock: { min: 1, amount: 5 } },
      ],
      description: 'Deal 15 damage. If you have Block, deal 5 more damage.',
    },
  },
  {
    id: 'patch-kit',
    name: 'Patch Kit',
    type: 'skill',
    cost: 1,
    target: 'none',
    exhaust: true,
    effects: [{ type: 'heal', amount: 6, target: 'self' }],
    description: 'Heal 6 HP. Exhaust.',
    upgrade: {
      effects: [{ type: 'heal', amount: 9, target: 'self' }],
      description: 'Heal 9 HP. Exhaust.',
    },
  },
  {
    id: 'grease-gun',
    name: 'Grease Gun',
    type: 'skill',
    cost: 0,
    target: 'none',
    effects: [{ type: 'scry', count: 3 }],
    description: 'Scry 3.',
    upgrade: {
      effects: [{ type: 'scry', count: 4, drawAfter: 1 }],
      description: 'Scry 4. Draw 1 card.',
    },
  },
  {
    id: 'escapement-break',
    name: 'Escapement Break',
    type: 'attack',
    cost: 1,
    target: 'enemy',
    effects: [{ type: 'damage-from-block', target: 'target' }],
    description: 'Deal damage equal to your Block.',
    upgrade: {
      effects: [
        { type: 'block', amount: 3 },
        { type: 'damage-from-block', target: 'target' },
      ],
      description: 'Gain 3 Block. Deal damage equal to your Block.',
    },
  },
  {
    id: 'lucky-strike',
    name: 'Lucky Strike',
    type: 'attack',
    cost: 1,
    target: 'enemy',
    dice: 'brass-d6',
    effects: [{ type: 'damage', amount: { atLeast: 5, low: 6, high: 18 }, target: 'target' }],
    description: 'Roll a d6. Deal 18 damage on a 5 or 6, otherwise 6.',
    upgrade: {
      effects: [{ type: 'damage', amount: { atLeast: 5, low: 8, high: 20 }, target: 'target' }],
      description: 'Roll a d6. Deal 20 damage on a 5 or 6, otherwise 8.',
    },
  },
  {
    id: 'capacitor',
    name: 'Capacitor',
    type: 'skill',
    cost: 1,
    target: 'none',
    effects: [
      { type: 'apply-status', status: 'charge', stacks: 2, target: 'self' },
      { type: 'draw', amount: 1 },
    ],
    description: 'Gain 2 Charge. Draw 1 card.',
    upgrade: {
      effects: [
        { type: 'apply-status', status: 'charge', stacks: 3, target: 'self' },
        { type: 'draw', amount: 1 },
      ],
      description: 'Gain 3 Charge. Draw 1 card.',
    },
  },
  {
    id: 'copper-coil',
    name: 'Copper Coil',
    type: 'attack',
    cost: 1,
    target: 'enemy',
    effects: [
      { type: 'damage', amount: 5, target: 'target' },
      { type: 'apply-status', status: 'charge', stacks: 1, target: 'self' },
    ],
    description: 'Deal 5 damage. Gain 1 Charge.',
    upgrade: {
      effects: [
        { type: 'damage', amount: 7, target: 'target' },
        { type: 'apply-status', status: 'charge', stacks: 1, target: 'self' },
      ],
      description: 'Deal 7 damage. Gain 1 Charge.',
    },
  },
  {
    id: 'flash-boiler',
    name: 'Flash Boiler',
    type: 'skill',
    cost: 'X',
    target: 'none',
    effects: [{ type: 'block', amount: { perSteam: 4 } }],
    description: 'Gain 4 Block per Steam spent.',
    upgrade: {
      effects: [{ type: 'block', amount: { perSteam: 5 } }],
      description: 'Gain 5 Block per Steam spent.',
    },
  },
  {
    id: 'overdrive-piston',
    name: 'Overdrive Piston',
    type: 'attack',
    cost: 'X',
    target: 'enemy',
    effects: [{ type: 'damage', amount: { perSteam: 7 }, target: 'target' }],
    description: 'Deal 7 damage per Steam spent.',
    upgrade: {
      effects: [{ type: 'damage', amount: { perSteam: 9 }, target: 'target' }],
      description: 'Deal 9 damage per Steam spent.',
    },
  },
  {
    id: 'reroll-lever',
    name: 'Reroll Lever',
    type: 'skill',
    cost: 0,
    target: 'none',
    pinned: true,
    effects: [{ type: 'allow-reroll' }],
    description: 'You may reroll your next throw once. Pinned.',
    upgrade: {
      effects: [{ type: 'allow-reroll' }, { type: 'draw', amount: 1 }],
      description: 'You may reroll your next throw once. Draw 1 card. Pinned.',
    },
  },
  {
    id: 'loaded-die',
    name: 'Loaded Die',
    type: 'skill',
    cost: 0,
    target: 'none',
    exhaust: true,
    effects: [{ type: 'load-die' }, { type: 'draw', amount: 1 }],
    description: 'Your next die this turn is Loaded. Draw 1 card. Exhaust.',
    upgrade: {
      exhaust: false,
      effects: [{ type: 'load-die' }, { type: 'draw', amount: 1 }],
      description: 'Your next die this turn is Loaded. Draw 1 card.',
    },
  },
  {
    id: 'crystal-gambit',
    name: 'Crystal Gambit',
    type: 'attack',
    cost: 3,
    target: 'enemy',
    dice: 'crystal-d12',
    diceCount: 2,
    effects: [{ type: 'damage', amount: { dice: 1 }, target: 'target' }],
    description: 'Roll two d12s. Deal their sum as damage.',
    upgrade: {
      effects: [{ type: 'damage', amount: { base: 4, dice: 1 }, target: 'target' }],
      description: 'Roll two d12s. Deal their sum + 4 damage.',
    },
  },
  {
    id: 'gyro-stabilizer',
    name: 'Gyro Stabilizer',
    type: 'mechanism',
    cost: 2,
    target: 'none',
    effects: [],
    mechanism: {
      timing: 'start-turn',
      effects: [{ type: 'block', amount: 3 }],
    },
    description: 'At turn start, gain 3 Block.',
    upgrade: {
      mechanism: { timing: 'start-turn', effects: [{ type: 'block', amount: 5 }] },
      description: 'At turn start, gain 5 Block.',
    },
  },
  {
    id: 'pressure-gauge',
    name: 'Pressure Gauge',
    type: 'mechanism',
    cost: 1,
    target: 'none',
    effects: [],
    mechanism: {
      timing: 'start-turn',
      effects: [{ type: 'apply-status', status: 'charge', stacks: 1, target: 'self' }],
    },
    description: 'At turn start, gain 1 Charge.',
    upgrade: {
      cost: 0,
      description: 'At turn start, gain 1 Charge.',
    },
  },
  {
    id: 'clockwork-turret',
    name: 'Clockwork Turret',
    type: 'mechanism',
    cost: 2,
    target: 'none',
    effects: [],
    mechanism: {
      timing: 'end-turn',
      target: 'least-hp',
      effects: [{ type: 'damage', amount: 3, target: 'target' }],
    },
    description: 'At turn end, deal 3 damage to the enemy with the least HP.',
    upgrade: {
      mechanism: {
        timing: 'end-turn',
        target: 'least-hp',
        effects: [{ type: 'damage', amount: 5, target: 'target' }],
      },
      description: 'At turn end, deal 5 damage to the enemy with the least HP.',
    },
  },
  {
    id: 'furnace-heart',
    name: 'Furnace Heart',
    type: 'mechanism',
    cost: 3,
    target: 'none',
    effects: [],
    mechanism: {
      timing: 'start-turn',
      effects: [{ type: 'apply-status', status: 'overheat', stacks: 2, target: 'all-opponents' }],
    },
    description: 'At turn start, apply 2 Overheat to all enemies.',
    upgrade: {
      mechanism: {
        timing: 'start-turn',
        effects: [{ type: 'apply-status', status: 'overheat', stacks: 3, target: 'all-opponents' }],
      },
      description: 'At turn start, apply 3 Overheat to all enemies.',
    },
  },
  {
    id: 'arc-chain',
    name: 'Arc Chain',
    type: 'sigil',
    sigil: 'bolt',
    cost: 1,
    target: 'enemy',
    effects: [
      { type: 'damage', amount: 5, target: 'target' },
      { type: 'damage', amount: 3, target: 'other-opponents' },
    ],
    description: 'Deal 5 damage. Deal 3 damage to each other enemy.',
    upgrade: {
      effects: [
        { type: 'damage', amount: 7, target: 'target' },
        { type: 'damage', amount: 4, target: 'other-opponents' },
      ],
      sigil: 'bolt-plus',
      description: 'Deal 7 damage. Deal 4 damage to each other enemy.',
    },
  },
  {
    id: 'gear-grinder',
    name: 'Gear Grinder',
    type: 'attack',
    cost: 1,
    target: 'enemy',
    effects: [{ type: 'damage', amount: 4, hits: 2, extraHitsIfTargetRust: 1, target: 'target' }],
    description: 'Deal 4 damage 2 times. Hit once more if the target has Rust.',
    upgrade: {
      effects: [{ type: 'damage', amount: 5, hits: 2, extraHitsIfTargetRust: 1, target: 'target' }],
      description: 'Deal 5 damage 2 times. Hit once more if the target has Rust.',
    },
  },
  {
    id: 'pendulum-ward',
    name: 'Pendulum Ward',
    type: 'sigil',
    sigil: 'pendulum-ward',
    cost: 2,
    target: 'none',
    effects: [
      { type: 'block', amount: 10 },
      { type: 'apply-status', status: 'plating', stacks: 2, target: 'self' },
    ],
    description: 'Gain 10 Block. Gain 2 Plating.',
    upgrade: {
      effects: [
        { type: 'block', amount: 14 },
        { type: 'apply-status', status: 'plating', stacks: 3, target: 'self' },
      ],
      sigil: 'pendulum-ward-plus',
      description: 'Gain 14 Block. Gain 3 Plating.',
    },
  },
  {
    id: 'field-dressing',
    name: 'Field Dressing',
    type: 'skill',
    cost: 2,
    target: 'none',
    exhaust: true,
    effects: [
      { type: 'block', amount: 9 },
      { type: 'heal', amount: 5, target: 'self' },
    ],
    description: 'Gain 9 Block. Heal 5 HP. Exhaust.',
    upgrade: {
      effects: [
        { type: 'block', amount: 12 },
        { type: 'heal', amount: 7, target: 'self' },
      ],
      description: 'Gain 12 Block. Heal 7 HP. Exhaust.',
    },
  },
  {
    id: 'redline-shot',
    name: 'Redline Shot',
    type: 'attack',
    cost: 1,
    target: 'enemy',
    dice: 'brass-d6',
    effects: [{ type: 'damage', amount: 18, target: 'target' }],
    rollRisk: {
      minimum: 4,
      miss: { type: 'apply-status', status: 'overheat', stacks: 3, target: 'self' },
    },
    description: 'Roll a d6. On 4+, deal 18 damage. Otherwise gain 3 Overheat.',
    upgrade: {
      effects: [{ type: 'damage', amount: 23, target: 'target' }],
      description: 'Roll a d6. On 4+, deal 23 damage. Otherwise gain 3 Overheat.',
    },
  },
  {
    id: 'boiler-gamble',
    name: 'Boiler Gamble',
    type: 'skill',
    cost: 1,
    target: 'none',
    dice: 'glass-d8',
    effects: [
      { type: 'gain-steam', amount: 3 },
      { type: 'draw', amount: 1 },
    ],
    rollRisk: {
      minimum: 5,
      miss: { type: 'apply-status', status: 'vulnerable', stacks: 2, target: 'self' },
    },
    description: 'Roll a d8. On 5+, gain 3 Steam and Draw 1 card. Otherwise gain 2 Vulnerable.',
    upgrade: {
      effects: [
        { type: 'gain-steam', amount: 3 },
        { type: 'draw', amount: 2 },
      ],
      description: 'Roll a d8. On 5+, gain 3 Steam and Draw 2 cards. Otherwise gain 2 Vulnerable.',
    },
  },
  {
    id: 'steam-sweep',
    name: 'Steam Sweep',
    type: 'attack',
    cost: 2,
    target: 'none',
    dice: 'glass-d8',
    effects: [{ type: 'damage', amount: 14, target: 'all-opponents' }],
    rollRisk: {
      minimum: 5,
      miss: { type: 'apply-status', status: 'rust', stacks: 2, target: 'self' },
    },
    description: 'Roll a d8. On 5+, deal 14 damage to all enemies. Otherwise gain 2 Rust.',
    upgrade: {
      effects: [{ type: 'damage', amount: 18, target: 'all-opponents' }],
      description: 'Roll a d8. On 5+, deal 18 damage to all enemies. Otherwise gain 2 Rust.',
    },
  },
  {
    id: 'plated-stand',
    name: 'Plated Stand',
    type: 'skill',
    cost: 1,
    target: 'none',
    dice: 'brass-d6',
    effects: [
      { type: 'block', amount: 8 },
      { type: 'apply-status', status: 'plating', stacks: 1, target: 'self' },
    ],
    rollRisk: {
      minimum: 4,
      miss: { type: 'apply-status', status: 'weak', stacks: 2, target: 'self' },
    },
    description: 'Roll a d6. On 4+, gain 8 Block and Gain 1 Plating. Otherwise gain 2 Weak.',
    upgrade: {
      effects: [
        { type: 'block', amount: 11 },
        { type: 'apply-status', status: 'plating', stacks: 2, target: 'self' },
      ],
      description: 'Roll a d6. On 4+, gain 11 Block and Gain 2 Plating. Otherwise gain 2 Weak.',
    },
  },
  {
    id: 'last-reserve',
    name: 'Last Reserve',
    type: 'skill',
    cost: 1,
    target: 'none',
    exhaust: true,
    dice: 'glass-d8',
    effects: [{ type: 'heal', amount: 12, target: 'self' }],
    rollRisk: {
      minimum: 6,
      miss: { type: 'apply-status', status: 'overheat', stacks: 2, target: 'self' },
    },
    description: 'Roll a d8. On 6+, heal 12 HP. Otherwise gain 2 Overheat. Exhaust.',
    upgrade: {
      effects: [{ type: 'heal', amount: 16, target: 'self' }],
      description: 'Roll a d8. On 6+, heal 16 HP. Otherwise gain 2 Overheat. Exhaust.',
    },
  },
];

export const CARDS_BY_ID: ReadonlyMap<string, SliceCard> = new Map(CARDS.map((c) => [c.id, c]));

/** Card ids of the deck every run starts with. */
export const STARTER_DECK: readonly string[] = [
  'strike',
  'strike',
  'strike',
  'strike',
  'defend',
  'defend',
  'defend',
  'patch-kit',
  'cog-toss',
  'warding-glyph',
];

/** The upgraded variant of a base card: id and name gain `+`, the upgrade's fields replace the base's. */
export function upgradedCard(def: SliceCard): SliceCard {
  const { upgrade, ...base } = def;
  if (def.upgraded || !upgrade) throw new Error(`Card ${def.id} has no upgrade`);
  const { name, sigil, ...fields } = upgrade;
  return {
    ...base,
    ...fields,
    ...(sigil === undefined ? {} : { sigil }),
    id: `${def.id}${UPGRADE_SUFFIX}`,
    name: name ?? `${def.name}${UPGRADE_SUFFIX}`,
    upgraded: true,
  };
}

/** Looks a card up by id; an id ending in `+` resolves to that card's upgraded variant. */
export function getCard(id: string): SliceCard {
  const upgraded = id.endsWith(UPGRADE_SUFFIX);
  const base = CARDS_BY_ID.get(upgraded ? id.slice(0, -UPGRADE_SUFFIX.length) : id);
  if (!base) throw new Error(`Unknown card ${id}`);
  return upgraded ? upgradedCard(base) : base;
}

/** Card defs for a list of ids, e.g. `deckDefs(STARTER_DECK)` for `start-combat`. */
export function deckDefs(ids: readonly string[]): SliceCard[] {
  return ids.map(getCard);
}
