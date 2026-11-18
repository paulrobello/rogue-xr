import { PERMANENT_CARD_IDS } from '../content/rewards.ts';
import { normalizeSeed, STREAMS, type StreamState } from '../core/rng.ts';
import { isDifficulty } from '../rules/difficulty.ts';
import type { PendingLoot, RewardOffer, RewardTier, RunState } from '../rules/run.ts';
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

function validateRunState(raw: unknown, path: string): RunState {
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
  // Also added after version 1: an older save names no level and resumes as `DEFAULT_DIFFICULTY`.
  if (r.difficulty !== undefined && !isDifficulty(r.difficulty)) {
    fail(`${path}.difficulty`, 'unknown difficulty');
  }
  const difficulty = r.difficulty;
  return {
    seed,
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
  return {
    version: SNAPSHOT_VERSION,
    savedAt: int(r.savedAt, 'snapshot.savedAt', 0),
    run: validateRunState(r.run, 'snapshot.run'),
    phase: r.phase,
    floorSeed: r.floorSeed,
    roomIndex: int(r.roomIndex, 'snapshot.roomIndex', 0),
    clearedEncounters: strings(r.clearedEncounters, 'snapshot.clearedEncounters'),
    pendingReward,
    ...(r.guardianDefeated === undefined ? {} : { guardianDefeated: r.guardianDefeated }),
  };
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
