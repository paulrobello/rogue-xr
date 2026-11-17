/**
 * H2 (Quest 3 playtest 2026-11-16): "any dice rolling cards finish before i even roll the dice". The
 * rules roll a dice card's die and apply it on play (seeded, so the throw lands on that face), and the
 * session showed the effects at once. The session now holds a dice card's effects, log line and
 * banner until the player's own throw settles, with a 30 s auto-throw and a 6 s settle fallback.
 */
import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import {
  CombatHook,
  type CombatPick,
  type CombatSession,
  DICE_AUTO_THROW_SECONDS,
  DICE_SETTLE_FALLBACK_SECONDS,
} from '../src/combat/combat-session.ts';
import { ActionBus } from '../src/core/actions.ts';
import { mountFloorView } from '../src/world/floor-view.ts';

const DT = 1 / 60;

async function openFight(options: { enemyHp?: number; deck?: readonly string[] }) {
  const scene = new THREE.Scene();
  const view = mountFloorView(scene, new THREE.Group(), 'SPIRE002');
  const room = view.world.plan.rooms.findIndex((r) => r.encounter?.tier === 'regular');
  const placed = view.world.plan.rooms[room];
  if (placed) view.world.update(placed.position[0], placed.position[1]);
  const at = view.world.enemies.get(room)?.[0]?.getWorldPosition(new THREE.Vector3());
  if (!at) throw new Error('no encounter room');
  const camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.05, 100);
  camera.position.set(at.x, 1.2, at.z + 1);
  scene.add(camera);
  view.world.update(camera.position.x, camera.position.z);
  const actions = new ActionBus();
  const hook = new CombatHook({
    floor: view,
    camera,
    actions,
    syncLabels: false,
    models: null,
    options,
  });
  const step = (seconds = DT) => {
    for (let t = 0; t < seconds - 1e-9; t += DT) {
      camera.updateMatrixWorld(true);
      view.update(camera, DT);
      hook.update(DT);
    }
  };
  step(1.2);
  const session = await hook.ready();
  if (!session) throw new Error('no session');
  return { view, camera, actions, hook, session, step };
}
type Rig = Awaited<ReturnType<typeof openFight>>;

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

function at(session: CombatSession, kind: CombatPick, key?: number | string): THREE.Vector3 {
  const p = session.worldOf(kind, key);
  if (!p) throw new Error(`no ${kind} ${key}`);
  return p;
}

/** Flings the first hand card at the first living enemy with the mouse. */
function flingFirstCard(rig: Rig): void {
  const { session } = rig;
  const card = session.controller.state.piles.hand[0];
  const foe = session.controller.state.enemies.find((e) => e.hp > 0);
  if (!card || !foe) throw new Error('nothing to play');
  const from = at(session, 'card', card.uid);
  const to = at(session, 'enemy', foe.id);
  pointerAt(rig, from, 'down');
  rig.step();
  for (let i = 1; i <= 6; i++) {
    pointerAt(rig, from.clone().lerp(to, i / 6), 'move');
    rig.step();
  }
  pointerAt(rig, to, 'up');
  rig.step();
}

const enemyHp = (state: CombatSession['view']) => state.enemies.map((e) => e.hp);

/** Steps until the attack's bolt (sent once the die settles) has landed on the enemy. */
function waitFlight(rig: Rig): void {
  for (let i = 0; i < 120 && rig.session.attackInFlight; i++) rig.step();
  expect(rig.session.attackInFlight).toBe(false);
}

