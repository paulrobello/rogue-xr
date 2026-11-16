/**
 * H1 (Quest 3 playtest 2026-11-16): after a defeat in the guardian vault the Grand Escapement walked
 * back to its socket, which is where the fight triggered (within 1.2 m of the seat), and stood over
 * the player's head; it was still there over the title board. These pin the head clearance on every
 * way a fight ends without a win, and the teardown the title path runs (main.ts `freshFloor`).
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { CombatHook } from '../src/combat/combat-session.ts';
import { EncounterDirector, enemyReach, HEAD_CLEARANCE } from '../src/combat/encounter.ts';
import { headingTo } from '../src/combat/placement.ts';
import { ActionBus } from '../src/core/actions.ts';
import { generateFloor } from '../src/floor/generate.ts';
import { mountFloorView } from '../src/world/floor-view.ts';
import { buildFloorWorld } from '../src/world/floor-world.ts';

const DT = 1 / 60;

function run(director: EncounterDirector, seconds: number, dt = 0.05): void {
  for (let i = 0; i < Math.round(seconds / dt); i++) director.update(dt);
}

/** The guardian vault of `seed` with the player standing `gap` metres from the guardian, facing it. */
function vault(seed: string, gap: number) {
  const plan = generateFloor(seed);
  const room = plan.guardianRoom;
  const world = buildFloorWorld(plan);
  world.current = room;
  world.group.updateMatrixWorld(true);
  const guardian = world.enemies.get(room)?.[0] as THREE.Object3D;
  const at = guardian.getWorldPosition(new THREE.Vector3());
  const fp = world.rooms[room]?.footprint as { min: [number, number]; max: [number, number] };
  const cx = (fp.min[0] + fp.max[0]) / 2;
  const cz = (fp.min[1] + fp.max[1]) / 2;
  const len = Math.hypot(cx - at.x, cz - at.z) || 1;
  const x = at.x + ((cx - at.x) / len) * gap;
  const z = at.z + ((cz - at.z) / len) * gap;
  const player = { x, z, yaw: headingTo([x, z], [at.x, at.z]), eyeHeight: 1.6 };
  return { world, room, guardian, player };
}

/** Floor distance from the seat to the guardian, less its reach: the space left around the head. */
function headroom(guardian: THREE.Object3D, seat: { x: number; z: number }): number {
  const p = guardian.getWorldPosition(new THREE.Vector3());
  return Math.hypot(p.x - seat.x, p.z - seat.z) - enemyReach(guardian);
}

describe('H1 guardian head clearance when a fight ends without a win', () => {
  for (const seed of ['SPIRE001', 'SPIRE002', 'SPIRE003']) {
    it(`a defeat leaves the guardian on its combat slot, clear of the head (${seed})`, () => {
      // The trigger fires at 1.2 m, so the player stands about there when the fight opens.
      const { world, room, guardian, player } = vault(seed, 1.15);
      const director = new EncounterDirector({ world, lockLocomotion: () => {} });
      expect(director.begin(room, player).ok).toBe(true);
      run(director, 1);
      const slot = guardian.getWorldPosition(new THREE.Vector3());
      director.end('defeat');
      for (let t = 0; t < 1.5; t += 0.05) {
        director.update(0.05);
        expect(headroom(guardian, player)).toBeGreaterThanOrEqual(HEAD_CLEARANCE);
      }
      expect(director.phase).toBe('idle');
      expect(guardian.getWorldPosition(new THREE.Vector3()).distanceTo(slot)).toBeLessThan(1e-6);
      expect(Math.hypot(slot.x - player.x, slot.z - player.z)).toBeGreaterThan(2);
    });
  }

  it('a flee never walks a guardian as wide as the Grand Escapement back into the head', () => {
    const { world, room, guardian, player } = vault('SPIRE002', 1.15);
    // The authored guardian is 3.54 m across its arms (grand-escapement.manifest.json bounds).
    guardian.scale.x = 3.54 / 1.2;
    world.group.updateMatrixWorld(true);
    expect(enemyReach(guardian)).toBeGreaterThan(1.7);
    const director = new EncounterDirector({ world, lockLocomotion: () => {} });
    expect(director.begin(room, player).ok).toBe(true);
    run(director, 1);
    director.end('flee');
    for (let t = 0; t < 1.5; t += 0.05) {
      director.update(0.05);
      expect(headroom(guardian, player)).toBeGreaterThanOrEqual(HEAD_CLEARANCE);
    }
    expect(director.phase).toBe('idle');
  });

  it('a flee still sends an automaton home when its home is clear of the head', () => {
    const { world, room, guardian, player } = vault('SPIRE002', 3);
    const home = guardian.position.clone();
    const director = new EncounterDirector({ world, lockLocomotion: () => {} });
    expect(director.begin(room, player).ok).toBe(true);
    run(director, 1);
    expect(guardian.position.distanceTo(home)).toBeGreaterThan(0.1);
    director.end('flee');
    run(director, 1.5);
    expect(guardian.position.distanceTo(home)).toBeLessThan(1e-6);
  });
});

describe('H1 defeat to title teardown', () => {
  it('a lost guardian fight keeps the head clear, and the title teardown leaves no encounter visual', async () => {
    const scene = new THREE.Scene();
    const rig = new THREE.Group();
    scene.add(rig);
    const view = mountFloorView(scene, rig, 'SPIRE002');
    const room = view.world.plan.guardianRoom;
    const placed = view.world.plan.rooms[room];
    if (placed) view.world.update(placed.position[0], placed.position[1]);
    const guardian = view.world.enemies.get(room)?.[0] as THREE.Object3D;
    const at = guardian.getWorldPosition(new THREE.Vector3());
    const camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.05, 100);
    camera.position.set(at.x, 1.2, at.z + 1.1);
    scene.add(camera);
    view.world.update(camera.position.x, camera.position.z);
    const actions = new ActionBus();
    const baseListeners = actions.listenerCount();
    const outcomes: string[] = [];
    const hook = new CombatHook({
      floor: view,
      camera,
      actions,
      syncLabels: false,
      models: null,
      options: { playerHp: 1 },
      onEnd: ({ outcome }) => outcomes.push(outcome),
    });
    const step = (seconds: number) => {
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
    for (let i = 0; i < 20 && session.controller.outcome === null; i++) {
      actions.emit({ type: 'end-turn' });
      step(DT);
    }
    expect(session.controller.outcome).toBe('lost');
    const seat = { x: camera.position.x, z: camera.position.z };
    for (let t = 0; t < 12 && view.encounter.phase !== 'idle'; t += DT) {
      step(DT);
      for (const body of view.world.enemies.get(room) ?? []) {
        if (body.parent) expect(headroom(body, seat)).toBeGreaterThanOrEqual(HEAD_CLEARANCE);
      }
    }
    expect(outcomes).toEqual(['defeat']);
    expect(view.encounter.phase).toBe('idle');
    expect(hook.session).toBeNull();

    // main.ts on the title after a finished run: `freshFloor` disposes the hook and the floor.
    hook.dispose();
    view.dispose();
    expect(actions.listenerCount()).toBe(baseListeners);
    const left: string[] = [];
    scene.traverse((node) => {
      if (
        node.name === 'combat-session' ||
        node.name === 'dice-presenter' ||
        node.name.startsWith('enemy-') ||
        node.name.startsWith('floor-') ||
        node.name === 'combat-table-fit' ||
        node.name === 'leaf-left'
      )
        left.push(node.name);
    });
    expect(left).toEqual([]);
  }, 60_000);
});
