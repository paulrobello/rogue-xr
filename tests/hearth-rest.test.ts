import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STARTER_DECK } from '../src/content/cards.ts';
import { REWARD_POOL } from '../src/content/rewards.ts';
import { GREYBOX_TEMPLATES, type RoomTemplate } from '../src/content/rooms.ts';
import { generateFloor, worldRooms } from '../src/floor/generate.ts';
import { type FlowEvent, RunFlow } from '../src/flow/flow.ts';
import { bindFlowPersistence } from '../src/flow/persist.ts';
import { openDb } from '../src/persist/db.ts';
import { loadRunSnapshot, SaveError, snapshotRun, validateSnapshot } from '../src/persist/saves.ts';
import {
  createRun,
  HEARTH_HEAL_FRACTION,
  hearthHeal,
  lootKey,
  parseLootKey,
  type RunState,
  useHearth,
} from '../src/rules/index.ts';
import { createWorkshop } from '../src/rules/workshop.ts';
import { mountFloorView } from '../src/world/floor-view.ts';
import { buildFloorWorld } from '../src/world/floor-world.ts';
import { hearthLines, hearthSocket } from '../src/world/hearth.ts';

/** Floors with one rest room (SPIRE007, room 4) and with two (SPIRE024, rooms 1 and 6). */
const REST_SEED = 'SPIRE007';
const REST_ROOM = 4;
const TWO_REST_SEED = 'SPIRE024';
const NO_REST_SEEDS = ['SPIRE001', 'SPIRE002', 'SPIRE003', 'SPIRE004', 'SPIRE010', 'SPIRE034'];
const KEY = lootKey(REST_ROOM, 'chest');

const newRun = (seed = REST_SEED, hp?: number, maxHp?: number): RunState =>
  createRun(seed, STARTER_DECK, {
    ...(hp === undefined ? {} : { hp }),
    ...(maxHp === undefined ? {} : { maxHp }),
  });

