// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { CombatController } from '../src/combat-view/controller.ts';
import { SIGIL_TEMPLATES } from '../src/sigil/index.ts';

function fight(deck: readonly string[]) {
  return new CombatController({
    seed: 'TEST0001',
    deck,
    setups: [
      {
        id: 'first',
        name: 'First',
        hp: 1,
        moves: [{ id: 'wait', intent: 'unknown', effects: [] }],
      },
      {
        id: 'second',
        name: 'Second',
        hp: 90,
        moves: [{ id: 'wait', intent: 'unknown', effects: [] }],
      },
    ],
  });
}

function uid(combat: CombatController, id: string): number {
  const card = combat.state.piles.hand.find((entry) => entry.def.id === id);
  if (!card) throw Error(`Missing ${id}`);
  return card.uid;
}

function select(combat: CombatController, id: string): void {
  expect(combat.select(uid(combat, id))).toEqual({ ok: true });
}

describe('Echo Glyph', () => {
  it('rejects an empty history without moving the card, changing state or spending Steam', () => {
    const combat = fight(['echo-glyph', 'strike', 'defend']);
    const before = combat.state;
    expect(combat.select(uid(combat, 'echo-glyph'))).toEqual({
      ok: false,
      reason: 'Cast a sigil successfully before Echo',
    });
    expect(combat.selectedUid).toBeNull();
    expect(combat.stage).toBe('idle');
    expect(combat.state).toBe(before);
  });

  it('replays the upgraded dice spell at its charged power on a fresh target once per spell', () => {
    const combat = fight(['arc-bolt+', 'capacitor', 'echo-glyph+', 'echo-glyph+', 'defend']);
    select(combat, 'capacitor');
    expect(combat.table().ok).toBe(true);
    select(combat, 'arc-bolt+');
    expect(combat.target('first').ok).toBe(true);
    expect(combat.submitSigil(SIGIL_TEMPLATES['bolt-plus'].strokes).ok).toBe(true);
    const memory = combat.state.lastSuccessfulSigil;
    const roll = combat.lastDice;
    expect(memory).toMatchObject({
      cardId: 'arc-bolt+',
      target: 'enemy',
      dice: roll?.value,
      power: 1.45,
    });
    expect(combat.state.player.statuses.charge).toBeUndefined();
    expect(combat.state.enemies[0]?.hp).toBe(0);

    expect(combat.endTurn().ok).toBe(true);
    expect(combat.state.lastSuccessfulSigil).toBe(memory);
    select(combat, 'capacitor');
    expect(combat.table().ok).toBe(true);
    const seededDice = combat.state.rng.dice;
    const damage = Math.round((5 + (roll?.value ?? 0)) * 1.45);
    for (const expectedHp of [90 - damage, 90 - damage * 2]) {
      const echo = uid(combat, 'echo-glyph+');
      expect(combat.cardTarget(echo)).toBe('enemy');
      select(combat, 'echo-glyph+');
      expect(combat.stage).toBe('target');
      expect(combat.target('first').ok).toBe(false);
      expect(combat.target('second').ok).toBe(true);
      expect(combat.awaitedSigil).toBe('spiral');
      combat.drainEvents();
      expect(combat.submitSigil(SIGIL_TEMPLATES.spiral.strokes).ok).toBe(true);
      const events = combat.drainEvents();
      expect(events.filter((event) => event.type === 'damage-dealt')).toHaveLength(1);
      expect(events.find((event) => event.type === 'card-played')).toMatchObject({
        uid: echo,
        cardId: 'echo-glyph+',
        echoedCardId: 'arc-bolt+',
        target: 'second',
        dice: roll?.value,
      });
      expect(combat.lastSigil).toMatchObject({ echoedCardId: 'arc-bolt+', multiplier: 1.45 });
      expect(combat.state.enemies[1]?.hp).toBe(expectedHp);
      expect(combat.state.lastSuccessfulSigil).toBe(memory);
      expect(combat.lastDice).toBe(roll);
      expect(combat.state.rng.dice).toEqual(seededDice);
      expect(combat.state.player.statuses.charge).toBe(2);
    }
    expect(combat.state.player.steam).toBe(0);
  });

  it('preserves the remembered self spell through a later fizzle and a fizzled Echo', () => {
    const combat = fight(['warding-glyph', 'time-spiral', 'echo-glyph', 'echo-glyph+', 'defend']);
    select(combat, 'warding-glyph');
    expect(combat.submitSigil(SIGIL_TEMPLATES.ward.strokes).ok).toBe(true);
    const memory = combat.state.lastSuccessfulSigil;
    expect(combat.state.player.block).toBe(10);
    select(combat, 'time-spiral');
    expect(combat.submitSigil(SIGIL_TEMPLATES.bolt.strokes).ok).toBe(true);
    expect(combat.lastSigil?.quality).toBe('Fizzle');
    select(combat, 'echo-glyph+');
    expect(combat.submitSigil(SIGIL_TEMPLATES.bolt.strokes).ok).toBe(true);
    expect(combat.lastSigil?.echoedCardId).toBeUndefined();
    expect(combat.state.lastSuccessfulSigil).toBe(memory);
    expect(combat.state.player.block).toBe(10);
    expect(combat.state.player.steam).toBe(0);

    expect(combat.endTurn().ok).toBe(true);
    select(combat, 'echo-glyph');
    expect(combat.stage).toBe('sigil');
    expect(combat.submitSigil(SIGIL_TEMPLATES.spiral.strokes).ok).toBe(true);
    expect(combat.lastSigil).toMatchObject({ echoedCardId: 'warding-glyph', multiplier: 1.25 });
    expect(combat.state.player.block).toBe(10);
    expect(combat.state.player.steam).toBe(1);
  });
});
