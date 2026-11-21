import { ENCOUNTER_CONTENT_VERSION } from '../combat/encounter-choice.ts';
import { PERMANENT_CARD_IDS } from '../content/rewards.ts';
import { normalizeSeed, STREAMS, type StreamState } from '../core/rng.ts';
import {
  alchemyRecipe,
  conservatoryFormula,
  type Ingredient,
  type StoredAlchemyState,
  type StoredConservatoryFormula,
} from '../rules/alchemy.ts';
import {
  BELL_PHRASE_LENGTH,
  type BellNote,
  bellMelody,
  type StoredBellChimesState,
} from '../rules/bell-chimes.ts';
import {
  calibrated,
  calibrationPlan,
  type GearId,
  type StoredCalibrationState,
} from '../rules/calibration.ts';
import {
  COMMISSION_PAYOUT,
  commissionPlan,
  type StoredCommissionState,
} from '../rules/commissions.ts';
import { counterweightTarget, type StoredCounterweightState } from '../rules/counterweight.ts';
import { isDifficulty } from '../rules/difficulty.ts';
import { type DispatchRoute, dispatchDestination } from '../rules/dispatch.ts';
import {
  isPressureNoteId,
  type PressureDials,
  pressureTarget,
  type StoredPressureState,
} from '../rules/pressure.ts';
import type { StoredPrismState } from '../rules/prism-signal.ts';
import type { PendingLoot, RewardOffer, RewardTier, RunState } from '../rules/run.ts';
import { floorSeedFor } from '../rules/run.ts';
import type { BrassKeyState, StoredDispatchState, StoredHiddenPanelState } from '../rules/types.ts';
import {
  createWorkshop,
  maxTier,
  UPGRADE_IDS,
  WORKSHOP_VERSION,
  type WorkshopState,
} from '../rules/workshop.ts';
import {
  getRun,
  getWorkshop,
  loadSettings,
  type PersistDb,
  putRun,
  putWorkshop,
  type Settings,
  saveSettings,
} from './db.ts';

/** Bump when `RunSnapshot` changes shape. */
export const SNAPSHOT_VERSION = 1;
/** Bump when the export envelope changes shape. */
export const EXPORT_SCHEMA_VERSION = 1;
export const EXPORT_FORMAT = 'rogue-xr-save';

/** A stored or imported save failed validation. Thrown by every `validate*`, `load*` and `importSave`. */
export class SaveError extends Error {
  override readonly name = 'SaveError';
}

/** Phases a run can be resumed in. Combat is not resumable: snapshot at explore or reward boundaries. */
export type SnapshotPhase = 'explore' | 'reward' | 'guardian-cleared';

/** Where the player stands in the floor. The floor itself regenerates from `floorSeed`. */
export interface SnapshotWorld {
  readonly phase: SnapshotPhase;
  /** Seed the floor generator was given; the same seed rebuilds the same room graph. */
  readonly floorSeed: string;
  /** Index of the current room in the generated floor. */
  readonly roomIndex: number;
  /** Ids of encounters already won, so they do not respawn on resume. */
  readonly clearedEncounters: readonly string[];
  /** The reward on screen when `phase` is `'reward'`, otherwise null. */
  readonly pendingReward: RewardOffer | null;
  /** True after the guardian has fallen, including while its reward is being claimed. */
  readonly guardianDefeated?: boolean;
  /** Encounter/reward content generation used to build this floor. Absent means the original pool. */
  readonly contentVersion?: number;
  readonly floorNumber?: number;
  readonly reachedRooms?: readonly number[];
  /** Visited floors other than the active one. */
  readonly floors?: readonly FloorSnapshot[];
}

export interface FloorSnapshot {
  readonly floorNumber: number;
  readonly floorSeed: string;
  readonly clearedEncounters: readonly string[];
  readonly reachedRooms: readonly number[];
  readonly guardianDefeated?: boolean;
  readonly openedLoot?: readonly string[];
  readonly pendingLoot?: readonly PendingLoot[];
  readonly usedHearths?: readonly string[];
  readonly pressure?: StoredPressureState;
  readonly dispatch?: StoredDispatchState;
  readonly bookSecretOpenedRooms?: readonly number[];
  readonly bookSecretKeyRooms?: readonly number[];
  readonly bookSecretCabinetRooms?: readonly number[];
  readonly prismSignal?: StoredPrismState;
}

export interface RunSnapshot extends SnapshotWorld {
  readonly version: number;
  /** Epoch milliseconds. */
  readonly savedAt: number;
  /** The full run state, including all five RNG stream states. */
  readonly run: RunState;
}

/** The JSON document written by `exportSave`. `run` is null when no run is in progress. */
export interface SaveExport {
  readonly format: typeof EXPORT_FORMAT;
  readonly schemaVersion: number;
  readonly exportedAt: number;
  readonly workshop: WorkshopState;
  readonly run: RunSnapshot | null;
  readonly settings: Settings;
}

