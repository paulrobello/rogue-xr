import { describe, expect, it } from 'vitest';
import {
  CombatController,
  type CombatOptions,
  describeEvent,
  ENEMY_ORDER,
  parseCombatQuery,
  resolveSetups,
  type ViewUpdate,
} from '../src/combat-view/controller.ts';
import { ENCOUNTERS } from '../src/content/enemies.ts';
import { SIGIL_TEMPLATES } from '../src/sigil/index.ts';
import { scoreTrace } from '../src/sigil-plate/index.ts';

const TURN_CAP = 60;

/** Plays the whole hand through the public API (first playable card first), then ends the turn. */
function playTurn(controller: CombatController): void {
  let played = true;
  while (played && controller.outcome === null) {
    played = false;
    for (const card of controller.state.piles.hand) {
      if (!controller.select(card.uid).ok) continue;
      const stage = controller.stage;
      let result: { ok: boolean };
      if (stage === 'target') {
        const enemy = [...controller.state.enemies]
          .filter((e) => e.hp > 0)
          .sort((a, b) => a.hp - b.hp)[0];
        result = controller.target((enemy as { id: string }).id);
        if (result.ok && controller.stage === 'sigil') result = drawTemplate(controller);
      } else if (stage === 'sigil') {
        result = drawTemplate(controller);
      } else {
        result = controller.table();
      }
      if (result.ok) {
        played = true;
        break;
      }
      controller.cancel();
    }
  }
  if (controller.outcome === null) controller.endTurn();
}

function drawTemplate(controller: CombatController): { ok: boolean } {
  const sigil = controller.awaitedSigil;
  if (sigil === null) throw new Error('No sigil awaited');
  return controller.submitSigil(SIGIL_TEMPLATES[sigil].strokes);
}

/** Plays turns until the fight ends. */
function fight(options: CombatOptions, turn: (c: CombatController) => void): CombatController {
  const controller = new CombatController(options);
  for (let i = 0; i < TURN_CAP && controller.outcome === null; i++) turn(controller);
  return controller;
}

describe('parseCombatQuery', () => {
  it('defaults to a cog-sentry fight on the default seed', () => {
    expect(parseCombatQuery('?view=combat')).toEqual({ seed: 'SPIRE001', enemy: 'cog-sentry' });
  });

  it('reads enemy, seed, encounter and cheats, and ignores invalid values', () => {
    expect(parseCombatQuery('?enemy=bellows-golem&seed=abcd-efgh&cheat=win')).toEqual({
      seed: 'ABCDEFGH',
      enemy: 'bellows-golem',
      enemyHp: 1,
    });
    expect(parseCombatQuery('?enemy=nope&seed=short&encounter=elite&cheat=lose')).toEqual({
      seed: 'SPIRE001',
      enemy: 'cog-sentry',
      encounter: 'elite',
      playerHp: 1,
    });
    expect(parseCombatQuery('?encounter=bogus').encounter).toBeUndefined();
  });

  it('resolves an encounter from the seed and numbers duplicate enemies', () => {
    const a = resolveSetups({ seed: 'SPIRE001', encounter: 'regular' });
    expect(a).toEqual(resolveSetups({ seed: 'SPIRE001', encounter: 'regular' }));
    expect(new Set(a.map((s) => s.id)).size).toBe(a.length);
    expect(resolveSetups({ encounter: 'guardian' }).map((s) => s.id)).toEqual(
      ENCOUNTERS.guardian[0]?.enemies,
    );
  });
});

