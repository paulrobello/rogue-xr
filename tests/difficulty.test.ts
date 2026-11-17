import { IDBFactory } from 'fake-indexeddb';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { chooseEncounter, fightSeed } from '../src/combat/encounter-choice.ts';
import { CombatController } from '../src/combat-view/controller.ts';
import { getCard, STARTER_DECK } from '../src/content/cards.ts';
import {
  ENCOUNTERS,
  ENEMIES,
  type EnemyKind,
  encounterSetups,
  GUARDIAN_PHASE_TWO_HP_FRACTION,
} from '../src/content/enemies.ts';
import { REWARD_POOL } from '../src/content/rewards.ts';
import { RunRng } from '../src/core/rng.ts';
import { RunFlow } from '../src/flow/flow.ts';
import { FlowUi } from '../src/flow/panels.ts';
import { bindFlowPersistence } from '../src/flow/persist.ts';
import {
  DEFAULT_SETTINGS,
  loadSettings,
  openDb,
  type Settings,
  saveSettings,
  validateSettings,
} from '../src/persist/db.ts';
import { loadRunSnapshot, SaveError, snapshotRun, validateSnapshot } from '../src/persist/saves.ts';
import {
  apply,
  type CardDef,
  type CombatState,
  createRun,
  DEFAULT_DIFFICULTY,
  DEFAULT_MAX_HP,
  DIFFICULTIES,
  DIFFICULTY_SCALE,
  type Difficulty,
  difficultyMaxHp,
  type EnemySetup,
  RulesError,
  type RunState,
  runDifficulty,
  scaleEnemySetup,
  startCombat,
} from '../src/rules/index.ts';
import { createWorkshop } from '../src/rules/workshop.ts';

const SEED = 'SPIRE010';
const KINDS = Object.keys(ENEMIES) as EnemyKind[];
const TIERS = ['regular', 'elite', 'guardian'] as const;

const damages = (setup: EnemySetup): number[] =>
  [...setup.moves, ...(setup.phaseTwo?.moves ?? [])].flatMap((m) =>
    m.effects.flatMap((e) => (e.type === 'damage' ? [e.amount as number] : [])),
  );

const newFlow = (workshop = createWorkshop()): RunFlow =>
  new RunFlow({ workshop, starterDeck: STARTER_DECK, rewardPool: REWARD_POOL });