type Rec = Record<string, unknown>;

const isRecord = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);

function fail(path: string, why: string): never {
  throw new SaveError(`${path}: ${why}`);
}

function int(v: unknown, path: string, min: number, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
    fail(path, `expected an integer in [${min}, ${max}]`);
  }
  return v;
}

function rec(v: unknown, path: string): Rec {
  if (!isRecord(v)) fail(path, 'expected an object');
  return v;
}

function strings(v: unknown, path: string): string[] {
  if (!Array.isArray(v) || v.some((s) => typeof s !== 'string')) {
    fail(path, 'expected an array of strings');
  }
  return [...v] as string[];
}

function bellChimes(v: unknown, path: string, seed: string): StoredBellChimesState {
  const r = rec(v, path);
  if (typeof r.clueHeard !== 'boolean') fail(`${path}.clueHeard`, 'expected a boolean');
  if (typeof r.solved !== 'boolean') fail(`${path}.solved`, 'expected a boolean');
  if (typeof r.rewardClaimed !== 'boolean') fail(`${path}.rewardClaimed`, 'expected a boolean');
  if (
    !Array.isArray(r.progress) ||
    r.progress.length > BELL_PHRASE_LENGTH ||
    r.progress.some((n) => ![0, 1, 2].includes(n as number))
  ) {
    fail(`${path}.progress`, 'expected up to four bell notes');
  }
  if (!r.clueHeard && (r.progress.length > 0 || r.solved || r.rewardClaimed))
    fail(path, 'cannot progress before hearing the clue');
  if (!r.solved && r.rewardClaimed) fail(`${path}.rewardClaimed`, 'cannot claim before solving');
  if (r.solved !== (r.progress.length === BELL_PHRASE_LENGTH))
    fail(`${path}.progress`, 'a complete phrase must be solved');
  const melody = bellMelody(seed);
  if (r.progress.some((note, i) => note !== melody[i]))
    fail(`${path}.progress`, 'does not match the seeded melody prefix');
  return {
    clueHeard: r.clueHeard,
    progress: [...r.progress] as BellNote[],
    solved: r.solved,
    rewardClaimed: r.rewardClaimed,
  };
}

function pendingLoot(v: unknown, path: string): PendingLoot[] {
  if (!Array.isArray(v)) fail(path, 'expected an array');
  return v.map((entry, i) => {
    const r = rec(entry, `${path}[${i}]`);
    if (typeof r.key !== 'string' || typeof r.card !== 'string') {
      fail(`${path}[${i}]`, 'expected { key, card } strings');
    }
    return { key: r.key, card: r.card };
  });
}

function pressure(v: unknown, path: string, seed: string, version: number): StoredPressureState {
  const r = rec(v, path);
  if (!Array.isArray(r.dials) || r.dials.length !== 3)
    fail(`${path}.dials`, 'expected three dial values');
  const dials = r.dials.map((dial, i) =>
    int(dial, `${path}.dials[${i}]`, 1, 3),
  ) as unknown as PressureDials;
  if (typeof r.solved !== 'boolean') fail(`${path}.solved`, 'expected a boolean');
  const target = pressureTarget(seed, version);
  if (r.solved && !dials.every((d, i) => d === target[i]))
    fail(`${path}.solved`, 'does not match the seeded target');
  const notes = r.notes === undefined ? [] : r.notes;
  if (!Array.isArray(notes) || notes.some((note) => !isPressureNoteId(note))) {
    fail(`${path}.notes`, 'expected unique pressure note ids');
  }
  if (new Set(notes).size !== notes.length) fail(`${path}.notes`, 'contains a duplicate note');
  const rewardClaimed = r.rewardClaimed === undefined ? r.solved === true : r.rewardClaimed;
  if (typeof rewardClaimed !== 'boolean') fail(`${path}.rewardClaimed`, 'expected a boolean');
  if (!r.solved && rewardClaimed) fail(`${path}.rewardClaimed`, 'cannot be claimed before solving');
  const drawerOpen = r.drawerOpen === undefined ? r.solved === true : r.drawerOpen;
  if (typeof drawerOpen !== 'boolean') fail(`${path}.drawerOpen`, 'expected a boolean');
  if (!r.solved && drawerOpen) fail(`${path}.drawerOpen`, 'cannot open before solving');
  if (!drawerOpen && rewardClaimed)
    fail(`${path}.rewardClaimed`, 'cannot be claimed before opening drawer');
  return { dials, solved: r.solved, notes: [...notes], drawerOpen, rewardClaimed };
}

