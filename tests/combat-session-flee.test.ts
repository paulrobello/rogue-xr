import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  CombatHook,
  type CombatHookDeps,
  type CombatSession,
  FLEE_WAIT,
} from '../src/combat/combat-session.ts';
import { ActionBus } from '../src/core/actions.ts';
import { type FloorView, mountFloorView } from '../src/world/floor-view.ts';

const DT = 1 / 60;
type Ended = Parameters<NonNullable<CombatHookDeps['onEnd']>>[0];

interface Rig {
  view: FloorView;
  camera: THREE.PerspectiveCamera;
  actions: ActionBus;
  hook: CombatHook;
  room: number;
  ends: Ended[];
  session: CombatSession;
  step(seconds?: number): void;
}

/**
 * Opens a fight in the first regular room (with `enemies` automatons, when given) or the guardian's,
 * standing 1 m south of an automaton.
 */
async function openFight(
  tier: 'regular' | 'guardian' = 'regular',
  seed = 'SPIRE002',
  enemies = 0,
): Promise<Rig> {
  const scene = new THREE.Scene();
  const view = mountFloorView(scene, new THREE.Group(), seed);
  const room =
    tier === 'guardian'
      ? view.world.plan.guardianRoom
      : view.world.plan.rooms.findIndex(
          (r) =>
            r.encounter?.tier === 'regular' &&
            (enemies === 0 || r.encounter.socketIds.length === enemies),
        );
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
  const ends: Ended[] = [];
  const hook = new CombatHook({
    floor: view,
    camera,
    actions,
    syncLabels: false,
    models: null,
    onEnd: (end) => ends.push(end),
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
  return { view, camera, actions, hook, room, ends, session, step };
}

/** Emits a combat-pointer press and release along the ray from the camera through `world`. */
function click(rig: Rig, world: THREE.Vector3): void {
  rig.camera.updateMatrixWorld(true);
  const origin = rig.camera.getWorldPosition(new THREE.Vector3());
  const direction = world.clone().sub(origin).normalize();
  for (const phase of ['down', 'up'] as const) {
    rig.actions.emit({
      type: 'combat-pointer',
      phase,
      origin: [origin.x, origin.y, origin.z],
      direction: [direction.x, direction.y, direction.z],
    });
  }
}

describe('Flee control (card B)', () => {
  it('a regular fight shows FLEE beside END TURN; the guardian fight has none and refuses', async () => {
    const regular = await openFight('regular');
    expect(regular.session.fleeable).toBe(true);
    expect(regular.session.worldOf('flee')).not.toBeNull();
    expect(regular.session.hudPoints().map((e) => e.name)).toContain('flee');
    regular.hook.dispose();

    const guardian = await openFight('guardian');
    expect(guardian.session.fleeable).toBe(false);
    expect(guardian.session.worldOf('flee')).toBeNull();
    expect(guardian.session.hudPoints().map((e) => e.name)).not.toContain('flee');
    expect(guardian.session.flee()).toBe(false);
    guardian.step(0.2);
    expect(guardian.ends).toEqual([]);
    expect(guardian.view.encounter.phase).toBe('active');
    guardian.hook.dispose();
  }, 60_000);

  it('clicking FLEE ends the fight with hp kept, sends the automatons home uncleared, and a new touch fights again', async () => {
    const rig = await openFight('regular');
    const hp = rig.session.controller.state.player.hp;
    const flee = rig.session.worldOf('flee') as THREE.Vector3;
    click(rig, flee);
    expect(rig.ends).toEqual([{ room: rig.room, outcome: 'flee', playerHp: hp }]);
    expect(rig.view.encounter.phase).toBe('folding');
    expect(rig.hook.banner).toBe('');
    rig.step(1);
    expect(rig.view.encounter.phase).toBe('idle');
    expect(rig.view.encounter.isCleared(rig.room)).toBe(false);
    expect(rig.hook.session).toBeNull();
    const live = (rig.view.world.enemies.get(rig.room) ?? []).filter((b) => b.parent !== null);
    expect(live.length).toBeGreaterThan(0);

    // Walk away, past the retry cooldown, then back up to an automaton: a fresh fight at full health.
    rig.camera.position.x += 40;
    rig.step(2);
    const at = live[0]?.getWorldPosition(new THREE.Vector3()) as THREE.Vector3;
    rig.camera.position.set(at.x, 1.2, at.z + 1);
    rig.step(1.2);
    expect(rig.view.encounter.phase).toBe('active');
    const again = await rig.hook.ready();
    expect(again).not.toBeNull();
    expect(again).not.toBe(rig.session);
    for (const enemy of again?.controller.state.enemies ?? []) expect(enemy.hp).toBe(enemy.maxHp);
    rig.hook.dispose();
  }, 60_000);

  it('refuses a flee while the enemies act, without queueing it', async () => {
    const rig = await openFight('regular');
    rig.actions.emit({ type: 'end-turn' });
    rig.step();
    expect(rig.session.enemyPhase).toBe(true);
    expect(rig.session.flee()).toBe(false);
    for (let t = 0; t < 15 && rig.session.enemyPhase; t += DT) rig.step();
    expect(rig.session.enemyPhase).toBe(false);
    rig.step(0.2);
    expect(rig.ends).toEqual([]);
    // Back in the player's input window it works.
    expect(rig.session.flee()).toBe(true);
    expect(rig.ends.map((e) => e.outcome)).toEqual(['flee']);
    rig.hook.dispose();
  }, 60_000);

  it('the desktop HUD fit keeps FLEE in view and clear of END TURN', async () => {
    const rig = await openFight('regular');
    const pose = rig.view.encounter.tablePose;
    if (!pose) throw new Error('no table pose');
    const yaw = (pose.yaw * Math.PI) / 180;
    const camera = new THREE.PerspectiveCamera(70, 1.6, 0.05, 100);
    camera.position.set(
      pose.x - Math.sin(yaw) * 0.5,
      pose.height + 0.75,
      pose.z + Math.cos(yaw) * 0.5,
    );
    camera.rotation.set(-0.53, -yaw, 0, 'YXZ');
    rig.session.fitHudToView(camera);
    camera.updateMatrixWorld(true);
    const rect = (name: string) => {
      const points = rig.session.hudPoints().find((e) => e.name === name)?.points ?? [];
      const ndc = points.map((p) => p.clone().project(camera));
      return {
        x0: Math.min(...ndc.map((p) => p.x)),
        x1: Math.max(...ndc.map((p) => p.x)),
        y0: Math.min(...ndc.map((p) => p.y)),
        y1: Math.max(...ndc.map((p) => p.y)),
      };
    };
    const flee = rect('flee');
    const end = rect('end-turn');
    for (const v of [flee.x0, flee.x1, flee.y0, flee.y1])
      expect(Math.abs(v)).toBeLessThanOrEqual(1);
    const overlap = flee.x0 < end.x1 && flee.x1 > end.x0 && flee.y0 < end.y1 && flee.y1 > end.y0;
    expect(overlap).toBe(false);
    rig.hook.dispose();
  }, 60_000);
});

describe('fleeing after a kill', () => {
  it('a killed automaton stays dead; the survivor fights again at full health', async () => {
    const seed = ['SPIRE001', 'SPIRE002', 'BRASS042', 'GEARS777', 'SPIRE003', 'SPIRE004'].find(
      (candidate) =>
        mountFloorView(new THREE.Scene(), new THREE.Group(), candidate).world.plan.rooms.some(
          (r) => r.encounter?.tier === 'regular' && r.encounter.socketIds.length === 2,
        ),
    );
    if (!seed) throw new Error('no two-automaton regular room in the test seeds');
    const rig = await openFight('regular', seed, 2);
    const { controller } = rig.session;
    const [first, second] = rig.session.enemies;
    if (!first || !second) throw new Error('expected two automatons');
    controller.state = {
      ...controller.state,
      enemies: controller.state.enemies.map((e) => (e.id === first.id ? { ...e, hp: 0 } : e)),
    };
    expect(rig.session.flee()).toBe(true);
    expect(first.body.parent).toBeNull();
    expect(second.body.parent).not.toBeNull();
    rig.step(1);
    expect(rig.view.encounter.phase).toBe('idle');
    rig.camera.position.x += 40;
    rig.step(2);
    const at = second.body.getWorldPosition(new THREE.Vector3());
    rig.camera.position.set(at.x, 1.2, at.z + 1);
    rig.step(1.2);
    const again = await rig.hook.ready();
    expect(again?.enemies).toHaveLength(1);
    for (const enemy of again?.controller.state.enemies ?? []) expect(enemy.hp).toBe(enemy.maxHp);
    rig.hook.dispose();
  }, 60_000);
});

describe('pausing a fight (card A)', () => {
  it('a paused fight ignores input and stands still, and resumes where it was', async () => {
    const rig = await openFight('regular');
    rig.actions.emit({ type: 'end-turn' });
    rig.step();
    expect(rig.session.enemyPhase).toBe(true);
    rig.hook.paused = true;
    const clock = rig.session.time;
    rig.step(5);
    expect(rig.session.paused).toBe(true);
    expect(rig.session.time).toBe(clock);
    expect(rig.session.enemyPhase).toBe(true);
    expect(rig.session.flee()).toBe(false);
    rig.hook.paused = false;
    for (let t = 0; t < 15 && rig.session.enemyPhase; t += DT) rig.step();
    expect(rig.session.enemyPhase).toBe(false);
    const turn = rig.session.controller.state.turn;
    rig.hook.paused = true;
    rig.step();
    rig.actions.emit({ type: 'end-turn' });
    click(rig, rig.session.worldOf('flee') as THREE.Vector3);
    rig.step();
    expect(rig.session.controller.state.turn).toBe(turn);
    expect(rig.session.enemyPhase).toBe(false);
    expect(rig.ends).toEqual([]);
    expect(rig.session.message).not.toBe(FLEE_WAIT);
    rig.hook.dispose();
  }, 60_000);
});
