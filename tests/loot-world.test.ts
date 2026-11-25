import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getCard } from '../src/content/cards.ts';
import { GREYBOX_TEMPLATES, type RoomTemplate } from '../src/content/rooms.ts';
import { generateFloor, guardedConnection, worldRooms } from '../src/floor/generate.ts';
import { withBrassCache } from '../src/floor/return-passages.ts';
import { mountFloorView } from '../src/world/floor-view.ts';
import { buildFloorWorld } from '../src/world/floor-world.ts';
import { LootToast, lootLines, surfaceHeightAt } from '../src/world/loot.ts';
import { moveWithCollision, type Vec2 } from '../src/xr/locomotion.ts';

/** The desk collider the baked study manifest adds (`public/assets/rooms/study`). */
const DESK = { min: [1.721, 0, 1.721], max: [3.079, 1.07, 3.079] } as const;
const STUDY_WITH_DESK: readonly RoomTemplate[] = GREYBOX_TEMPLATES.map((t) =>
  t.id === 'study'
    ? { ...t, colliders: [...t.colliders, { min: [...DESK.min], max: [...DESK.max] }] }
    : t,
);

const SEEDS = ['SPIRE001', 'SPIRE002', 'SPIRE003', 'SPIRE005', 'SPIRE034', 'SPIRE004', 'SPIRE010'];