function dispatch(v: unknown, path: string, seed: string): StoredDispatchState {
  const value = rec(v, path);
  const route = int(value.route, `${path}.route`, 0, 2) as DispatchRoute;
  if (typeof value.sent !== 'boolean') fail(`${path}.sent`, 'expected a boolean');
  if (typeof value.opened !== 'boolean') fail(`${path}.opened`, 'expected a boolean');
  if (value.sent && route !== dispatchDestination(seed))
    fail(`${path}.route`, 'wrong dispatch route');
  if (value.opened && !value.sent) fail(`${path}.opened`, 'cannot open before sending');
  return { route, sent: value.sent, opened: value.opened };
}

function counterweight(v: unknown, path: string, seed: string): StoredCounterweightState {
  const r = rec(v, path);
  if (r.selected !== undefined && r.selected !== 0 && r.selected !== 1)
    fail(`${path}.selected`, 'expected 0 or 1');
  if (typeof r.solved !== 'boolean') fail(`${path}.solved`, 'expected a boolean');
  if (r.solved && r.selected !== counterweightTarget(seed))
    fail(path, 'wrong weight for completed counterweight');
  return {
    solved: r.solved,
    ...(r.selected === undefined ? {} : { selected: r.selected as 0 | 1 }),
  };
}

function alchemy(v: unknown, path: string, seed: string): StoredAlchemyState {
  const r = rec(v, path);
  const list = (value: unknown, name: string): Ingredient[] => {
    if (
      !Array.isArray(value) ||
      value.some((n) => ![0, 1, 2].includes(n as number)) ||
      new Set(value).size !== value.length
    )
      fail(`${path}.${name}`, 'expected unique ingredient ids');
    return [...value] as Ingredient[];
  };
  const found = list(r.found, 'found');
  const added = list(r.added, 'added');
  const recipe = alchemyRecipe(seed);
  if (added.some((id, i) => id !== recipe[i])) fail(path, 'mixture does not match its recipe');
  if (added.some((n) => !found.includes(n))) fail(`${path}.added`, 'ingredient was not found');
  if (added.length > 2 || typeof r.brewed !== 'boolean' || typeof r.opened !== 'boolean')
    fail(path, 'invalid brew state');
  if (r.brewed !== (added.length === 2)) fail(`${path}.brewed`, 'must match two added ingredients');
  if (r.opened && !r.brewed) fail(`${path}.opened`, 'cannot open before brewing');
  return { found, added, brewed: r.brewed, opened: r.opened };
}

function formula(v: unknown, path: string, seed: string): StoredConservatoryFormula {
  const r = rec(v, path);
  const plan = conservatoryFormula(seed);
  if (r.recipe !== plan.recipe) fail(`${path}.recipe`, 'does not match seeded recipe');
  if (!Array.isArray(r.clues) || r.clues.some((c) => c !== 'portrait' && c !== 'record'))
    fail(`${path}.clues`, 'invalid clues');
  if (
    !Array.isArray(r.added) ||
    r.added.some((n) => ![0, 1, 2].includes(n as number)) ||
    r.added.some((n, i) => n !== plan.ingredients[i])
  )
    fail(`${path}.added`, 'invalid seeded order');
  if (
    typeof r.brewed !== 'boolean' ||
    r.brewed !== (r.added.length === 2) ||
    typeof r.revealed !== 'boolean' ||
    typeof r.opened !== 'boolean'
  )
    fail(path, 'invalid formula state');
  if (
    new Set(r.clues).size !== r.clues.length ||
    (r.added.length && r.clues.length !== 2) ||
    (r.revealed && !r.brewed) ||
    (r.revealed && r.recipe !== 'lantern-ink' && !r.opened)
  )
    fail(path, 'inconsistent archive progression');
  if (r.opened && !r.revealed) fail(`${path}.opened`, 'cannot open before reveal');
  return {
    recipe: plan.recipe,
    clues: [...r.clues],
    added: [...r.added] as Ingredient[],
    brewed: r.brewed,
    revealed: r.revealed,
    opened: r.opened,
  };
}

function commission(v: unknown, path: string, seed: string): StoredCommissionState {
  const r = rec(v, path);
  const kind = commissionPlan(seed);
  if (
    r.kind !== kind ||
    typeof r.accepted !== 'boolean' ||
    typeof r.claimed !== 'boolean' ||
    typeof r.payout !== 'number' ||
    r.payout !== COMMISSION_PAYOUT[kind]
  )
    fail(path, 'invalid seeded commission');
  if (
    !Array.isArray(r.recovered) ||
    r.recovered.some((n) => ![0, 1, 2].includes(n as number)) ||
    new Set(r.recovered).size !== r.recovered.length
  )
    fail(`${path}.recovered`, 'invalid spring ids');
  if (
    (kind !== 'recovery' && r.recovered.length !== 0) ||
    (r.claimed && (!r.accepted || (kind === 'recovery' && r.recovered.length !== 3)))
  )
    fail(path, 'commission payment or recovery is inconsistent');
  return {
    kind,
    accepted: r.accepted,
    claimed: r.claimed,
    recovered: [...r.recovered] as (0 | 1 | 2)[],
    payout: r.payout,
  };
}

