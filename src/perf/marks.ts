import type { PerfRecorder } from './recorder.ts';

/** How long `perfWindow` keeps its window open when the caller names no length. */
export const PERF_WINDOW_MS = 3000;

let active: PerfRecorder | null = null;
/** Counts marks, so a timed window end never overrides a mark made after it opened. */
let markCount = 0;
let lastRoom = -1;

/** Points the marks at the recorder in use, or null when recording is off. */
export function setActivePerfRecorder(recorder: PerfRecorder | null): void {
  active = recorder;
  lastRoom = -1;
}

/** True while a recorder is taking marks. */
export function perfRecording(): boolean {
  return active !== null;
}

/** Closes the open frame window and opens the next as `label`. A no-op (one null check) when recording is off. */
export function perfMark(label: string): void {
  if (!active) return;
  markCount += 1;
  active.mark(label);
}

/**
 * Marks `label`, then `after` once `ms` pass, unless another mark came first: a window around a
 * short event. The first second of each window is not counted, so keep `ms` above 1500.
 */
export function perfWindow(label: string, ms: number = PERF_WINDOW_MS, after = 'play'): void {
  const recorder = active;
  if (!recorder) return;
  perfMark(label);
  const stamp = markCount;
  setTimeout(() => {
    if (active === recorder && markCount === stamp) perfMark(after);
  }, ms);
}

/** The slice of the floor world `perfRoom` reads. */
export interface PerfRoomSource {
  readonly current: number;
  readonly plan: { readonly rooms: readonly { readonly templateId: string }[] };
}

/** Marks `room <index> <template>` when the current room changed since the last call. */
export function perfRoom(world: PerfRoomSource): void {
  if (!active || world.current === lastRoom) return;
  lastRoom = world.current;
  perfMark(`room ${world.current} ${world.plan.rooms[world.current]?.templateId ?? '?'}`);
}