describe('CombatController input', () => {
  it('starts the first player turn with a full hand and steam', () => {
    const c = new CombatController({ seed: 'TEST0001' });
    expect(c.state.phase).toBe('player');
    expect(c.state.turn).toBe(1);
    expect(c.state.piles.hand).toHaveLength(5);
    expect(c.state.player.steam).toBe(3);
    expect(c.stage).toBe('idle');
  });

  it('walks select, target and play for an attack, and select, table for a skill', () => {
    const c = new CombatController({
      seed: 'TEST0001',
      deck: ['strike', 'defend', 'strike', 'defend', 'strike'],
    });
    const strike = c.state.piles.hand.find((h) => h.def.id === 'strike');
    const defend = c.state.piles.hand.find((h) => h.def.id === 'defend');
    expect(c.select((strike as { uid: number }).uid).ok).toBe(true);
    expect(c.stage).toBe('target');
    expect(c.table().ok).toBe(false);
    expect(c.target('cog-sentry').ok).toBe(true);
    expect(c.state.enemies[0]?.hp).toBe(32);
    expect(c.stage).toBe('idle');

    expect(c.select((defend as { uid: number }).uid).ok).toBe(true);
    expect(c.stage).toBe('table');
    expect(c.table().ok).toBe(true);
    expect(c.state.player.block).toBe(5);
    expect(c.state.player.steam).toBe(1);
  });

  it('toggles selection off on a second click and cancels', () => {
    const c = new CombatController({ seed: 'TEST0001' });
    const uid = (c.state.piles.hand[0] as { uid: number }).uid;
    c.select(uid);
    expect(c.selectedUid).toBe(uid);
    c.select(uid);
    expect(c.selectedUid).toBeNull();
    c.select(uid);
    c.cancel();
    expect(c.selectedUid).toBeNull();
  });

  it('flashes invalid plays and leaves state and dice stream untouched', () => {
    const c = new CombatController({
      seed: 'TEST0001',
      deck: ['cog-toss', 'cog-toss', 'cog-toss', 'cog-toss', 'cog-toss'],
    });
    const updates: ViewUpdate[] = [];
    c.subscribe((u) => updates.push(u));
    const [a, b, d, e] = c.state.piles.hand.map((h) => h.uid);
    for (const uid of [a, b, d]) {
      c.select(uid as number);
      c.target('cog-sentry');
    }
    expect(c.state.player.steam).toBe(0);
    const before = c.state;
    const result = c.select(e as number);
    expect(result.ok).toBe(false);
    expect(c.state).toBe(before);
    expect(c.state.rng.dice).toEqual(before.rng.dice);
    expect(updates.at(-1)).toMatchObject({ type: 'invalid', subject: { kind: 'card', uid: e } });
    expect(c.table().ok).toBe(true);
    expect(c.target('cog-sentry').ok).toBe(false);
  });

  it('rolls dice on commit, shows the result, and replays from the seed', () => {
    const run = (): number => {
      const c = new CombatController({
        seed: 'TEST0001',
        deck: ['cog-toss', 'cog-toss', 'cog-toss', 'cog-toss', 'cog-toss'],
      });
      const uid = (c.state.piles.hand[0] as { uid: number }).uid;
      c.select(uid);
      expect(c.lastDice).toBeNull();
      c.target('cog-sentry');
      expect(c.lastDice).toMatchObject({ cardId: 'cog-toss', dieName: 'Brass d6', faces: 6 });
      const roll = (c.lastDice as { value: number }).value;
      expect(c.state.enemies[0]?.hp).toBe(38 - (2 + roll));
      return roll;
    };
    expect(run()).toBe(run());
  });

  it('scores a sigil trace with the real recognizer and scales the cast', () => {
    const c = new CombatController({ seed: 'TEST0001', deck: Array(5).fill('arc-bolt') });
    const uid = (c.state.piles.hand[0] as { uid: number }).uid;
    c.select(uid);
    c.target('cog-sentry');
    expect(c.stage).toBe('sigil');
    expect(c.awaitedSigil).toBe('bolt');
    expect(c.state.enemies[0]?.hp).toBe(38);
    expect(c.submitSigil([[{ x: 0.5, y: 0.5 }]]).ok).toBe(false);
    expect(c.stage).toBe('sigil');

    expect(c.submitSigil(SIGIL_TEMPLATES.bolt.strokes).ok).toBe(true);
    expect(c.lastSigil).toMatchObject({
      sigil: 'bolt',
      recognizedAs: 'bolt',
      quality: 'Masterful',
    });
    expect(c.lastSigil?.multiplier).toBeCloseTo(1.25, 5);
    const roll = (c.lastDice as { value: number }).value;
    expect(c.state.enemies[0]?.hp).toBe(38 - Math.round((3 + roll) * 1.25));
    expect(c.stage).toBe('idle');
  });

  it('judges the same sloppy trace more strictly at the hard level (F9)', () => {
    const sloppy = SIGIL_TEMPLATES.bolt.strokes.map((stroke) =>
      stroke.map((p, i) => ({ x: p.x + (i % 2 ? 0.07 : -0.05), y: p.y + (i % 3 ? 0.04 : -0.06) })),
    );
    const cast = (difficulty?: 'hard') => {
      const c = new CombatController({
        seed: 'TEST0001',
        deck: Array(5).fill('arc-bolt'),
        ...(difficulty ? { difficulty } : {}),
      });
      c.select((c.state.piles.hand[0] as { uid: number }).uid);
      c.target('cog-sentry');
      expect(c.submitSigil(sloppy).ok).toBe(true);
      return c.lastSigil?.multiplier ?? Number.NaN;
    };
    expect(cast('hard')).toBeLessThan(cast());
  });

  it('fizzles a wrong trace to half power but still plays the card', () => {
    const c = new CombatController({ seed: 'TEST0001', deck: Array(5).fill('warding-glyph') });
    c.select((c.state.piles.hand[0] as { uid: number }).uid);
    expect(c.stage).toBe('sigil');
    c.submitSigil(SIGIL_TEMPLATES.bolt.strokes);
    expect(c.lastSigil).toMatchObject({ sigil: 'ward', recognizedAs: 'bolt', quality: 'Fizzle' });
    expect(c.lastSigil?.multiplier).toBe(0.5);
    expect(c.state.player.block).toBe(4);
  });

  it('scores through the shared scoreTrace path, rejecting traces under MIN_CAST_POINTS', () => {
    const traces = [
      SIGIL_TEMPLATES.gear.strokes,
      SIGIL_TEMPLATES.spiral.strokes.map((stroke) =>
        stroke.map((p) => ({ x: p.x * 0.3, y: p.y * 0.3 })),
      ),
      SIGIL_TEMPLATES.flame.strokes.map((stroke) => stroke.slice(0, 20)),
    ];
    for (const strokes of traces) {
      for (const sigil of ['gear', 'flame', 'ward', 'bolt', 'spiral'] as const) {
        const card = {
          gear: 'cogstorm',
          flame: 'furnace-brand',
          ward: 'warding-glyph',
          bolt: 'arc-bolt',
          spiral: 'time-spiral',
        }[sigil];
        const c = new CombatController({ seed: 'TEST0001', deck: Array(5).fill(card) });
        c.select((c.state.piles.hand[0] as { uid: number }).uid);
        if (c.stage === 'target') c.target('cog-sentry');
        expect(c.awaitedSigil).toBe(sigil);
        expect(c.submitSigil(strokes).ok).toBe(true);
        const expected = scoreTrace(strokes, sigil);
        expect(c.lastSigil).toEqual({
          sigil,
          score: expected.score,
          multiplier: expected.multiplier,
          quality: expected.quality,
          recognizedAs: expected.recognizedAs,
        });
      }
    }
    const c = new CombatController({ seed: 'TEST0001', deck: Array(5).fill('warding-glyph') });
    c.select((c.state.piles.hand[0] as { uid: number }).uid);
    const stub = [
      [
        { x: 0, y: 0 },
        { x: 0.1, y: 0.1 },
      ],
    ];
    expect(scoreTrace(stub, 'ward').castable).toBe(false);
    expect(c.submitSigil(stub).ok).toBe(false);
    expect(c.stage).toBe('sigil');
  });

  it('logs events in plain language', () => {
    const c = new CombatController({ seed: 'TEST0001', deck: Array(5).fill('strike') });
    c.select((c.state.piles.hand[0] as { uid: number }).uid);
    c.target('cog-sentry');
    expect(c.log).toContain('Played Piston Strike on Cog Sentry');
    expect(c.log).toContain('You hit Cog Sentry for 6');
    expect(describeEvent({ type: 'card-drawn', uid: 1, cardId: 'strike' }, c.state)).toBeNull();
  });
});

