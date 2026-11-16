import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import {
  CombatHook,
  type CombatPick,
  type CombatSession,
  chooseEncounter,
  SIGIL_CAST_SECONDS,
} from '../src/combat/combat-session.ts';
import { getCard } from '../src/content/cards.ts';
import { dieById } from '../src/content/dice.ts';
import { ActionBus } from '../src/core/actions.ts';
import { Stream } from '../src/core/rng.ts';
import { DicePresenter } from '../src/dice/presenter.ts';
import { SIGIL_TEMPLATES } from '../src/sigil/index.ts';
import { type FloorView, mountFloorView } from '../src/world/floor-view.ts';

const DT = 1 / 60;

interface Rig {
  view: FloorView;
  camera: THREE.PerspectiveCamera;
  actions: ActionBus;
  hook: CombatHook;
  room: number;
  bodies: readonly THREE.Object3D[];
  baseListeners: number;
  step(seconds?: number): void;
}

async function openFight(
  seed = 'SPIRE002',
  options?: { enemyHp?: number; playerHp?: number },
): Promise<Rig & { session: CombatSession }> {
  const scene = new THREE.Scene();
  const player = new THREE.Group();
  const view = mountFloorView(scene, player, seed);
  // A regular fight: the scripted policy is not meant to beat the elite or the guardian.
  const room = view.world.plan.rooms.findIndex((r) => r.encounter?.tier === 'regular');
  const placed = view.world.plan.rooms[room];
  if (placed) view.world.update(placed.position[0], placed.position[1]);
  const bodies = view.world.enemies.get(room);
  if (room < 0 || !bodies?.length) throw new Error('no encounter room');
  const at = bodies[0]?.getWorldPosition(new THREE.Vector3()) as THREE.Vector3;
  const camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.05, 100);
  camera.position.set(at.x, 1.2, at.z + 1);
  scene.add(camera);
  view.world.update(camera.position.x, camera.position.z);
  const actions = new ActionBus();
  const baseListeners = actions.listenerCount();
  const hook = new CombatHook({
    floor: view,
    camera,
    actions,
    syncLabels: false,
    ...(options ? { options } : {}),
  });
  const step = (seconds = DT) => {
    for (let t = 0; t < seconds - 1e-9; t += DT) {
      camera.updateMatrixWorld(true);
      view.update(camera, DT);
      hook.update(DT);
    }
  };
  step(1.2);
  expect(view.encounter.phase).toBe('active');
  const session = await hook.ready();
  if (!session) throw new Error('no session');
  return { view, camera, actions, hook, room, bodies, baseListeners, step, session };
}

/** Emits a combat-pointer action whose ray runs from the camera through `world`. */
function pointerAt(rig: Rig, world: THREE.Vector3, phase: 'down' | 'move' | 'up'): void {
  rig.camera.updateMatrixWorld(true);
  const origin = rig.camera.getWorldPosition(new THREE.Vector3());
  const direction = world.clone().sub(origin).normalize();
  const ndc = world.clone().project(rig.camera);
  rig.actions.emit({
    type: 'combat-pointer',
    phase,
    origin: [origin.x, origin.y, origin.z],
    direction: [direction.x, direction.y, direction.z],
    ndc: [ndc.x, ndc.y],
  });
}

function at(
  session: CombatSession,
  kind: CombatPick,
  key?: number | string,
  u?: number,
  v?: number,
) {
  const p = session.worldOf(kind, key, u, v);
  if (!p) throw new Error(`no ${kind} ${key}`);
  return p;
}

/** Drags a hand card along the mouse ray to `to` over a few frames and lets go. */
function drag(rig: Rig, session: CombatSession, uid: number, to: THREE.Vector3): void {
  const from = at(session, 'card', uid);
  pointerAt(rig, from, 'down');
  rig.step();
  for (let i = 1; i <= 6; i++) {
    pointerAt(rig, from.clone().lerp(to, i / 6), 'move');
    rig.step();
  }
  pointerAt(rig, to, 'up');
  rig.step();
}

