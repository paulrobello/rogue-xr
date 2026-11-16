import { describe, expect, it } from 'vitest';
import { RunRng } from '../src/core/rng.ts';
import {
  type Action,
  type ApplyResult,
  apply,
  type CardDef,
  type CombatEvent,
  type CombatState,
  createIdleState,
  DRAW_PER_TURN,
  type EnemySetup,
  intentDamage,
  RulesError,
  STEAM_PER_TURN,
  startCombat,
  validate,
} from '../src/rules/index.ts';

const strike = (id = 'strike', amount = 6): CardDef => ({
  id,
  cost: 1,
  target: 'enemy',
  effects: [{ type: 'damage', amount, target: 'target' }],
});
const guard = (id = 'guard', amount = 5): CardDef => ({
  id,
  cost: 1,
  target: 'none',
  effects: [{ type: 'block', amount }],
});
const dummy = (id = 'dummy', hp = 40): EnemySetup => ({
  id,
  name: id,
  hp,
  moves: [{ id: 'wait', intent: 'unknown', effects: [] }],
});
const brute = (id = 'brute', damage = 7): EnemySetup => ({
  id,
  name: 'Cog Brute',
  hp: 30,
  moves: [
    {
      id: 'slam',
      intent: 'attack',
      effects: [{ type: 'damage', amount: damage, target: 'target' }],
    },
  ],
});
const starter = (): CardDef[] => [
  ...Array.from({ length: 5 }, (_, i) => strike(`strike${i}`)),
  ...Array.from({ length: 5 }, (_, i) => guard(`guard${i}`)),
];

function begin(
  deck: CardDef[] = starter(),
  enemies: EnemySetup[] = [dummy()],
  seed = 'SP1RE000',
  hp = 30,
): CombatState {
  return startCombat({ player: { hp, maxHp: 30 }, deck, enemies, rng: new RunRng(seed).snapshot() })
    .state;
}

/** Applies actions in order and collects every event. */
function run(state: CombatState, actions: Action[]): ApplyResult {
  const events: CombatEvent[] = [];
  for (const action of actions) {
    const result = apply(state, action);
    state = result.state;
    events.push(...result.events);
  }
  return { state, events };
}

const handIds = (state: CombatState): string[] => state.piles.hand.map((c) => c.def.id);

/** Moves a card from the draw pile into the hand, so a test does not depend on the shuffle. */
function toHand(state: CombatState, uid: number): CombatState {
  const card = state.piles.draw.find((c) => c.uid === uid);
  if (!card) return state;
  const draw = state.piles.draw.filter((c) => c.uid !== uid);
  return { ...state, piles: { ...state.piles, draw, hand: [...state.piles.hand, card] } };
}
const pileTotal = (state: CombatState): number =>
  state.piles.draw.length +
  state.piles.hand.length +
  state.piles.discard.length +
  state.piles.exhaust.length;

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

describe('start-combat', () => {
  it('shuffles the deck into the draw pile and shows every enemy intent', () => {
    const { state, events } = startCombat({
      player: { hp: 30, maxHp: 30 },
      deck: starter(),
      enemies: [brute('a'), dummy('b')],
      rng: new RunRng('SP1RE000').snapshot(),
    });
    expect(state.phase).toBe('awaiting-turn');
    expect(state.piles.draw).toHaveLength(10);
    expect(new Set(state.piles.draw.map((c) => c.uid)).size).toBe(10);
    expect(state.enemies.map((e) => e.intent?.id)).toEqual(['slam', 'wait']);
    expect(events).toEqual([
      { type: 'combat-started', enemies: ['a', 'b'], deckSize: 10 },
      { type: 'enemy-intent', enemyId: 'a', moveId: 'slam', intent: 'attack' },
      { type: 'enemy-intent', enemyId: 'b', moveId: 'wait', intent: 'unknown' },
    ]);
  });

  it('rejects bad setups', () => {
    const rng = new RunRng('SP1RE000').snapshot();
    const base = { player: { hp: 30, maxHp: 30 }, deck: starter(), rng };
    expect(() => startCombat({ ...base, enemies: [] })).toThrow(RulesError);
    expect(() => startCombat({ ...base, enemies: [dummy('x'), dummy('x')] })).toThrow(/taken/);
    expect(() => startCombat({ ...base, enemies: [dummy('player')] })).toThrow(/reserved/);
    const diceMove: EnemySetup = {
      ...dummy(),
      moves: [
        {
          id: 'r',
          intent: 'attack',
          effects: [{ type: 'damage', amount: { dice: 1 }, target: 'target' }],
        },
      ],
    };
    expect(() => startCombat({ ...base, enemies: [diceMove] })).toThrow(/dice/);
    const aimless: CardDef = { ...strike(), target: 'none' };
    expect(() => startCombat({ ...base, deck: [aimless], enemies: [dummy()] })).toThrow(/targets/);
  });
});