function validateCalibration(value: unknown, path: string, seed: string): StoredCalibrationState {
  const r = rec(value, path),
    plan = calibrationPlan(seed);
  if (
    r.kind !== plan.kind ||
    typeof r.chart !== 'boolean' ||
    typeof r.solved !== 'boolean' ||
    typeof r.claimed !== 'boolean'
  )
    fail(path, 'invalid calibration state');
  const gear = (v: unknown): v is GearId | null => v === null || v === 0 || v === 1 || v === 2;
  if (!gear(r.selected) || !Array.isArray(r.slots) || r.slots.length !== 3 || !r.slots.every(gear))
    fail(path, 'invalid gear layout');
  const occupied = r.slots.filter((id) => id !== null);
  if (new Set(occupied).size !== occupied.length) fail(path, 'gear installed twice');
  if (
    !Array.isArray(r.detents) ||
    r.detents.length !== 3 ||
    r.detents.some((d) => !Number.isInteger(d) || d < 0 || d > 3)
  )
    fail(path, 'invalid ring detents');
  if (
    (r.spare !== undefined && typeof r.spare !== 'boolean') ||
    (r.repaired !== undefined && typeof r.repaired !== 'boolean')
  ) {
    fail(path, 'invalid drive repair');
  }
  const key =
    r.key === undefined
      ? plan.kind !== 'orrery' || !r.chart
        ? 'missing'
        : r.solved
          ? 'inserted'
          : 'held'
      : r.key;
  if (key !== 'missing' && key !== 'held' && key !== 'inserted')
    fail(path, 'invalid winding key state');
  // Completed orreries from before the coupling step already released their cabinet.
  const priorRepair =
    plan.kind === 'orrery' && r.solved && r.spare === undefined && r.repaired === undefined;
  const state: StoredCalibrationState = {
    kind: plan.kind,
    chart: r.chart,
    key,
    spare: r.spare ?? priorRepair,
    repaired: r.repaired ?? priorRepair,
    selected: r.selected,
    slots: [...r.slots],
    detents: [...r.detents],
    solved: r.solved,
    claimed: r.claimed,
  };
  if (
    (state.claimed && !state.solved) ||
    (state.solved && (!state.chart || !calibrated(state, plan))) ||
    (state.kind === 'orrery' && (occupied.length || state.selected !== null)) ||
    (state.repaired && (!state.spare || !state.chart)) ||
    (state.kind === 'gears' &&
      (state.key !== 'missing' ||
        state.spare ||
        state.repaired ||
        state.detents.some((d) => d !== 0)))
  )
    fail(path, 'inconsistent calibration progress');
  return state;
}
function streamState(v: unknown, path: string): StreamState {
  if (!Array.isArray(v) || v.length !== 4) fail(path, 'expected four 32-bit words');
  // sfc32 words can be negative: `a = b ^ (b >>> 9)` leaves a signed int32 in the state.
  const words = v.map((w, i) => int(w, `${path}[${i}]`, -0x8000_0000, 0xffff_ffff));
  return [words[0], words[1], words[2], words[3]] as unknown as StreamState;
}

/** Strict structural check of a stored `WorkshopState`. Throws `SaveError`; never repairs. */
export function validateWorkshop(raw: unknown): WorkshopState {
  const r = rec(raw, 'workshop');
  if (r.version !== WORKSHOP_VERSION) fail('workshop.version', `expected ${WORKSHOP_VERSION}`);
  const bought = rec(r.purchased, 'workshop.purchased');
  for (const key of Object.keys(bought)) {
    if (!(UPGRADE_IDS as readonly string[]).includes(key)) {
      fail(`workshop.purchased.${key}`, 'unknown upgrade');
    }
  }
  const purchased = Object.fromEntries(
    UPGRADE_IDS.map((id) => [
      id,
      bought[id] === undefined ? 0 : int(bought[id], `workshop.purchased.${id}`, 0, maxTier(id)),
    ]),
  ) as WorkshopState['purchased'];
  const permanentCards =
    r.permanentCards === undefined ? [] : strings(r.permanentCards, 'workshop.permanentCards');
  for (const [i, id] of permanentCards.entries()) {
    if (!(PERMANENT_CARD_IDS as readonly string[]).includes(id)) {
      fail(`workshop.permanentCards[${i}]`, 'unknown or unavailable card');
    }
  }
  return {
    version: WORKSHOP_VERSION,
    cogsBanked: int(r.cogsBanked, 'workshop.cogsBanked', 0),
    purchased,
    permanentCards,
  };
}

function roomIds(value: unknown, path: string): number[] | undefined {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.some((id) => !Number.isInteger(id) || id < 0) ||
    new Set(value).size !== value.length
  )
    fail(path, 'expected unique non-negative room integers');
  return [...value];
}

