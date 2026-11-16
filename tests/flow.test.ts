import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { STARTER_DECK } from '../src/content/cards.ts';
import { REWARD_POOL } from '../src/content/rewards.ts';
import { normalizeSeed } from '../src/core/rng.ts';
import { FLOW_TRANSITIONS, type FlowEvent, type FlowPhase, RunFlow } from '../src/flow/flow.ts';
import { bindFlowPersistence } from '../src/flow/persist.ts';
import { openDb } from '../src/persist/db.ts';
import { loadRunSnapshot, loadWorkshop } from '../src/persist/saves.ts';
import { REWARD_COGS, SKIP_REWARD } from '../src/rules/run.ts';
import { createWorkshop, type WorkshopState } from '../src/rules/workshop.ts';
import { mountFloorView } from '../src/world/floor-view.ts';

const SEED = 'SPIRE001';

function flowWith(workshop: WorkshopState = createWorkshop()): RunFlow {
  return new RunFlow({ workshop, starterDeck: STARTER_DECK, rewardPool: REWARD_POOL });
}

function phases(flow: RunFlow): FlowPhase[] {
  const seen: FlowPhase[] = [];
  flow.onChange((e: FlowEvent) => {
    if (e.type === 'phase') seen.push(e.to);
  });
  return seen;
}

/** Plays one won regular fight in `room` and returns to exploring with `card` (or skip). */
function winRegular(flow: RunFlow, room: number, pick: 'first' | 'skip' = 'first'): string | null {
  expect(flow.fightStarted(room)).toBe(true);
  expect(flow.fightEnded({ room, outcome: 'win', tier: 'regular' })).toBe(true);
  const card = pick === 'first' ? (flow.offer?.cards[0] ?? null) : null;
  expect(flow.pickReward(card ?? SKIP_REWARD)).toBe(true);
  return card;
}

