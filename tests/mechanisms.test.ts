// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { CombatController } from '../src/combat-view/controller.ts';
import { foldEvents, segmentEvents } from '../src/combat-view/enemy-turn.ts';
import { getCard } from '../src/content/cards.ts';
import { RunRng } from '../src/core/rng.ts';
import { startCombat } from '../src/rules/engine.ts';
import type { Effect, EnemySetup } from '../src/rules/types.ts';

const foe = (id: string, hp: number): EnemySetup => ({
  id,
  name: id,
  hp,
  moves: [{ id: 'wait', intent: 'unknown', effects: [] }],
});

function duel(deck: readonly string[], setups = [foe('first', 15), foe('second', 12)]) {
  const combat = new CombatController({ seed: 'MECH0001', deck, setups });
  combat.drainEvents();
  return combat;
}

function install(combat: CombatController, id: string): number {
  const card = combat.state.piles.hand.find((entry) => entry.def.id === id);
  if (!card) throw new Error(`Missing ${id}`);
  expect(combat.select(card.uid).ok).toBe(true);
  expect(combat.table().ok).toBe(true);
  return card.uid;
}

const installed = (combat: CombatController) =>
  (combat.state.mechanisms ?? []).map((c) => c.def.id);

describe('mechanisms', () => {
  it.each<readonly [Effect, string]>([
    [{ type: 'block', amount: { dice: 1 } }, 'require a die result'],
    [{ type: 'scry', count: 1 }, 'require a player choice'],
    [{ type: 'block', amount: { perSteam: 2 } }, 'spent Steam'],
    [{ type: 'damage', target: 'target', amount: 3 }, 'targets nothing'],
  ])('rejects an unresolved automatic effect at setup', (effect, error) => {
    expect(() =>
      startCombat({
        player: { hp: 20, maxHp: 20 },
        enemies: [foe('first', 20)],
        deck: [
          {
            id: 'broken-device',
            cost: 1,
            target: 'none',
            effects: [],
            mechanism: { timing: 'start-turn', effects: [effect] },
          },
        ],
        rng: new RunRng('MECH0001').snapshot(),
      }),
    ).toThrow(error);
  });
  it('installs without immediate benefit, preserves order, and retires the oldest at the fourth install', () => {
    const combat = duel([
      'gyro-stabilizer',
      'pressure-gauge+',
      'clockwork-turret',
      'furnace-heart+',
      'strike',
    ]);
    const gyro = install(combat, 'gyro-stabilizer');
    install(combat, 'pressure-gauge+');
    expect(combat.state.player.block).toBe(0);
    expect(combat.state.player.statuses.charge).toBeUndefined();
    expect(combat.state.player.steam).toBe(1);
    expect(combat.state.piles.discard.some((card) => card.uid === gyro)).toBe(false);
    combat.endTurn();
    expect(combat.state.player.block).toBe(3);
    expect(combat.state.player.statuses.charge).toBe(1);
    install(combat, 'clockwork-turret');
    expect(combat.state.enemies[1].hp).toBe(12);
    combat.endTurn();
    expect(combat.state.enemies[1].hp).toBe(9);
    const replacement = install(combat, 'furnace-heart+');
    expect(combat.state.player.steam).toBe(0);
    expect(installed(combat)).toEqual(['pressure-gauge+', 'clockwork-turret', 'furnace-heart+']);
    expect(combat.drainEvents()).toContainEqual({
      type: 'mechanism-installed',
      uid: replacement,
      cardId: 'furnace-heart+',
      replacedUid: gyro,
    });
    expect(combat.state.piles.exhaust.map(({ uid }) => uid)).toEqual([gyro]);
    combat.endTurn();
    expect(combat.state.player.block).toBe(0);
    expect(combat.state.player.statuses.charge).toBe(3);
    expect(combat.state.enemies.map((enemy) => enemy.statuses.overheat)).toEqual([3, 3]);
    expect(combat.state.enemies[1].hp).toBe(6);
  });

  it.each([
    ['gyro-stabilizer', [3, 0, 0, 12]],
    ['gyro-stabilizer+', [5, 0, 0, 12]],
    ['pressure-gauge', [0, 1, 0, 12]],
    ['pressure-gauge+', [0, 1, 0, 12]],
    ['clockwork-turret', [0, 0, 0, 9]],
    ['clockwork-turret+', [0, 0, 0, 7]],
    ['furnace-heart', [0, 0, 2, 12]],
    ['furnace-heart+', [0, 0, 3, 12]],
  ] as const)('resolves %s at the declared turn phase', (id, expected) => {
    const combat = duel([id, 'strike', 'defend']);
    const phases = getCard(id).mechanism?.timing;
    const installedUid = install(combat, id);
    combat.drainEvents();
    const before = combat.state;
    combat.endTurn();
    const { block, statuses } = combat.state.player;
    const second = combat.state.enemies[1];
    expect([block, statuses.charge ?? 0, second.statuses.overheat ?? 0, second.hp]).toEqual(
      expected,
    );
    const events = combat.drainEvents();
    const segments = segmentEvents(events);
    const beats = segments.filter((segment) => segment.kind === 'mechanism');
    expect(beats).toHaveLength(1);
    expect(beats[0]?.trigger).toMatchObject({ timing: phases, uid: installedUid, cardId: id });
    expect(beats[0]?.events.at(-1)).toEqual({ type: 'mechanism-finished', uid: installedUid });
    expect(
      segments.flatMap((segment) =>
        segment.kind === 'enemy' ? [...segment.lead, ...segment.act] : segment.events,
      ),
    ).toEqual(events);
    const displayed = foldEvents(before, events);
    expect(displayed.player).toEqual(combat.state.player);
    expect(displayed.enemies).toEqual(combat.state.enemies);
  });

  it('targets tied foes in encounter order, retargets after a kill, and bars enemy action after victory', () => {
    const combat = duel(
      ['clockwork-turret', 'clockwork-turret+', 'strike'],
      [foe('front', 5), foe('back', 5)],
    );
    install(combat, 'clockwork-turret');
    combat.endTurn();
    expect(combat.state.enemies.map((enemy) => enemy.hp)).toEqual([2, 5]);
    install(combat, 'clockwork-turret+');
    combat.drainEvents();
    combat.endTurn();
    const events = combat.drainEvents();
    expect(combat.outcome).toBe('won');
    expect(
      events.filter((event) => event.type === 'mechanism-triggered').map((event) => event.target),
    ).toEqual(['front', 'back']);
    expect(events.some((event) => event.type === 'enemy-acted')).toBe(false);
  });
});