function validateRunState(
  raw: unknown,
  path: string,
  version: number,
  pressureSeed?: string,
): RunState {
  const r = rec(raw, path);
  let seed: string;
  try {
    seed = normalizeSeed(String(r.seed));
  } catch {
    return fail(`${path}.seed`, 'not a valid run seed');
  }
  const rngRaw = rec(r.rng, `${path}.rng`);
  const rng = Object.fromEntries(
    STREAMS.map((name) => [name, streamState(rngRaw[name], `${path}.rng.${name}`)]),
  ) as unknown as RunState['rng'];
  const maxHp = int(r.maxHp, `${path}.maxHp`, 1);
  const bonusDice =
    r.bonusDice === undefined ? undefined : int(r.bonusDice, `${path}.bonusDice`, 0);
  const rewardChoices =
    r.rewardChoices === undefined ? undefined : int(r.rewardChoices, `${path}.rewardChoices`, 1);
  // Added after version 1 shipped: absent in older saves, which then simply have nothing opened or used.
  const openedLoot = r.openedLoot === undefined ? [] : strings(r.openedLoot, `${path}.openedLoot`);
  const usedHearths =
    r.usedHearths === undefined ? [] : strings(r.usedHearths, `${path}.usedHearths`);
  // Added later still: a save from before claimable chest cards has no card waiting.
  const pending =
    r.pendingLoot === undefined ? [] : pendingLoot(r.pendingLoot, `${path}.pendingLoot`);
  const activeFloorSeed = pressureSeed ?? seed;
  if (r.floorSeed !== undefined && r.floorSeed !== activeFloorSeed)
    fail(`${path}.floorSeed`, 'does not match active floor');
  const pressureState =
    r.pressure === undefined
      ? undefined
      : pressure(r.pressure, `${path}.pressure`, activeFloorSeed, version);
  const dispatchState =
    r.dispatch === undefined ? undefined : dispatch(r.dispatch, `${path}.dispatch`, seed);
  const counterweightState =
    r.counterweight === undefined
      ? undefined
      : counterweight(r.counterweight, `${path}.counterweight`, seed);
  const alchemyState =
    r.alchemy === undefined ? undefined : alchemy(r.alchemy, `${path}.alchemy`, seed);
  const formulaState =
    r.conservatoryFormula === undefined
      ? undefined
      : formula(r.conservatoryFormula, `${path}.conservatoryFormula`, seed);
  const commissionState =
    r.commission === undefined ? undefined : commission(r.commission, `${path}.commission`, seed);
  const hiddenPanelState =
    r.hiddenPanel === undefined
      ? undefined
      : (() => {
          const h = rec(r.hiddenPanel, `${path}.hiddenPanel`);
          if (
            typeof h.discovered !== 'boolean' ||
            typeof h.opened !== 'boolean' ||
            (h.opened && !h.discovered)
          )
            fail(`${path}.hiddenPanel`, 'invalid panel progression');
          return { discovered: h.discovered, opened: h.opened } as StoredHiddenPanelState;
        })();
  if (
    formulaState &&
    (formulaState.added.length || formulaState.brewed) &&
    (!alchemyState?.opened || formulaState.added.some((id) => !alchemyState.found.includes(id)))
  )
    fail(path, 'archive brew requires an open thorn ward and recovered ingredients');
  const calibrationState =
    r.calibration === undefined
      ? undefined
      : validateCalibration(r.calibration, path + '.calibration', seed);
  const bellChimesState =
    r.bellChimes === undefined ? undefined : bellChimes(r.bellChimes, `${path}.bellChimes`, seed);
  const bookSecretOpenedRooms = roomIds(r.bookSecretOpenedRooms, `${path}.bookSecretOpenedRooms`);
  const bookSecretKeyRooms = roomIds(r.bookSecretKeyRooms, `${path}.bookSecretKeyRooms`);
  const bookSecretCabinetRooms = roomIds(
    r.bookSecretCabinetRooms,
    `${path}.bookSecretCabinetRooms`,
  );
  if (r.patrolDefeated !== undefined && r.patrolDefeated !== true)
    fail(`${path}.patrolDefeated`, 'expected true or absent');
  if (r.brassCacheSeen !== undefined && typeof r.brassCacheSeen !== 'boolean')
    fail(`${path}.brassCacheSeen`, 'expected a boolean');
  if (r.windowCacheOpened !== undefined && typeof r.windowCacheOpened !== 'boolean')
    fail(`${path}.windowCacheOpened`, 'expected a boolean');
  const brassKey =
    r.brassKey === undefined
      ? undefined
      : r.brassKey === 'missing' || r.brassKey === 'held' || r.brassKey === 'spent'
        ? (r.brassKey as BrassKeyState)
        : fail(`${path}.brassKey`, 'unknown key state');
  const prismSignal =
    r.prismSignal === undefined
      ? undefined
      : (() => {
          const p = rec(r.prismSignal, `${path}.prismSignal`);
          const orientation = int(p.orientation, `${path}.prismSignal.orientation`, 0, 2);
          const progress = int(p.progress, `${path}.prismSignal.progress`, 0, 3);
          return { orientation: orientation as 0 | 1 | 2, progress: progress as 0 | 1 | 2 | 3 };
        })();
  // Also added after version 1: an older save names no level and resumes as `DEFAULT_DIFFICULTY`.
  if (r.difficulty !== undefined && !isDifficulty(r.difficulty)) {
    fail(`${path}.difficulty`, 'unknown difficulty');
  }
  const difficulty = r.difficulty;
  return {
    seed,
    ...(r.floorSeed === undefined ? {} : { floorSeed: activeFloorSeed }),
    rng,
    deck: strings(r.deck, `${path}.deck`),
    cogs: int(r.cogs, `${path}.cogs`, 0),
    hp: int(r.hp, `${path}.hp`, 0, maxHp),
    maxHp,
    ...(bonusDice === undefined ? {} : { bonusDice }),
    ...(rewardChoices === undefined ? {} : { rewardChoices }),
    ...(openedLoot.length === 0 ? {} : { openedLoot }),
    ...(usedHearths.length === 0 ? {} : { usedHearths }),
    ...(pending.length === 0 ? {} : { pendingLoot: pending }),
    ...(difficulty === undefined ? {} : { difficulty }),
    ...(pressureState === undefined ? {} : { pressure: pressureState }),
    ...(dispatchState === undefined ? {} : { dispatch: dispatchState }),
    ...(counterweightState === undefined ? {} : { counterweight: counterweightState }),
    ...(alchemyState === undefined ? {} : { alchemy: alchemyState }),
    ...(formulaState === undefined ? {} : { conservatoryFormula: formulaState }),
    ...(commissionState === undefined ? {} : { commission: commissionState }),
    ...(hiddenPanelState === undefined ? {} : { hiddenPanel: hiddenPanelState }),
    ...(bellChimesState === undefined ? {} : { bellChimes: bellChimesState }),
    ...(calibrationState && { calibration: calibrationState }),
    ...(bookSecretOpenedRooms === undefined ? {} : { bookSecretOpenedRooms }),
    ...(bookSecretKeyRooms === undefined ? {} : { bookSecretKeyRooms }),
    ...(bookSecretCabinetRooms === undefined ? {} : { bookSecretCabinetRooms }),
    ...(brassKey === undefined ? {} : { brassKey }),
    ...(r.patrolDefeated === true && { patrolDefeated: true }),
    ...(r.brassCacheSeen === true && { brassCacheSeen: true }),
    ...(r.windowCacheOpened === true && { windowCacheOpened: true }),
    ...(prismSignal === undefined ? {} : { prismSignal }),
  };
}

