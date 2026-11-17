// @vitest-environment node
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import {
  closeDb,
  DB_NAME,
  DB_VERSION,
  DEFAULT_SETTINGS,
  FOVEATION_CHOICES,
  getRun,
  getWorkshop,
  loadSettings,
  MIGRATIONS,
  type Migration,
  openDb,
  type PersistDb,
  putRun,
  putWorkshop,
  saveSettings,
  validateSettings,
} from '../src/persist/db.ts';

const storeNames = (handle: PersistDb): string[] =>
  [...(handle.idb?.objectStoreNames ?? [])].sort();

// Writes a raw value into the settings store, bypassing saveSettings validation.
async function putRaw(handle: PersistDb, value: unknown): Promise<void> {
  const tx = handle.idb?.transaction('settings', 'readwrite');
  if (!tx) throw new Error('no idb');
  tx.objectStore('settings').put(value, 'current');
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

describe('validateSettings', () => {
  it('returns defaults for non-objects', () => {
    for (const raw of [undefined, null, 42, 'x', [], true]) {
      expect(validateSettings(raw)).toEqual(DEFAULT_SETTINGS);
    }
  });

  it('repairs invalid fields individually and keeps valid ones', () => {
    const repaired = validateSettings({
      turnMode: 'warp',
      snapDegrees: 45,
      vignette: 'yes',
      vignetteStrength: Number.NaN,
      eyeHeight: 99,
      masterVolume: 1.5,
      musicVolume: 0.25,
      sfxVolume: -1,
      teleportEnabled: false,
    });
    expect(repaired).toEqual({
      ...DEFAULT_SETTINGS,
      snapDegrees: 45,
      musicVolume: 0.25,
      teleportEnabled: false,
    });
  });
});

describe('persist db', () => {
  it('creates all stores at the current version', async () => {
    const handle = await openDb(new IDBFactory());
    expect(handle.persistent).toBe(true);
    expect(handle.idb?.version).toBe(DB_VERSION);
    expect(storeNames(handle)).toEqual(['run', 'settings', 'workshop']);
    closeDb(handle);
  });

  it('returns defaults on an empty db', async () => {
    const handle = await openDb(new IDBFactory());
    expect(await loadSettings(handle)).toEqual(DEFAULT_SETTINGS);
    expect(await getWorkshop(handle)).toBeUndefined();
    expect(await getRun(handle)).toBeUndefined();
    closeDb(handle);
  });

  it('defaults to teleport on and keeps a flipped teleport toggle across a reopen', async () => {
    expect(DEFAULT_SETTINGS.teleportEnabled).toBe(true);
    const factory = new IDBFactory();
    const first = await openDb(factory);
    await saveSettings(first, { ...DEFAULT_SETTINGS, teleportEnabled: true, turnMode: 'smooth' });
    closeDb(first);
    const second = await openDb(factory);
    const stored = await loadSettings(second);
    expect(stored.teleportEnabled).toBe(true);
    expect(stored.turnMode).toBe('smooth');
    await saveSettings(second, { ...stored, teleportEnabled: false });
    closeDb(second);
    const third = await openDb(factory);
    expect((await loadSettings(third)).teleportEnabled).toBe(false);
    closeDb(third);
  });

  it('writes, then reopens and reads the same data', async () => {
    const factory = new IDBFactory();
    const first = await openDb(factory);
    const next = {
      ...DEFAULT_SETTINGS,
      turnMode: 'smooth' as const,
      eyeHeight: 1.45,
      masterVolume: 0.3,
    };
    await saveSettings(first, next);
    await putWorkshop(first, { upgrades: ['gear'] });
    await putRun(first, { seed: 'SP1RE000' });
    closeDb(first);

    const second = await openDb(factory);
    expect(await loadSettings(second)).toEqual(next);
    expect(await getWorkshop(second)).toEqual({ upgrades: ['gear'] });
    expect(await getRun(second)).toEqual({ seed: 'SP1RE000' });
    closeDb(second);
  });

  it('repairs partial and corrupt stored settings on load', async () => {
    const handle = await openDb(new IDBFactory());
    await putRaw(handle, { turnMode: 'smooth', snapDegrees: 'wide', extra: 1 });
    expect(await loadSettings(handle)).toEqual({ ...DEFAULT_SETTINGS, turnMode: 'smooth' });
    await putRaw(handle, 'garbage');
    expect(await loadSettings(handle)).toEqual(DEFAULT_SETTINGS);
    closeDb(handle);
  });

  it('migrates a v1 db to v2 through the migration hook, keeping data', async () => {
    const factory = new IDBFactory();
    const v1 = await openDb(factory);
    await saveSettings(v1, { ...DEFAULT_SETTINGS, snapDegrees: 60 });
    closeDb(v1);

    const seen: number[] = [];
    const v2Step: Migration = (db, tx, oldVersion) => {
      seen.push(oldVersion);
      db.createObjectStore('cosmetics');
      tx.objectStore('settings').put({ turnMode: 'smooth', snapDegrees: 60 }, 'current');
    };
    const v2 = await openDb(factory, { migrations: [...MIGRATIONS, v2Step] });
    expect(v2.persistent).toBe(true);
    expect(v2.idb?.version).toBe(2);
    expect(seen).toEqual([1]);
    expect(storeNames(v2)).toEqual(['cosmetics', 'run', 'settings', 'workshop']);
    expect(await loadSettings(v2)).toEqual({
      ...DEFAULT_SETTINGS,
      turnMode: 'smooth',
      snapDegrees: 60,
    });
    closeDb(v2);
  });

  it('runs every migration step from version 0 on a fresh db', async () => {
    const seen: number[] = [];
    const extra: Migration = (_db, _tx, oldVersion) => {
      seen.push(oldVersion);
    };
    const handle = await openDb(new IDBFactory(), { migrations: [...MIGRATIONS, extra] });
    expect(handle.idb?.version).toBe(2);
    expect(seen).toEqual([0]);
    expect(storeNames(handle)).toEqual(['run', 'settings', 'workshop']);
    closeDb(handle);
  });

  it('falls back to in-memory defaults when indexedDB is unavailable', async () => {
    const handle = await openDb(undefined);
    expect(handle.persistent).toBe(false);
    expect(handle.idb).toBeNull();
    expect(handle.reason).toBeTruthy();
    expect(await loadSettings(handle)).toEqual(DEFAULT_SETTINGS);
    await saveSettings(handle, { ...DEFAULT_SETTINGS, vignette: false });
    expect((await loadSettings(handle)).vignette).toBe(false);
    await putRun(handle, { seed: 'X' });
    expect(await getRun(handle)).toEqual({ seed: 'X' });
  });

  it('falls back when opening fails (stored version is newer than the code)', async () => {
    const factory = new IDBFactory();
    const future = await openDb(factory, { migrations: [...MIGRATIONS, () => {}] });
    closeDb(future);
    const handle = await openDb(factory);
    expect(handle.persistent).toBe(false);
    expect(handle.reason).toBeTruthy();
    expect(await loadSettings(handle)).toEqual(DEFAULT_SETTINGS);
  });

  it('uses the documented database name', () => {
    expect(DB_NAME).toBe('rogue-xr');
  });
});

describe('table distance and foveation settings (F3, F4)', () => {
  it('default to the 1.1 m table and medium foveation', () => {
    expect(DEFAULT_SETTINGS.tableDistance).toBe(1.1);
    expect(DEFAULT_SETTINGS.foveation).toBe('medium');
    expect(FOVEATION_CHOICES).toEqual(['off', 'low', 'medium', 'high']);
  });

  it('keeps every offered value and snaps float drift onto the list', () => {
    for (const tableDistance of [0.9, 1.0, 1.1, 1.2, 1.3]) {
      expect(validateSettings({ ...DEFAULT_SETTINGS, tableDistance }).tableDistance).toBe(
        tableDistance,
      );
    }
    expect(validateSettings({ tableDistance: 1.2000000000000002 }).tableDistance).toBe(1.2);
    for (const foveation of FOVEATION_CHOICES) {
      expect(validateSettings({ foveation }).foveation).toBe(foveation);
    }
  });

  it('repairs off-list and wrongly typed values to the defaults', () => {
    for (const tableDistance of [0.5, 1.7, Number.NaN, '1.2', null]) {
      expect(validateSettings({ tableDistance }).tableDistance).toBe(1.1);
    }
    for (const foveation of ['ultra', 0.5, true, null]) {
      expect(validateSettings({ foveation }).foveation).toBe('medium');
    }
  });

  it('migrates a save from before the settings existed to the defaults, keeping the rest', async () => {
    const handle = await openDb(new IDBFactory());
    const {
      tableDistance: _t,
      foveation: _f,
      ...old
    } = {
      ...DEFAULT_SETTINGS,
      turnMode: 'smooth' as const,
      masterVolume: 0.4,
    };
    await putRaw(handle, old);
    expect(await loadSettings(handle)).toEqual({
      ...DEFAULT_SETTINGS,
      turnMode: 'smooth',
      masterVolume: 0.4,
    });
    closeDb(handle);
  });

  it('persists a chosen table distance and foveation across a reopen', async () => {
    const factory = new IDBFactory();
    const first = await openDb(factory);
    await saveSettings(first, { ...DEFAULT_SETTINGS, tableDistance: 1.3, foveation: 'high' });
    closeDb(first);
    const second = await openDb(factory);
    const stored = await loadSettings(second);
    expect(stored.tableDistance).toBe(1.3);
    expect(stored.foveation).toBe('high');
    closeDb(second);
  });
});