describe('turn loop', () => {
  it('start-turn refills 3 steam and draws 5', () => {
    const { state, events } = apply(begin(), { type: 'start-turn' });
    expect(state.phase).toBe('player');
    expect(state.turn).toBe(1);
    expect(state.player.steam).toBe(STEAM_PER_TURN);
    expect(state.piles.hand).toHaveLength(DRAW_PER_TURN);
    expect(state.piles.draw).toHaveLength(5);
    expect(events.filter((e) => e.type === 'card-drawn')).toHaveLength(5);
    expect(events[0]).toEqual({ type: 'turn-started', turn: 1 });
  });

  it('steam does not carry over between turns', () => {
    const state = run(begin(), [
      { type: 'start-turn' },
      { type: 'end-turn' },
      { type: 'enemy-act' },
      { type: 'start-turn' },
    ]).state;
    expect(state.player.steam).toBe(STEAM_PER_TURN);
  });

  it('end-turn discards the whole hand', () => {
    const { state, events } = run(begin(), [{ type: 'start-turn' }, { type: 'end-turn' }]);
    expect(state.piles.hand).toHaveLength(0);
    expect(state.piles.discard).toHaveLength(5);
    expect(state.phase).toBe('enemy');
    expect(events.filter((e) => e.type === 'card-discarded')).toHaveLength(5);
  });

  it('reshuffles the discard into the draw pile when it runs dry', () => {
    const turn: Action[] = [{ type: 'start-turn' }, { type: 'end-turn' }, { type: 'enemy-act' }];
    const { state, events } = run(begin(), [...turn, ...turn, { type: 'start-turn' }]);
    expect(events).toContainEqual({ type: 'reshuffled', count: 10 });
    expect(state.piles.hand).toHaveLength(5);
    expect(state.piles.draw).toHaveLength(5);
    expect(pileTotal(state)).toBe(10);
  });

  it('stops drawing quietly when draw and discard are both empty', () => {
    const { state, events } = apply(begin([strike(), strike('b')]), { type: 'start-turn' });
    expect(state.piles.hand).toHaveLength(2);
    expect(events.some((e) => e.type === 'reshuffled')).toBe(false);
  });

  it('player block lasts through the enemy turn and resets at the next turn start', () => {
    let state = apply(begin([guard('g', 5)], [brute('b', 7)]), { type: 'start-turn' }).state;
    state = apply(state, { type: 'play-card', uid: 0 }).state;
    const enemy = run(state, [{ type: 'end-turn' }, { type: 'enemy-act' }]);
    expect(enemy.events).toContainEqual({
      type: 'damage-dealt',
      source: 'b',
      target: 'player',
      kind: 'attack',
      amount: 7,
      blocked: 5,
      hpLost: 2,
    });
    expect(enemy.state.player.hp).toBe(28);
    expect(enemy.state.player.block).toBe(0);

    const kept = apply(begin([guard('g', 10)], [dummy()]), { type: 'start-turn' }).state;
    const blocked = run(apply(kept, { type: 'play-card', uid: 0 }).state, [
      { type: 'end-turn' },
      { type: 'enemy-act' },
    ]).state;
    expect(blocked.player.block).toBe(10);
    const next = apply(blocked, { type: 'start-turn' });
    expect(next.state.player.block).toBe(0);
    expect(next.events).toContainEqual({ type: 'block-cleared', target: 'player', amount: 10 });
  });

  it('enemy block resets at the start of its own action', () => {
    const turtle: EnemySetup = {
      id: 't',
      name: 'Turtle',
      hp: 20,
      moves: [{ id: 'shell', intent: 'defend', effects: [{ type: 'block', amount: 6 }] }],
    };
    let state = run(begin([strike()], [turtle]), [
      { type: 'start-turn' },
      { type: 'end-turn' },
      { type: 'enemy-act' },
    ]).state;
    expect(state.enemies[0]?.block).toBe(6);
    state = apply(state, { type: 'start-turn' }).state;
    const hit = apply(state, { type: 'play-card', uid: 0, target: 't' });
    expect(hit.state.enemies[0]).toMatchObject({ block: 0, hp: 20 });
    const acted = run(hit.state, [{ type: 'end-turn' }, { type: 'enemy-act' }]);
    expect(acted.events).toContainEqual({ type: 'block-gained', target: 't', amount: 6 });
    expect(acted.state.enemies[0]?.block).toBe(6);
  });

  it('enemy-act returns to awaiting-turn and re-rolls the intent', () => {
    const { state, events } = run(begin(), [
      { type: 'start-turn' },
      { type: 'end-turn' },
      { type: 'enemy-act' },
    ]);
    expect(state.phase).toBe('awaiting-turn');
    expect(events).toContainEqual({ type: 'enemy-acted', enemyId: 'dummy', moveId: 'wait' });
    expect(events.at(-1)).toEqual({
      type: 'enemy-intent',
      enemyId: 'dummy',
      moveId: 'wait',
      intent: 'unknown',
    });
  });
});

