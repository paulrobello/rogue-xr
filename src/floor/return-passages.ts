import { FACINGS, type Facing, type QuarterTurns, templateById } from '../content/rooms.ts';
import { Stream } from '../core/rng.ts';
import {
  attachPressureWing,
  type DoorRef,
  type FloorConnection,
  type FloorPlan,
  generateFloor,
  type PlacedRoom,
  type PuzzleGate,
  rectsOverlap,
  worldRoom,
  worldRooms,
} from './generate.ts';
import { placeStairEntry } from './stairs.ts';

const facing = (side: Facing, turn: number): Facing =>
  FACINGS[(FACINGS.indexOf(side) + turn + 4) % 4];
const same = (a: DoorRef, b: DoorRef) => a.room === b.room && a.door === b.door;
type Site = ReturnType<typeof worldRoom>['doors'][number];

export function joinDoors(plan: FloorPlan, a: DoorRef, b: DoorRef, gate?: PuzzleGate): FloorPlan {
  const edge: FloorConnection = Object.assign([a, b] as const, gate ? { puzzleGate: gate } : {});
  return {
    ...plan,
    connections: [...plan.connections, edge],
    sealed: plan.sealed.filter((s) => !same(s, a) && !same(s, b)),
  };
}

function site(plan: FloorPlan, ref: DoorRef): Site {
  const room = plan.rooms[ref.room];
  const w = worldRoom(templateById(room.templateId), room.turns, room.position);
  const door = w.doors.find((d) => d.id === ref.door);
  if (!door) throw Error('Missing room socket');
  return door;
}

export function attachRoom(
  plan: FloorPlan,
  ref: DoorRef,
  turns: QuarterTurns,
  role: PlacedRoom['role'],
  gate?: PuzzleGate,
  reserve?: ReturnType<typeof placeStairEntry>,
  templateId = 'hall',
): FloorPlan | null {
  const template = templateById(templateId);
  const from = site(plan, ref);
  const entrance = worldRoom(template, turns, [0, 0]).doors.find(
    (d) => d.facing === facing(from.facing, 2),
  );
  if (!entrance) return null;
  const position = [from.world[0] - entrance.world[0], from.world[1] - entrance.world[1]] as const;
  const hall = worldRoom(template, turns, position);
  if (
    worldRooms(plan).some((r) => rectsOverlap(r.footprint, hall.footprint)) ||
    (reserve && rectsOverlap(reserve.alcove, hall.footprint))
  )
    return null;
  const host = plan.rooms[ref.room],
    index = plan.rooms.length;
  const room: PlacedRoom = {
    index,
    position,
    turns,
    templateId,
    role,
    depth: host.depth + 1,
    wing: host.wing,
    encounter: null,
    loot:
      role === 'treasure' && template.lootSockets[0]
        ? [{ socketId: template.lootSockets[0].id, kind: 'card' }]
        : [],
  };
  const next = {
    ...plan,
    rooms: [...plan.rooms, room],
    sealed: [
      ...plan.sealed,
      ...hall.doors.map((d) => ({ room: index, door: d.id, style: 'wall' as const })),
    ],
  };
  return joinDoors(next, ref, { room: index, door: entrance.id }, gate);
}

function doorFacing(plan: FloorPlan, room: number, direction: Facing): DoorRef | undefined {
  return plan.sealed.find((s) => s.room === room && site(plan, s).facing === direction);
}

/** A loop of four offset-door halls closes exactly when adjacent quarters alternate. */
function ring(
  plan: FloorPlan,
  anchor: number,
  out: Facing,
  side: Facing,
  reserve: ReturnType<typeof placeStairEntry>,
): FloorPlan | null {
  let next = plan,
    prev = anchor;
  for (const [i, dir] of [out, side, facing(out, 2)].entries()) {
    const exit = doorFacing(next, prev, dir);
    if (!exit || (reserve && same(exit, reserve))) return null;
    const built = attachRoom(
      next,
      exit,
      ((next.rooms[prev].turns + 1) % 4) as QuarterTurns,
      i === 2 ? 'treasure' : i === 1 ? 'rest' : 'corridor',
      undefined,
      reserve,
    );
    if (!built) return null;
    next = built;
    prev = next.rooms.length - 1;
  }
  const a = doorFacing(next, anchor, side),
    b = doorFacing(next, prev, facing(side, 2));
  if (!a || !b || (reserve && same(a, reserve))) return null;
  const [ax, az] = site(next, a).world,
    [bx, bz] = site(next, b).world;
  return ax === bx && az === bz ? joinDoors(next, a, b, 'counterweight') : null;
}