describe('flow transitions', () => {
  it('walks title, workshop and settings and back', () => {
    const flow = flowWith();
    const seen = phases(flow);
    expect(flow.phase).toBe('title');
    expect(flow.openWorkshop()).toBe(true);
    expect(flow.openSettings()).toBe(false);
    expect(flow.toTitle()).toBe(true);
    expect(flow.openSettings()).toBe(true);
    expect(flow.toTitle()).toBe(true);
    expect(flow.toTitle()).toBe(false);
    expect(seen).toEqual(['workshop', 'title', 'settings', 'title']);
  });

  it('rejects run actions outside their phase', () => {
    const flow = flowWith();
    expect(flow.fightStarted(1)).toBe(false);
    expect(flow.fightEnded({ room: 1, outcome: 'win', tier: 'regular' })).toBe(false);
    expect(flow.pickReward(SKIP_REWARD)).toBe(false);
    expect(flow.snapshot()).toBeNull();
    expect(flow.newRun(SEED)).toBe(true);
    expect(flow.newRun(SEED)).toBe(false);
    expect(flow.openWorkshop()).toBe(false);
    expect(flow.toTitle()).toBe(false);
  });

  it('starts a run with the workshop upgrades applied', () => {
    const ws: WorkshopState = {
      ...createWorkshop(),
      purchased: { 'sturdy-frame': 2, 'spare-die': 1, 'wide-catalog': 1 },
    };
    const flow = flowWith(ws);
    flow.newRun(SEED);
    expect(flow.phase).toBe('explore');
    expect(flow.run).toMatchObject({
      seed: normalizeSeed(SEED),
      maxHp: 70,
      hp: 70,
      bonusDice: 1,
      rewardChoices: 4,
    });
    expect(flow.run?.deck).toEqual(STARTER_DECK);
  });

  it('a win opens the reward, and the chosen card joins the deck with the cogs', () => {
    const flow = flowWith();
    const seen = phases(flow);
    flow.newRun(SEED);
    flow.fightStarted(2);
    expect(flow.fightEnded({ room: 2, outcome: 'win', tier: 'regular', playerHp: 41 })).toBe(true);
    expect(flow.phase).toBe('reward');
    const offer = flow.offer;
    expect(offer?.cards).toHaveLength(3);
    for (const id of offer?.cards ?? []) expect(REWARD_POOL).toContain(id);
    expect(flow.pickReward('not-offered')).toBe(false);
    const card = offer?.cards[1] as string;
    expect(flow.pickReward(card)).toBe(true);
    expect(flow.phase).toBe('explore');
    expect(flow.run?.deck).toEqual([...STARTER_DECK, card]);
    expect(flow.run?.cogs).toBe(offer?.cogs);
    expect(flow.run?.hp).toBe(41);
    expect(flow.cleared).toEqual([2]);
    // A cleared room never starts another fight.
    expect(flow.fightStarted(2)).toBe(false);
    expect(seen).toEqual(['explore', 'combat', 'reward', 'explore']);
  });

  it('fleeing returns to exploring without clearing the room', () => {
    const flow = flowWith();
    flow.newRun(SEED);
    flow.fightStarted(3);
    expect(flow.fightEnded({ room: 3, outcome: 'flee', tier: 'regular' })).toBe(true);
    expect(flow.phase).toBe('explore');
    expect(flow.cleared).toEqual([]);
  });

  it('a defeat goes to the death screen once, banks the purse once, and never fights again', () => {
    const flow = flowWith();
    const events: FlowEvent[] = [];
    flow.onChange((e) => events.push(e));
    flow.newRun(SEED);
    flow.enterRoom(1);
    winRegular(flow, 2);
    const purse = flow.run?.cogs ?? 0;
    expect(purse).toBeGreaterThan(0);
    flow.fightStarted(4);
    expect(flow.fightEnded({ room: 4, outcome: 'defeat', tier: 'regular', playerHp: 0 })).toBe(
      true,
    );
    expect(flow.phase).toBe('death');
    expect(flow.workshop.cogsBanked).toBe(purse);
    expect(flow.summary).toEqual({
      outcome: 'death',
      seed: normalizeSeed(SEED),
      roomsReached: 4,
      fightsWon: 1,
      cogsEarned: purse,
      bankTotal: purse,
    });
    // A second end call for the same fight, or a stray trigger, changes nothing.
    expect(flow.fightEnded({ room: 4, outcome: 'defeat', tier: 'regular' })).toBe(false);
    expect(flow.fightStarted(4)).toBe(false);
    expect(flow.workshop.cogsBanked).toBe(purse);
    expect(events.filter((e) => e.type === 'phase' && e.to === 'death')).toHaveLength(1);
    expect(flow.toTitle()).toBe(true);
    expect(flow.run).toBeNull();
    expect(flow.workshop.cogsBanked).toBe(purse);
  });

  it('clearing the guardian room wins the run with the guardian purse', () => {
    const flow = flowWith();
    flow.newRun(SEED);
    winRegular(flow, 1, 'skip');
    const before = flow.run?.cogs ?? 0;
    flow.fightStarted(6);
    expect(flow.fightEnded({ room: 6, outcome: 'win', tier: 'guardian' })).toBe(true);
    expect(flow.phase).toBe('victory');
    expect(flow.offer).toBeNull();
    expect(flow.run?.cogs).toBe(before + REWARD_COGS.guardian.min);
    expect(flow.summary).toMatchObject({
      outcome: 'victory',
      fightsWon: 2,
      cogsEarned: before + 60,
      bankTotal: before + 60,
    });
    expect(flow.toTitle()).toBe(true);
    expect(flow.phase).toBe('title');
  });

  it('buys upgrades only in the workshop and only when affordable', () => {
    const flow = flowWith({ ...createWorkshop(), cogsBanked: 40 });
    expect(flow.buy('sturdy-frame')).toBe(false);
    flow.openWorkshop();
    expect(flow.canBuy('spare-die')).toBe(false);
    expect(flow.buy('spare-die')).toBe(false);
    expect(flow.buy('sturdy-frame')).toBe(true);
    expect(flow.workshop).toMatchObject({ cogsBanked: 10, purchased: { 'sturdy-frame': 1 } });
    expect(flow.buy('sturdy-frame')).toBe(false);
  });

  it('every declared transition is reachable from the title', () => {
    const reachable = new Set<FlowPhase>(['title']);
    let grew = true;
    while (grew) {
      grew = false;
      for (const from of reachable) {
        for (const to of FLOW_TRANSITIONS[from]) {
          if (!reachable.has(to)) {
            reachable.add(to);
            grew = true;
          }
        }
      }
    }
    expect([...reachable].sort()).toEqual(Object.keys(FLOW_TRANSITIONS).sort());
  });
});

