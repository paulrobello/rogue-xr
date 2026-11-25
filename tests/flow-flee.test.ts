import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { STARTER_DECK } from '../src/content/cards.ts';
import { REWARD_POOL } from '../src/content/rewards.ts';
import { encounterStartsFight, FLEE_INSET, fleeStandPoint } from '../src/flow/flee.ts';
import { type FlowEvent, RunFlow } from '../src/flow/flow.ts';
import { bindFlowPersistence } from '../src/flow/persist.ts';
import { openDb } from '../src/persist/db.ts';
import { loadRunSnapshot, loadWorkshop } from '../src/persist/saves.ts';
import { SKIP_REWARD } from '../src/rules/run.ts';
import { createWorkshop } from '../src/rules/workshop.ts';
import { mountFloorView } from '../src/world/floor-view.ts';

const SEED = 'SPIRE001';

const flowWith = (): RunFlow =>
  new RunFlow({ workshop: createWorkshop(), starterDeck: STARTER_DECK, rewardPool: REWARD_POOL });

describe('fleeing a fight (card B)', () => {
  it('keeps healing from a win and prevents net healing from repeating a fled fight', () => {
    const fresh = flowWith();
    fresh.newRun(SEED);
    const snapshot = fresh.snapshot(1, 0);
    if (!snapshot) throw Error('Missing snapshot');
    const flow = flowWith();
    expect(flow.continueRun({ ...snapshot, run: { ...snapshot.run, hp: 20 } })).toBe(true);
    for (let i = 0; i < 2; i++) {
      expect(flow.fightStarted(3)).toBe(true);
      expect(flow.fightEnded({ room: 3, outcome: 'flee', tier: 'regular', playerHp: 26 })).toBe(
        true,
      );
      expect(flow.run?.hp).toBe(20);
    }
    expect(flow.fightStarted(3)).toBe(true);
    expect(flow.fightEnded({ room: 3, outcome: 'win', tier: 'regular', playerHp: 26 })).toBe(true);
    expect(flow.pickReward(SKIP_REWARD)).toBe(true);
    expect(flow.run?.hp).toBe(26);
  });

  it('a regular fight flees to exploring with hp kept, no reward and the room uncleared', () => {
    const flow = flowWith();
    flow.newRun(SEED);
    const cogs = flow.run?.cogs;
    expect(flow.fightStarted(3)).toBe(true);
    expect(flow.fightEnded({ room: 3, outcome: 'flee', tier: 'regular', playerHp: 31 })).toBe(true);
    expect(flow.phase).toBe('explore');
    expect(flow.run?.hp).toBe(31);
    expect(flow.run?.cogs).toBe(cogs);
    expect(flow.offer).toBeNull();
    expect(flow.cleared).toEqual([]);
    // The same room fights again.
    expect(flow.fightStarted(3)).toBe(true);
  });

  it('an elite or guardian fight refuses a flee and stays in combat', () => {
    for (const tier of ['elite', 'guardian'] as const) {
      const flow = flowWith();
      flow.newRun(SEED);
      flow.fightStarted(4);
      const hp = flow.run?.hp;
      expect(flow.fightEnded({ room: 4, outcome: 'flee', tier, playerHp: 5 })).toBe(false);
      expect(flow.phase).toBe('combat');
      expect(flow.run?.hp).toBe(hp);
    }
  });

  it('a run saved after a flee resumes with the fled room still to fight', async () => {
    const db = await openDb(undefined);
    const flow = flowWith();
    const saved = bindFlowPersistence(flow, db);
    flow.newRun(SEED);
    flow.fightStarted(2);
    flow.fightEnded({ room: 2, outcome: 'flee', tier: 'regular', playerHp: 40 });
    await saved.flushed();
    const snap = await loadRunSnapshot(db);
    expect(snap?.phase).toBe('explore');
    expect(snap?.clearedEncounters).toEqual([]);
    expect(snap?.run.hp).toBe(40);
    saved.dispose();

    const resumed = flowWith();
    if (!snap) throw new Error('no snapshot');
    expect(resumed.continueRun(snap)).toBe(true);
    expect(resumed.fightStarted(2)).toBe(true);
    expect(resumed.fightEnded({ room: 2, outcome: 'win', tier: 'regular' })).toBe(true);
    expect(resumed.cleared).toEqual([2]);
  });
});