describe('coffers in the floor world', () => {
  it('instantiates the brass coffer when its only reachable socket is in a quiet room', () => {
    const base = generateFloor('SPIRE002');
    const study = base.rooms.find((r) => r.templateId === 'study');
    if (!study) throw Error('Fixture needs a study drawer');
    const plan = withBrassCache({
      ...base,
      rooms: [{ ...study, index: 0, role: 'entry', encounter: null, loot: [] }],
      guardianRoom: -1,
      connections: [],
      sealed: [],
    });
    expect(plan.brassCache).toEqual({ room: 0, socketId: 'desk-drawer' });
    const world = buildFloorWorld(plan, STUDY_WITH_DESK);
    expect(world.coffers.map((c) => c.socketId)).toEqual(['desk-drawer']);
    expect(world.coffers[0]?.object.getObjectByName('coffer-padlock')?.visible).toBe(true);
    world.dispose();
  });

  it('builds the planned treasure and combat coffers and pays the vault reward separately', () => {
    for (const seed of SEEDS) {
      const plan = generateFloor(seed);
      const world = buildFloorWorld(plan);
      const expected = plan.rooms
        .filter((r) => r.role === 'treasure' || r.role === 'combat')
        .flatMap((r) => r.loot.map((l) => `coffer-${r.index}-${l.socketId}`));
      expect(world.coffers.map((c) => c.object.name).sort()).toEqual(expected.sort());
      expect(world.coffers.every((c) => c.room !== plan.guardianRoom)).toBe(true);
      expect(plan.rooms[plan.guardianRoom]?.loot.length).toBeGreaterThan(0);
      world.dispose();
    }
  });

  it('places each coffer at its manifest loot socket, in world space, facing its yaw', () => {
    for (const seed of SEEDS) {
      const plan = generateFloor(seed);
      const world = buildFloorWorld(plan);
      world.group.updateMatrixWorld(true);
      const rooms = worldRooms(plan);
      for (const coffer of world.coffers) {
        const room = rooms[coffer.room];
        const placed = plan.rooms[coffer.room];
        const socket = room?.template.lootSockets.find((s) => s.id === coffer.socketId);
        expect(room && placed && socket).toBeTruthy();
        if (!room || !placed || !socket) continue;
        const at = coffer.object.getWorldPosition(new THREE.Vector3());
        expect(at.x).toBeCloseTo(placed.position[0] + socket.position[0], 6);
        expect(at.z).toBeCloseTo(placed.position[1] + socket.position[2], 6);
        expect(at.y).toBeCloseTo(0, 6);
        const front = new THREE.Vector3(0, 0, -1).transformDirection(coffer.object.matrixWorld);
        const yaw = (socket.yaw * Math.PI) / 180;
        expect(front.x).toBeCloseTo(Math.sin(yaw), 6);
        expect(front.z).toBeCloseTo(-Math.cos(yaw), 6);
        expect(coffer.kind).toBe(placed.loot.find((l) => l.socketId === coffer.socketId)?.kind);
      }
      world.dispose();
    }
  });

  it('stands on the desk top when the room has one and on the floor in the greybox', () => {
    expect(
      surfaceHeightAt(STUDY_WITH_DESK.find((t) => t.id === 'study')?.colliders ?? [], 2.6, 2.6),
    ).toBeCloseTo(1.07);
    expect(
      surfaceHeightAt(GREYBOX_TEMPLATES.find((t) => t.id === 'study')?.colliders ?? [], 2.6, 2.6),
    ).toBe(0);
    const plan = generateFloor('SPIRE002');
    const world = buildFloorWorld(plan, STUDY_WITH_DESK);
    world.group.updateMatrixWorld(true);
    const [coffer] = world.coffers;
    expect(coffer?.object.getWorldPosition(new THREE.Vector3()).y).toBeCloseTo(0.78, 6);
    world.dispose();
  });

  it('supports the desk coffer and clears the rack and candles throughout the lid swing', () => {
    const world = buildFloorWorld(generateFloor('SPIRE002'), STUDY_WITH_DESK);
    const coffer = world.coffers.find((c) => c.socketId === 'desk-drawer');
    if (!coffer) throw new Error('missing study coffer');
    world.group.updateMatrixWorld(true);
    const toDesk = new THREE.Matrix4()
      .makeRotationY(-Math.PI / 4)
      .multiply(new THREE.Matrix4().makeTranslation(-2.4, -0.78, -2.4))
      .multiply(world.roomGroups[coffer.room].matrixWorld.clone().invert());
    const rack = new THREE.Box3(
      new THREE.Vector3(-0.66, 0, 0.14),
      new THREE.Vector3(0.66, 0.29, 0.32),
    );
    const obstacles = [
      rack,
      ...[
        [0.42, 0.18],
        [-0.36, 0.2],
      ].map(
        ([x, z]) =>
          new THREE.Box3(
            new THREE.Vector3(x - 0.05, 0.29, z - 0.05),
            new THREE.Vector3(x + 0.05, 0.62, z + 0.05),
          ),
      ),
    ];
    const triangle = new THREE.Triangle(),
      toLocal = new THREE.Matrix4();
    const bodyBounds = new THREE.Box3();
    let tested = 0,
      collided = false;
    coffer.unlock(true);
    coffer.open(true);
    for (let step = 0; step <= 24; step++) {
      world.group.updateMatrixWorld(true);
      coffer.object.traverse((node) => {
        if (
          !(node instanceof THREE.Mesh) ||
          !node.visible ||
          ['coffer-hit', 'coffer-glow'].includes(node.name)
        )
          return;
        const g = node.geometry,
          index = g.index,
          pos = g.getAttribute('position');
        toLocal.multiplyMatrices(toDesk, node.matrixWorld);
        for (let i = 0; i < (index?.count ?? pos.count); i += 3) {
          for (const [j, v] of [triangle.a, triangle.b, triangle.c].entries()) {
            v.fromBufferAttribute(pos, index ? index.getX(i + j) : i + j).applyMatrix4(toLocal);
            if (node.name === 'coffer-body' && step === 0) bodyBounds.expandByPoint(v);
          }
          tested++;
          if (obstacles.some((o) => o.intersectsTriangle(triangle))) collided = true;
        }
      });
      coffer.update(0.025);
    }
    expect(coffer.object.getObjectByName('coffer-lid')?.rotation.x).toBeGreaterThan(Math.PI / 2);
    expect(tested).toBeGreaterThan(100);
    expect(bodyBounds.min.y).toBeCloseTo(0, 5);
    expect(bodyBounds.min.z).toBeGreaterThan(-0.31);
    expect(bodyBounds.max.z).toBeLessThan(0.14);
    expect(Math.max(Math.abs(bodyBounds.min.x), Math.abs(bodyBounds.max.x))).toBeLessThan(0.65);
    expect(collided).toBe(false);
    world.dispose();
  });

  it('removes the greybox marker the coffer replaces', () => {
    const world = buildFloorWorld(generateFloor('SPIRE002'));
    const coffer = world.coffers[0];
    const group = world.roomGroups[coffer?.room ?? -1];
    expect(group?.getObjectByName('socket-desk-drawer')).toBeUndefined();
    world.dispose();
  });

  it('frees its geometry and placeholder materials with the floor', () => {
    const world = buildFloorWorld(generateFloor('SPIRE002'));
    const mesh = world.coffers[0]?.object.getObjectByName('coffer-body') as THREE.Mesh;
    const body = mesh.geometry;
    const material = mesh.material as THREE.Material;
    let freed = 0;
    body.addEventListener('dispose', () => freed++);
    material.addEventListener('dispose', () => freed++);
    world.dispose();
    expect(freed).toBe(2);
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

describe('floor loot view', () => {
  beforeEach(stubCanvas2d);
  afterEach(() => vi.restoreAllMocks());
  const mount = (seed: string) => {
    const scene = new THREE.Scene();
    const rig = new THREE.Group();
    scene.add(rig);
    const view = mountFloorView(scene, rig, seed);
    return { scene, rig, view };
  };
  /** Moves the floor's current room to the coffer's room. */
  const enter = (view: ReturnType<typeof mount>['view'], room: number) => {
    const r = view.world.rooms[room];
    const fp = r?.footprint;
    if (!fp) throw new Error('no room');
    view.world.update((fp.min[0] + fp.max[0]) / 2, (fp.min[1] + fp.max[1]) / 2);
    expect(view.world.current).toBe(room);
    view.world.group.updateMatrixWorld(true);
  };

  it('keeps every line of a longer reward caption inside the framed plaque', () => {
    const draws: [string, number, number, number][] = [];
    const context = new Proxy(
      {
        measureText: (text: string) => ({ width: text.length * 20 }),
        fillText: (...args: [string, number, number, number]) => draws.push(args),
      },
      { get: (target, key) => Reflect.get(target, key) ?? (() => undefined) },
    );
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
      context as unknown as CanvasRenderingContext2D,
    );
    const caption = 'The clockmaker hid a cache for the one who noticed the red book.';
    const toast = new LootToast({ text: '+10 cogs', caption }, new THREE.Vector3());
    const lines = draws.slice(1);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.map(([line]) => line).join(' ')).toBe(caption);
    for (const [line, x, y, maxWidth] of lines) {
      expect(context.measureText(line).width).toBeLessThanOrEqual(maxWidth);
      expect(x - maxWidth / 2).toBeGreaterThan(18);
      expect(y + 20).toBeLessThan(toast.canvas.height / 2 - 18);
    }
    toast.dispose();
  });

  it('picks an unopened coffer in the current room along a ray, within reach', () => {
    const { view } = mount('SPIRE002');
    const coffer = view.loot.coffers[0];
    if (!coffer) throw new Error('SPIRE002 has a coffer');
    // Room 0 is current at the start: the coffer is not pickable from another room.
    const target = coffer.object.getWorldPosition(new THREE.Vector3());
    const from = target.clone().add(new THREE.Vector3(0, 0.6, 2));
    expect(view.loot.pick(from, target.clone().sub(from))).toBeNull();
    enter(view, coffer.room);
    const hit = view.loot.pick(from, target.clone().sub(from));
    expect(hit).toMatchObject({ room: coffer.room, socketId: 'desk-drawer', kind: 'cogs' });
    expect(hit?.distance).toBeGreaterThan(1);
    expect(view.loot.pick(from, target.clone().sub(from), 1)).toBeNull();
    expect(view.loot.pick(from, new THREE.Vector3(0, 1, 0))).toBeNull();
    view.dispose();
  });

  it('opens a coffer: the lid swings, the picked coffer stops being a target, a panel shows the find', () => {
    const { view } = mount('SPIRE002');
    const coffer = view.loot.coffers.find(
      (c) => view.world.plan.rooms[c.room]?.role === 'treasure',
    );
    if (!coffer) throw new Error('SPIRE002 has a coffer');
    enter(view, coffer.room);
    const target = coffer.object.getWorldPosition(new THREE.Vector3());
    const from = target.clone().add(new THREE.Vector3(0, 0.6, 2));
    const fp = view.world.rooms[coffer.room]?.footprint;
    const head = new THREE.Object3D();
    head.position.set(
      ((fp?.min[0] ?? 0) + (fp?.max[0] ?? 0)) / 2,
      1.6,
      ((fp?.min[1] ?? 0) + (fp?.max[1] ?? 0)) / 2,
    );
    view.suspendTriggers = true;
    expect(coffer.opened).toBe(false);
    expect(view.loot.open(coffer.room, 'desk-drawer', { kind: 'cogs', cogs: 19 })).toBe(true);
    expect(view.loot.open(9999, 'x', { kind: 'cogs', cogs: 1 })).toBe(false);
    expect(coffer.opened).toBe(true);
    for (let i = 0; i < 20; i++) view.update(head, 0.05);
    const lid = coffer.object.getObjectByName('coffer-lid');
    expect(lid?.rotation.x).toBeGreaterThan(1.5);
    expect(coffer.object.getObjectByName('coffer-glow')?.visible).toBe(true);
    expect(view.loot.toast?.text).toBe('+19 cogs');
    expect(view.loot.pick(from, target.clone().sub(from))).toBeNull();
    // The panel faces the head, then expires and is freed.
    const panel = view.world.group.getObjectByName('loot-toast-root');
    expect(panel).toBeDefined();
    const toastBefore = view.loot.toast;
    for (let i = 0; i < 100; i++) view.update(head, 0.05);
    expect(view.loot.toast).toBeNull();
    expect(view.world.group.getObjectByName('loot-toast-root')).toBeUndefined();
    expect(toastBefore?.text).toBe('+19 cogs');
    view.dispose();
  });

  it('shows the lock on a combat coffer until its room is cleared', () => {
    const { view } = mount('SPIRE002');
    const coffer = view.loot.coffers.find((c) => view.world.plan.rooms[c.room]?.role === 'combat');
    if (!coffer) throw new Error('SPIRE002 has a guarded coffer');
    const { room, socketId } = coffer;
    const payout = { kind: 'cogs', cogs: 7 } as const;
    expect(view.loot.showLock(room, socketId)).toBe(true);
    const padlock = coffer.object.getObjectByName('coffer-padlock');
    expect(padlock?.visible).toBe(true);
    expect(view.loot.toast?.text).toBe('Locked');
    expect(view.loot.open(room, socketId, payout)).toBe(false);
    expect(coffer.opened).toBe(false);
    view.markCleared(room);
    view.update(new THREE.Object3D(), 0.25);
    expect(padlock?.visible).toBe(false);
    expect(view.loot.showLock(room, socketId)).toBe(false);
    expect(view.loot.open(room, socketId, payout)).toBe(true);
    expect(coffer.opened).toBe(true);
    view.dispose();
  });

  it('blocks a selected exit on both sides and removes its collider when restoring a win', () => {
    const seed = SEEDS.find((seed) => guardedConnection(generateFloor(seed)) !== null);
    if (!seed) throw new Error('no guarded doors in the fixture set');
    const { view } = mount(seed);
    const passage = guardedConnection(view.world.plan);
    if (!passage) throw new Error('missing guarded connection');
    const [from, to] = passage;
    const door = view.world.rooms[from.room]?.doors.find((door) => door.id === from.door);
    if (!door) throw new Error('missing guarded door');
    const walkThrough = (room: number, sign: number): number => {
      enter(view, room);
      const [x, z] = door.world;
      const sx = door.facing === 'W' ? sign : door.facing === 'E' ? -sign : 0;
      const sz = door.facing === 'N' ? sign : door.facing === 'S' ? -sign : 0;
      const start: Vec2 = [x + sx * 0.6, z + sz * 0.6];
      const end = moveWithCollision(start, [-sx * 1.2, -sz * 1.2], view.world.nearbyColliders());
      return (end[0] - x) * sx + (end[1] - z) * sz;
    };
    expect(door.world).toEqual(
      view.world.rooms[to.room]?.doors.find((door) => door.id === to.door)?.world,
    );
    const visual = view.world.group.getObjectByName(`encounter-lock-${from.room}-${from.door}`);
    expect(visual?.parent).toBe(view.world.roomGroups[from.room]);
    const leaf = visual?.getObjectByName('encounter-lock-leaf');
    const before = leaf?.getWorldPosition(new THREE.Vector3());
    const doorClick = (room: number, sign: number) => {
      enter(view, room);
      const [x, z] = door.world;
      const dx = door.facing === 'W' ? sign : door.facing === 'E' ? -sign : 0;
      const dz = door.facing === 'N' ? sign : door.facing === 'S' ? -sign : 0;
      return view.world.pickLockedDoor(
        new THREE.Vector3(x + dx, 1.15, z + dz),
        new THREE.Vector3(-dx, 0, -dz),
      );
    };
    expect(walkThrough(from.room, 1)).toBeGreaterThan(0.25);
    expect(walkThrough(to.room, -1)).toBeGreaterThan(0.25);
    expect(doorClick(from.room, 1)?.kind).toBe('encounter');
    expect(doorClick(to.room, -1)?.kind).toBe('encounter');
    view.markCleared(to.room);
    expect(walkThrough(from.room, 1)).toBeGreaterThan(0.25);
    view.markCleared(from.room);
    expect(
      view.world.group.getObjectByName(`encounter-lock-${from.room}-${from.door}`),
    ).toBeDefined();
    view.suspendTriggers = true;
    const head = new THREE.Object3D();
    view.update(head, 0.05);
    const during = leaf?.getWorldPosition(new THREE.Vector3());
    expect(before && during && during.distanceTo(before)).toBeGreaterThan(0.001);
    for (let i = 1; i < 20; i++) view.update(head, 0.05);
    const openedDoor = view.world.group.getObjectByName(`encounter-lock-${from.room}-${from.door}`);
    expect(openedDoor).toBeDefined();
    expect(openedDoor?.getObjectByName('encounter-lock-leaf')).toBeDefined();
    expect(walkThrough(from.room, 1)).toBeCloseTo(-0.6);
    expect(walkThrough(to.room, -1)).toBeCloseTo(-0.6);
    expect(doorClick(from.room, 1)).toBeNull();
    expect(doorClick(to.room, -1)).toBeNull();
    view.dispose();
  });

  it('shows a resumed coffer open at once with no panel', () => {
    const { view } = mount('SPIRE002');
    const coffer = view.loot.coffers[0];
    if (!coffer) throw new Error('SPIRE002 has a coffer');
    view.loot.markOpened(coffer.room, 'desk-drawer');
    expect(coffer.opened).toBe(true);
    expect(coffer.object.getObjectByName('coffer-lid')?.rotation.x).toBeGreaterThan(1.5);
    expect(view.loot.toast).toBeNull();
    view.dispose();
  });

  it('disposes a live panel with the floor and leaves no coffer nodes behind', () => {
    const { scene, view } = mount('SPIRE002');
    const coffer = view.loot.coffers[0];
    if (!coffer) throw new Error('SPIRE002 has a coffer');
    view.loot.open(coffer.room, 'desk-drawer', { kind: 'cogs', cogs: 17 });
    view.dispose();
    let nodes = 0;
    scene.traverse(() => nodes++);
    expect(nodes).toBe(2);
  });

  it('keeps the same node count open and closed so scene-leak checks stay exact', () => {
    const { view } = mount('SPIRE002');
    const count = (): number => {
      let n = 0;
      view.world.group.traverse(() => n++);
      return n;
    };
    const coffer = view.loot.coffers[0];
    if (!coffer) throw new Error('SPIRE002 has a coffer');
    const closed = count();
    view.loot.markOpened(coffer.room, 'desk-drawer');
    expect(count()).toBe(closed);
    view.dispose();
  });
});

describe('lootLines', () => {
  it('words a cog pickup and a card pickup', () => {
    expect(lootLines({ kind: 'cogs', cogs: 21 }).text).toBe('+21 cogs');
    expect(lootLines({ kind: 'card', card: 'arc-bolt' }).text).toBe(
      `New card: ${getCard('arc-bolt').name}`,
    );
  });
});
