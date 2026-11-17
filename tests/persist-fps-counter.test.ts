import { describe, expect, it } from 'vitest';
import {
  closeDb,
  DEFAULT_SETTINGS,
  loadSettings,
  openDb,
  saveSettings,
  validateSettings,
} from '../src/persist/db.ts';

describe('FPS counter setting (item D)', () => {
  it('defaults off, keeps a boolean and repairs anything else to off', () => {
    expect(DEFAULT_SETTINGS.fpsCounter).toBe(false);
    expect(validateSettings({ fpsCounter: true }).fpsCounter).toBe(true);
    for (const fpsCounter of ['on', 1, null, undefined]) {
      expect(validateSettings({ fpsCounter }).fpsCounter).toBe(false);
    }
    // A save from before the setting existed keeps everything else.
    const { fpsCounter: _f, ...old } = { ...DEFAULT_SETTINGS, foveation: 'high' as const };
    expect(validateSettings(old)).toEqual({ ...DEFAULT_SETTINGS, foveation: 'high' });
  });

  it('saves and loads with the other settings', async () => {
    const db = await openDb(undefined);
    await saveSettings(db, { ...DEFAULT_SETTINGS, fpsCounter: true });
    expect((await loadSettings(db)).fpsCounter).toBe(true);
    closeDb(db);
  });
});