describe('abandoning a run (card A)', () => {
  it('from explore or combat: banks the purse as a defeat does and returns to the title', () => {
    for (const fighting of [false, true]) {
      const flow = flowWith();
      const events: FlowEvent[] = [];
      flow.onChange((e) => events.push(e));
      flow.newRun(SEED);
      flow.fightStarted(1);
      flow.fightEnded({ room: 1, outcome: 'win', tier: 'regular' });
      flow.pickReward(SKIP_REWARD);
      const purse = flow.run?.cogs ?? 0;
      expect(purse).toBeGreaterThan(0);
      if (fighting) flow.fightStarted(2);
      expect(flow.abandonRun()).toBe(true);
      expect(flow.phase).toBe('title');
      expect(flow.run).toBeNull();
      expect(flow.summary).toBeNull();
      expect(flow.workshop.cogsBanked).toBe(purse);
      expect(events.at(-1)).toEqual({
        type: 'phase',
        from: fighting ? 'combat' : 'explore',
        to: 'title',
      });
      // Only once, and never from the title.
      expect(flow.abandonRun()).toBe(false);
      expect(flow.workshop.cogsBanked).toBe(purse);
    }
  });

  it('is refused outside explore and combat', () => {
    const flow = flowWith();
    expect(flow.abandonRun()).toBe(false);
    flow.newRun(SEED);
    flow.fightStarted(1);
    flow.fightEnded({ room: 1, outcome: 'win', tier: 'regular' });
    expect(flow.phase).toBe('reward');
    expect(flow.abandonRun()).toBe(false);
  });

  it('clears the saved run before saving the banked workshop, so Continue cannot bring it back', async () => {
    const db = await openDb(undefined);
    const flow = flowWith();
    const saved = bindFlowPersistence(flow, db);
    flow.newRun(SEED);
    flow.fightStarted(1);
    flow.fightEnded({ room: 1, outcome: 'win', tier: 'regular' });
    flow.pickReward(SKIP_REWARD);
    await saved.flushed();
    expect(await loadRunSnapshot(db)).not.toBeNull();
    const purse = flow.run?.cogs ?? 0;
    flow.abandonRun();
    await saved.flushed();
    expect(await loadRunSnapshot(db)).toBeNull();
    expect((await loadWorkshop(db)).cogsBanked).toBe(purse);
    saved.dispose();
  });
});

describe('fleeStandPoint', () => {
  it('stands inside the room by its entry door, clear of every automaton home', () => {
    let checked = 0;
    for (const seed of ['SPIRE001', 'SPIRE002', 'BRASS042', 'GEARS777']) {
      const view = mountFloorView(new THREE.Scene(), new THREE.Group(), seed);
      const { plan, rooms } = view.world;
      plan.rooms.forEach((placed, room) => {
        if (placed.encounter?.tier !== 'regular') return;
        const at = fleeStandPoint(plan, rooms, room);
        const r = rooms[room];
        if (!at || !r) throw new Error('no stand point');
        // Inside the room's footprint.
        expect(at.x).toBeGreaterThan(r.footprint.min[0]);
        expect(at.x).toBeLessThan(r.footprint.max[0]);
        expect(at.z).toBeGreaterThan(r.footprint.min[1]);
        expect(at.z).toBeLessThan(r.footprint.max[1]);
        // One inset from the door the plan entered it by.
        const entry = plan.connections.find(([, own]) => own.room === room)?.[1].door;
        const door = r.doors.find((d) => d.id === entry)?.world;
        if (!door) throw new Error('no entry door');
        checked += 1;
        expect(Math.hypot(at.x - door[0], at.z - door[1])).toBeCloseTo(FLEE_INSET, 6);
        // Outside the 1.2 m trigger radius of every automaton's home, so fleeing never re-triggers,
        // and so is where a run saved after the flee resumes (`standPoint`).
        const resume = view.standPoint(room);
        for (const body of view.world.enemies.get(room) ?? []) {
          const home = body.getWorldPosition(new THREE.Vector3());
          expect(Math.hypot(home.x - at.x, home.z - at.z), `${seed} room ${room}`).toBeGreaterThan(
            1.2,
          );
          if (resume)
            expect(
              Math.hypot(home.x - resume.x, home.z - resume.z),
              `${seed} room ${room} resume`,
            ).toBeGreaterThan(1.2);
        }
      });
      view.dispose();
    }
    expect(checked).toBeGreaterThanOrEqual(4);
  });

  it('is null for an unknown room', () => {
    const view = mountFloorView(new THREE.Scene(), new THREE.Group(), SEED);
    expect(fleeStandPoint(view.world.plan, view.world.rooms, 99)).toBeNull();
    view.dispose();
  });
});

describe('encounterStartsFight', () => {
  it('starts a fight only while the encounter opens or is open and the flow explores', () => {
    expect(encounterStartsFight('unfolding', 'explore')).toBe(true);
    expect(encounterStartsFight('active', 'explore')).toBe(true);
    expect(encounterStartsFight('idle', 'explore')).toBe(false);
    expect(encounterStartsFight('unfolding', 'combat')).toBe(false);
  });

  it('does not restart the fight while the table folds after a flee', () => {
    // A flee puts the flow back to explore at once; the encounter folds for a while after.
    expect(encounterStartsFight('folding', 'explore')).toBe(false);
  });
});
