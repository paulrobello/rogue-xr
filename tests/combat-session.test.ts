import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import {
  CombatHook,
  type CombatHookDeps,
  type CombatPick,
  type CombatSession,
  chooseEncounter,
  ENEMY_GAP_SECONDS,
  fightSeed,
  HIT_NUMBER_SECONDS,
  untargetedHint,
} from '../src/combat/combat-session.ts';
import { REVEAL_EFFECT_AT, SHIELD_FORM_SECONDS } from '../src/combat-view/cast-timing.ts';
import { CombatController } from '../src/combat-view/controller.ts';
import { type PlayerHit, playerHit, segmentEvents } from '../src/combat-view/enemy-turn.ts';
import { HIT_NUMBER_SLOTS } from '../src/combat-view/hit-numbers.ts';
import {
  CARD_LAUNCH_DELAY,
  FLIGHT_MAX_SECONDS,
  FLIGHT_MIN_SECONDS,
  flightSeconds,
} from '../src/combat-view/impact-timing.ts';
import { getCard } from '../src/content/cards.ts';
import { dieById } from '../src/content/dice.ts';
import { encounterSetups } from '../src/content/enemies.ts';
import { ActionBus } from '../src/core/actions.ts';
import { Stream } from '../src/core/rng.ts';
import { fitCombatFraming } from '../src/desktop/combat-framing.ts';
import { DicePresenter } from '../src/dice/presenter.ts';
import { cardSteamCost } from '../src/rules/index.ts';
import { SIGIL_TEMPLATES } from '../src/sigil/index.ts';
import { GLYPH_LAUNCH_SECONDS } from '../src/sigil-plate/index.ts';
import { type FloorView, mountFloorView } from '../src/world/floor-view.ts';

const DT = 1 / 60;
/** The real table's authored top and its tray and plate sockets (`combat-table.manifest.json`). */
const TABLE_ASSET_TOP = 0.756;
function tableAssetStandIn(): THREE.Object3D {
  const asset = new THREE.Group();
  for (const [name, y, z] of [
    ['socket-dice-tray', 0.724, 0.18],
    ['socket-sigil-plate', 1.05, -0.15],
  ] as const) {
    const socket = new THREE.Object3D();
    socket.name = name;
    socket.position.set(0, y, z);
    asset.add(socket);
  }
  return asset;
}

interface Rect {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}
/** Screen rectangle (normalized device coordinates) of `points` seen through `camera`. */
function rectOf(camera: THREE.PerspectiveCamera, points: THREE.Vector3[]): Rect {
  camera.updateMatrixWorld(true);
  const ndc = points.map((p) => p.clone().project(camera));
  return {
    x0: Math.min(...ndc.map((p) => p.x)),
    x1: Math.max(...ndc.map((p) => p.x)),
    y0: Math.min(...ndc.map((p) => p.y)),
    y1: Math.max(...ndc.map((p) => p.y)),
  };
}
const overlap = (a: Rect, b: Rect): boolean =>
  a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;

/**
 * A do-nothing 2D context, so the canvas labels (status panel, readouts) exist in happy-dom, which
 * has no canvas. Restore with `vi.restoreAllMocks()`.
 */
