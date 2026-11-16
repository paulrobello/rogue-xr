export const DB_NAME = 'rogue-xr';

export type TurnMode = 'snap' | 'smooth';

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

/** Repairs arbitrary stored data into a complete Settings; never throws. */
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
