import { describe, expect, it } from 'vitest';
import {
  CHARGE_CONTENT_VERSION,
  CRYSTAL_GAMBIT_VERSION,
  DUNGEON_CONTENT_VERSION,
  ECHO_GLYPH_VERSION,
  LENS_FOCUS_VERSION,
  MECHANISM_CONTENT_VERSION,
  OVERDRIVE_CONTENT_VERSION,
  WAVE_A_COMPLETE_VERSION,
  WAVE_A_REPAIR_VERSION,
  WAVE_B_CHAIN_VERSION,
  WAVE_B_DICE_VERSION,
} from '../src/combat/encounter-choice.ts';
import { STARTER_DECK } from '../src/content/cards.ts';
import {
  CRYSTAL_GAMBIT_IDS,
  DUNGEON_REWARD_IDS,
  ECHO_GLYPH_IDS,
  LEGACY_REWARD_POOL,
  LENS_FOCUS_IDS,
  PERMANENT_CARD_IDS,
  REWARD_POOL,
  WAVE_A_COMPLETE_IDS,
  WAVE_A_REPAIR_IDS,
  WAVE_B_CHAIN_IDS,
  WAVE_B_CHARGE_IDS,
  WAVE_B_DICE_IDS,
  WAVE_B_MECHANISM_IDS,
  WAVE_B_OVERDRIVE_IDS,
} from '../src/content/rewards.ts';
import { RunFlow } from '../src/flow/flow.ts';
import { rewardOffer } from '../src/rules/run.ts';
import { createWorkshop } from '../src/rules/workshop.ts';

const options = {
  workshop: createWorkshop(),
  starterDeck: STARTER_DECK,
  rewardPool: REWARD_POOL,
};
const beforeLensFocus = REWARD_POOL.filter((id) => !LENS_FOCUS_IDS.has(id));
const beforeEcho = beforeLensFocus.filter((id) => !ECHO_GLYPH_IDS.has(id));
const beforeCrystal = beforeEcho.filter((id) => !CRYSTAL_GAMBIT_IDS.has(id));
const beforeMechanisms = beforeCrystal.filter(
  (id) => !WAVE_B_MECHANISM_IDS.has(id) && !WAVE_B_CHAIN_IDS.has(id),
);
const beforeWaveBDice = beforeMechanisms.filter((id) => !WAVE_B_DICE_IDS.has(id));
const beforeOverdrive = beforeWaveBDice.filter((id) => !WAVE_B_OVERDRIVE_IDS.has(id));
const beforeCharge = beforeOverdrive.filter((id) => !WAVE_B_CHARGE_IDS.has(id));
const beforeComplete = beforeCharge.filter((id) => !WAVE_A_COMPLETE_IDS.has(id));
const beforeRepair = beforeComplete.filter((id) => !WAVE_A_REPAIR_IDS.has(id));
const beforeDungeon = beforeRepair.filter((id) => !DUNGEON_REWARD_IDS.has(id));
const beforeChain = beforeDungeon;
const beforeChainWithMechanisms = beforeCrystal.filter((id) => !WAVE_B_CHAIN_IDS.has(id));

describe('Combat card availability by content version', () => {
  it('adds all three cards to the new reward pool and Workshop', () => {
    expect(beforeComplete.slice(-3)).toEqual(['spare-parts', 'flywheel-swing', 'patch-kit']);
    for (const id of WAVE_A_REPAIR_IDS) expect(PERMANENT_CARD_IDS).toContain(id);
  });

  it('adds the final Wave A cards to combat rewards and the Workshop', () => {
    expect(beforeCharge.slice(-3)).toEqual(['grease-gun', 'escapement-break', 'lucky-strike']);
    for (const id of WAVE_A_COMPLETE_IDS) expect(PERMANENT_CARD_IDS).toContain(id);
  });

  it('adds both Charge cards to rewards and the Workshop', () => {
    expect(beforeOverdrive.slice(-2)).toEqual(['capacitor', 'copper-coil']);
    for (const id of WAVE_B_CHARGE_IDS) expect(PERMANENT_CARD_IDS).toContain(id);
  });

  it('adds both Overdrive cards to rewards and the Workshop', () => {
    expect(REWARD_POOL.filter((id) => WAVE_B_OVERDRIVE_IDS.has(id))).toEqual([
      'flash-boiler',
      'overdrive-piston',
    ]);
    for (const id of WAVE_B_OVERDRIVE_IDS) expect(PERMANENT_CARD_IDS).toContain(id);
  });

  it('adds Lens Focus to rewards and the Workshop', () => {
    expect(REWARD_POOL).toContain('lens-focus');
    expect(PERMANENT_CARD_IDS).toContain('lens-focus');
  });

  it.each([
    [1, LEGACY_REWARD_POOL],
    [2, beforeChain],
    [DUNGEON_CONTENT_VERSION - 1, beforeChain],
    [DUNGEON_CONTENT_VERSION, beforeRepair],
    [WAVE_A_REPAIR_VERSION - 1, beforeRepair],
    [WAVE_A_REPAIR_VERSION, beforeComplete],
    [WAVE_A_COMPLETE_VERSION - 1, beforeComplete],
    [WAVE_A_COMPLETE_VERSION, beforeCharge],
    [CHARGE_CONTENT_VERSION - 1, beforeCharge],
    [CHARGE_CONTENT_VERSION, beforeOverdrive],
    [OVERDRIVE_CONTENT_VERSION - 1, beforeOverdrive],
    [OVERDRIVE_CONTENT_VERSION, beforeWaveBDice],
    [WAVE_B_DICE_VERSION, beforeMechanisms],
    [MECHANISM_CONTENT_VERSION - 1, beforeMechanisms],
    [MECHANISM_CONTENT_VERSION, beforeChainWithMechanisms],
    [WAVE_B_CHAIN_VERSION, beforeCrystal],
    [CRYSTAL_GAMBIT_VERSION, beforeEcho],
    [ECHO_GLYPH_VERSION - 1, beforeEcho],
    [ECHO_GLYPH_VERSION, beforeLensFocus],
    [LENS_FOCUS_VERSION - 1, beforeLensFocus],
    [LENS_FOCUS_VERSION, REWARD_POOL],
  ])('replays the exact combat reward order for content version %i', (version, eligible) => {
    for (let i = 0; i < 24; i++) {
      const fresh = new RunFlow(options);
      fresh.newRun(`REPA1R${String(i).padStart(2, '0')}`);
      const snapshot = fresh.snapshot(1, 0);
      if (!snapshot) throw Error('Missing snapshot');
      const run = new RunFlow(options);
      expect(run.continueRun({ ...snapshot, contentVersion: version })).toBe(true);
      expect(run.fightStarted(1)).toBe(true);
      const expected = rewardOffer(snapshot.run, 'regular', eligible).offer;
      expect(
        run.fightEnded({ room: 1, outcome: 'win', tier: 'regular', playerHp: snapshot.run.hp }),
      ).toBe(true);
      expect(run.offer).toEqual(expected);
    }
  });
});