/** Traces the awaited sigil's template strokes on the plate with the mouse, then waits for the cast. */
function drawSigil(rig: Rig, session: CombatSession): void {
  const sigil = session.controller.awaitedSigil;
  if (!sigil) throw new Error('no sigil awaited');
  const strokes = SIGIL_TEMPLATES[sigil].strokes;
  const pts = strokes.flat();
  const [minX, maxX] = [Math.min(...pts.map((p) => p.x)), Math.max(...pts.map((p) => p.x))];
  const [minY, maxY] = [Math.min(...pts.map((p) => p.y)), Math.max(...pts.map((p) => p.y))];
  const uv = (p: { x: number; y: number }) =>
    [
      0.15 + (0.7 * (p.x - minX)) / (maxX - minX || 1),
      0.15 + (0.7 * (p.y - minY)) / (maxY - minY || 1),
    ] as const;
  for (const stroke of strokes) {
    stroke.forEach((p, i) => {
      const [u, v] = uv(p);
      pointerAt(rig, at(session, 'plate', undefined, u, v), i === 0 ? 'down' : 'move');
    });
    const last = stroke[stroke.length - 1] as { x: number; y: number };
    const [u, v] = uv(last);
    pointerAt(rig, at(session, 'plate', undefined, u, v), 'up');
    rig.step(0.1);
  }
  rig.step(SIGIL_CAST_SECONDS + 0.1);
}

interface FightLog {
  log: string[];
  rolls: number[];
  verbs: Set<string>;
  outcome: string | null;
}

/** Plays the fight with desktop verbs only: drags at enemies, drops on the table, sigils, dice, End Turn. */
async function playFight(rig: Rig & { session: CombatSession }): Promise<FightLog> {
  const { session } = rig;
  const verbs = new Set<string>();
  const rolls: number[] = [];
  for (let guard = 0; guard < 400 && session.controller.outcome === null; guard++) {
    if (session.awaitingThrow) {
      const roll = session.controller.lastDice;
      pointerAt(rig, at(session, 'throw'), 'down');
      pointerAt(rig, at(session, 'throw'), 'up');
      const before = session.rolls.length;
      for (let i = 0; i < 600 && session.rolls.length === before; i++) rig.step();
      const shown = session.rolls[session.rolls.length - 1];
      expect(shown?.value).toBe(roll?.value);
      const die = dieById(getCard(roll?.cardId ?? '').dice ?? 'brass-d6');
      expect(shown?.face).toBe(die.faces.indexOf(roll?.value ?? -1));
      expect(session.dice.upFace(shown?.id ?? '')).toBe(shown?.face);
      rolls.push(shown?.value ?? -1);
      verbs.add('dice');
      continue;
    }
    if (session.controller.stage === 'sigil') {
      drawSigil(rig, session);
      verbs.add('sigil');
      continue;
    }
    const state = session.controller.state;
    const affordable = state.piles.hand.filter((c) => getCard(c.def.id).cost <= state.player.steam);
    // Attack first, then the rest, so the scripted fight ends.
    const playable = affordable.find((c) => getCard(c.def.id).type === 'attack') ?? affordable[0];
    if (!playable) {
      pointerAt(rig, at(session, 'end-turn'), 'down');
      pointerAt(rig, at(session, 'end-turn'), 'up');
      rig.step();
      verbs.add('end-turn');
      continue;
    }
    const card = getCard(playable.def.id);
    const handBefore = state.piles.hand.length;
    if (card.target === 'enemy') {
      const foe = state.enemies.find((e) => e.hp > 0);
      drag(rig, session, playable.uid, at(session, 'enemy', foe?.id));
      verbs.add('fling');
    } else {
      drag(rig, session, playable.uid, at(session, 'table'));
      verbs.add('drop');
    }
    const stageAfter: string = session.controller.stage;
    const played =
      session.controller.state.piles.hand.length < handBefore || stageAfter === 'sigil';
    if (!played) {
      pointerAt(rig, at(session, 'end-turn'), 'down');
      rig.step();
    }
  }
  rig.step(2);
  return {
    log: [...session.controller.log],
    rolls,
    verbs,
    outcome: session.controller.outcome,
  };
}