describe('H2 a dice card waits for its die', () => {
  it('shows nothing of the card until the player throws and the die settles', async () => {
    const rig = await openFight({ deck: Array(10).fill('cog-toss') });
    const { session } = rig;
    const before = enemyHp(session.view);
    const logBefore = session.log.length;
    flingFirstCard(rig);
    // The rules have applied the card; the view has not.
    expect(session.awaitingThrow).toBe(true);
    expect(session.stage).toBe('dice');
    expect(enemyHp(session.controller.state)).not.toEqual(before);
    rig.step(10);
    expect(session.awaitingThrow).toBe(true);
    expect(enemyHp(session.view)).toEqual(before);
    expect(session.log.length).toBe(logBefore);
    // Every other verb waits for the throw.
    const frozen = JSON.stringify(session.controller.state);
    rig.actions.emit({ type: 'end-turn' });
    rig.step();
    expect(JSON.stringify(session.controller.state)).toBe(frozen);
    expect(session.message).toBe('Throw the dice first');

    rig.actions.emit({ type: 'throw-dice' });
    rig.step();
    expect(session.awaitingThrow).toBe(false);
    expect(session.awaitingDice).toBe(true);
    expect(session.stage).toBe('dice');
    expect(enemyHp(session.view)).toEqual(before);
    rig.actions.emit({ type: 'end-turn' });
    rig.step();
    expect(JSON.stringify(session.controller.state)).toBe(frozen);
    expect(session.message).toBe('The dice are rolling');

    for (let i = 0; i < 600 && session.rolls.length === 0; i++) rig.step();
    expect(session.rolls).toHaveLength(1);
    expect(session.rolls[0]?.value).toBe(session.controller.lastDice?.value);
    rig.step();
    expect(session.awaitingDice).toBe(false);
    expect(session.stage).toBe('idle');
    // The settled die sends the attack's bolt; its damage shows when the bolt lands.
    expect(session.attackInFlight).toBe(true);
    expect(enemyHp(session.view)).toEqual(before);
    waitFlight(rig);
    expect(enemyHp(session.view)).toEqual(enemyHp(session.controller.state));
    expect(session.log.length).toBeGreaterThan(logBefore);
    rig.hook.dispose();
  }, 60_000);

  it(`throws for an idle player after ${DICE_AUTO_THROW_SECONDS} s, not before`, async () => {
    const rig = await openFight({ deck: Array(10).fill('cog-toss') });
    const { session } = rig;
    flingFirstCard(rig);
    expect(session.awaitingThrow).toBe(true);
    rig.step(DICE_AUTO_THROW_SECONDS - 1);
    expect(session.awaitingThrow).toBe(true);
    rig.step(1.5);
    expect(session.awaitingThrow).toBe(false);
    for (let i = 0; i < 600 && session.awaitingDice; i++) rig.step();
    expect(session.rolls).toHaveLength(1);
    waitFlight(rig);
    expect(enemyHp(session.view)).toEqual(enemyHp(session.controller.state));
    rig.hook.dispose();
  }, 60_000);

  it(`releases the card ${DICE_SETTLE_FALLBACK_SECONDS} s after a throw whose die never settles`, async () => {
    const rig = await openFight({ deck: Array(10).fill('cog-toss') });
    const { session } = rig;
    flingFirstCard(rig);
    // A die that never comes to rest.
    vi.spyOn(session.dice, 'update').mockImplementation(() => {});
    rig.actions.emit({ type: 'throw-dice' });
    rig.step(DICE_SETTLE_FALLBACK_SECONDS - 0.5);
    expect(session.awaitingDice).toBe(true);
    rig.step(1);
    expect(session.awaitingDice).toBe(false);
    waitFlight(rig);
    expect(enemyHp(session.view)).toEqual(enemyHp(session.controller.state));
    vi.restoreAllMocks();
    rig.hook.dispose();
  }, 60_000);

  it('holds a killing dice card and its victory banner until the die settles', async () => {
    const rig = await openFight({ enemyHp: 1, deck: Array(10).fill('cog-toss') });
    const { session } = rig;
    const end = vi.spyOn(rig.view.encounter, 'end');
    let guard = 0;
    while (session.controller.outcome === null && guard++ < 6) {
      flingFirstCard(rig);
      if (session.controller.outcome !== null) break;
      rig.actions.emit({ type: 'throw-dice' });
      for (let i = 0; i < 600 && session.awaitingDice; i++) rig.step();
    }
    expect(session.controller.outcome).toBe('won');
    expect(session.awaitingThrow).toBe(true);
    rig.step(5);
    expect(rig.hook.banner).toBe('');
    expect(end).not.toHaveBeenCalled();
    expect(session.view.enemies.some((e) => e.hp > 0)).toBe(true);
    // The mouse can still throw once the rules have decided the fight.
    pointerAt(rig, at(session, 'throw'), 'down');
    pointerAt(rig, at(session, 'throw'), 'up');
    expect(session.awaitingThrow).toBe(false);
    for (let i = 0; i < 600 && session.awaitingDice; i++) rig.step();
    // The killing bolt is still flying: the banner waits for it to land.
    expect(rig.hook.banner).toBe('');
    waitFlight(rig);
    rig.step(0.2);
    expect(rig.hook.banner).toBe('VICTORY');
    rig.step(6);
    expect(end).toHaveBeenCalledWith('win');
    vi.restoreAllMocks();
    rig.hook.dispose();
  }, 60_000);
});
