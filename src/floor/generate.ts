import {
  type Door,
  type Facing,
  GREYBOX_TEMPLATES,
  type QuarterTurns,
  type Rect,
  type RoomKind,
  type RoomTemplate,
  rotateTemplate,
} from '../content/rooms.ts';
import { RunRng, type Stream } from '../core/rng.ts';

export type EncounterTier = 'regular' | 'elite' | 'guardian';
export type LootKind = 'cogs' | 'card';

export interface PlacedRoom {
  index: number;
  templateId: string;
  turns: QuarterTurns;
  /** World offset of the room origin on the floor plane, [x, z]. */
  position: readonly [number, number];
  role: RoomKind;
  /** Wing number from the entry, or -1 for the entry itself. */
  wing: number;
  /** Doors crossed from the entry. */
  depth: number;
  encounter: { tier: EncounterTier; socketIds: readonly string[] } | null;
  loot: readonly { socketId: string; kind: LootKind }[];
}

export interface DoorRef {
  room: number;
  door: string;
}

export interface FloorPlan {
  seed: string;
  rooms: readonly PlacedRoom[];
  connections: readonly (readonly [DoorRef, DoorRef])[];
  /** Doors that lead nowhere; the world builds a sealed cap in each. */
  sealed: readonly DoorRef[];
  guardianRoom: number;
}

export interface FloorParams {
  minRooms: number;
  maxRooms: number;
  minWings: number;
  maxWings: number;
  templates: readonly RoomTemplate[];
}

export const DEFAULT_FLOOR_PARAMS: FloorParams = {
  minRooms: 6,
  maxRooms: 8,
  minWings: 2,
  maxWings: 3,
  templates: GREYBOX_TEMPLATES,
};

const MAX_ATTEMPTS = 50;
const EPS = 1e-6;

const OPPOSITE: Record<Facing, Facing> = { N: 'S', S: 'N', E: 'W', W: 'E' };

/** A room template as placed in the world: rotated, with its offset applied to the footprint and doors. */
export interface WorldRoom {
  template: RoomTemplate;
  footprint: Rect;
  doors: readonly (Door & { world: readonly [number, number] })[];
}

export function worldRoom(
  t: RoomTemplate,
  turns: QuarterTurns,
  position: readonly [number, number],
): WorldRoom {
  const r = rotateTemplate(t, turns);
  const [ox, oz] = position;
  return {
    template: r,
    footprint: {
      min: [r.footprint.min[0] + ox, r.footprint.min[1] + oz],
      max: [r.footprint.max[0] + ox, r.footprint.max[1] + oz],
    },
    doors: r.doors.map((d) => ({ ...d, world: [d.position[0] + ox, d.position[2] + oz] as const })),
  };
}

/** Positive-area overlap; rooms sharing a wall line do not overlap. */
export function rectsOverlap(a: Rect, b: Rect): boolean {
  return (
    a.min[0] < b.max[0] - EPS &&
    b.min[0] < a.max[0] - EPS &&
    a.min[1] < b.max[1] - EPS &&
    b.min[1] < a.max[1] - EPS
  );
}

interface Draft {
  template: RoomTemplate;
  turns: QuarterTurns;
  position: readonly [number, number];
  world: WorldRoom;
  wing: number;
  depth: number;
  parent: DoorRef | null;
  /** Door ids already joined to a neighbour. */
  used: Set<string>;
}

function tryAttach(
  rooms: Draft[],
  from: number,
  doorId: string,
  candidates: readonly RoomTemplate[],
  stream: Stream,
  wing: number,
): Draft | null {
  const host = rooms[from] as Draft;
  const hostDoor = host.world.doors.find((d) => d.id === doorId);
  if (!hostDoor) return null;
  const want = OPPOSITE[hostDoor.facing];
  for (const t of stream.shuffle(candidates)) {
    for (const turns of stream.shuffle(t.rotations)) {
      const rotated = rotateTemplate(t, turns);
      for (const door of stream.shuffle(rotated.doors.filter((d) => d.facing === want))) {
        const position = [
          hostDoor.world[0] - door.position[0],
          hostDoor.world[1] - door.position[2],
        ] as const;
        const world = worldRoom(t, turns, position);
        if (rooms.some((r) => rectsOverlap(r.world.footprint, world.footprint))) continue;
        return {
          template: t,
          turns,
          position,
          world,
          wing,
          depth: host.depth + 1,
          parent: { room: from, door: doorId },
          used: new Set([door.id]),
        };
      }
    }
  }
  return null;
}

