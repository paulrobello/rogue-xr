import type { PersistDb } from '../persist/db.ts';
import { clearRunSnapshot, saveRunSnapshot, saveWorkshop } from '../persist/saves.ts';
import type { RunFlow } from './flow.ts';

export interface FlowPersistence {
  /** Resolves once every write queued so far has landed. */
  flushed(): Promise<void>;
  dispose(): void;
}

/**
 * Writes the flow to IndexedDB as it changes: a run snapshot at every explore, reward and guardian-cleared boundary and
 * after exploration interactions that change the run without changing phase,
 * the workshop after a purchase, and at run end the snapshot cleared before the banked workshop is
 * saved, so a crash between the two writes can lose the payout but never bank it twice. An abandoned
 * run (explore or combat straight to the title) ends the same way. Writes run in
 * order on one queue. `roomIndex` reports the player's current room for the snapshot.
 */
export function bindFlowPersistence(
  flow: RunFlow,
  db: PersistDb,
  roomIndex: () => number = () => flow.room,
): FlowPersistence {
  let queue: Promise<void> = Promise.resolve();
  const enqueue = (write: () => Promise<void>): void => {
    queue = queue.then(write).catch((error: unknown) => console.error('save failed', error));
  };
  const off = flow.onChange((event) => {
    if (event.type === 'floor-travel') {
      const snapshot = flow.snapshot(Date.now(), event.room);
      if (snapshot) enqueue(() => saveRunSnapshot(db, snapshot));
      return;
    }
    if (event.type === 'workshop') {
      const ws = flow.workshop;
      enqueue(() => saveWorkshop(db, ws));
      return;
    }
    if (
      event.type === 'loot' ||
      event.type === 'hearth' ||
      event.type === 'pressure' ||
      event.type === 'dispatch' ||
      event.type === 'speaking-pipes' ||
      event.type === 'book-secret' ||
      event.type === 'bell-chimes' ||
      event.type === 'counterweight' ||
      event.type === 'formula' ||
      event.type === 'commission' ||
      event.type === 'calibration' ||
      event.type === 'alchemy' ||
      event.type === 'hidden-panel' ||
      event.type === 'window-cache' ||
      event.type === 'brass-key' ||
      event.type === 'prism-signal' ||
      event.type === 'reliquary'
    ) {
      const snapshot = flow.snapshot(Date.now(), roomIndex());
      if (snapshot) enqueue(() => saveRunSnapshot(db, snapshot));
      return;
    }
    if (event.to === 'explore' || event.to === 'reward' || event.to === 'guardian-cleared') {
      const snapshot = flow.snapshot(Date.now(), roomIndex());
      if (snapshot) enqueue(() => saveRunSnapshot(db, snapshot));
    } else if (
      event.to === 'death' ||
      event.to === 'victory' ||
      (event.to === 'title' && (event.from === 'explore' || event.from === 'combat'))
    ) {
      const ws = flow.workshop;
      enqueue(() => clearRunSnapshot(db));
      enqueue(() => saveWorkshop(db, ws));
    }
  });
  return {
    flushed: () => queue,
    dispose: off,
  };
}
