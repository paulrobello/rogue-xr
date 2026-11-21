import { describe, expect, it } from 'vitest';
import { attachDispatchRoom } from '../src/floor/dispatch-room.ts';
import { generateFloor } from '../src/floor/generate.ts';
import {
  dispatchDestination,
  openDispatch,
  readDispatch,
  sendDispatch,
  turnDispatch,
} from '../src/rules/dispatch.ts';
import { createRun } from '../src/rules/run.ts';

describe('dispatch room', () => {
  it('appends a gated vault without changing prior indices', () => {
    const base = generateFloor('DISPAT01');
    const next = attachDispatchRoom(base);
    expect(next.rooms.slice(0, base.rooms.length)).toEqual(base.rooms);
    expect(next.dispatchRoom?.vaultRoom).toBe(base.rooms.length);
    expect(next.connections.at(-1)?.puzzleGate).toBe('dispatch');
  });

  it('cycles, retries misroutes, persists send, and opens once', () => {
    let run = createRun('DISPAT01', []);
    const target = dispatchDestination(run.seed);
    if (target === 0) run = { ...run, dispatch: turnDispatch(readDispatch(run)) };
    const bounced = sendDispatch(run);
    expect(bounced?.result).toBe('misrouted');
    expect(bounced?.run.dispatch).toMatchObject({ sent: false, opened: false });
    expect(openDispatch(bounced!.run)).toBeNull();
    run = bounced!.run;
    while (readDispatch(run).route !== target)
      run = { ...run, dispatch: turnDispatch(readDispatch(run)) };
    const sent = sendDispatch(run);
    expect(sent?.result).toBe('sent');
    run = sent!.run;
    expect(sendDispatch(run)).toBeNull();
    const opened = openDispatch(run);
    expect(opened?.dispatch?.opened).toBe(true);
    expect(openDispatch(opened!)).toBeNull();
  });
});