describe('difficulty multipliers', () => {
  it('Hard fights every enemy exactly as written, in every tier', () => {
    for (const kind of KINDS) {
      for (const tier of TIERS) {
        expect(scaleEnemySetup(ENEMIES[kind], tier, 'hard')).toBe(ENEMIES[kind]);
      }
    }
    for (const enc of Object.values(ENCOUNTERS).flat()) {
      expect(encounterSetups(enc, 'hard')).toEqual(encounterSetups(enc));
    }
    expect(difficultyMaxHp(DEFAULT_MAX_HP, 'hard')).toBe(DEFAULT_MAX_HP);
  });

  it('Normal lowers only the elite and the guardian hp', () => {
    const warden = encounterSetups(ENCOUNTERS.elite[0] as never, 'normal')[0] as EnemySetup;
    const guardian = encounterSetups(ENCOUNTERS.guardian[0] as never, 'normal')[0] as EnemySetup;
    expect(warden.hp).toBe(69);
    expect(guardian.hp).toBe(120);
    expect(warden.hp).toBeLessThan(ENEMIES['orrery-warden'].hp);
    expect(guardian.hp).toBeLessThan(ENEMIES['grand-escapement'].hp);
    expect(damages(warden)).toEqual(damages(ENEMIES['orrery-warden']));
    expect(damages(guardian)).toEqual(damages(ENEMIES['grand-escapement']));
    for (const enc of ENCOUNTERS.regular) {
      expect(encounterSetups(enc, 'normal')).toEqual(encounterSetups(enc));
    }
    expect(difficultyMaxHp(DEFAULT_MAX_HP, 'normal')).toBe(DEFAULT_MAX_HP);
  });

  it('Casual scales hp and damage further and raises the player max hp', () => {
    const scaled = (kind: EnemyKind, tier: (typeof TIERS)[number]) =>
      scaleEnemySetup(ENEMIES[kind], tier, 'casual');
    expect(scaled('orrery-warden', 'elite').hp).toBe(51);
    expect(scaled('grand-escapement', 'guardian').hp).toBe(72);
    // 38 x 0.75 = 28.5 rounds up to 29.
    expect(scaled('cog-sentry', 'regular').hp).toBe(29);
    // 8 x 0.7 = 5.6 rounds to 6; the hound's 3-damage snap drops to 2 (2.1 rounds down).
    expect(damages(scaled('cog-sentry', 'regular'))).toEqual([6, 3]);
    expect(damages(scaled('spring-hound', 'regular'))).toEqual([2, 6]);
    expect(difficultyMaxHp(DEFAULT_MAX_HP, 'casual')).toBe(90);
    for (const kind of KINDS) {
      const base = ENEMIES[kind];
      const c = scaled(kind, 'regular');
      expect(c.hp).toBeLessThanOrEqual(base.hp);
      damages(c).forEach((d, i) => {
        expect(d).toBeGreaterThanOrEqual(1);
        expect(d).toBeLessThanOrEqual(damages(base)[i] as number);
      });
      // Block and statuses are left as written.
      const rest = (s: EnemySetup) =>
        s.moves.map((m) => m.effects.filter((e) => e.type !== 'damage'));
      expect(rest(c)).toEqual(rest(base));
    }
  });

  it('levels get easier in order: Casual below Normal below or at Hard', () => {
    for (const tier of TIERS) {
      const hp = (d: Difficulty) => DIFFICULTY_SCALE[d].enemyHp[tier];
      expect(hp('casual')).toBeLessThanOrEqual(hp('normal'));
      expect(hp('normal')).toBeLessThanOrEqual(hp('hard'));
    }
    expect(DIFFICULTY_SCALE.casual.enemyDamage).toBeLessThan(DIFFICULTY_SCALE.hard.enemyDamage);
  });

  it('keeps the guardian phase-2 threshold at half of its scaled max hp', () => {
    const hit = (amount: number): CardDef[] =>
      Array.from({ length: 10 }, (_, i) => ({
        id: `hit${i}`,
        cost: 0,
        target: 'enemy' as const,
        effects: [{ type: 'damage' as const, amount, target: 'target' as const }],
      }));
    const strikeOnce = (level: Difficulty, amount: number): CombatState => {
      const guardian = scaleEnemySetup(ENEMIES['grand-escapement'], 'guardian', level);
      expect(guardian.phaseTwo?.hpFraction).toBe(GUARDIAN_PHASE_TWO_HP_FRACTION);
      let state = startCombat({
        player: { hp: 1_000_000, maxHp: 1_000_000 },
        deck: hit(amount),
        enemies: [guardian],
        rng: new RunRng(SEED).snapshot(),
      }).state;
      state = apply(state, { type: 'start-turn' }).state;
      const uid = state.piles.hand[0]?.uid as number;
      return apply(state, { type: 'play-card', uid, target: guardian.id }).state;
    };
    for (const level of DIFFICULTIES) {
      const max = scaleEnemySetup(ENEMIES['grand-escapement'], 'guardian', level).hp;
      const half = max * GUARDIAN_PHASE_TWO_HP_FRACTION;
      const above = strikeOnce(level, max - half - 1).enemies[0];
      const at = strikeOnce(level, max - half).enemies[0];
      expect(above?.maxHp).toBe(max);
      expect(above?.phase).toBe(1);
      expect(at?.hp).toBe(half);
      expect(at?.phase).toBe(2);
    }
  });
});