function stubCanvas2d(): void {
  const handler: ProxyHandler<object> = {
    get: (_target, key) =>
      key === 'measureText'
        ? (text: string) => ({ width: String(text).length * 10 })
        : () => new Proxy({}, handler),
    set: () => true,
  };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    () => new Proxy({}, handler) as unknown as CanvasRenderingContext2D,
  );
}

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
  options?: { enemyHp?: number; playerHp?: number; deck?: readonly string[] },
  extra: Pick<CombatHookDeps, 'onPlayerHit'> = {},
  where: { tier?: 'regular' | 'guardian'; tableAsset?: THREE.Object3D } = {},
): Promise<Rig & { session: CombatSession }> {
  const scene = new THREE.Scene();
  const player = new THREE.Group();
  // These fixed combat traces predate the roster expansion.
  const view = mountFloorView(scene, player, seed, { contentVersion: 1 });
  if (where.tableAsset) view.useTableAsset(where.tableAsset, TABLE_ASSET_TOP);
  // A regular fight: the scripted policy is not meant to beat the elite or the guardian.
  const room =
    where.tier === 'guardian'
      ? view.world.plan.guardianRoom
      : view.world.plan.rooms.findIndex((r) => r.encounter?.tier === 'regular');
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
    models: null,
    ...(options ? { options } : {}),
    ...extra,
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

/** Steps until the enemy phase has played out (one enemy at a time); returns the seconds it took. */
function waitEnemyPhase(rig: Rig, session: CombatSession, limit = 15): number {
  let t = 0;
  while (session.enemyPhase && t < limit) {
    rig.step();
    t += DT;
  }
  expect(session.enemyPhase).toBe(false);
  return t;
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

/** Stand-in tracked hands for an XR fight: main grip and ray posed together, the fan on `off`. */
function xrHands(rig: Rig) {
  const { camera } = rig;
  const scene = camera.parent as THREE.Scene;
  const head = camera.getWorldPosition(new THREE.Vector3());
  const main = new THREE.Group();
  const mainRay = new THREE.Group();
  const off = new THREE.Group();
  off.position.copy(head).add(new THREE.Vector3(-0.18, -0.3, -0.3));
  scene.add(main, mainRay, off);
  const hands = { main, mainRay, off };
  return {
    rest: head.clone().add(new THREE.Vector3(0.18, -0.3, -0.3)),
    pose(from: THREE.Vector3, target: THREE.Vector3) {
      for (const o of [main, mainRay]) {
        o.position.copy(from);
        o.lookAt(target);
        o.rotateY(Math.PI);
        o.updateMatrixWorld(true);
      }
    },
    step(seconds = DT) {
      for (let t = 0; t < seconds - 1e-9; t += DT) {
        camera.updateMatrixWorld(true);
        rig.view.update(camera, DT);
        rig.hook.update(DT, hands);
      }
    },
    hand(control: 'squeeze' | 'trigger', pressed: boolean) {
      rig.actions.emit({ type: 'combat-hand', hand: 'main', control, pressed });
    },
  };
}

/** Desktop play: clicks a hand card to pick it up, moves the mouse to `to` and clicks to use it. */
function playCard(rig: Rig, session: CombatSession, uid: number, to: THREE.Vector3): void {
  const from = at(session, 'card', uid);
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

/** Traces the awaited sigil's template strokes, then explicitly clicks the visible Cast control. */
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
  pointerAt(rig, at(session, 'sigil-cast'), 'down');
  pointerAt(rig, at(session, 'sigil-cast'), 'up');
  rig.step(0.1);
}

interface FightLog {
  log: string[];
  rolls: number[];
  verbs: Set<string>;
  outcome: string | null;
}

/** Plays the fight with desktop verbs only: cards used at enemies or on the table, sigils, dice, End Turn. */
async function playFight(rig: Rig & { session: CombatSession }): Promise<FightLog> {
  const { session } = rig;
  const verbs = new Set<string>();
  const rolls: number[] = [];
  // A dice card's effects wait for its throw (H2), even a killing blow's, so a pending throw is
  // thrown before the loop checks the outcome.
  for (
    let guard = 0;
    guard < 400 && (session.controller.outcome === null || session.awaitingThrow);
    guard++
  ) {
    waitEnemyPhase(rig, session);
    if (session.awaitingThrow) {
      const roll = session.controller.lastDice;
      pointerAt(rig, at(session, 'dice'), 'down');
      pointerAt(rig, at(session, 'dice'), 'up');
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
    if (session.controller.outcome !== null) break;
    if (session.controller.stage === 'sigil') {
      drawSigil(rig, session);
      verbs.add('sigil');
      continue;
    }
    const state = session.controller.state;
    const affordable = state.piles.hand.filter(
      (c) => cardSteamCost(c.def.cost, state.player.steam) <= state.player.steam,
    );
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
      playCard(rig, session, playable.uid, at(session, 'enemy', foe?.id));
      verbs.add('fling');
    } else {
      playCard(rig, session, playable.uid, at(session, 'table'));
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
    const expected = chooseEncounter(
      view.seed,
      rig.room,
      tier,
      rig.bodies.length,
      view.contentVersion,
    );
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
    // The banner waits for the killing blow to play out.
    rig.step(0.1);
    expect(rig.hook.banner).toBe('');
    waitEnemyPhase(rig, rig.session);
    rig.step(0.1);
    expect(rig.hook.banner).toBe('DEFEAT');
    rig.step(2);
    expect(end).toHaveBeenCalledWith('defeat');
    expect(rig.view.encounter.isCleared(rig.room)).toBe(false);
    rig.step(1);
    expect(rig.hook.session).toBeNull();
    expect(rig.actions.listenerCount()).toBe(rig.baseListeners);
  });

  // P6-T2 bug bash (SPIRE002, room 4): a sigil card played while the last cast's result still
  // showed left the controller waiting on a plate that never came back.
  it('shows the plate for a sigil card staged while the last result is on screen', async () => {
    const rig = await openFight('SPIRE002', { deck: Array(10).fill('warding-glyph') });
    const { session } = rig;
    const table = at(session, 'table');
    const first = session.controller.state.piles.hand[0]?.uid as number;
    playCard(rig, session, first, table);
    expect(session.controller.stage).toBe('sigil');
    drawSigil(rig, session);
    expect(session.plate.phase).toBe('done');
    const blockAfterFirst = session.controller.state.player.block;
    expect(blockAfterFirst).toBeGreaterThan(0);

    const second = session.controller.state.piles.hand[0]?.uid as number;
    playCard(rig, session, second, table);
    expect(session.controller.stage).toBe('sigil');
    rig.step(2);
    expect(session.plate.phase).toBe('ready');
    expect(session.plate.sigilId).toBe('ward');
    // The controller how-to line is XR only; the desktop HUD carries its own instructions.
    expect(session.plate.hintText).toMatch(/click cast/i);
    drawSigil(rig, session);
    expect(session.controller.stage).toBe('idle');
    expect(session.controller.state.player.block).toBeGreaterThan(blockAfterFirst);
  }, 60_000);

  // Card verbs (Quest 3 playtest 2026-11-17): "if you are holding a card and you release it it goes
  // back to your hand, trigger while holding the card should be activator". The trigger does nothing
  // to a card still in the fan; a grabbed card is used by the trigger or put back by letting go.
  it('plays a block card in XR only once grabbed: trigger uses it, letting go puts it back', async () => {
    const rig = await openFight('SPIRE002', { deck: Array(10).fill('defend') });
    const { session } = rig;
    const xr = xrHands(rig);
    const name = getCard('defend').name;
    xr.step();
    const handSize = session.controller.state.piles.hand.length;
    const first = () => at(session, 'card', session.controller.state.piles.hand[0]?.uid as number);

    // Pointed at in the fan: the hint says grip first, and the trigger alone plays nothing.
    xr.pose(xr.rest, first());
    xr.step();
    expect(session.fan.hovered).toBe(0);
    expect(session.hint).toBe(untargetedHint(name, 'pointed-xr'));
    xr.hand('trigger', true);
    xr.hand('trigger', false);
    xr.step(0.5);
    expect(session.controller.state.piles.hand).toHaveLength(handSize);
    expect(session.controller.state.player.block).toBe(0);

    // Grabbed and let go: back in the hand, nothing selected.
    xr.pose(xr.rest, first());
    xr.step();
    xr.hand('squeeze', true);
    xr.step();
    expect(session.holdingCard).toBe(true);
    expect(session.hint).toBe(untargetedHint(name, 'held-xr'));
    xr.hand('squeeze', false);
    xr.step(0.5);
    expect(session.holdingCard).toBe(false);
    expect(session.controller.stage).toBe('idle');
    expect(session.controller.state.piles.hand).toHaveLength(handSize);
    expect(session.fan.count).toBe(handSize);

    // Grabbed and triggered: it plays from wherever the hand is.
    xr.pose(xr.rest, first());
    xr.step();
    xr.hand('squeeze', true);
    xr.step();
    xr.hand('trigger', true);
    xr.step();
    expect(session.fling.lastDecision).toMatchObject({ outcome: 'played', via: 'press' });
    expect(session.controller.state.player.block).toBeGreaterThan(0);
    xr.hand('trigger', false);
    xr.hand('squeeze', false);
    xr.step();
    expect(session.controller.state.piles.hand).toHaveLength(handSize - 1);
    rig.hook.dispose();
  }, 60_000);

  it('fires a held attack in XR at the enemy the hand aims at, and keeps it held with no aim', async () => {
    const rig = await openFight('SPIRE002', { deck: Array(10).fill('strike') });
    const { session } = rig;
    const xr = xrHands(rig);
    xr.step();
    const uid = session.controller.state.piles.hand[0]?.uid as number;
    const enemy = session.controller.state.enemies[0];
    if (!enemy) throw new Error('no enemy');
    const hp = enemy.hp;
    xr.pose(xr.rest, at(session, 'card', uid));
    xr.step();
    xr.hand('trigger', true);
    xr.hand('trigger', false);
    xr.step();
    expect(session.holdingCard).toBe(false);
    expect(session.controller.stage).toBe('idle');
    // Grabbed and let go: back in the hand, nothing selected.
    xr.hand('squeeze', true);
    xr.step();
    expect(session.controller.stage).toBe('target');
    xr.hand('squeeze', false);
    xr.step(0.5);
    expect(session.holdingCard).toBe(false);
    expect(session.controller.stage).toBe('idle');
    expect(session.controller.state.piles.hand.some((c) => c.uid === uid)).toBe(true);
    xr.pose(xr.rest, at(session, 'card', uid));
    xr.step();
    xr.hand('squeeze', true);
    xr.step();
    expect(session.controller.stage).toBe('target');

    // Aimed at the floor behind the player: no target, the card stays in the hand.
    xr.pose(xr.rest, xr.rest.clone().add(new THREE.Vector3(0, -1, 2)));
    xr.step();
    xr.hand('trigger', true);
    xr.hand('trigger', false);
    xr.step();
    expect(session.holdingCard).toBe(true);
    expect(session.fling.lastDecision).toMatchObject({ outcome: 'held' });

    // Aimed a little off the enemy, inside the assist cone: it fires at that enemy.
    const foe = at(session, 'enemy', enemy.id);
    xr.pose(xr.rest, foe.clone().add(new THREE.Vector3(0.35, 0.2, 0)));
    xr.step();
    xr.hand('trigger', true);
    xr.step();
    expect(session.fling.lastDecision).toMatchObject({
      outcome: 'played',
      via: 'aim',
      targetId: enemy.id,
    });
    expect(session.holdingCard).toBe(false);
    xr.hand('trigger', false);
    xr.hand('squeeze', false);
    xr.step(FLIGHT_MAX_SECONDS + 0.5);
    expect(session.controller.state.enemies[0]?.hp).toBeLessThan(hp);
    rig.hook.dispose();
  }, 60_000);

  it('a desktop block card is clicked up, clicked to play, or right-clicked back to the hand', async () => {
    const rig = await openFight('SPIRE002', { deck: Array(10).fill('defend') });
    const { session } = rig;
    const card = session.controller.state.piles.hand[0];
    if (!card) throw new Error('no card');
    const from = at(session, 'card', card.uid);
    pointerAt(rig, from, 'down');
    pointerAt(rig, from, 'up');
    rig.step();
    expect(session.holdingCard).toBe(true);
    expect(session.hint).toBe(untargetedHint(getCard('defend').name, 'held'));
    // The right click (main.ts sends combat-cancel) puts it back.
    rig.actions.emit({ type: 'combat-cancel' });
    rig.step(0.5);
    expect(session.holdingCard).toBe(false);
    expect(session.controller.stage).toBe('idle');
    expect(session.controller.state.player.block).toBe(0);

    pointerAt(rig, from, 'down');
    pointerAt(rig, from, 'up');
    rig.step();
    // Letting go of the mouse button does not play it; the next click does, wherever it lands.
    expect(session.holdingCard).toBe(true);
    const table = at(session, 'table');
    pointerAt(rig, table, 'move');
    rig.step();
    pointerAt(rig, table, 'down');
    pointerAt(rig, table, 'up');
    rig.step();
    expect(session.fling.lastDecision).toMatchObject({ outcome: 'played', targetId: null });
    expect(session.controller.state.player.block).toBeGreaterThan(0);
    expect(session.hint).toBe('');
    rig.hook.dispose();
  }, 60_000);

  // Quest 3 report 2026-11-15: tracing on the plate with a controller drew nothing and the cast
  // said "too short". The tip, out of reach of the plate, fed a miss every frame that closed the
  // stroke the ray had just started, so no stroke ever held two points. Playtest 2026-11-17: the
  // plate opened (and the trigger drew, lighting its dot) while the glyph card was still only held.
  it('casts a sigil in XR: grab the card, trigger lays it down, then each trigger press draws', async () => {
    const rig = await openFight('SPIRE002', { deck: Array(10).fill('warding-glyph') });
    const { session } = rig;
    const xr = xrHands(rig);
    xr.step();
    const uid = session.controller.state.piles.hand[0]?.uid as number;
    xr.pose(xr.rest, at(session, 'card', uid));
    xr.step();
    expect(session.fan.hovered).toBe(0);
    xr.hand('squeeze', true);
    xr.step(0.3);
    // Held only: no plate yet.
    expect(session.plate.phase).toBe('hidden');
    xr.hand('squeeze', false);
    xr.step(0.5);
    expect(session.plate.phase).toBe('hidden');
    expect(session.controller.stage).toBe('idle');

    xr.pose(xr.rest, at(session, 'card', uid));
    xr.step();
    xr.hand('squeeze', true);
    xr.step();
    xr.hand('trigger', true);
    xr.step();
    xr.hand('trigger', false);
    xr.hand('squeeze', false);
    xr.step(0.5);
    expect(session.fling.lastDecision).toMatchObject({ outcome: 'staged', via: 'press' });
    expect(session.controller.stage).toBe('sigil');
    expect(session.plate.phase).toBe('ready');
    expect(session.plate.hintText).toMatch(/trigger/i);

    const p = session.platePoseNow;
    const size = Math.min(p.halfWidth, p.halfHeight) * 1.6;
    const onPlate = (pt: { x: number; y: number }) =>
      new THREE.Vector3(p.center.x, p.center.y, p.center.z)
        .addScaledVector(new THREE.Vector3(p.right.x, p.right.y, p.right.z), (pt.x - 0.5) * size)
        .addScaledVector(new THREE.Vector3(p.up.x, p.up.y, p.up.z), (pt.y - 0.5) * size);
    const sparks = session.plate.getObjectByName('sigil-sparks') as THREE.Object3D & {
      dotBrightness: number;
    };
    const points = session.plate.getObjectByName('sigil-sparks-points') as THREE.Points;
    // Card B: aiming at the plate before the trigger lights nothing.
    xr.pose(xr.rest, onPlate({ x: 0.5, y: 0.5 }));
    xr.step(0.3);
    expect(sparks.dotBrightness).toBe(0);
    expect(points.visible).toBe(false);

    const trail = session.plate.getObjectByName('sigil-plate-trail') as THREE.Mesh;
    let lit = 0;
    for (const stroke of SIGIL_TEMPLATES.ward.strokes) {
      xr.pose(xr.rest, onPlate(stroke[0] as { x: number; y: number }));
      xr.step();
      xr.hand('trigger', true);
      for (const pt of stroke) {
        xr.pose(xr.rest, onPlate(pt));
        xr.step();
        lit = Math.max(lit, sparks.dotBrightness);
      }
      expect(points.visible).toBe(true);
      expect(trail.geometry.drawRange.count).toBeGreaterThan(0);
      xr.hand('trigger', false);
      xr.step(0.1);
    }
    expect(lit).toBe(1);
    // Releasing the final stroke does not auto-cast, even after the former timer window elapses.
    xr.step(3);
    expect(session.plate.phase).toBe('ready');
    expect(session.controller.stage).toBe('sigil');
    xr.pose(xr.rest, at(session, 'sigil-cast'));
    xr.step();
    xr.hand('squeeze', true);
    xr.step();
    xr.hand('squeeze', false);
    xr.step(0.1);
    expect(session.plate.phase).toBe('done');
    expect(session.plate.labelText).not.toMatch(/too short|fizzle/i);
    expect(session.controller.stage).toBe('idle');
    expect(session.controller.state.player.block).toBeGreaterThan(0);
    rig.hook.dispose();
  }, 60_000);

  it('a targeted dice sigil (Furnace Brand) is laid down the same way: aim, trigger, plate waits', async () => {
    const rig = await openFight('SPIRE002', { deck: Array(10).fill('furnace-brand') });
    const { session } = rig;
    const xr = xrHands(rig);
    xr.step();
    const uid = session.controller.state.piles.hand[0]?.uid as number;
    const enemy = session.controller.state.enemies[0];
    if (!enemy) throw new Error('no enemy');
    xr.pose(xr.rest, at(session, 'card', uid));
    xr.step();
    xr.hand('squeeze', true);
    xr.step(0.3);
    expect(session.plate.phase).toBe('hidden');
    xr.pose(xr.rest, at(session, 'enemy', enemy.id));
    xr.step();
    xr.hand('trigger', true);
    xr.step();
    xr.hand('trigger', false);
    xr.step(0.4);
    expect(session.fling.lastDecision).toMatchObject({
      outcome: 'staged',
      via: 'aim',
      targetId: enemy.id,
    });
    expect(session.controller.stage).toBe('sigil');
    expect(session.plate.phase).toBe('ready');
    const sparks = session.plate.getObjectByName('sigil-sparks') as THREE.Object3D & {
      dotBrightness: number;
    };
    const p = session.platePoseNow;
    xr.pose(xr.rest, new THREE.Vector3(p.center.x, p.center.y, p.center.z));
    xr.step(0.2);
    expect(sparks.dotBrightness).toBe(0);
    // Letting go of the grip after laying it down keeps the cast waiting.
    xr.hand('squeeze', false);
    xr.step(0.3);
    expect(session.plate.phase).toBe('ready');
    expect(session.controller.stage).toBe('sigil');
    xr.hand('trigger', true);
    xr.step();
    expect(session.plate.phase).toBe('drawing');
    expect(sparks.dotBrightness).toBeGreaterThan(0);
    xr.hand('trigger', false);
    rig.hook.dispose();
  }, 60_000);

  // Sigil traces bash (BASH7000 room 5): after a sigil cast, the next card grabbed at the same fan
  // index sprang back to the fan, so a drag at an enemy staged it without ever targeting it.
  it('plays a targeted card dragged at an enemy right after a sigil cast', async () => {
    const rig = await openFight('SPIRE002');
    const { session } = rig;
    const controller = session.controller;
    const state = controller.state;
    controller.state = {
      ...state,
      player: { ...state.player, steam: 9 },
      piles: {
        ...state.piles,
        hand: [
          { uid: 9001, def: getCard('warding-glyph') },
          { uid: 9002, def: getCard('strike') },
        ],
      },
    };
    (controller as unknown as { changed(): void }).changed();
    rig.step(0.5);

    playCard(rig, session, 9001, at(session, 'table'));
    expect(controller.stage).toBe('sigil');
    drawSigil(rig, session);
    expect(controller.stage).toBe('idle');
    rig.step(2);
    expect(controller.state.piles.hand.map((c) => c.uid)).toEqual([9002]);

    const enemy = session.enemies[0];
    if (!enemy) throw new Error('no enemy');
    const hpBefore = controller.state.enemies.find((e) => e.id === enemy.id)?.hp as number;
    playCard(rig, session, 9002, at(session, 'enemy', enemy.id));
    expect(controller.state.piles.hand.map((c) => c.uid)).toEqual([]);
    expect(controller.state.enemies.find((e) => e.id === enemy.id)?.hp).toBeLessThan(hpBefore);
    rig.hook.dispose();
  }, 60_000);

  it('lands a flung Piston Strike with physical impact, knock-back and HP change at contact', async () => {
    const rig = await openFight('SPIRE002', { deck: Array(10).fill('strike') });
    const { session } = rig;
    const launch = vi.spyOn(session.spellFx, 'launch');
    const impact = vi.spyOn(session.spellFx, 'impact');
    const enemy = session.enemies[0];
    if (!enemy) throw new Error('no enemy');
    const hpOf = (s: CombatSession['view']) => s.enemies.find((e) => e.id === enemy.id)?.hp ?? -1;
    const home = enemy.body.position.clone();
    const before = hpOf(session.view);
    const uid = session.controller.state.piles.hand[0]?.uid as number;
    playCard(rig, session, uid, at(session, 'enemy', enemy.id));
    expect(hpOf(session.controller.state)).toBeLessThan(before);
    expect(session.attackInFlight).toBe(true);
    expect(hpOf(session.view)).toBe(before);
    let flew = 0;
    let t = DT;
    while (session.attackInFlight && t < 1) {
      rig.step();
      t += DT;
      if (session.spellFx.flying > 0) flew += DT;
    }
    expect(session.attackInFlight).toBe(false);
    expect(flew).toBeGreaterThan(FLIGHT_MIN_SECONDS - 2 * DT);
    expect(t).toBeLessThanOrEqual(CARD_LAUNCH_DELAY + FLIGHT_MAX_SECONDS + 2 * DT);
    expect(hpOf(session.view)).toBe(hpOf(session.controller.state));
    expect(session.spellFx.flashing).toBe(1);
    rig.step(0.05);
    expect(enemy.body.position.distanceTo(home)).toBeGreaterThan(0.01);
    rig.step(0.5);
    expect(enemy.body.position.equals(home)).toBe(true);
    expect(session.spellFx.active).toBe(false);
    expect(launch.mock.calls[0]?.[6]).toBe('physical');
    expect(impact.mock.calls[0]?.[3]).toBe('physical');
    rig.hook.dispose();
  }, 60_000);

  // F5 (Quest 3 playtest 2026-11-17): "have red numbers float up and fade away to show the damage
  // done". Each hit on an enemy floats its number up from in front of the body at contact, the
  // player's from the status panel, out of one fixed pool.
  it('floats a damage number from the enemy at contact and from the player when hit, pooled', async () => {
    const rig = await openFight('SPIRE002', { deck: Array(10).fill('strike') });
    const { session } = rig;
    const enemy = session.enemies[0];
    if (!enemy) throw new Error('no enemy');
    const children = session.numbers.children.length;
    expect(session.numbers.slots).toHaveLength(HIT_NUMBER_SLOTS);
    const before = session.view.enemies.find((e) => e.id === enemy.id)?.hp ?? 0;
    const uid = session.controller.state.piles.hand[0]?.uid as number;
    playCard(rig, session, uid, at(session, 'enemy', enemy.id));
    // Nothing floats while the bolt flies; the number shows with the HP change.
    expect(session.numbers.active).toHaveLength(0);
    for (let i = 0; i < 120 && session.attackInFlight; i++) rig.step();
    const after = session.view.enemies.find((e) => e.id === enemy.id)?.hp ?? 0;
    const [number] = session.numbers.active;
    expect(number?.amount.hpLost).toBe(before - after);
    const aim = at(session, 'enemy', enemy.id);
    // In front of the body, toward the seat, and above the hit point.
    const eye = rig.camera.getWorldPosition(new THREE.Vector3());
    expect(number?.start.distanceTo(aim)).toBeLessThan(0.6);
    expect(number?.start.y).toBeGreaterThan(aim.y);
    expect(number?.start.distanceTo(eye)).toBeLessThan(aim.distanceTo(eye));
    rig.step(HIT_NUMBER_SECONDS + 0.05);
    expect(session.numbers.active).toHaveLength(0);

    // The enemy turn: whatever lands on the player floats from the status panel.
    let seen = 0;
    for (let turn = 0; turn < 4 && session.hitLog.length === 0; turn++) {
      rig.actions.emit({ type: 'end-turn' });
      rig.step();
      for (let i = 0; i < 900 && session.enemyPhase; i++) {
        rig.step();
        seen = Math.max(seen, session.numbers.active.length);
      }
    }
    expect(session.hitLog.length).toBeGreaterThan(0);
    expect(seen).toBeGreaterThan(0);
    // The pool never grows.
    expect(session.numbers.children.length).toBe(children);
    expect(session.numbers.slots).toHaveLength(HIT_NUMBER_SLOTS);
    rig.hook.dispose();
    expect(session.numbers.parent).toBeNull();
  }, 60_000);

  it('casts a damage sigil as its glyph collapses, one bolt to every enemy, landing together', async () => {
    const rig = await openFight('SPIRE002', { deck: Array(10).fill('cogstorm') });
    const { session } = rig;
    const launch = vi.spyOn(session.spellFx, 'launch');
    const impact = vi.spyOn(session.spellFx, 'impact');
    const living = session.controller.state.enemies.filter((e) => e.hp > 0).length;
    const before = session.view.enemies.map((e) => e.hp);
    const uid = session.controller.state.piles.hand[0]?.uid as number;
    playCard(rig, session, uid, at(session, 'table'));
    expect(session.controller.stage).toBe('sigil');
    drawSigil(rig, session);
    expect(session.controller.stage).toBe('idle');
    expect(session.plate.casting).toBe(true);
    expect(session.attackInFlight).toBe(true);
    expect(session.castReveal.cardId).toBe('cogstorm');
    expect(session.view.enemies.map((e) => e.hp)).toEqual(before);
    let most = 0;
    let t = 0;
    while (session.attackInFlight && t < 2) {
      rig.step();
      t += DT;
      most = Math.max(most, session.spellFx.flying);
      // Nothing leaves the plate before the glyph collapses and the card has shown.
      if (
        session.plate.casting &&
        session.plate.castAge < GLYPH_LAUNCH_SECONDS + REVEAL_EFFECT_AT - DT
      )
        expect(session.spellFx.flying).toBe(0);
    }
    expect(session.attackInFlight).toBe(false);
    expect(most).toBe(Math.min(4, living));
    expect(session.view.enemies.map((e) => e.hp)).toEqual(
      session.controller.state.enemies.map((e) => e.hp),
    );
    expect(session.spellFx.flashing).toBe(Math.min(4, living));
    expect(launch.mock.calls[0]?.[6]).toBe('storm');
    expect(impact.mock.calls[0]?.[3]).toBe('storm');
    rig.hook.dispose();
  }, 60_000);

  // Quest 3 playtest 2026-11-17: after a completed sigil's flash the card's art shows over the
  // plate for a moment, then its effect plays; a block card forms a ward shield in front of the
  // player, and the block readout changes when the shield has formed.
  it('reveals a cast sigil card over the plate, then forms the ward shield and shows the block', async () => {
    const rig = await openFight('SPIRE002', { deck: Array(10).fill('warding-glyph') });
    const { session } = rig;
    const before = session.view.player.block;
    const uid = session.controller.state.piles.hand[0]?.uid as number;
    playCard(rig, session, uid, at(session, 'table'));
    drawSigil(rig, session);
    expect(session.controller.state.player.block).toBeGreaterThan(before);
    expect(session.attackInFlight).toBe(true);
    expect(session.castReveal.cardId).toBe('warding-glyph');
    expect(session.view.player.block).toBe(before);
    // The card's face (+Z, front side) points at the player's eye.
    const face = new THREE.Vector3(0, 0, 1).applyQuaternion(
      session.castReveal.getWorldQuaternion(new THREE.Quaternion()),
    );
    const toEye = rig.camera
      .getWorldPosition(new THREE.Vector3())
      .sub(session.castReveal.getWorldPosition(new THREE.Vector3()));
    expect(face.dot(toEye)).toBeGreaterThan(0);
    const castAt = session.time - session.plate.castAge;
    let revealedAt = -1;
    let shieldAt = -1;
    let shownAt = -1;
    for (let i = 0; i < 180; i++) {
      rig.step();
      const t = session.time - castAt;
      if (revealedAt < 0 && session.castReveal.visible) revealedAt = t;
      const lit = session.castFx.lit;
      if (shieldAt < 0 && lit) shieldAt = t;
      if (shownAt < 0 && session.view.player.block > before) shownAt = t;
    }
    // Glyph collapse, then the card, then the shield, then the readout once the shield has formed.
    expect(revealedAt).toBeGreaterThan(GLYPH_LAUNCH_SECONDS - 2 * DT);
    expect(revealedAt).toBeLessThan(GLYPH_LAUNCH_SECONDS + 3 * DT);
    expect(shieldAt).toBeGreaterThan(GLYPH_LAUNCH_SECONDS + REVEAL_EFFECT_AT - 2 * DT);
    expect(shownAt).toBeGreaterThan(
      GLYPH_LAUNCH_SECONDS + REVEAL_EFFECT_AT + SHIELD_FORM_SECONDS - 3 * DT,
    );
    expect(shownAt).toBeLessThan(
      GLYPH_LAUNCH_SECONDS + REVEAL_EFFECT_AT + SHIELD_FORM_SECONDS + 4 * DT,
    );
    expect(session.view.player.block).toBe(session.controller.state.player.block);
    expect(session.castReveal.visible).toBe(false);
    rig.step(2);
    expect(session.castFx.active).toBe(false);
    rig.hook.dispose();
  }, 60_000);

  it('plays the shield for a defend card dropped on the table, with no card reveal', async () => {
    const rig = await openFight('SPIRE002', { deck: Array(10).fill('defend') });
    const { session } = rig;
    const before = session.view.player.block;
    const uid = session.controller.state.piles.hand[0]?.uid as number;
    playCard(rig, session, uid, at(session, 'table'));
    expect(session.controller.state.player.block).toBeGreaterThan(before);
    expect(session.castFx.shielding).toBe(true);
    expect(session.castReveal.active).toBe(false);
    let t = 0;
    while (session.attackInFlight && t < 1) {
      rig.step();
      t += DT;
    }
    expect(t).toBeLessThanOrEqual(CARD_LAUNCH_DELAY + SHIELD_FORM_SECONDS + 3 * DT);
    expect(session.view.player.block).toBe(session.controller.state.player.block);
    rig.hook.dispose();
  }, 60_000);

  it('puffs steam and sends the draw shimmer to the hand for a steam card', async () => {
    const rig = await openFight('SPIRE002', { deck: Array(10).fill('release-valve') });
    const { session } = rig;
    const before = session.view.player.steam;
    const uid = session.controller.state.piles.hand[0]?.uid as number;
    playCard(rig, session, uid, at(session, 'table'));
    expect(session.attackInFlight).toBe(true);
    expect(session.castFx.puffs).toBeGreaterThan(0);
    expect(session.castFx.streams).toBe(1);
    // The play's steam cost and gain show together when the puff lands.
    expect(session.view.player.steam).toBe(before);
    for (let i = 0; i < 60 && session.attackInFlight; i++) rig.step();
    expect(session.attackInFlight).toBe(false);
    expect(session.view.player.steam).toBe(session.controller.state.player.steam);
    rig.hook.dispose();
  }, 60_000);

  it('lands a bolt still in flight at once when the player ends the turn', async () => {
    const rig = await openFight('SPIRE002', { deck: Array(10).fill('strike') });
    const { session } = rig;
    const enemy = session.enemies[0];
    if (!enemy) throw new Error('no enemy');
    const home = enemy.body.position.clone();
    const uid = session.controller.state.piles.hand[0]?.uid as number;
    playCard(rig, session, uid, at(session, 'enemy', enemy.id));
    expect(session.attackInFlight).toBe(true);
    const hit = session.controller.state.enemies.find((e) => e.id === enemy.id)?.hp;
    rig.actions.emit({ type: 'end-turn' });
    rig.step();
    expect(session.attackInFlight).toBe(false);
    // The enemy phase starts from the state with the strike landed, and every body ends home.
    expect(session.view.enemies.find((e) => e.id === enemy.id)?.hp).toBe(hit);
    waitEnemyPhase(rig, session);
    expect(enemy.body.position.equals(home)).toBe(true);
    rig.hook.dispose();
  }, 60_000);

  it('replays the same fight identically from the same seed', async () => {
    const a = await playFight(await openFight());
    const b = await playFight(await openFight());
    expect(b.log).toEqual(a.log);
    expect(b.rolls).toEqual(a.rolls);
  }, 120_000);
});

describe('desktop HUD fit', () => {
  const ndcOf = (camera: THREE.PerspectiveCamera, points: THREE.Vector3[]) => {
    camera.updateMatrixWorld(true);
    const ndc = points.map((p) => p.clone().project(camera));
    return {
      x: [Math.min(...ndc.map((p) => p.x)), Math.max(...ndc.map((p) => p.x))],
      y: [Math.min(...ndc.map((p) => p.y)), Math.max(...ndc.map((p) => p.y))],
    };
  };
  /** The desktop view at the close fallback table (0.5 m ahead) with the opening pitch combatPitch gives. */
  const closeView = (rig: Rig, pitch: number): THREE.PerspectiveCamera => {
    const pose = rig.view.encounter.tablePose;
    if (!pose) throw new Error('no table pose');
    const yaw = (pose.yaw * Math.PI) / 180;
    const camera = new THREE.PerspectiveCamera(70, 1.6, 0.05, 100);
    camera.position.set(
      pose.x - Math.sin(yaw) * 0.5,
      pose.height + 0.75,
      pose.z + Math.cos(yaw) * 0.5,
    );
    camera.rotation.set(pitch, -yaw, 0, 'YXZ');
    return camera;
  };
  const hud = (session: CombatSession) =>
    session.hudPoints().filter((e) => e.name !== 'tray' && e.name !== 'plate');

  it('slides the buttons (and the panel and readouts, where labels exist) into the view, and back for XR', async () => {
    const rig = await openFight();
    const camera = closeView(rig, -0.53);
    const home = hud(rig.session).map((e) => e.points.map((p) => p.clone()));
    const outside = hud(rig.session).filter((e) => {
      const { x, y } = ndcOf(camera, e.points);
      return (x[0] ?? 0) < -1 || (x[1] ?? 0) > 1 || (y[0] ?? 0) < -1 || (y[1] ?? 0) > 1;
    });
    // Without the fit the close fallback table cuts the HUD off, which is the reported bug.
    expect(outside.map((e) => e.name)).toEqual(expect.arrayContaining(['end-turn']));

    rig.session.fitHudToView(camera);
    const names = hud(rig.session).map((e) => e.name);
    // The panel and readouts are canvas labels, which the test environment cannot make; the browser check covers them.
    expect(names).toEqual(expect.arrayContaining(['end-turn']));
    for (const { name, points } of hud(rig.session)) {
      const { x, y } = ndcOf(camera, points);
      expect(x[0], `${name} left`).toBeGreaterThanOrEqual(-1);
      expect(x[1], `${name} right`).toBeLessThanOrEqual(1);
      expect(y[0], `${name} bottom`).toBeGreaterThanOrEqual(-1);
      expect(y[1], `${name} top`).toBeLessThanOrEqual(1);
    }

    // The XR layout is the home layout: a reset puts every element back where it was built.
    rig.session.resetHud();
    hud(rig.session).forEach((e, i) => {
      e.points.forEach((p, j) => {
        expect(p.distanceTo(home[i]?.[j] as THREE.Vector3)).toBeLessThan(1e-9);
      });
    });
    rig.hook.dispose();
  }, 60_000);

  it('leaves a HUD that already fits where it is', async () => {
    const rig = await openFight();
    const camera = closeView(rig, -0.53);
    rig.session.fitHudToView(camera);
    const fitted = hud(rig.session).map((e) => e.points.map((p) => p.clone()));
    rig.session.fitHudToView(camera);
    hud(rig.session).forEach((e, i) => {
      e.points.forEach((p, j) => {
        expect(p.distanceTo(fitted[i]?.[j] as THREE.Vector3)).toBeLessThan(1e-6);
      });
    });
    rig.hook.dispose();
  }, 60_000);

  it('reports the tray, plate and automatons for the framing fit', async () => {
    const rig = await openFight();
    const { must, want } = rig.session.framingPoints();
    expect(must.length).toBe(12);
    expect(want.length).toBe(rig.session.enemies.length);
    rig.hook.dispose();
  }, 60_000);

  /**
   * The player's desktop view as main.ts frames it: the eye `distance` behind the table centre at
   * the seated height, pitch and fov from `fitCombatFraming` on the session's framing points.
   */
  const framed = (rig: Rig & { session: CombatSession }, distance: number) => {
    const pose = rig.view.encounter.tablePose;
    if (!pose) throw new Error('no table pose');
    const yaw = (pose.yaw * Math.PI) / 180;
    const camera = rig.camera;
    camera.position.set(
      pose.x - Math.sin(yaw) * distance,
      pose.height + 0.75,
      pose.z + Math.cos(yaw) * distance,
    );
    const { must, want, floor } = rig.session.framingPoints();
    const fit = fitCombatFraming({
      eye: camera.position,
      headingDeg: pose.yaw,
      aspect: 1.6,
      baseFov: 70,
      must,
      want,
      floor,
    });
    camera.aspect = 1.6;
    camera.fov = fit.fov;
    camera.updateProjectionMatrix();
    camera.rotation.set(fit.pitch, -yaw, 0, 'YXZ');
    camera.updateMatrixWorld(true);
    return camera;
  };
  // The bug bash placements: the 0.5 m last-resort table, the 0.65 m comfortable fallback, the
  // 0.85 m one (H5), the 0.95 and 1.0 m fallbacks, the 1.1 m default and the earlier 1.2 m one
  // after the 2026-11-16 playtests, and the guardian (taller, its readout higher), on the real table's
  // sockets and on the greybox.
  const placements = [
    { tier: 'regular', distance: 0.5, asset: true },
    { tier: 'regular', distance: 0.65, asset: true },
    { tier: 'regular', distance: 0.85, asset: true },
    { tier: 'regular', distance: 0.95, asset: true },
    { tier: 'regular', distance: 1.0, asset: true },
    { tier: 'regular', distance: 1.1, asset: true },
    { tier: 'regular', distance: 1.2, asset: true },
    { tier: 'guardian', distance: 0.5, asset: true },
    { tier: 'guardian', distance: 0.65, asset: true },
    { tier: 'guardian', distance: 0.85, asset: true },
    { tier: 'guardian', distance: 0.95, asset: true },
    { tier: 'guardian', distance: 1.0, asset: true },
    { tier: 'guardian', distance: 1.1, asset: true },
    { tier: 'guardian', distance: 1.2, asset: true },
    { tier: 'regular', distance: 0.5, asset: false },
    { tier: 'regular', distance: 0.85, asset: false },
    { tier: 'regular', distance: 1.1, asset: false },
    { tier: 'regular', distance: 1.2, asset: false },
  ] as const;
  for (const { tier, distance, asset } of placements) {
    const where = `${tier}, table ${distance} m, ${asset ? 'table asset' : 'greybox'}`;
    it(`keeps the hand off the tray and the plate and its label off every readout (${where})`, async () => {
      stubCanvas2d();
      try {
        const rig = await openFight(
          'SPIRE002',
          undefined,
          {},
          {
            tier,
            ...(asset ? { tableAsset: tableAssetStandIn() } : {}),
          },
        );
        const camera = framed(rig, distance);
        rig.session.fitHudToView(camera);
        const { session } = rig;
        expect(session.fan.count).toBeGreaterThan(0);
        const points = new Map(session.hudPoints().map((e) => [e.name, e.points]));
        const readouts = [...points.keys()].filter((n) => n.startsWith('readout:'));
        expect(readouts.length).toBeGreaterThan(0);
        // O7: a thrown die lands in the tray, which must not sit behind the hand strip.
        const tray = rectOf(camera, points.get('tray') ?? []);
        const hand = rectOf(camera, session.handCorners());
        expect(
          overlap(hand, tray),
          `hand ${JSON.stringify(hand)} tray ${JSON.stringify(tray)}`,
        ).toBe(false);
        // O6: the plate and the result label it shows after a cast never cover a readout.
        const plate = rectOf(camera, [
          ...(points.get('plate') ?? []),
          ...session.resultLabelCorners(),
        ]);
        for (const name of readouts) {
          const readout = rectOf(camera, points.get(name) ?? []);
          expect(
            overlap(plate, readout),
            `${name} ${JSON.stringify(readout)} plate ${JSON.stringify(plate)}`,
          ).toBe(false);
          expect(readout.x0, `${name} left`).toBeGreaterThanOrEqual(-1);
          expect(readout.x1, `${name} right`).toBeLessThanOrEqual(1);
          expect(readout.y0, `${name} bottom`).toBeGreaterThanOrEqual(-1);
          expect(readout.y1, `${name} top`).toBeLessThanOrEqual(1);
        }
        // The tray and the plate stay in the view the framing chose.
        for (const r of [tray, rectOf(camera, points.get('plate') ?? []), hand]) {
          expect(r.x0).toBeGreaterThanOrEqual(-1);
          expect(r.x1).toBeLessThanOrEqual(1);
          expect(r.y1).toBeLessThanOrEqual(1);
        }
        expect(hand.y0).toBeGreaterThanOrEqual(-1);
        rig.hook.dispose();
      } finally {
        vi.restoreAllMocks();
      }
    }, 60_000);
  }
});

describe('XR status panel', () => {
  it('sits inside both eyes of the seated forward view at the 0.5 to 1.2 m tables', async () => {
    stubCanvas2d();
    try {
      for (const asset of [true, false]) {
        const rig = await openFight(
          'SPIRE002',
          undefined,
          {},
          asset ? { tableAsset: tableAssetStandIn() } : {},
        );
        rig.session.resetHud();
        const pose = rig.view.encounter.tablePose;
        if (!pose) throw new Error('no table pose');
        const status = rig.session.hudPoints().find((e) => e.name === 'status')?.points;
        expect(status?.length).toBe(8);
        const plate = rig.session.hudPoints().find((e) => e.name === 'plate')?.points ?? [];
        const yaw = (pose.yaw * Math.PI) / 180;
        const [fx, fz] = [Math.sin(yaw), -Math.cos(yaw)];
        const [rx, rz] = [Math.cos(yaw), Math.sin(yaw)];
        for (const distance of [0.5, 0.65, 0.85, 1.0, 1.2]) {
          for (const eye of [-0.032, 0.032]) {
            // The emulated Quest 3 eye (IWER: 90 degree vertical fov, half of a 1600 x 900 canvas),
            // level, at the seated eye height (the table top sits 0.75 m below it).
            const camera = new THREE.PerspectiveCamera(90, 800 / 900, 0.05, 100);
            camera.position.set(
              pose.x - fx * distance + rx * eye,
              pose.height + 0.75,
              pose.z - fz * distance + rz * eye,
            );
            camera.rotation.set(0, -yaw, 0, 'YXZ');
            camera.updateMatrixWorld(true);
            const where = `table ${distance} m, eye ${eye}, ${asset ? 'asset' : 'greybox'}`;
            for (const p of status ?? []) {
              const ndc = p.clone().project(camera);
              expect(Math.abs(ndc.x), where).toBeLessThanOrEqual(0.95);
              expect(Math.abs(ndc.y), where).toBeLessThanOrEqual(0.95);
              expect(ndc.z, where).toBeLessThan(1);
            }
            // Clear of the real table's sigil plate in the same view (the greybox plate stands
            // taller and nearer; it only shows when the table asset fails to load).
            if (asset)
              expect(overlap(rectOf(camera, status ?? []), rectOf(camera, plate)), where).toBe(
                false,
              );
          }
        }
        rig.hook.dispose();
      }
    } finally {
      vi.restoreAllMocks();
    }
  }, 60_000);
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

// Quest 3 playtest 2026-11-15: "the enemies attack at same time they should take turns, hits that
// land on player should have some kind of visible effect".
describe('enemy phase, one enemy at a time', () => {
  /** Ends the turn through the action bus and samples the shown state each frame until it is over. */
  const endTurnAndWatch = (rig: Rig & { session: CombatSession }) => {
    const { session } = rig;
    const from = session.turnTrace.length;
    const hitsFrom = session.hitLog.length;
    rig.actions.emit({ type: 'end-turn' });
    const samples: { t: number; hp: number; intents: (string | null)[]; log: string[] }[] = [];
    for (let i = 0; i < 900; i++) {
      rig.step();
      if (!session.enemyPhase) break;
      samples.push({
        t: session.time,
        hp: session.view.player.hp,
        intents: session.view.enemies.map((e) => e.intent?.id ?? null),
        log: [...session.log],
      });
    }
    expect(session.enemyPhase).toBe(false);
    return {
      trace: session.turnTrace.slice(from),
      hits: session.hitLog.slice(hitsFrom),
      samples,
    };
  };

  /** A bare controller with the session's fight: the unsequenced resolution. */
  const bareTwin = (rig: Rig & { session: CombatSession }, deck?: readonly string[]) => {
    const tier = rig.view.world.plan.rooms[rig.room]?.encounter?.tier ?? 'regular';
    const encounter = chooseEncounter(
      rig.view.seed,
      rig.room,
      tier,
      rig.bodies.length,
      rig.view.contentVersion,
    );
    return new CombatController({
      seed: fightSeed(rig.view.seed, rig.room),
      setups: encounterSetups(encounter),
      ...(deck ? { deck } : {}),
    });
  };

  it('plays each enemy in rules order, the next only after the last resolved plus a gap', async () => {
    const rig = await openFight('SPIRE002');
    const { session } = rig;
    expect(session.controller.state.enemies.length).toBeGreaterThanOrEqual(2);
    for (let turn = 0; turn < 3 && session.controller.outcome === null; turn++) {
      const order = session.controller.state.enemies.filter((e) => e.hp > 0).map((e) => e.id);
      const before = session.view.enemies.map((e) => e.intent?.id ?? null);
      const hp0 = session.view.player.hp;
      const { trace, hits, samples } = endTurnAndWatch(rig);
      expect(trace.map((b) => b.enemyId)).toEqual(order);
      trace.forEach((b, i) => {
        // Capsules (no models in tests) lunge to attack and brace otherwise.
        expect(['lunge', 'brace']).toContain(b.motion);
        expect(b.impact).not.toBeNull();
        expect(b.end).not.toBeNull();
        expect(b.impact as number).toBeGreaterThanOrEqual(b.start);
        expect(b.end as number).toBeGreaterThanOrEqual(b.impact as number);
        const prev = trace[i - 1];
        if (prev)
          expect(b.start).toBeGreaterThanOrEqual((prev.end as number) + ENEMY_GAP_SECONDS - 1e-6);
      });
      // Readouts follow each enemy: between the first and second impacts only the first has acted.
      const [a, b] = trace;
      if (a && b) {
        const between = samples.filter(
          (s) => s.t >= (a.impact as number) && s.t < (b.impact as number),
        );
        expect(between.length).toBeGreaterThan(0);
        const after = session.controller.state.enemies.map((e) => e.intent?.id ?? null);
        const firstHit = hits
          .filter((h) => h.enemyId === a.enemyId)
          .reduce((n, h) => n + h.hpLost, 0);
        for (const s of between) {
          expect(s.intents[1]).toBe(before[1]);
          expect(s.intents[0]).toBe(after[0]);
          expect(s.hp).toBe(hp0 - firstHit);
        }
        for (const s of samples.filter((x) => x.t < (a.impact as number))) expect(s.hp).toBe(hp0);
      }
      expect(session.view).toBe(session.controller.state);
      // The log tells each enemy's move as it plays, never ahead of it.
      const full = session.controller.log;
      expect(samples[0]?.log.length).toBeLessThan(full.length);
      for (const s of samples) expect(full.slice(0, s.log.length)).toEqual(s.log);
      expect(session.log).toEqual(full);
    }
    rig.hook.dispose();
  }, 60_000);

  it('resolves exactly like the unsequenced rules, and shows each hit with its numbers', async () => {
    const kinds = new Set<string>();
    for (const [seed, deck] of [
      ['SPIRE002', undefined],
      ['SPIRE003', undefined],
      ['SPIRE002', Array(10).fill('defend')],
      ['SPIRE003', Array(10).fill('defend')],
    ] as const) {
      const seen: PlayerHit[] = [];
      const rig = await openFight(seed, deck ? { deck } : undefined, {
        onPlayerHit: (hit) => seen.push(hit),
      });
      const { session } = rig;
      const twin = bareTwin(rig, deck);
      twin.drainEvents();
      expect(session.controller.state).toEqual(twin.state);
      for (let turn = 0; turn < 6 && session.controller.outcome === null; turn++) {
        // Spend the steam on Brass Guards in both, through the controller (no drags needed).
        for (const c of [session.controller, twin]) {
          for (let i = 0; i < 3; i++) {
            const card = c.state.piles.hand.find(
              (h) =>
                h.def.id === 'defend' &&
                cardSteamCost(h.def.cost, c.state.player.steam) <= c.state.player.steam,
            );
            if (!card) break;
            c.select(card.uid);
            c.table();
          }
        }
        rig.step();
        twin.drainEvents();
        const seenFrom = seen.length;
        const { hits } = endTurnAndWatch(rig);
        twin.endTurn();
        expect(session.controller.state).toEqual(twin.state);
        const expected = segmentEvents(twin.drainEvents()).flatMap((seg) => {
          const hit = seg.kind === 'enemy' ? playerHit([...seg.lead, ...seg.act]) : null;
          return hit && seg.kind === 'enemy' ? [{ ...hit, enemyId: seg.enemyId }] : [];
        });
        expect(hits.map(({ at: _at, ...h }) => h)).toEqual(expected);
        expect(seen.slice(seenFrom)).toEqual(expected.map(({ enemyId: _id, ...h }) => h));
        for (const h of hits) kinds.add(h.kind);
      }
      rig.hook.dispose();
    }
    expect(kinds).toContain('hit');
    expect(kinds.has('blocked') || kinds.has('partial')).toBe(true);
  }, 120_000);

  it('locks End Turn, cards and dice until the last enemy is done', async () => {
    const rig = await openFight('SPIRE002');
    const { session } = rig;
    const handBefore = session.controller.state.piles.hand.length;
    rig.actions.emit({ type: 'end-turn' });
    rig.step();
    expect(session.enemyPhase).toBe(true);
    expect(session.stage).toBe('enemy');
    expect(session.fan.count).toBe(0);
    const frozen = JSON.stringify(session.controller.state);
    const turn = session.controller.state.turn;
    rig.actions.emit({ type: 'end-turn' });
    rig.actions.emit({ type: 'throw-dice' });
    pointerAt(rig, at(session, 'end-turn'), 'down');
    pointerAt(rig, at(session, 'end-turn'), 'up');
    pointerAt(rig, at(session, 'table'), 'down');
    pointerAt(rig, at(session, 'table'), 'up');
    rig.step();
    expect(JSON.stringify(session.controller.state)).toBe(frozen);
    expect(session.message).toBe('Enemies are acting');
    expect(session.fan.count).toBe(0);
    for (let i = 0; i < 900 && session.enemyPhase; i++) rig.step();
    expect(session.enemyPhase).toBe(false);
    expect(session.controller.state.turn).toBe(turn);
    expect(session.fan.count).toBe(session.controller.state.piles.hand.length);
    expect(session.fan.count).toBe(handBefore);
    // The next End Turn is accepted again.
    rig.actions.emit({ type: 'end-turn' });
    rig.step();
    expect(session.enemyPhase || session.controller.state.turn > turn).toBe(true);
    rig.hook.dispose();
  }, 60_000);

  it('puts every lunging or bracing capsule back exactly where it stood', async () => {
    const rig = await openFight('SPIRE002');
    const { session } = rig;
    const homes = session.enemies.map(({ body }) => body.position.clone());
    let moved = 0;
    rig.actions.emit({ type: 'end-turn' });
    for (let i = 0; i < 900; i++) {
      rig.step();
      session.enemies.forEach(({ body }, k) => {
        if (body.position.distanceTo(homes[k] as THREE.Vector3) > 0.05) moved++;
      });
      if (!session.enemyPhase) break;
    }
    expect(moved).toBeGreaterThan(0);
    session.enemies.forEach(({ body }, k) => {
      expect(body.position.toArray()).toEqual((homes[k] as THREE.Vector3).toArray());
    });
    rig.hook.dispose();
  }, 60_000);
});

it('seats the rack inside the authored rim beyond the cog', async () => {
  const rig = await openFight(
    'SPIRE002',
    { deck: ['clockwork-turret'] },
    {},
    {
      tableAsset: tableAssetStandIn(),
    },
  );
  try {
    const { session } = rig;
    const rack = session.mechanismRack?.root;
    const base = rack?.children.find((child): child is THREE.Mesh => child instanceof THREE.Mesh);
    const pose = rig.view.encounter.tablePose;
    if (!base || !pose) throw new Error('Missing authored table or mechanism rack');
    base.updateWorldMatrix(true, false);
    base.geometry.computeBoundingBox();
    const tableToWorld = new THREE.Matrix4()
      .makeRotationY((-pose.yaw * Math.PI) / 180)
      .setPosition(pose.x, pose.height, pose.z);
    const box = base.geometry.boundingBox
      ?.clone()
      .applyMatrix4(tableToWorld.invert().multiply(base.matrixWorld));
    if (!box) throw new Error('Missing mechanism rack base bounds');
    expect(box.max.z).toBeLessThan(-0.15 - 0.105);
    const right = Math.max(-box.min.x, box.max.x);
    const forward = -box.min.z;
    expect((right / 0.73) ** 3 + (forward / 0.38) ** 3).toBeLessThan(1);
  } finally {
    rig.hook.dispose();
    rig.view.dispose();
  }
});

it('shows a turret hit before the enemy acts and removes its table rack with the session', async () => {
  const rig = await openFight('SPIRE002', {
    deck: ['clockwork-turret+', 'strike', 'strike', 'defend', 'defend'],
  });
  const { session } = rig;
  const rack = session.mechanismRack?.root;
  const base = rack?.children.find((child): child is THREE.Mesh => child instanceof THREE.Mesh);
  if (!rack || !base) throw new Error('Missing mechanism rack');
  const release = vi.spyOn(base.geometry, 'dispose');
  const { controller } = session;
  try {
    const card = controller.state.piles.hand.find((entry) => entry.def.id === 'clockwork-turret+');
    if (!card) throw new Error('Missing turret card');
    expect(controller.select(card.uid).ok).toBe(true);
    expect(controller.table().ok).toBe(true);
    rig.step();
    expect(rack.getObjectByName('mechanism-slot-0')?.userData.cardId).toBe('clockwork-turret+');
    const weakest = session.view.enemies.reduce((a, b) => (b.hp < a.hp ? b : a));
    const hp = weakest.hp;
    const targetHp = () => session.view.enemies.find((enemy) => enemy.id === weakest.id)?.hp;
    rig.actions.emit({ type: 'end-turn' });
    rig.step();
    expect(targetHp()).toBe(hp);
    expect(session.turnTrace).toHaveLength(0);
    for (let i = 0; i < 90 && targetHp() === hp; i++) rig.step();
    expect(targetHp()).toBe(hp - 5);
    expect(session.log.some((line) => line.includes('Clockwork Turret+ activates'))).toBe(true);
    expect(session.turnTrace).toHaveLength(0);
    for (let i = 0; i < 120 && session.turnTrace.length === 0; i++) rig.step();
    expect(session.turnTrace).toHaveLength(1);
  } finally {
    rig.hook.dispose();
    rig.view.dispose();
  }
  expect(rack.parent).toBeNull();
  expect(release).toHaveBeenCalledOnce();
});

it('sends Arc Chain from the plate to its aimed enemy before branching to the others', async () => {
  const rig = await openFight('SPIRE002', { deck: Array(5).fill('arc-chain+') });
  const { session } = rig;
  const launch = vi.spyOn(session.spellFx, 'launch');
  const impact = vi.spyOn(session.spellFx, 'impact');
  try {
    const before = session.view.enemies.map((enemy) => enemy.hp);
    expect(before.length).toBeGreaterThan(1);
    const foe = session.view.enemies.at(-1);
    const entry = session.controller.state.piles.hand[0];
    if (!foe || !entry) throw new Error('Missing Arc Chain test target');
    playCard(rig, session, entry.uid, at(session, 'enemy', foe.id));
    expect(session.controller.selectedTarget).toBe(foe.id);
    drawSigil(rig, session);
    expect(session.attackInFlight).toBe(true);
    expect(session.view.enemies.map((enemy) => enemy.hp)).toEqual(before);
    for (let i = 0; i < 120 && !launch.mock.calls.length; i++) rig.step();
    expect(launch.mock.calls).toHaveLength(1);
    const first = launch.mock.calls[0]?.[1];
    expect(first).toBeDefined();
    for (let i = 0; i < 120 && launch.mock.calls.length < before.length; i++) rig.step();
    expect(launch.mock.calls).toHaveLength(before.length);
    expect(impact.mock.calls).toHaveLength(1);
    for (const [from, to, duration] of launch.mock.calls.slice(1)) {
      expect(from).toEqual(first);
      expect(duration).toBeCloseTo(
        flightSeconds(Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z)),
      );
    }
    expect(session.view.enemies.map((enemy) => enemy.hp)).toEqual(before);
    for (let i = 0; i < 120 && session.attackInFlight; i++) rig.step();
    expect(session.attackInFlight).toBe(false);
    expect(impact.mock.calls).toHaveLength(before.length);
    expect(session.view.enemies.map((enemy) => enemy.hp)).toEqual(
      session.controller.state.enemies.map((enemy) => enemy.hp),
    );
  } finally {
    rig.hook.dispose();
    rig.view.dispose();
  }
});