const TIERS: readonly string[] = ['regular', 'elite', 'guardian'] satisfies RewardTier[];

function validateReward(raw: unknown, path: string): RewardOffer {
  const r = rec(raw, path);
  if (typeof r.tier !== 'string' || !TIERS.includes(r.tier)) fail(`${path}.tier`, 'unknown tier');
  return {
    tier: r.tier as RewardTier,
    cards: strings(r.cards, `${path}.cards`),
    cogs: int(r.cogs, `${path}.cogs`, 0),
  };
}

/** Strict structural check of a stored or imported `RunSnapshot`. Throws `SaveError`; never repairs. */
export function validateSnapshot(raw: unknown): RunSnapshot {
  const r = rec(raw, 'snapshot');
  if (r.version !== SNAPSHOT_VERSION) fail('snapshot.version', `expected ${SNAPSHOT_VERSION}`);
  if (r.phase !== 'explore' && r.phase !== 'reward' && r.phase !== 'guardian-cleared') {
    fail('snapshot.phase', 'unknown phase');
  }
  if (typeof r.floorSeed !== 'string' || r.floorSeed === '') {
    fail('snapshot.floorSeed', 'expected a non-empty string');
  }
  const version = int(r.contentVersion ?? 1, 'snapshot.contentVersion', 1);
  const floorNumber =
    r.floorNumber === undefined
      ? 1
      : int(r.floorNumber, 'snapshot.floorNumber', 1, version >= 5 ? 3 : 2);
  const activeRun = validateRunState(
    r.run,
    'snapshot.run',
    version,
    r.floorNumber === undefined ? undefined : r.floorSeed,
  );
  const expectedSeed = floorSeedFor(activeRun.seed, floorNumber);
  if (r.floorNumber !== undefined && r.floorSeed !== expectedSeed)
    fail('snapshot.floorSeed', 'does not match this floor');
  const pendingReward =
    r.pendingReward === null || r.pendingReward === undefined
      ? null
      : validateReward(r.pendingReward, 'snapshot.pendingReward');
  if ((r.phase === 'reward') !== (pendingReward !== null)) {
    fail('snapshot.pendingReward', 'must be present exactly when phase is reward');
  }
  if (r.guardianDefeated !== undefined && typeof r.guardianDefeated !== 'boolean') {
    fail('snapshot.guardianDefeated', 'expected a boolean');
  }
  if (
    r.contentVersion !== undefined &&
    (typeof r.contentVersion !== 'number' ||
      !Number.isInteger(r.contentVersion) ||
      r.contentVersion < 1)
  ) {
    fail('snapshot.contentVersion', 'expected a positive integer');
  }
  const floors =
    r.floors === undefined
      ? undefined
      : validateFloors(r.floors, activeRun.seed, floorNumber, version);
  const payment = activeRun.commission;
  if (payment?.claimed) {
    const powered =
      floorNumber === 1
        ? activeRun.pressure?.solved
        : floors?.find((f) => f.floorNumber === 1)?.pressure?.solved;
    if (
      (payment.kind === 'restoration' && !powered) ||
      (payment.kind === 'delve' && !activeRun.conservatoryFormula?.opened)
    )
      fail('snapshot.run.commission.claimed', 'payment has no completed work order');
  }
  if (activeRun.calibration?.chart || activeRun.calibration?.spare) {
    const repaired =
      floorNumber === 1
        ? activeRun.pressure?.solved
        : floors?.find((f) => f.floorNumber === 1)?.pressure?.solved;
    if (!repaired) fail('snapshot.run.calibration', 'the cabinet is behind the pressure lock');
    if (
      activeRun.calibration.claimed &&
      !activeRun.deck.includes(calibrationPlan(activeRun.seed).rewardCard)
    )
      fail('snapshot.run.calibration.claimed', 'collected card is missing from the deck');
  }
  return {
    version: SNAPSHOT_VERSION,
    savedAt: int(r.savedAt, 'snapshot.savedAt', 0),
    run: activeRun,
    phase: r.phase,
    floorSeed: r.floorSeed,
    roomIndex: int(r.roomIndex, 'snapshot.roomIndex', 0),
    clearedEncounters: strings(r.clearedEncounters, 'snapshot.clearedEncounters'),
    pendingReward,
    ...(r.guardianDefeated === undefined ? {} : { guardianDefeated: r.guardianDefeated }),
    ...(r.contentVersion === undefined ? {} : { contentVersion: r.contentVersion }),
    ...(r.floorNumber === undefined ? {} : { floorNumber }),
    ...(r.reachedRooms === undefined
      ? {}
      : { reachedRooms: roomIds(r.reachedRooms, 'snapshot.reachedRooms') }),
    ...(floors === undefined ? {} : { floors }),
  };
}