describe('the run carries its difficulty', () => {
  it('defaults to Normal', () => {
    expect(DEFAULT_DIFFICULTY).toBe('normal');
    expect(DEFAULT_SETTINGS.difficulty).toBe('normal');
    const flow = newFlow();
    flow.newRun(SEED);
    expect(flow.run?.difficulty).toBe('normal');
    expect(runDifficulty({})).toBe('normal');
  });

  it('a new run stores its level and applies the level max hp on top of the workshop', () => {
    const workshop = { ...createWorkshop(), purchased: { ...createWorkshop().purchased } };
    for (const level of DIFFICULTIES) {
      const flow = newFlow(workshop);
      flow.newRun(SEED, level);
      expect(flow.run?.difficulty).toBe(level);
      expect(flow.run?.maxHp).toBe(difficultyMaxHp(DEFAULT_MAX_HP, level));
      expect(flow.run?.hp).toBe(flow.run?.maxHp);
    }
  });

  it('createRun rejects an unknown level and stores none unless given', () => {
    expect(() => createRun(SEED, STARTER_DECK, { difficulty: 'nightmare' as Difficulty })).toThrow(
      RulesError,
    );
    expect('difficulty' in createRun(SEED, STARTER_DECK)).toBe(false);
  });

  it('the end-of-run summary names the level', () => {
    const flow = newFlow();
    flow.newRun(SEED, 'casual');
    flow.fightStarted(2);
    flow.fightEnded({ room: 2, outcome: 'defeat', tier: 'regular', playerHp: 0 });
    expect(flow.summary?.difficulty).toBe('casual');
  });
});

describe('snapshots carry the difficulty', () => {
  const world = {
    phase: 'explore' as const,
    floorSeed: SEED,
    roomIndex: 0,
    clearedEncounters: [],
    pendingReward: null,
  };
  const runAt = (level?: Difficulty): RunState =>
    createRun(SEED, STARTER_DECK, level ? { difficulty: level } : {});

  it('round-trips each level through snapshotRun and JSON', () => {
    for (const level of DIFFICULTIES) {
      const snap = snapshotRun(runAt(level), world, 1);
      expect(validateSnapshot(JSON.parse(JSON.stringify(snap))).run.difficulty).toBe(level);
    }
  });

  it('loads a snapshot saved before the field existed as Normal', () => {
    const raw = JSON.parse(JSON.stringify(snapshotRun(runAt(), world, 1))) as {
      run: Record<string, unknown>;
    };
    expect('difficulty' in raw.run).toBe(false);
    const snap = validateSnapshot(raw);
    expect(snap.run).toEqual(runAt());
    expect(runDifficulty(snap.run)).toBe('normal');
    const flow = newFlow();
    expect(flow.continueRun(snap)).toBe(true);
    expect(runDifficulty(flow.run as RunState)).toBe('normal');
  });

  it('rejects an unknown level', () => {
    const raw = JSON.parse(JSON.stringify(snapshotRun(runAt('hard'), world, 1))) as {
      run: Record<string, unknown>;
    };
    raw.run.difficulty = 'nightmare';
    expect(() => validateSnapshot(raw)).toThrow(SaveError);
    raw.run.difficulty = 2;
    expect(() => validateSnapshot(raw)).toThrow(SaveError);
  });

  it('a resumed run keeps its level, whatever the title now offers', async () => {
    const db = await openDb(new IDBFactory());
    const flow = newFlow();
    const saved = bindFlowPersistence(flow, db);
    flow.newRun(SEED, 'hard');
    await saved.flushed();
    const snapshot = await loadRunSnapshot(db);
    expect(snapshot?.run.difficulty).toBe('hard');
    const resumed = newFlow();
    resumed.continueRun(snapshot as NonNullable<typeof snapshot>);
    expect(resumed.run?.difficulty).toBe('hard');
    expect(resumed.run).toEqual(flow.run);
    saved.dispose();
  });
});