describe('play-card', () => {
  it('pays steam, resolves effects and discards the card', () => {
    let state = apply(begin(), { type: 'start-turn' }).state;
    const card = state.piles.hand.find((c) => c.def.id.startsWith('strike'));
    if (!card) throw new Error('setup');
    const result = apply(state, { type: 'play-card', uid: card.uid, target: 'dummy' });
    state = result.state;
    expect(state.player.steam).toBe(2);
    expect(state.enemies[0]?.hp).toBe(34);
    expect(state.piles.discard.map((c) => c.uid)).toEqual([card.uid]);
    expect(result.events.map((e) => e.type)).toEqual([
      'steam-changed',
      'card-played',
      'damage-dealt',
      'card-discarded',
    ]);
  });

  it('lose-steam floors at zero and gain-steam can exceed the refill', () => {
    const drain: CardDef = {
      id: 'drain',
      cost: 1,
      target: 'none',
      effects: [{ type: 'lose-steam', amount: 5 }],
    };
    const surge: CardDef = {
      id: 'surge',
      cost: 0,
      target: 'none',
      effects: [{ type: 'gain-steam', amount: 2 }],
    };
    const start = apply(begin([drain, surge]), { type: 'start-turn' }).state;
    const surged = apply(start, { type: 'play-card', uid: 1 }).state;
    expect(surged.player.steam).toBe(5);
    const drained = apply(start, { type: 'play-card', uid: 0 });
    expect(drained.state.player.steam).toBe(0);
    expect(drained.events).toContainEqual({ type: 'steam-changed', from: 2, to: 0 });
  });

  it('exhausts cards marked exhaust', () => {
    const burn: CardDef = { ...guard('burn'), exhaust: true };
    const state = run(begin([burn]), [{ type: 'start-turn' }, { type: 'play-card', uid: 0 }]).state;
    expect(state.piles.exhaust.map((c) => c.def.id)).toEqual(['burn']);
    expect(state.piles.discard).toHaveLength(0);
  });

  it('handles every effect type: damage, block, steam, status, draw', () => {
    const combo: CardDef = {
      id: 'combo',
      cost: 2,
      target: 'enemy',
      effects: [
        { type: 'damage', amount: 2, hits: 3, target: 'target' },
        { type: 'block', amount: 4 },
        { type: 'gain-steam', amount: 2 },
        { type: 'lose-steam', amount: 1 },
        { type: 'apply-status', status: 'weak', stacks: 2, target: 'all-opponents' },
        { type: 'apply-status', status: 'wound-up', stacks: 1, target: 'self' },
        { type: 'draw', amount: 2 },
      ],
    };
    const deck = [combo, ...Array.from({ length: 8 }, (_, i) => guard(`g${i}`))];
    const state = toHand(
      apply(begin(deck, [dummy('a'), dummy('b')]), { type: 'start-turn' }).state,
      0,
    );
    const handBefore = state.piles.hand.length;
    const result = apply(state, { type: 'play-card', uid: 0, target: 'a' });
    const after = result.state;
    expect(after.enemies.find((e) => e.id === 'a')?.hp).toBe(34);
    expect(after.enemies.find((e) => e.id === 'b')?.hp).toBe(40);
    expect(after.player.block).toBe(4);
    expect(after.player.steam).toBe(3 - 2 + 2 - 1);
    expect(after.enemies.map((e) => e.statuses)).toEqual([{ weak: 2 }, { weak: 2 }]);
    expect(after.player.statuses).toEqual({ 'wound-up': 1 });
    expect(after.piles.hand).toHaveLength(handBefore - 1 + 2);
  });

  it('removes the played card before effects so a draw cannot redraw it', () => {
    const cycle: CardDef = {
      id: 'cycle',
      cost: 0,
      target: 'none',
      effects: [{ type: 'draw', amount: 3 }],
    };
    const result = run(begin([cycle]), [{ type: 'start-turn' }, { type: 'play-card', uid: 0 }]);
    expect(result.state.piles.hand).toHaveLength(0);
    expect(result.state.piles.discard.map((c) => c.def.id)).toEqual(['cycle']);
    expect(result.events.some((e) => e.type === 'reshuffled')).toBe(false);
  });

  it('uses the caller-supplied dice result and rejects a dice card without one', () => {
    const roll: CardDef = {
      id: 'roll',
      cost: 1,
      target: 'enemy',
      effects: [{ type: 'damage', amount: { base: 1, dice: 2 }, target: 'target' }],
    };
    const state = apply(begin([roll]), { type: 'start-turn' }).state;
    expect(validate(state, { type: 'play-card', uid: 0, target: 'dummy' })).toMatch(/dice/);
    const result = apply(state, { type: 'play-card', uid: 0, target: 'dummy', dice: 4 });
    expect(result.state.enemies[0]?.hp).toBe(40 - 9);
    expect(result.events).toContainEqual({
      type: 'card-played',
      uid: 0,
      cardId: 'roll',
      target: 'dummy',
      dice: 4,
    });
  });

  it('rejects illegal plays with a RulesError and a validator message', () => {
    const state = apply(begin(), { type: 'start-turn' }).state;
    const strikeCard = state.piles.hand.find((c) => c.def.target === 'enemy');
    const guardCard = state.piles.hand.find((c) => c.def.target === 'none');
    if (!strikeCard || !guardCard) throw new Error('setup');
    expect(validate(state, { type: 'play-card', uid: 999 })).toMatch(/not in hand/);
    expect(validate(state, { type: 'play-card', uid: strikeCard.uid })).toMatch(/target/);
    expect(validate(state, { type: 'play-card', uid: strikeCard.uid, target: 'nobody' })).toMatch(
      /target/,
    );
    expect(validate(state, { type: 'play-card', uid: guardCard.uid, target: 'dummy' })).toMatch(
      /no target/,
    );
    const broke = { ...state, player: { ...state.player, steam: 0 } };
    expect(() => apply(broke, { type: 'play-card', uid: guardCard.uid })).toThrow(/steam/);
    expect(() => apply(state, { type: 'start-turn' })).toThrow(RulesError);
    expect(() => apply(state, { type: 'enemy-act' })).toThrow(RulesError);
    expect(() => apply(createIdleState(), { type: 'end-turn' })).toThrow(RulesError);
  });
});