function validateFloors(
  raw: unknown,
  runSeed: string,
  active: number,
  version: number,
): FloorSnapshot[] {
  if (!Array.isArray(raw)) fail('snapshot.floors', 'expected an array');
  const seen = new Set<number>([active]);
  return raw.map((value, i) => {
    const path = `snapshot.floors[${i}]`;
    const r = rec(value, path);
    const floorNumber = int(r.floorNumber, `${path}.floorNumber`, 1, version >= 5 ? 3 : 2);
    if (seen.has(floorNumber)) fail(`${path}.floorNumber`, 'duplicate floor');
    seen.add(floorNumber);
    const floorSeed =
      typeof r.floorSeed === 'string'
        ? normalizeSeed(r.floorSeed)
        : fail(`${path}.floorSeed`, 'expected a seed');
    if (floorSeed !== floorSeedFor(runSeed, floorNumber))
      fail(`${path}.floorSeed`, 'does not match run seed');
    if (r.guardianDefeated !== undefined && typeof r.guardianDefeated !== 'boolean')
      fail(`${path}.guardianDefeated`, 'expected a boolean');
    const result: FloorSnapshot = {
      floorNumber,
      floorSeed,
      clearedEncounters: strings(r.clearedEncounters, `${path}.clearedEncounters`),
      reachedRooms: roomIds(r.reachedRooms, `${path}.reachedRooms`) ?? [],
      ...(r.guardianDefeated === undefined ? {} : { guardianDefeated: r.guardianDefeated }),
      ...(r.openedLoot === undefined
        ? {}
        : { openedLoot: strings(r.openedLoot, `${path}.openedLoot`) }),
      ...(r.pendingLoot === undefined
        ? {}
        : { pendingLoot: pendingLoot(r.pendingLoot, `${path}.pendingLoot`) }),
      ...(r.usedHearths === undefined
        ? {}
        : { usedHearths: strings(r.usedHearths, `${path}.usedHearths`) }),
      ...(r.pressure === undefined
        ? {}
        : { pressure: pressure(r.pressure, `${path}.pressure`, floorSeed, version) }),
      ...(r.dispatch === undefined
        ? {}
        : { dispatch: dispatch(r.dispatch, `${path}.dispatch`, runSeed) }),
      ...(r.bookSecretOpenedRooms === undefined
        ? {}
        : {
            bookSecretOpenedRooms: roomIds(
              r.bookSecretOpenedRooms,
              `${path}.bookSecretOpenedRooms`,
            ),
          }),
      ...(r.bookSecretKeyRooms === undefined
        ? {}
        : { bookSecretKeyRooms: roomIds(r.bookSecretKeyRooms, `${path}.bookSecretKeyRooms`) }),
      ...(r.bookSecretCabinetRooms === undefined
        ? {}
        : {
            bookSecretCabinetRooms: roomIds(
              r.bookSecretCabinetRooms,
              `${path}.bookSecretCabinetRooms`,
            ),
          }),
      ...(r.prismSignal === undefined
        ? {}
        : {
            prismSignal: (() => {
              const p = rec(r.prismSignal, `${path}.prismSignal`);
              return {
                orientation: int(p.orientation, `${path}.prismSignal.orientation`, 0, 2) as
                  | 0
                  | 1
                  | 2,
                progress: int(p.progress, `${path}.prismSignal.progress`, 0, 3) as 0 | 1 | 2 | 3,
              };
            })(),
          }),
    };
    return result;
  });
}