describe('continue from a snapshot', () => {
  it('restores the same run and offer, and continues identically', () => {
    const a = flowWith();
    a.newRun(SEED);
    winRegular(a, 1);
    a.fightStarted(3);
    a.fightEnded({ room: 3, outcome: 'win', tier: 'elite', playerHp: 30 });
    const snap = a.snapshot(1000, 3);
    expect(snap?.phase).toBe('reward');
    expect(snap?.pendingReward).toEqual(a.offer);

    const b = flowWith();
    expect(b.continueRun(structuredClone(snap) as NonNullable<typeof snap>)).toBe(true);
    expect(b.phase).toBe('reward');
    expect(b.run).toEqual(a.run);
    expect(b.offer).toEqual(a.offer);
    expect(b.cleared).toEqual([1, 3]);
    expect(b.room).toBe(3);

    // Same choice, same next fight: identical continuation, including the loot stream.
    const card = a.offer?.cards[2] as string;
    a.pickReward(card);
    b.pickReward(card);
    expect(b.run).toEqual(a.run);
    a.fightStarted(5);
    b.fightStarted(5);
    a.fightEnded({ room: 5, outcome: 'win', tier: 'regular' });
    b.fightEnded({ room: 5, outcome: 'win', tier: 'regular' });
    expect(b.offer).toEqual(a.offer);
    expect(b.run).toEqual(a.run);
  });

  it('resumes an explore snapshot into exploring', () => {
    const a = flowWith();
    a.newRun(SEED);
    winRegular(a, 2);
    const snap = a.snapshot(5, 2);
    const b = flowWith();
    b.continueRun(snap as NonNullable<typeof snap>);
    expect(b.phase).toBe('explore');
    expect(b.offer).toBeNull();
    expect(b.fightStarted(2)).toBe(false);
  });
});

describe('flow persistence', () => {
  it('snapshots at explore and reward, then clears it and banks exactly once at run end', async () => {
    const db = await openDb(undefined);
    const flow = flowWith();
    const saved = bindFlowPersistence(flow, db);
    flow.newRun(SEED);
    await saved.flushed();
    expect((await loadRunSnapshot(db))?.phase).toBe('explore');

    flow.fightStarted(2);
    flow.fightEnded({ room: 2, outcome: 'win', tier: 'regular' });
    await saved.flushed();
    const atReward = await loadRunSnapshot(db);
    expect(atReward?.phase).toBe('reward');
    expect(atReward?.pendingReward).toEqual(flow.offer);

    flow.pickReward(SKIP_REWARD);
    const purse = flow.run?.cogs ?? 0;
    flow.fightStarted(4);
    flow.fightEnded({ room: 4, outcome: 'defeat', tier: 'regular' });
    flow.fightEnded({ room: 4, outcome: 'defeat', tier: 'regular' });
    flow.toTitle();
    await saved.flushed();
    expect(await loadRunSnapshot(db)).toBeNull();
    expect((await loadWorkshop(db)).cogsBanked).toBe(purse);

    flow.openWorkshop();
    flow.buy('sturdy-frame');
    await saved.flushed();
    const ws = await loadWorkshop(db);
    expect(ws.purchased['sturdy-frame']).toBe(purse >= 30 ? 1 : 0);
    saved.dispose();
  });
});

describe('floor triggers after a defeat', () => {
  it('a lost fight never re-triggers while the flow holds the death screen', () => {
    const scene = new THREE.Scene();
    const view = mountFloorView(scene, new THREE.Group(), SEED);
    const [room, bodies] = [...view.world.enemies].find(([, b]) => b.length > 0) ?? [];
    const target = new THREE.Vector3();
    bodies?.[0]?.getWorldPosition(target);
    const head = new THREE.Object3D();
    scene.add(head);
    head.position.set(target.x, 1.2, target.z + 1);
    view.world.update(head.position.x, head.position.z);
    const step = (seconds: number) => {
      for (let t = 0; t < seconds; t += 1 / 60) {
        head.updateMatrixWorld(true);
        view.update(head, 1 / 60);
      }
    };
    step(1.2);
    expect(view.encounter.phase).toBe('active');
    expect(view.encounter.activeRoom).toBe(room);

    view.suspendTriggers = true;
    view.encounter.end('defeat');
    step(4);
    expect(view.encounter.phase).toBe('idle');
    expect(view.locked).toBe(false);

    // Without the suspension the same spot does fight again, which is what the flow prevents.
    view.suspendTriggers = false;
    step(0.5);
    expect(view.encounter.phase).not.toBe('idle');
    view.dispose();
    expect(scene.children.filter((c) => c !== head)).toHaveLength(0);
  });

  it('markCleared removes a room from the encounter triggers', () => {
    const scene = new THREE.Scene();
    const view = mountFloorView(scene, new THREE.Group(), SEED);
    const [room, bodies] = [...view.world.enemies].find(([, b]) => b.length > 0) ?? [];
    const target = new THREE.Vector3();
    bodies?.[0]?.getWorldPosition(target);
    view.markCleared(room as number);
    view.world.update(target.x, target.z + 1);
    expect(view.encounter.checkTrigger({ x: target.x, z: target.z + 1 })).toBeNull();
    expect(view.standPoint(room as number)).not.toBeNull();
    expect(view.standPoint(999)).toBeNull();
    view.dispose();
  });
});