function openDoors(room: Draft): string[] {
  return room.world.doors.filter((d) => !room.used.has(d.id)).map((d) => d.id);
}

/** Grows one wing as a chain from an entry door. Returns the indices of its rooms in order. */
function growWing(
  rooms: Draft[],
  entryDoor: string,
  length: number,
  pool: readonly RoomTemplate[],
  stream: Stream,
  wing: number,
): number[] {
  const chain: number[] = [];
  let host = 0;
  let door: string | undefined = entryDoor;
  for (let i = 0; i < length && door !== undefined; i++) {
    const next = tryAttach(rooms, host, door, pool, stream, wing);
    if (!next) break;
    (rooms[host] as Draft).used.add(door);
    rooms.push(next);
    host = rooms.length - 1;
    chain.push(host);
    door = stream.shuffle(openDoors(next))[0];
  }
  return chain;
}

function attempt(rng: RunRng, params: FloorParams): FloorPlan | null {
  const floor = rng.stream('floor');
  const entries = params.templates.filter((t) => t.kinds.includes('entry'));
  const vaults = params.templates.filter((t) => t.kinds.includes('guardian'));
  const pool = params.templates.filter((t) => !t.kinds.includes('guardian'));
  if (entries.length === 0 || vaults.length === 0)
    throw new Error('floor templates need an entry and a guardian room');

  const entryTemplate = floor.pick(entries);
  const entryTurns = floor.pick(entryTemplate.rotations);
  const rooms: Draft[] = [
    {
      template: entryTemplate,
      turns: entryTurns,
      position: [0, 0],
      world: worldRoom(entryTemplate, entryTurns, [0, 0]),
      wing: -1,
      depth: 0,
      parent: null,
      used: new Set(),
    },
  ];
  const total = floor.int(params.minRooms, params.maxRooms);
  const entryDoors = floor.shuffle(openDoors(rooms[0] as Draft));
  const wingCount = Math.min(floor.int(params.minWings, params.maxWings), entryDoors.length);
  // Rooms between the entry and the vault, spread over the wings with at least one each.
  const lengths = Array.from({ length: wingCount }, () => 1);
  for (let i = wingCount; i < total - 2; i++) lengths[floor.int(0, wingCount - 1)] += 1;

  const wings: number[][] = [];
  for (let w = 0; w < wingCount; w++) {
    const chain = growWing(rooms, entryDoors[w] as string, lengths[w] as number, pool, floor, w);
    if (chain.length !== lengths[w]) return null;
    wings.push(chain);
  }

  // The vault closes the deepest wing; ties go to the first such wing.
  const deepest = wings.reduce(
    (best, chain, w) => (chain.length > (wings[best] as number[]).length ? w : best),
    0,
  );
  const tip = (wings[deepest] as number[]).at(-1) as number;
  let vault: Draft | null = null;
  for (const door of floor.shuffle(openDoors(rooms[tip] as Draft))) {
    vault = tryAttach(rooms, tip, door, vaults, floor, deepest);
    if (vault) {
      (rooms[tip] as Draft).used.add(door);
      break;
    }
  }
  if (!vault) return null;
  rooms.push(vault);
  const guardianRoom = rooms.length - 1;
  if (rooms.length < params.minRooms || rooms.length > params.maxRooms) return null;

  const tips = new Set(wings.map((chain, w) => (w === deepest ? -1 : (chain.at(-1) as number))));
  const ai = rng.stream('ai');
  const loot = rng.stream('loot');
  const placed: PlacedRoom[] = rooms.map((r, index) => {
    const t = r.template;
    let role: RoomKind;
    if (index === 0) role = 'entry';
    else if (index === guardianRoom) role = 'guardian';
    else if (tips.has(index) && t.kinds.includes('treasure')) role = 'treasure';
    else if (tips.has(index) && t.kinds.includes('rest')) role = 'rest';
    else if (t.kinds.includes('combat') && t.enemySockets.length > 0) role = 'combat';
    else role = t.kinds.includes('corridor') ? 'corridor' : (t.kinds[0] as RoomKind);
    return {
      index,
      templateId: t.id,
      turns: r.turns,
      position: r.position,
      role,
      wing: r.wing,
      depth: r.depth,
      encounter: null,
      loot: [],
    };
  });

  // Encounters: the guardian in the vault, one elite in the deepest combat room past the first
  // room of its wing, regular fights elsewhere. Socket choice comes from the ai stream.
  const combat = placed.filter((p) => p.role === 'combat');
  const eliteCandidates = combat.filter((p) => p.depth >= 2);
  const maxDepth = Math.max(-1, ...eliteCandidates.map((p) => p.depth));
  const elite =
    eliteCandidates.length > 0
      ? ai.pick(eliteCandidates.filter((p) => p.depth === maxDepth)).index
      : -1;
  for (const p of placed) {
    const sockets = rooms[p.index]?.template.enemySockets ?? [];
    if (p.role === 'guardian') {
      p.encounter = { tier: 'guardian', socketIds: sockets.slice(0, 1).map((s) => s.id) };
    } else if (p.role === 'combat') {
      const tier: EncounterTier = p.index === elite ? 'elite' : 'regular';
      const count = tier === 'elite' ? 1 : ai.int(1, Math.min(2, sockets.length));
      p.encounter = {
        tier,
        socketIds: ai
          .shuffle(sockets)
          .slice(0, count)
          .map((s) => s.id),
      };
    }
    const lootSockets = rooms[p.index]?.template.lootSockets ?? [];
    if (lootSockets.length > 0 && (p.role === 'treasure' || p.role === 'guardian')) {
      p.loot = [
        {
          socketId: loot.pick(lootSockets).id,
          kind: p.role === 'guardian' ? 'card' : loot.pick(['cogs', 'card'] as const),
        },
      ];
    }
  }

  const connections: (readonly [DoorRef, DoorRef])[] = [];
  const sealed: DoorRef[] = [];
  rooms.forEach((r, index) => {
    if (r.parent) {
      const own = [...r.used][0] as string;
      connections.push([r.parent, { room: index, door: own }]);
    }
    for (const d of openDoors(r)) sealed.push({ room: index, door: d });
  });
  return { seed: rng.seed, rooms: placed, connections, sealed, guardianRoom };
}

/**
 * Generates a floor as plain data: an entry hall, 2 to 3 wings of rooms joined door to door,
 * and one guardian vault closing the deepest wing. Layout draws come from the `floor` stream,
 * encounters from `ai` and loot from `loot`; the same seed always gives the same floor.
 */
export function generateFloor(seed: string, params: FloorParams = DEFAULT_FLOOR_PARAMS): FloorPlan {
  const rng = new RunRng(seed);
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    const plan = attempt(rng, params);
    if (plan) return plan;
  }
  throw new Error(`no valid floor for seed ${seed} after ${MAX_ATTEMPTS} attempts`);
}

/** Every room's world-space template, for the world builder and for tests. */
export function worldRooms(
  plan: FloorPlan,
  templates: readonly RoomTemplate[] = GREYBOX_TEMPLATES,
): WorldRoom[] {
  return plan.rooms.map((r) => {
    const t = templates.find((c) => c.id === r.templateId);
    if (!t) throw new Error(`floor references unknown template ${r.templateId}`);
    return worldRoom(t, r.turns, r.position);
  });
}