describe('win and lose', () => {
  it('wins when every enemy is dead and stops resolving the card', () => {
    const finisher: CardDef = {
      id: 'finisher',
      cost: 1,
      target: 'enemy',
      effects: [
        { type: 'damage', amount: 10, target: 'target' },
        { type: 'block', amount: 5 },
      ],
    };
    const result = run(begin([finisher], [dummy('d', 8)]), [
      { type: 'start-turn' },
      { type: 'play-card', uid: 0, target: 'd' },
    ]);
    expect(result.state.outcome).toBe('won');
    expect(result.state.phase).toBe('over');
    expect(result.state.player.block).toBe(0);
    expect(result.state.enemies[0]).toMatchObject({ hp: 0, intent: null });
    expect(result.events).toContainEqual({ type: 'enemy-died', enemyId: 'd' });
    expect(result.events).toContainEqual({ type: 'combat-won' });
    expect(result.events.some((e) => e.type === 'block-gained')).toBe(false);
    expect(() => apply(result.state, { type: 'end-turn' })).toThrow(RulesError);
  });

  it('skips remaining hits on a target that died but keeps the fight going', () => {
    const flurry: CardDef = {
      id: 'flurry',
      cost: 1,
      target: 'enemy',
      effects: [{ type: 'damage', amount: 5, hits: 4, target: 'target' }],
    };
    const result = run(begin([flurry], [dummy('a', 7), dummy('b')]), [
      { type: 'start-turn' },
      { type: 'play-card', uid: 0, target: 'a' },
    ]);
    expect(result.events.filter((e) => e.type === 'damage-dealt')).toHaveLength(2);
    expect(result.state.outcome).toBeNull();
    expect(result.state.enemies.map((e) => e.hp)).toEqual([0, 40]);
    const acted = run(result.state, [{ type: 'end-turn' }, { type: 'enemy-act' }]);
    expect(acted.events.filter((e) => e.type === 'enemy-acted')).toEqual([
      { type: 'enemy-acted', enemyId: 'b', moveId: 'wait' },
    ]);
  });

  it('loses when the player reaches 0 HP and later enemies do not act', () => {
    const result = run(begin([strike()], [brute('a', 50), brute('b', 50)], 'SP1RE000', 10), [
      { type: 'start-turn' },
      { type: 'end-turn' },
      { type: 'enemy-act' },
    ]);
    expect(result.state.outcome).toBe('lost');
    expect(result.state.player.hp).toBe(0);
    expect(result.events.at(-1)).toEqual({ type: 'combat-lost' });
    expect(result.events.filter((e) => e.type === 'enemy-acted')).toHaveLength(1);
  });
});