function newFlow(): RunFlow {
  return new RunFlow({
    workshop: createWorkshop(),
    starterDeck: STARTER_DECK,
    rewardPool: REWARD_POOL,
  });
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

describe('the hearth rule constant', () => {
  it('is the 30 percent default the owner reviews', () => {
    expect(HEARTH_HEAL_FRACTION).toBe(0.3);
  });
});

describe('hearthHeal', () => {
  it('is 30 percent of max hp rounded down, capped at the missing hp', () => {
    expect(hearthHeal({ hp: 20, maxHp: 60 })).toBe(18);
    expect(hearthHeal({ hp: 1, maxHp: 55 })).toBe(16);
    expect(hearthHeal({ hp: 1, maxHp: 7 })).toBe(2);
    expect(hearthHeal({ hp: 1, maxHp: 3 })).toBe(0);
    expect(hearthHeal({ hp: 50, maxHp: 60 })).toBe(10);
    expect(hearthHeal({ hp: 42, maxHp: 60 })).toBe(18);
    expect(hearthHeal({ hp: 43, maxHp: 60 })).toBe(17);
    expect(hearthHeal({ hp: 60, maxHp: 60 })).toBe(0);
  });
});

describe('useHearth', () => {
  it('heals by the rule and records the hearth once, changing nothing else', () => {
    const run = deepFreeze(newRun(REST_SEED, 20));
    const first = useHearth(run, KEY);
    expect(first).not.toBeNull();
    expect(first?.healed).toBe(18);
    expect(first?.run.hp).toBe(38);
    expect(first?.run.usedHearths).toEqual([KEY]);
    const healedRun = first?.run as RunState;
    const { hp: _hp, usedHearths: _used, ...rest } = healedRun;
    const { hp: _before, ...untouched } = run;
    expect(rest).toEqual(untouched);
    expect(run.usedHearths).toBeUndefined();
  });

  it('caps the heal at max hp and reports the hp actually gained', () => {
    const result = useHearth(newRun(REST_SEED, 55), KEY);
    expect(result?.healed).toBe(5);
    expect(result?.run.hp).toBe(60);
  });

  it('is spent even at full hp, healing nothing', () => {
    const result = useHearth(newRun(), KEY);
    expect(result?.healed).toBe(0);
    expect(result?.run.hp).toBe(60);
    expect(result?.run.usedHearths).toEqual([KEY]);
    expect(useHearth(result?.run as RunState, KEY)).toBeNull();
  });

  it('refuses a second use of the same hearth and leaves the run as it was', () => {
    const used = useHearth(newRun(REST_SEED, 10), KEY)?.run as RunState;
    expect(useHearth(used, KEY)).toBeNull();
    expect(used.hp).toBe(28);
  });

  it('keeps hearths apart by room', () => {
    const a = useHearth(newRun(REST_SEED, 10), lootKey(1, 'chest'))?.run as RunState;
    const b = useHearth(a, lootKey(6, 'chest'));
    expect(b?.run.usedHearths).toEqual([lootKey(1, 'chest'), lootKey(6, 'chest')]);
    expect(b?.run.hp).toBe(10 + 18 + 18);
  });

  it('draws no random number: every stream is exactly as it was', () => {
    const run = newRun(REST_SEED, 10);
    expect(useHearth(run, KEY)?.run.rng).toEqual(run.rng);
  });

  it('does not touch the treasure record', () => {
    const run: RunState = { ...newRun(REST_SEED, 10), openedLoot: [lootKey(3, 'desk-drawer')] };
    expect(useHearth(run, KEY)?.run.openedLoot).toEqual([lootKey(3, 'desk-drawer')]);
  });
});

describe('RunFlow.useHearth', () => {
  it('works only while exploring', () => {
    const flow = newFlow();
    expect(flow.useHearth(REST_ROOM, 'chest')).toBeNull();
    flow.newRun(REST_SEED);
    flow.fightStarted(2);
    expect(flow.phase).toBe('combat');
    expect(flow.useHearth(REST_ROOM, 'chest')).toBeNull();
    flow.fightEnded({ room: 2, outcome: 'win', tier: 'regular', playerHp: 30 });
    expect(flow.phase).toBe('reward');
    expect(flow.useHearth(REST_ROOM, 'chest')).toBeNull();
    expect(flow.run?.usedHearths).toBeUndefined();
    expect(flow.run?.hp).toBe(30);
  });

  it('heals once, says how much, and emits one hearth event', () => {
    const flow = newFlow();
    const seen: FlowEvent[] = [];
    flow.onChange((e) => seen.push(e));
    flow.newRun(REST_SEED);
    flow.fightStarted(2);
    flow.fightEnded({ room: 2, outcome: 'flee', tier: 'regular', playerHp: 25 });
    expect(flow.phase).toBe('explore');
    const before = flow.run as RunState;
    const used = flow.useHearth(REST_ROOM, 'chest');
    expect(used).toEqual({ room: REST_ROOM, socketId: 'chest', healed: 18, hp: 43 });
    expect(flow.run?.hp).toBe(before.hp + 18);
    expect(flow.run?.cogs).toBe(before.cogs);
    expect(flow.run?.deck).toEqual(before.deck);
    expect(flow.isHearthUsed(REST_ROOM, 'chest')).toBe(true);
    expect(flow.lastHearth).toEqual(used);
    expect(flow.useHearth(REST_ROOM, 'chest')).toBeNull();
    expect(flow.run?.hp).toBe(43);
    expect(seen.filter((e) => e.type === 'hearth')).toHaveLength(1);
    expect(flow.phase).toBe('explore');
  });

  it('forgets used hearths with the run', () => {
    const flow = newFlow();
    flow.newRun(REST_SEED);
    flow.useHearth(REST_ROOM, 'chest');
    flow.fightStarted(2);
    flow.fightEnded({ room: 2, outcome: 'defeat', tier: 'regular' });
    flow.toTitle();
    flow.newRun(REST_SEED);
    expect(flow.lastHearth).toBeNull();
    expect(flow.isHearthUsed(REST_ROOM, 'chest')).toBe(false);
    expect(flow.run?.usedHearths).toBeUndefined();
  });

  it('saves a snapshot at the hearth, and a resumed run cannot use it again', async () => {
    const db = await openDb(undefined);
    const flow = newFlow();
    const saved = bindFlowPersistence(flow, db);
    flow.newRun(REST_SEED);
    flow.fightStarted(2);
    flow.fightEnded({ room: 2, outcome: 'flee', tier: 'regular', playerHp: 20 });
    flow.enterRoom(REST_ROOM);
    await saved.flushed();
    expect((await loadRunSnapshot(db))?.run.usedHearths).toBeUndefined();

    flow.useHearth(REST_ROOM, 'chest');
    await saved.flushed();
    const snapshot = await loadRunSnapshot(db);
    expect(snapshot?.run.usedHearths).toEqual([KEY]);
    expect(snapshot?.run.hp).toBe(38);
    expect(snapshot?.run).toEqual(flow.run);
    expect(snapshot?.roomIndex).toBe(REST_ROOM);

    const resumed = newFlow();
    expect(resumed.continueRun(snapshot as NonNullable<typeof snapshot>)).toBe(true);
    expect(resumed.isHearthUsed(REST_ROOM, 'chest')).toBe(true);
    expect(resumed.useHearth(REST_ROOM, 'chest')).toBeNull();
    expect(resumed.run?.hp).toBe(38);
    expect(resumed.run).toEqual(flow.run);
    saved.dispose();
  });
});

describe('snapshots carry used hearths', () => {
  const world = {
    phase: 'explore' as const,
    floorSeed: REST_SEED,
    roomIndex: REST_ROOM,
    clearedEncounters: [],
    pendingReward: null,
  };

  it('round-trips through snapshotRun and JSON', () => {
    const used = useHearth(newRun(REST_SEED, 10), KEY)?.run as RunState;
    const snap = snapshotRun(used, world, 1);
    expect(snap.run.usedHearths).toEqual([KEY]);
    expect(validateSnapshot(JSON.parse(JSON.stringify(snap))).run).toEqual(used);
  });

  it('loads a snapshot saved before the field existed', () => {
    const raw = JSON.parse(JSON.stringify(snapshotRun(newRun(), world, 1))) as {
      run: Record<string, unknown>;
    };
    expect('usedHearths' in raw.run).toBe(false);
    const snap = validateSnapshot(raw);
    expect(snap.run.usedHearths).toBeUndefined();
    expect(snap.run).toEqual(newRun());
  });

  it('rejects a used-hearth list that is not strings', () => {
    const raw = JSON.parse(JSON.stringify(snapshotRun(newRun(), world, 1))) as {
      run: Record<string, unknown>;
    };
    raw.run.usedHearths = [3];
    expect(() => validateSnapshot(raw)).toThrow(SaveError);
    raw.run.usedHearths = 'x';
    expect(() => validateSnapshot(raw)).toThrow(SaveError);
  });

  it('keys round-trip through parseLootKey', () => {
    expect(parseLootKey(KEY)).toEqual({ room: REST_ROOM, socketId: 'chest' });
  });
});

describe('hearthSocket and hearthLines', () => {
  it('takes the loot socket, then a dressing socket, else nothing', () => {
    const hall = GREYBOX_TEMPLATES.find((t) => t.id === 'hall') as RoomTemplate;
    expect(hearthSocket(hall)?.id).toBe('chest');
    expect(hearthSocket({ ...hall, lootSockets: [] })?.id).toBe('bench-w');
    expect(hearthSocket({ ...hall, lootSockets: [], dressingSockets: [] })).toBeNull();
  });

  it('words the gain as +N hp', () => {
    expect(hearthLines(18).text).toBe('+18 hp');
    expect(hearthLines(0).text).toBe('+0 hp');
  });
});

describe('hearths in the floor world', () => {
  it('stands one in each rest room and none anywhere else', () => {
    for (const seed of [REST_SEED, TWO_REST_SEED, ...NO_REST_SEEDS]) {
      const plan = generateFloor(seed);
      const world = buildFloorWorld(plan);
      const expected = plan.rooms
        .filter((r) => r.role === 'rest')
        .map((r) => `hearth-${r.index}-chest`);
      expect(world.hearths.map((h) => h.object.name).sort()).toEqual(expected.sort());
      world.dispose();
    }
    expect(generateFloor(REST_SEED).rooms[REST_ROOM]?.role).toBe('rest');
    expect(generateFloor(TWO_REST_SEED).rooms.filter((r) => r.role === 'rest')).toHaveLength(2);
    for (const seed of NO_REST_SEEDS)
      expect(generateFloor(seed).rooms.some((r) => r.role === 'rest')).toBe(false);
  });

  it('places each hearth at its rest room loot socket, in world space, on the floor', () => {
    for (const seed of [REST_SEED, TWO_REST_SEED]) {
      const plan = generateFloor(seed);
      const world = buildFloorWorld(plan);
      world.group.updateMatrixWorld(true);
      const rooms = worldRooms(plan);
      for (const hearth of world.hearths) {
        const room = rooms[hearth.room];
        const placed = plan.rooms[hearth.room];
        const socket = room?.template.lootSockets.find((s) => s.id === hearth.socketId);
        expect(room && placed && socket).toBeTruthy();
        if (!placed || !socket) continue;
        const at = hearth.object.getWorldPosition(new THREE.Vector3());
        expect(at.x).toBeCloseTo(placed.position[0] + socket.position[0], 6);
        expect(at.z).toBeCloseTo(placed.position[1] + socket.position[2], 6);
        expect(at.y).toBeCloseTo(0, 6);
        expect(placed.loot).toEqual([]);
      }
      world.dispose();
    }
  });

  it('removes the greybox marker the hearth replaces, and adds no light', () => {
    const world = buildFloorWorld(generateFloor(REST_SEED));
    const hearth = world.hearths[0];
    const group = world.roomGroups[hearth?.room ?? -1];
    expect(group?.getObjectByName('socket-chest')).toBeUndefined();
    let lights = 0;
    hearth?.object.traverse((o) => {
      if (o instanceof THREE.Light) lights++;
    });
    expect(lights).toBe(0);
    world.dispose();
  });

  it('frees its geometry and placeholder materials with the floor', () => {
    const world = buildFloorWorld(generateFloor(REST_SEED));
    const mesh = world.hearths[0]?.object.getObjectByName('hearth-bowl') as THREE.Mesh;
    const coals = world.hearths[0]?.object.getObjectByName('hearth-coals') as THREE.Mesh;
    let freed = 0;
    mesh.geometry.addEventListener('dispose', () => freed++);
    (mesh.material as THREE.Material).addEventListener('dispose', () => freed++);
    (coals.material as THREE.Material).addEventListener('dispose', () => freed++);
    world.dispose();
    expect(freed).toBe(3);
  });
});

/** A do-nothing 2D context: happy-dom has no canvas, and the toast draws on one. */
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

describe('floor hearth view', () => {
  beforeEach(stubCanvas2d);
  afterEach(() => vi.restoreAllMocks());
  const mount = (seed: string) => {
    const scene = new THREE.Scene();
    const rig = new THREE.Group();
    scene.add(rig);
    return { scene, view: mountFloorView(scene, rig, seed) };
  };
  const enter = (view: ReturnType<typeof mount>['view'], room: number) => {
    const fp = view.world.rooms[room]?.footprint;
    if (!fp) throw new Error('no room');
    view.world.update((fp.min[0] + fp.max[0]) / 2, (fp.min[1] + fp.max[1]) / 2);
    expect(view.world.current).toBe(room);
    view.world.group.updateMatrixWorld(true);
  };
  const headIn = (view: ReturnType<typeof mount>['view'], room: number): THREE.Object3D => {
    const fp = view.world.rooms[room]?.footprint;
    const head = new THREE.Object3D();
    head.position.set(
      ((fp?.min[0] ?? 0) + (fp?.max[0] ?? 0)) / 2,
      1.6,
      ((fp?.min[1] ?? 0) + (fp?.max[1] ?? 0)) / 2,
    );
    return head;
  };

  it('picks an unused hearth in the current room along a ray, within reach', () => {
    const { view } = mount(REST_SEED);
    const hearth = view.hearth.hearths[0];
    if (!hearth) throw new Error('SPIRE007 has a hearth');
    const target = hearth.object.getWorldPosition(new THREE.Vector3());
    const from = target.clone().add(new THREE.Vector3(0, 0.8, 2));
    expect(view.hearth.pick(from, target.clone().sub(from))).toBeNull();
    enter(view, hearth.room);
    const hit = view.hearth.pick(from, target.clone().sub(from));
    expect(hit).toMatchObject({ room: REST_ROOM, socketId: 'chest' });
    expect(hit?.distance).toBeGreaterThan(1);
    expect(view.hearth.pick(from, target.clone().sub(from), 1)).toBeNull();
    expect(view.hearth.pick(from, new THREE.Vector3(0, 1, 0))).toBeNull();
    expect(view.loot.pick(from, target.clone().sub(from))).toBeNull();
    view.dispose();
  });

  it('uses a hearth: the coals go to ash, it stops being a target, a panel shows the hp', () => {
    const { view } = mount(REST_SEED);
    const hearth = view.hearth.hearths[0];
    if (!hearth) throw new Error('SPIRE007 has a hearth');
    enter(view, hearth.room);
    const target = hearth.object.getWorldPosition(new THREE.Vector3());
    const from = target.clone().add(new THREE.Vector3(0, 0.8, 2));
    const head = headIn(view, hearth.room);
    view.suspendTriggers = true;
    const coals = hearth.object.getObjectByName('hearth-coals') as THREE.Mesh;
    const lit = (coals.material as THREE.MeshBasicMaterial).color.clone();
    expect(hearth.used).toBe(false);
    expect(view.hearth.use(hearth.room, 'chest', 18)).toBe(true);
    expect(view.hearth.use(9999, 'x', 1)).toBe(false);
    expect(hearth.used).toBe(true);
    for (let i = 0; i < 40; i++) view.update(head, 0.05);
    const ash = (coals.material as THREE.MeshBasicMaterial).color;
    expect(ash.r + ash.g + ash.b).toBeLessThan((lit.r + lit.g + lit.b) * 0.3);
    expect(view.hearth.toast?.text).toBe('+18 hp');
    expect(view.loot.toast?.text).toBe('+18 hp');
    expect(view.hearth.pick(from, target.clone().sub(from))).toBeNull();
    const toastBefore = view.hearth.toast;
    for (let i = 0; i < 100; i++) view.update(head, 0.05);
    expect(view.hearth.toast).toBeNull();
    expect(toastBefore?.text).toBe('+18 hp');
    view.dispose();
  });

  it('shows a resumed hearth spent at once with no panel', () => {
    const { view } = mount(REST_SEED);
    const hearth = view.hearth.hearths[0];
    if (!hearth) throw new Error('SPIRE007 has a hearth');
    view.hearth.markUsed(hearth.room, 'chest');
    expect(hearth.used).toBe(true);
    const coals = hearth.object.getObjectByName('hearth-coals') as THREE.Mesh;
    const ash = (coals.material as THREE.MeshBasicMaterial).color;
    expect(ash.r).toBeLessThan(0.2);
    expect(view.hearth.toast).toBeNull();
    view.dispose();
  });

  it('keeps the same node count lit and spent so scene-leak checks stay exact, and leaves none behind', () => {
    const { scene, view } = mount(REST_SEED);
    const count = (): number => {
      let n = 0;
      view.world.group.traverse(() => n++);
      return n;
    };
    const hearth = view.hearth.hearths[0];
    if (!hearth) throw new Error('SPIRE007 has a hearth');
    const lit = count();
    view.hearth.markUsed(hearth.room, 'chest');
    expect(count()).toBe(lit);
    view.dispose();
    let nodes = 0;
    scene.traverse(() => nodes++);
    expect(nodes).toBe(2);
  });

  it('gives the approach point a clear spot in front of the hearth', () => {
    const { view } = mount(REST_SEED);
    const hearth = view.hearth.hearths[0];
    if (!hearth) throw new Error('SPIRE007 has a hearth');
    const at = view.hearth.approachPoint(hearth.room, 'chest', 2);
    const base = hearth.object.getWorldPosition(new THREE.Vector3());
    expect(at?.distanceTo(new THREE.Vector3(base.x, 0, base.z))).toBeCloseTo(2, 6);
    expect(view.hearth.approachPoint(9999, 'x')).toBeNull();
    view.dispose();
  });
});