describe('settings remember the last level', () => {
  it('keeps a valid level and repairs anything else to Normal', () => {
    expect(validateSettings({ difficulty: 'hard' }).difficulty).toBe('hard');
    expect(validateSettings({ difficulty: 'casual' }).difficulty).toBe('casual');
    expect(validateSettings({ difficulty: 'nightmare' }).difficulty).toBe('normal');
    expect(validateSettings({}).difficulty).toBe('normal');
  });

  it('persists the chosen level', async () => {
    const factory = new IDBFactory();
    const first = await openDb(factory);
    await saveSettings(first, { ...DEFAULT_SETTINGS, difficulty: 'casual' });
    expect((await loadSettings(await openDb(factory))).difficulty).toBe('casual');
  });
});

describe('the title offers the level', () => {
  it('chooses a level, remembers it in settings and starts New Run at it', () => {
    const flow = newFlow();
    let settings: Settings = { ...DEFAULT_SETTINGS };
    const started: Difficulty[] = [];
    const ui = new FlowUi({
      flow,
      keyArt: { url: '', titleSafe: { x: 0, y: 0, w: 0.3, h: 0.4 } },
      seed: 'BRASS042',
      snapshot: () => null,
      settings: () => settings,
      onNewRun: (seed, level) => {
        started.push(level);
        flow.newRun(seed, level);
      },
      onContinue: () => {},
      onSettings: (next) => {
        settings = next;
      },
    });
    ui.sync(new THREE.Object3D());
    for (const level of DIFFICULTIES) {
      expect(ui.controlIds()).toContain(`title-difficulty-${level}`);
    }
    expect(ui.activate('title-difficulty-casual')).toBe(true);
    expect(settings.difficulty).toBe('casual');
    expect(ui.activate('title-new-run')).toBe(true);
    expect(started).toEqual(['casual']);
    expect(flow.run?.difficulty).toBe('casual');
    ui.dispose();
  });
});

describe('difficulty never changes a random draw', () => {
  /** Plays a whole fight with a fixed policy, recording the state after every action. */
  function replay(level: Difficulty, room: number, tier: 'regular' | 'elite' | 'guardian') {
    const enc = chooseEncounter(SEED, room, tier, 1);
    const ctl = new CombatController({
      seed: fightSeed(SEED, room),
      setups: encounterSetups(enc, level),
      deck: STARTER_DECK,
      playerMaxHp: difficultyMaxHp(DEFAULT_MAX_HP, level),
    });
    const states: string[] = [JSON.stringify(ctl.state)];
    const firstTurn = { hand: ctl.state.piles.hand.map((c) => c.def.id), rng: ctl.state.rng };
    for (let turn = 0; turn < 40 && ctl.outcome === null; turn++) {
      for (const card of [...ctl.state.piles.hand]) {
        if (ctl.outcome !== null || getCard(card.def.id).sigil) continue;
        if (!ctl.select(card.uid).ok) continue;
        const foe = ctl.state.enemies.find((e) => e.hp > 0);
        const played = card.def.target === 'enemy' && foe ? ctl.target(foe.id) : ctl.table();
        if (!played.ok) ctl.cancel();
        states.push(JSON.stringify(ctl.state));
      }
      if (ctl.outcome === null) ctl.endTurn();
      states.push(JSON.stringify(ctl.state));
    }
    return { states, firstTurn, intents: ctl.state.enemies.map((e) => e.intent?.id) };
  }

  for (const level of DIFFICULTIES) {
    it(`replays a fight exactly on ${level}`, () => {
      for (const tier of TIERS) {
        expect(replay(level, 3, tier).states).toEqual(replay(level, 3, tier).states);
      }
    });
  }

  it('every level starts a run and a fight from the same draws', () => {
    const runs = DIFFICULTIES.map((level) => {
      const flow = newFlow();
      flow.newRun(SEED, level);
      return flow.run as RunState;
    });
    for (const run of runs) expect(run.rng).toEqual(runs[0]?.rng);
    for (const tier of TIERS) {
      const fights = DIFFICULTIES.map((level) => replay(level, 3, tier).firstTurn);
      for (const f of fights) expect(f).toEqual(fights[0]);
    }
  });
});