function withShortcut(
  plan: FloorPlan,
  reserve: ReturnType<typeof placeStairEntry>,
): FloorPlan | null {
  const random = Stream.fromKey(plan.seed + ':service-passages');
  const sources = random.shuffle(
    plan.sealed.filter(
      (s) =>
        s.room !== plan.guardianRoom &&
        s.room !== plan.pressureWing?.pumpRoom &&
        (!reserve || !same(s, reserve)),
    ),
  );
  sources.sort((a, b) => plan.rooms[a.room].depth - plan.rooms[b.room].depth);
  // A spare pair of existing doors can shorten the route without adding an arcade.
  for (const a of sources)
    for (const b of sources) {
      if (
        a.room >= b.room ||
        plan.connections.some(
          (e) => e.some((r) => r.room === a.room) && e.some((r) => r.room === b.room),
        )
      )
        continue;
      const da = site(plan, a),
        db = site(plan, b);
      if (
        da.facing === facing(db.facing, 2) &&
        da.world[0] === db.world[0] &&
        da.world[1] === db.world[1]
      )
        return joinDoors(plan, a, b, 'counterweight');
    }
  for (const a of sources) {
    if (plan.rooms[a.room].templateId !== 'hall') continue;
    const dir = site(plan, a).facing;
    for (const turn of [1, 3]) {
      const result = ring(plan, a.room, dir, facing(dir, turn), reserve);
      if (result) return result;
    }
  }
  for (const a of sources) {
    const dir = site(plan, a).facing;
    let approach = plan,
      exit: DoorRef = a;
    for (let length = 0; length < 3; length++) {
      for (const rotation of [0, 1] as const) {
        const entry = attachRoom(approach, exit, rotation, 'corridor', undefined, reserve);
        if (!entry) continue;
        for (const turn of [1, 3]) {
          const result = ring(entry, entry.rooms.length - 1, dir, facing(dir, turn), reserve);
          if (result) return result;
        }
      }
      const straight = attachRoom(
        approach,
        exit,
        dir === 'N' || dir === 'S' ? 0 : 1,
        'corridor',
        undefined,
        reserve,
        'corridor',
      );
      if (!straight) break;
      approach = straight;
      exit = doorFacing(approach, approach.rooms.length - 1, dir)!;
    }
  }
  return null;
}

function fitReturnPassages(base: FloorPlan, alternative = 0): FloorPlan | null {
  const plan = attachPressureWing(base, undefined, alternative);
  if (!plan.pressureWing) return null;
  const reserve = placeStairEntry(plan);
  const loop = withShortcut(plan, reserve);
  if (!loop) return null;
  return addArchive(base, loop, reserve);
}
function addArchive(
  base: FloorPlan,
  loop: FloorPlan,
  reserve: ReturnType<typeof placeStairEntry>,
): FloorPlan | null {
  const sources = Stream.fromKey(base.seed + ':pressure-vault').shuffle(
    loop.sealed.filter((s) => s.room !== loop.guardianRoom && (!reserve || !same(s, reserve))),
  );
  const rank = (s: DoorRef) => (s.room < base.rooms.length ? 0 : 100) + loop.rooms[s.room].depth;
  for (const door of sources.sort((a, b) => rank(a) - rank(b))) {
    for (const turns of [0, 1] as const) {
      const archive = attachRoom(loop, door, turns, 'treasure', 'pressure', reserve);
      if (archive) return archive;
    }
  }
  return null;
}

export function attachFloorOneTopology(base: FloorPlan): FloorPlan {
  const stream = Stream.fromKey(base.seed + ':return-layout');
  let draft = base;
  for (let attempt = 0; attempt < 50; attempt++) {
    for (let placement = 0; placement < 20; placement++) {
      const result = fitReturnPassages(draft, placement);
      if (result) return result;
    }
    const reserve = placeStairEntry(draft);
    const arcade = withShortcut(draft, reserve);
    if (arcade) {
      for (let placement = 0; placement < 12; placement++) {
        const withPump = attachPressureWing(arcade, undefined, placement);
        if (!withPump.pressureWing) continue;
        const archive = addArchive(draft, withPump, placeStairEntry(withPump));
        if (archive) return archive;
      }
    }
    const layoutSeed = stream.nextUint32().toString(16).padStart(8, '0').toUpperCase();
    draft = { ...generateFloor(layoutSeed), seed: base.seed };
  }
  throw Error(`Could not fit return passages on ${base.seed}`);
}