describe('combat session', () => {
  it('opens when the encounter goes active with the room encounter and the table pose', async () => {
    const rig = await openFight();
    const { session, view } = rig;
    expect(session.room).toBe(view.encounter.activeRoom);
    const tier = view.world.plan.rooms[rig.room]?.encounter?.tier ?? 'regular';
    const expected = chooseEncounter(view.seed, rig.room, tier, rig.bodies.length);
    expect(session.controller.state.enemies.map((e) => e.id.replace(/-\d+$/, ''))).toEqual(
      expected.enemies,
    );
    expect(session.enemies).toHaveLength(Math.min(rig.bodies.length, expected.enemies.length));
    const pose = view.encounter.tablePose;
    expect(pose).not.toBeNull();
    const tray = session.dice.root.getWorldPosition(new THREE.Vector3());
    expect(Math.hypot(tray.x - (pose?.x ?? 0), tray.z - (pose?.z ?? 0))).toBeLessThan(0.5);
    expect(tray.y).toBeCloseTo(pose?.height ?? 0, 1);
    expect(session.fan.count).toBe(session.controller.state.piles.hand.length);
    expect(rig.actions.listenerCount()).toBeGreaterThan(rig.baseListeners);
    rig.hook.dispose();
  });

  it('wins a desktop fight driven only by actions, then ends the encounter and tears down', async () => {
    const rig = await openFight();
    const end = vi.spyOn(rig.view.encounter, 'end');
    const result = await playFight(rig);
    expect(result.outcome).toBe('won');
    expect(end).toHaveBeenCalledWith('win');
    expect(result.verbs).toEqual(new Set(['fling', 'drop', 'dice', 'sigil', 'end-turn']));
    expect(result.rolls.length).toBeGreaterThan(0);
    rig.step(1);
    expect(rig.view.encounter.phase).toBe('idle');
    expect(rig.view.encounter.isCleared(rig.room)).toBe(true);
    expect(rig.view.locked).toBe(false);
    expect(rig.hook.session).toBeNull();
    // Teardown: every bus listener released, every visual detached.
    expect(rig.actions.listenerCount()).toBe(rig.baseListeners);
    expect(rig.view.world.group.getObjectByName('combat-session')).toBeUndefined();
    expect(rig.camera.getObjectByName('desktop-hand')).toBeUndefined();
    expect(rig.view.world.group.getObjectByName('dice-presenter')).toBeUndefined();
  }, 60_000);

  it('a lost fight ends the encounter in defeat and shows the banner', async () => {
    const rig = await openFight('SPIRE002', { playerHp: 1 });
    const end = vi.spyOn(rig.view.encounter, 'end');
    for (let i = 0; i < 20 && rig.session.controller.outcome === null; i++) {
      rig.actions.emit({ type: 'end-turn' });
      rig.step();
    }
    expect(rig.session.controller.outcome).toBe('lost');
    rig.step(0.1);
    expect(rig.hook.banner).toBe('DEFEAT');
    rig.step(2);
    expect(end).toHaveBeenCalledWith('defeat');
    expect(rig.view.encounter.isCleared(rig.room)).toBe(false);
    rig.step(1);
    expect(rig.hook.session).toBeNull();
    expect(rig.actions.listenerCount()).toBe(rig.baseListeners);
  });

  it('replays the same fight identically from the same seed', async () => {
    const a = await playFight(await openFight());
    const b = await playFight(await openFight());
    expect(b.log).toEqual(a.log);
    expect(b.rolls).toEqual(a.rolls);
  }, 120_000);
});

describe('dice presenter', () => {
  it('lands every throw on the engine face', async () => {
    const presenter = await DicePresenter.create(Stream.fromKey('TEST0001:dice-throw'), {
      halfX: 0.2,
      halfZ: 0.11,
    });
    for (const [kind, face] of [
      ['d6', 0],
      ['d6', 4],
      ['d8', 7],
      ['d8', 2],
    ] as const) {
      let settled: number | null = null;
      const off = presenter.onSettled((roll) => {
        settled = roll.face;
      });
      const id = presenter.throw(kind, face, face + 1);
      for (let i = 0; i < 900 && settled === null; i++) presenter.update(DT);
      off();
      expect(settled).toBe(face);
      expect(presenter.upFace(id)).toBe(face);
    }
    presenter.dispose();
  });
});