describe('CombatController full fights', () => {
  it.each(ENEMY_ORDER)('loses to %s when the player only ends turns', (enemy) => {
    const c = fight({ seed: 'LOSE0001', enemy }, (ctl) => ctl.endTurn());
    expect(c.outcome).toBe('lost');
    expect(c.state.player.hp).toBe(0);
    expect(c.log.at(-1)).toBe('DEFEAT');
    expect(c.select(0).ok).toBe(false);
    expect(c.endTurn().ok).toBe(false);
  });

  it.each(ENEMY_ORDER)('loses to %s at 1 hp with the loss cheat', (enemy) => {
    const c = fight({ seed: 'LOSE0002', enemy, playerHp: 1 }, (ctl) => ctl.endTurn());
    expect(c.outcome).toBe('lost');
  });

  it.each(ENEMY_ORDER)('wins against %s at 1 hp with the win cheat', (enemy) => {
    const c = fight({ seed: 'WIN00001', enemy, enemyHp: 1 }, playTurn);
    expect(c.outcome).toBe('won');
    expect(c.log.at(-1)).toBe('VICTORY');
    expect(c.state.enemies.every((e) => e.hp === 0)).toBe(true);
  });

  it.each(['cog-sentry', 'spring-hound', 'bellows-golem'] as const)(
    'wins a full uncheated fight against %s through the public API',
    (enemy) => {
      const c = fight({ seed: 'WIN00002', enemy }, playTurn);
      expect(c.outcome).toBe('won');
      expect(c.state.turn).toBeGreaterThan(1);
      expect(c.state.player.hp).toBeGreaterThan(0);
    },
  );

  it('is deterministic: the same seed and inputs give the same fight', () => {
    const a = fight({ seed: 'WIN00003', enemy: 'bellows-golem' }, playTurn);
    const b = fight({ seed: 'WIN00003', enemy: 'bellows-golem' }, playTurn);
    expect(a.log).toEqual(b.log);
    expect(a.state).toEqual(b.state);
  });

  it('runs an encounter with several enemies to a win', () => {
    const c = fight({ seed: 'WIN00004', encounter: 'regular', enemyHp: 1 }, playTurn);
    expect(c.outcome).toBe('won');
  });
});
