import type { CardDef, Effect } from '../rules/index.ts';
import type { SigilId } from '../sigil/types.ts';
import type { DieId } from './dice.ts';

export { SIGIL_IDS, type SigilId } from '../sigil/types.ts';
export { DIE_IDS, type DieId } from './dice.ts';

export type CardType = 'attack' | 'skill' | 'sigil';

/** Fields an upgrade replaces. Everything it leaves out is kept from the base card. */
export interface CardUpgrade {
  readonly name?: string;
  readonly cost?: number;
  readonly effects?: readonly Effect[];
  readonly exhaust?: boolean;
  readonly dice?: DieId;
  readonly description: string;
}

/**
 * A slice card. `dice` names the die rolled before the card resolves; it is set exactly when an effect
 * uses a dice `Amount`, and the roll is passed as `play-card.dice`. `sigil` is set exactly on sigil
 * spells; the sigil hook scales the base effects by the trace's power multiplier.
 */
export interface SliceCard extends CardDef {
  readonly name: string;
  readonly type: CardType;
  readonly description: string;
  readonly dice?: DieId;
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
    cost: 2,
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
    cost: 2,
    target: 'none',
    effects: [{ type: 'damage', amount: 4, hits: 2, target: 'all-opponents' }],
    description: 'Deal 4 damage to all enemies 2 times.',
    upgrade: {
      effects: [{ type: 'damage', amount: 6, hits: 2, target: 'all-opponents' }],
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
      description: 'Draw 3 cards. Apply 2 Weak to all enemies.',
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
  'defend',
  'cog-toss',
  'warding-glyph',
];

/** The upgraded variant of a base card: id and name gain `+`, the upgrade's fields replace the base's. */
export function upgradedCard(def: SliceCard): SliceCard {
  const { upgrade, ...base } = def;
  if (def.upgraded || !upgrade) throw new Error(`Card ${def.id} has no upgrade`);
  const { name, ...fields } = upgrade;
  return {
    ...base,
    ...fields,
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
