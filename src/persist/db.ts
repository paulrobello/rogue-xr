import { DEFAULT_TABLE_DISTANCE, TABLE_DISTANCE_CHOICES } from '../combat/placement.ts';
import { DEFAULT_DIFFICULTY, type Difficulty, isDifficulty } from '../rules/difficulty.ts';

export const DB_NAME = 'rogue-xr';

export type TurnMode = 'snap' | 'smooth';

/**
 * Fixed-foveation levels the settings offer, lowest first. The names match the toolkit's
 * `FoveationLevel` (`perf/xr-perf.ts` maps them to three.js values); they are listed here so the
 * settings store needs no toolkit import.
 */
export const FOVEATION_CHOICES = ['off', 'low', 'medium', 'high'] as const;
export type FoveationChoice = (typeof FOVEATION_CHOICES)[number];
/** The Quest 3 guide's level, what every session used before the setting existed. */
export const DEFAULT_FOVEATION: FoveationChoice = 'medium';

export function isFoveationChoice(value: unknown): value is FoveationChoice {
  return (FOVEATION_CHOICES as readonly unknown[]).includes(value);
}

/** The listed table distance within 5 cm of `value` (the nearest), or null when none is. */
function tableDistanceChoice(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const nearest = TABLE_DISTANCE_CHOICES.reduce((a, b) =>
    Math.abs(b - value) < Math.abs(a - value) ? b : a,
  );
  return Math.abs(nearest - value) <= 0.05 ? nearest : null;
}

export interface Settings {
  turnMode: TurnMode;
  snapDegrees: number;
  vignette: boolean;
  vignetteStrength: number;
  eyeHeight: number;
  masterVolume: number;
  musicVolume: number;
  sfxVolume: number;
  teleportEnabled: boolean;
  /** The level the title offers for the next New Run: the last one chosen. */
  difficulty: Difficulty;
  /** Player-to-table-centre distance fights aim for, metres: one of `TABLE_DISTANCE_CHOICES`. */
  tableDistance: number;
  /** Fixed-foveation level applied in XR. */
  foveation: FoveationChoice;
  /** Shows the frame-rate counter. */
  fpsCounter: boolean;
}

export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  turnMode: 'snap',
  snapDegrees: 30,
  vignette: true,
  vignetteStrength: 0.6,
  eyeHeight: 1.6,
  masterVolume: 0.8,
  musicVolume: 0.6,
  sfxVolume: 0.8,
  teleportEnabled: true,
  difficulty: DEFAULT_DIFFICULTY,
  tableDistance: DEFAULT_TABLE_DISTANCE,
  foveation: DEFAULT_FOVEATION,
  fpsCounter: false,
});

export const STORE_SETTINGS = 'settings';
export const STORE_WORKSHOP = 'workshop';
export const STORE_RUN = 'run';
export type StoreName = typeof STORE_SETTINGS | typeof STORE_WORKSHOP | typeof STORE_RUN;

const SINGLETON_KEY = 'current';

export type Migration = (db: IDBDatabase, tx: IDBTransaction, oldVersion: number) => void;

// MIGRATIONS[i] upgrades a database from version i to i + 1. During one upgrade every pending
// step runs in order inside the single versionchange transaction and receives the version the
// database had before the upgrade began (0 for a fresh database).
export const MIGRATIONS: readonly Migration[] = [
  (db) => {
    db.createObjectStore(STORE_SETTINGS);
    db.createObjectStore(STORE_WORKSHOP);
    db.createObjectStore(STORE_RUN);
  },
];

export const DB_VERSION = MIGRATIONS.length;

export interface PersistDb {
  /** The open database, or null when running on the in-memory fallback. */
  readonly idb: IDBDatabase | null;
  /** False when indexedDB is unavailable or failed to open: nothing survives a reload. */
  readonly persistent: boolean;
  /** Why the fallback is active; undefined when persistent. */
  readonly reason?: string;
  readonly memory: Map<StoreName, unknown>;
}