/** A detached, JSON-safe copy of the run and its world position, stamped with `now`. */
export function snapshotRun(
  run: RunState,
  world: Omit<SnapshotWorld, 'pendingReward'> & { readonly pendingReward?: RewardOffer | null },
  now: number = Date.now(),
): RunSnapshot {
  return validateSnapshot(
    structuredClone({
      version: SNAPSHOT_VERSION,
      savedAt: now,
      run,
      ...world,
      pendingReward: world.pendingReward ?? null,
      contentVersion: world.contentVersion ?? ENCOUNTER_CONTENT_VERSION,
    }),
  );
}

/** The saved workshop, or a fresh one when nothing is stored. Throws `SaveError` on corrupt data. */
export async function loadWorkshop(handle: PersistDb): Promise<WorkshopState> {
  const raw = await getWorkshop(handle);
  return raw === undefined || raw === null ? createWorkshop() : validateWorkshop(raw);
}

export async function saveWorkshop(handle: PersistDb, ws: WorkshopState): Promise<void> {
  await putWorkshop(handle, validateWorkshop(ws));
}

/** The saved run snapshot, or null when none is stored. Throws `SaveError` on corrupt data. */
export async function loadRunSnapshot(handle: PersistDb): Promise<RunSnapshot | null> {
  const raw = await getRun(handle);
  return raw === undefined || raw === null ? null : validateSnapshot(raw);
}

export async function saveRunSnapshot(handle: PersistDb, snapshot: RunSnapshot): Promise<void> {
  await putRun(handle, validateSnapshot(snapshot));
}

/** Drops the stored snapshot. Call when a run ends, so Continue disappears. */
export async function clearRunSnapshot(handle: PersistDb): Promise<void> {
  await putRun(handle, null);
}

/** Serializes workshop, run snapshot and settings to one versioned JSON document. */
export async function exportSave(handle: PersistDb, now: number = Date.now()): Promise<string> {
  const doc: SaveExport = {
    format: EXPORT_FORMAT,
    schemaVersion: EXPORT_SCHEMA_VERSION,
    exportedAt: now,
    workshop: await loadWorkshop(handle),
    run: await loadRunSnapshot(handle),
    settings: await loadSettings(handle),
  };
  return JSON.stringify(doc, null, 2);
}

/**
 * Replaces the stored workshop, run snapshot and settings with the contents of `json`. The whole
 * document is validated first, so a rejected import (`SaveError`) writes nothing. A document without
 * `settings` leaves the stored settings alone; `run: null` clears any stored snapshot.
 */
export async function importSave(handle: PersistDb, json: string): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return fail('import', 'not valid JSON');
  }
  const doc = rec(parsed, 'import');
  if (doc.format !== EXPORT_FORMAT) fail('import.format', `expected ${EXPORT_FORMAT}`);
  if (doc.schemaVersion !== EXPORT_SCHEMA_VERSION) {
    fail('import.schemaVersion', `expected ${EXPORT_SCHEMA_VERSION}`);
  }
  const workshop = validateWorkshop(doc.workshop);
  const run = doc.run === null || doc.run === undefined ? null : validateSnapshot(doc.run);
  const settings = doc.settings === undefined ? null : rec(doc.settings, 'import.settings');
  await putWorkshop(handle, workshop);
  await putRun(handle, run);
  if (settings) await saveSettings(handle, settings as unknown as Settings);
}
