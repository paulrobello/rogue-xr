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
  DESKTOP_DICE_HINT,
  DICE_AUTO_THROW_SECONDS,
  DICE_SETTLE_FALLBACK_SECONDS,
  XR_DICE_HINT,
} from '../src/combat/combat-session.ts';
import { ActionBus } from '../src/core/actions.ts';
import { mountFloorView } from '../src/world/floor-view.ts';

const DT = 1 / 60;

async function openFight(options: {
  enemyHp?: number;
  deck?: readonly string[];
  bonusDice?: number;
}) {
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

/** Plays the first hand card at the first living enemy with the mouse: click it up, click the enemy. */
function flingFirstCard(rig: Rig): void {
  const { session } = rig;
  const card = session.controller.state.piles.hand[0];
  const foe = session.controller.state.enemies.find((e) => e.hp > 0);
  if (!card || !foe) throw new Error('nothing to play');
  const from = at(session, 'card', card.uid);
  const to = at(session, 'enemy', foe.id);
  pointerAt(rig, from, 'down');
  pointerAt(rig, from, 'up');
  rig.step();
  for (let i = 1; i <= 6; i++) {
    pointerAt(rig, from.clone().lerp(to, i / 6), 'move');
    rig.step();
  }
  pointerAt(rig, to, 'down');
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
    pointerAt(rig, at(session, 'dice'), 'down');
    pointerAt(rig, at(session, 'dice'), 'up');
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

/**
 * F11 (Quest 3 playtest 2026-11-17): "the throw button should not be needed the dice should light up /
 * pulse to indicate that it needs to be thrown". There is no THROW button: a rolled die waits in the
 * tray, pulsing, with a table hint; the mouse clicks it, the XR main hand grabs it and lets go.
 */
describe('F11 the rolled die pulses in the tray until it is thrown', () => {
  it('shows a pulsing die and a hint while a throw is due, and a click on the die throws it', async () => {
    const rig = await openFight({ deck: Array(10).fill('cog-toss') });
    const { session } = rig;
    expect(session.dice.waiting).toBeNull();
    expect(session.hint).toBe('');
    expect(rig.view.world.group.getObjectByName('throw-dice')).toBeUndefined();
    flingFirstCard(rig);
    expect(session.awaitingThrow).toBe(true);
    expect(session.dice.waiting).not.toBeNull();
    expect(session.hint).toBe(DESKTOP_DICE_HINT);
    const pulse: number[] = [];
    for (let i = 0; i < 90; i++) {
      rig.step();
      pulse.push(session.dice.pulse);
    }
    // It swells and fades: the halo runs from dim to full over each 1.1 s pulse.
    expect(Math.min(...pulse)).toBeLessThan(0.4);
    expect(Math.max(...pulse)).toBeGreaterThan(0.9);

    pointerAt(rig, at(session, 'dice'), 'down');
    pointerAt(rig, at(session, 'dice'), 'up');
    rig.step();
    expect(session.awaitingThrow).toBe(false);
    expect(session.dice.waiting).toBeNull();
    expect(session.dice.pulse).toBe(0);
    expect(session.hint).toBe('');
    for (let i = 0; i < 600 && session.awaitingDice; i++) rig.step();
    expect(session.rolls[0]?.value).toBe(session.controller.lastDice?.value);
    rig.hook.dispose();
  }, 60_000);

  it('throws in XR when the main hand grabs the die and lets go over the tray', async () => {
    const rig = await openFight({ deck: Array(10).fill('cog-toss') });
    const { session, camera } = rig;
    flingFirstCard(rig);
    expect(session.awaitingThrow).toBe(true);
    const scene = camera.parent as THREE.Scene;
    const head = camera.getWorldPosition(new THREE.Vector3());
    const main = new THREE.Group();
    const mainRay = new THREE.Group();
    const off = new THREE.Group();
    off.position.copy(head).add(new THREE.Vector3(-0.18, -0.3, -0.3));
    main.position.copy(head).add(new THREE.Vector3(0.18, -0.3, -0.3));
    scene.add(main, mainRay, off);
    const xr = { main, mainRay, off };
    const step = (seconds = 1 / 60) => {
      for (let t = 0; t < seconds - 1e-9; t += 1 / 60) {
        camera.updateMatrixWorld(true);
        rig.view.update(camera, 1 / 60);
        rig.hook.update(1 / 60, xr);
      }
    };
    const hand = (control: 'squeeze' | 'trigger', pressed: boolean) =>
      rig.actions.emit({ type: 'combat-hand', hand: 'main', control, pressed });
    step();
    expect(session.hint).toBe(XR_DICE_HINT);
    hand('squeeze', true);
    step();
    // The die follows the hand while it is held.
    const die = session.dice.waiting as THREE.Object3D;
    const tray = at(session, 'dice');
    main.position.copy(tray).add(new THREE.Vector3(0.02, 0.12, 0));
    main.updateMatrixWorld(true);
    step();
    expect(die.getWorldPosition(new THREE.Vector3()).distanceTo(main.position)).toBeLessThan(1e-6);
    expect(session.awaitingThrow).toBe(true);
    hand('squeeze', false);
    step();
    expect(session.awaitingThrow).toBe(false);
    expect(session.dice.waiting).toBeNull();
    for (let i = 0; i < 600 && session.awaitingDice; i++) step();
    expect(session.rolls).toHaveLength(1);
    expect(session.rolls[0]?.value).toBe(session.controller.lastDice?.value);
    rig.hook.dispose();
  }, 60_000);

  // Card verbs (playtest 2026-11-17): grab the dice card, the trigger plays it at the aimed enemy
  // and the gripping hand takes its die; letting go throws. Letting go of the card instead puts it
  // back with nothing rolled.
  it('in XR a held dice card is put back by letting go, or used by the trigger, which hands over the die', async () => {
    const rig = await openFight({ deck: Array(10).fill('cog-toss') });
    const { session, camera } = rig;
    const scene = camera.parent as THREE.Scene;
    const head = camera.getWorldPosition(new THREE.Vector3());
    const main = new THREE.Group();
    const mainRay = new THREE.Group();
    const off = new THREE.Group();
    off.position.copy(head).add(new THREE.Vector3(-0.18, -0.3, -0.3));
    scene.add(main, mainRay, off);
    const xr = { main, mainRay, off };
    const rest = head.clone().add(new THREE.Vector3(0.18, -0.3, -0.3));
    const pose = (target: THREE.Vector3) => {
      for (const o of [main, mainRay]) {
        o.position.copy(rest);
        o.lookAt(target);
        o.rotateY(Math.PI);
        o.updateMatrixWorld(true);
      }
    };
    const step = (seconds = 1 / 60) => {
      for (let t = 0; t < seconds - 1e-9; t += 1 / 60) {
        camera.updateMatrixWorld(true);
        rig.view.update(camera, 1 / 60);
        rig.hook.update(1 / 60, xr);
      }
    };
    const hand = (control: 'squeeze' | 'trigger', pressed: boolean) =>
      rig.actions.emit({ type: 'combat-hand', hand: 'main', control, pressed });
    step();
    const handSize = session.controller.state.piles.hand.length;
    const card = () => at(session, 'card', session.controller.state.piles.hand[0]?.uid as number);

    pose(card());
    step();
    hand('squeeze', true);
    step();
    expect(session.holdingCard).toBe(true);
    hand('squeeze', false);
    step(0.5);
    expect(session.holdingCard).toBe(false);
    expect(session.awaitingThrow).toBe(false);
    expect(session.controller.lastDice).toBeNull();
    expect(session.controller.state.piles.hand).toHaveLength(handSize);

    pose(card());
    step();
    hand('squeeze', true);
    step();
    const foe = session.controller.state.enemies.find((e) => e.hp > 0);
    if (!foe) throw new Error('no enemy');
    pose(at(session, 'enemy', foe.id));
    step();
    hand('trigger', true);
    hand('trigger', false);
    step(0.1);
    expect(session.fling.lastDecision).toMatchObject({ outcome: 'played', targetId: foe.id });
    expect(session.awaitingThrow).toBe(true);
    // The die is in the gripping hand.
    const die = session.dice.waiting as THREE.Object3D;
    main.position.add(new THREE.Vector3(0.05, 0.05, 0));
    main.updateMatrixWorld(true);
    step();
    expect(die.getWorldPosition(new THREE.Vector3()).distanceTo(main.position)).toBeLessThan(1e-6);
    hand('squeeze', false);
    step();
    expect(session.awaitingThrow).toBe(false);
    for (let i = 0; i < 600 && session.awaitingDice; i++) step();
    expect(session.rolls).toHaveLength(1);
    rig.hook.dispose();
  }, 60_000);
});

it('renders and settles both Spare Die rolls before releasing effects', async () => {
  const rig = await openFight({ deck: Array(10).fill('cog-toss'), bonusDice: 1 });
  const { session } = rig;
  flingFirstCard(rig);
  const readout = session.controller.lastDice;
  expect(readout?.rolls).toHaveLength(2);
  expect(session.awaitingThrow).toBe(true);
  rig.actions.emit({ type: 'throw-dice' });
  for (let i = 0; i < 600 && session.awaitingDice; i++) rig.step();
  expect(session.rolls).toHaveLength(2);
  expect(session.message).toBe(`${readout?.rolls.join(' and ')} · Kept ${readout?.value}`);
  expect(readout?.value).toBe(Math.max(...(readout?.rolls ?? [])));
  rig.hook.dispose();
}, 60_000);