export interface OpenDbOptions {
  name?: string;
  migrations?: readonly Migration[];
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const pickBool = (v: unknown, fallback: boolean): boolean =>
  typeof v === 'boolean' ? v : fallback;

const pickNum = (v: unknown, fallback: number, min: number, max: number): number =>
  typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : fallback;

/**
 * Repairs arbitrary stored data into a complete Settings; never throws. Saves from before a field
 * existed (no `tableDistance`, no `foveation`, no `fpsCounter`) take its default, so no store
 * migration is needed.
 */
export function validateSettings(raw: unknown): Settings {
  const d = DEFAULT_SETTINGS;
  const r = isRecord(raw) ? raw : {};
  return {
    turnMode: r.turnMode === 'snap' || r.turnMode === 'smooth' ? r.turnMode : d.turnMode,
    snapDegrees: pickNum(r.snapDegrees, d.snapDegrees, 5, 180),
    vignette: pickBool(r.vignette, d.vignette),
    vignetteStrength: pickNum(r.vignetteStrength, d.vignetteStrength, 0, 1),
    eyeHeight: pickNum(r.eyeHeight, d.eyeHeight, 0.8, 2.5),
    masterVolume: pickNum(r.masterVolume, d.masterVolume, 0, 1),
    musicVolume: pickNum(r.musicVolume, d.musicVolume, 0, 1),
    sfxVolume: pickNum(r.sfxVolume, d.sfxVolume, 0, 1),
    teleportEnabled: pickBool(r.teleportEnabled, d.teleportEnabled),
    difficulty: isDifficulty(r.difficulty) ? r.difficulty : d.difficulty,
    tableDistance: tableDistanceChoice(r.tableDistance) ?? d.tableDistance,
    foveation: isFoveationChoice(r.foveation) ? r.foveation : d.foveation,
    fpsCounter: pickBool(r.fpsCounter, d.fpsCounter),
  };
}

function fallback(reason: string): PersistDb {
  return { idb: null, persistent: false, reason, memory: new Map() };
}

const requestResult = <T>(req: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

const txDone = (tx: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
  });

/**
 * Opens (and migrates) the database. Resolves to an in-memory fallback, never rejects, when
 * indexedDB is missing or the open fails (private mode, blocked, downgrade).
 */
export async function openDb(
  factory: IDBFactory | undefined = globalThis.indexedDB,
  options: OpenDbOptions = {},
): Promise<PersistDb> {
  if (!factory) return fallback('indexedDB unavailable');
  const { name = DB_NAME, migrations = MIGRATIONS } = options;
  try {
    const idb = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = factory.open(name, migrations.length);
      req.onupgradeneeded = (event) => {
        const tx = req.transaction;
        if (!tx) return;
        for (let v = event.oldVersion; v < migrations.length; v++) {
          migrations[v]?.(req.result, tx, event.oldVersion);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('open blocked by another connection'));
    });
    idb.onversionchange = () => idb.close();
    return { idb, persistent: true, memory: new Map() };
  } catch (error) {
    return fallback(error instanceof Error ? error.message : String(error));
  }
}

export function closeDb(handle: PersistDb): void {
  handle.idb?.close();
}

async function readStore(handle: PersistDb, store: StoreName): Promise<unknown> {
  if (!handle.idb) return handle.memory.get(store);
  const tx = handle.idb.transaction(store, 'readonly');
  return requestResult(tx.objectStore(store).get(SINGLETON_KEY));
}

async function writeStore(handle: PersistDb, store: StoreName, value: unknown): Promise<void> {
  if (!handle.idb) {
    handle.memory.set(store, value);
    return;
  }
  const tx = handle.idb.transaction(store, 'readwrite');
  tx.objectStore(store).put(value, SINGLETON_KEY);
  await txDone(tx);
}

export async function loadSettings(handle: PersistDb): Promise<Settings> {
  return validateSettings(await readStore(handle, STORE_SETTINGS));
}

export async function saveSettings(handle: PersistDb, settings: Settings): Promise<void> {
  await writeStore(handle, STORE_SETTINGS, validateSettings(settings));
}

export const getWorkshop = (handle: PersistDb): Promise<unknown> =>
  readStore(handle, STORE_WORKSHOP);
export const putWorkshop = (handle: PersistDb, value: unknown): Promise<void> =>
  writeStore(handle, STORE_WORKSHOP, value);
export const getRun = (handle: PersistDb): Promise<unknown> => readStore(handle, STORE_RUN);
export const putRun = (handle: PersistDb, value: unknown): Promise<void> =>
  writeStore(handle, STORE_RUN, value);