describe('intents', () => {
  it('picks weighted moves from the ai stream only', () => {
    const mixed: EnemySetup = {
      id: 'm',
      name: 'Mixed',
      hp: 99,
      moves: [
        {
          id: 'jab',
          intent: 'attack',
          weight: 3,
          effects: [{ type: 'damage', amount: 1, target: 'target' }],
        },
        { id: 'brace', intent: 'defend', weight: 1, effects: [{ type: 'block', amount: 1 }] },
      ],
    };
    const turn: Action[] = [{ type: 'start-turn' }, { type: 'end-turn' }, { type: 'enemy-act' }];
    const actions = Array.from({ length: 30 }, () => turn).flat();
    const intents = (seed: string): string[] =>
      run(begin(starter(), [mixed], seed), actions).events.flatMap((e) =>
        e.type === 'enemy-intent' ? [e.moveId] : [],
      );
    const picks = intents('SP1RE000');
    expect(new Set(picks)).toEqual(new Set(['jab', 'brace']));
    expect(picks.filter((p) => p === 'jab').length).toBeGreaterThan(picks.length / 2);
    expect(intents('SP1RE000')).toEqual(picks);
  });

  it('previews intent damage after statuses', () => {
    const state = begin(starter(), [{ ...brute('b', 8), statuses: { weak: 1 } }]);
    expect(intentDamage(state, 'b')).toEqual([6]);
    expect(intentDamage(state, 'missing')).toEqual([]);
  });
});

describe('purity and determinism', () => {
  const script: Action[] = [
    { type: 'start-turn' },
    { type: 'end-turn' },
    { type: 'enemy-act' },
    { type: 'start-turn' },
    { type: 'end-turn' },
    { type: 'enemy-act' },
    { type: 'start-turn' },
  ];

  it('never mutates the input state', () => {
    let state = begin(starter(), [brute()]);
    for (const action of script) {
      const before = JSON.stringify(state);
      deepFreeze(state);
      const next = apply(state, action).state;
      expect(JSON.stringify(state)).toBe(before);
      state = next;
    }
    const card = state.piles.hand.find((c) => c.def.target === 'enemy');
    if (!card) throw new Error('setup');
    deepFreeze(state);
    expect(() => apply(state, { type: 'play-card', uid: card.uid, target: 'brute' })).not.toThrow();
  });

  it('replays identically for the same seed and actions', () => {
    const a = run(begin(starter(), [brute()], 'SP1RE000'), script);
    const b = run(begin(starter(), [brute()], 'SP1RE000'), script);
    expect(a.state).toEqual(b.state);
    expect(a.events).toEqual(b.events);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('a different seed changes the draw order', () => {
    const a = apply(begin(starter(), [dummy()], 'SP1RE000'), { type: 'start-turn' }).state;
    const b = apply(begin(starter(), [dummy()], 'SP1RE001'), { type: 'start-turn' }).state;
    expect(a.piles.draw.map((c) => c.uid)).not.toEqual(b.piles.draw.map((c) => c.uid));
  });

  it('drawing and shuffling touch only the deck stream', () => {
    const start = begin();
    const drawn = run(start, script).state;
    expect(drawn.rng.deck).not.toEqual(start.rng.deck);
    expect(drawn.rng.dice).toEqual(start.rng.dice);
    expect(drawn.rng.loot).toEqual(start.rng.loot);
    const afterTurn = apply(start, { type: 'start-turn' }).state;
    expect(afterTurn.rng.ai).toEqual(start.rng.ai);
  });

  it('round-trips through JSON', () => {
    const { state } = run(begin(), script);
    expect(JSON.parse(JSON.stringify(state))).toEqual(state);
    expect(handIds(state)).toHaveLength(5);
  });
});
