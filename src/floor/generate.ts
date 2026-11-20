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
import { RunRng, Stream } from '../core/rng.ts';
import { stairFootprint } from './stair-footprint.ts';

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

/** How a door that leads nowhere is closed: plain wall, or (rarely) a boarded-up door leaf. */
export type SealStyle = 'wall' | 'boarded';

export interface SealedDoor extends DoorRef {
  style: SealStyle;
}

export type PuzzleGate = 'counterweight' | 'pressure' | 'thorn' | 'archive';

export type FloorConnection = readonly [DoorRef, DoorRef] & { puzzleGate?: PuzzleGate };

/** Chance that a floor boards up one of its dead-end doors; every other one is plain wall. */
export const BOARDED_DOOR_CHANCE = 0.5;
const GUARDED_CHEST_CHANCE = 0.45;
const GUARDED_DOOR_CHANCE = 0.65;

export interface FloorPlan {
  seed: string;
  rooms: readonly PlacedRoom[];
  connections: readonly FloorConnection[];
  /** Doors that lead nowhere; the world closes each with a wall or a boarded door. */
  sealed: readonly SealedDoor[];
  guardianRoom: number;
  pressureWing?: { gallery: number; pumpRoom: number; source: DoorRef };
}

export interface FloorParams {
  minRooms: number;
  maxRooms: number;
  minWings: number;
  maxWings: number;
  templates: readonly RoomTemplate[];
  /** Optional fixed entry template used by authored alternate floors. */
  entryTemplateId?: string;
}

/** Reserved walk-through of all five baked room templates. */
export const SHOWCASE_SEED = 'MAPTEST2';
export const SHOWCASE_UPPER_SEED = 'MAPTEST3';
export const isShowcaseFloor = (seed: string, floor: 1 | 2): boolean =>
  floor === 1 ? seed === SHOWCASE_SEED : seed === SHOWCASE_UPPER_SEED;

export const DEFAULT_FLOOR_PARAMS: FloorParams = {
  minRooms: 6,
  maxRooms: 8,
  minWings: 2,
  maxWings: 3,
  templates: GREYBOX_TEMPLATES,
};

/** Upper Works uses the industrial shaft as its fixed entry and a longer, narrower branch profile. */
export const UPPER_FLOOR_PARAMS: FloorParams = {
  minRooms: 8,
  maxRooms: 10,
  minWings: 1,
  maxWings: 2,
  templates: GREYBOX_TEMPLATES,
  entryTemplateId: 'gear-shaft',
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

  const entryTemplate = params.entryTemplateId
    ? params.templates.find((template) => template.id === params.entryTemplateId)
    : floor.pick(entries);
  if (!entryTemplate) throw new Error(`unknown entry template ${params.entryTemplateId}`);
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
  const guardedLoot = Stream.fromKey(`${rng.seed}:guarded-chests`);
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
    if (rng.seed !== SHOWCASE_SEED && p.role === 'guardian') {
      p.encounter = { tier: 'guardian', socketIds: sockets.slice(0, 1).map((s) => s.id) };
    } else if (rng.seed !== SHOWCASE_SEED && p.role === 'combat') {
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
    } else if (
      p.role === 'combat' &&
      lootSockets.length > 0 &&
      guardedLoot.next() < GUARDED_CHEST_CHANCE
    ) {
      p.loot = [
        {
          socketId: guardedLoot.pick(lootSockets).id,
          kind: guardedLoot.pick(['cogs', 'card'] as const),
        },
      ];
    }
  }

  const connections: (readonly [DoorRef, DoorRef])[] = [];
  const sealed: SealedDoor[] = [];
  rooms.forEach((r, index) => {
    if (r.parent) {
      const own = [...r.used][0] as string;
      connections.push([r.parent, { room: index, door: own }]);
    }
    for (const d of openDoors(r)) sealed.push({ room: index, door: d, style: 'wall' });
  });
  boardUpOne(sealed, rng.seed);
  if (
    params.entryTemplateId &&
    !entryLandingFits(
      rooms.map((room) => room.world),
      sealed,
    )
  )
    return null;
  return {
    seed: rng.seed,
    rooms: placed,
    connections,
    sealed,
    guardianRoom,
  };
}

/**
 * Boards up at most one dead-end door per floor, never in the entry room. The draw comes from a
 * stream keyed on the seed alone, so it shifts no layout draw and needs no saved stream state.
 */
function boardUpOne(sealed: SealedDoor[], seed: string): void {
  const doors = Stream.fromKey(`${seed}:sealed-doors`);
  const candidates = sealed.filter((s) => s.room !== 0);
  if (candidates.length === 0 || doors.next() >= BOARDED_DOOR_CHANCE) return;
  doors.pick(candidates).style = 'boarded';
}

function entryLandingFits(rooms: readonly WorldRoom[], sealed: readonly SealedDoor[]): boolean {
  return (
    rooms[0]?.doors.some((door) => {
      if (!sealed.some((s) => s.room === 0 && s.door === door.id)) return false;
      const alcove = stairFootprint(door);
      return rooms.every((room) => !rectsOverlap(room.footprint, alcove));
    }) ?? false
  );
}

/** Picks at most one lock on an outward edge from a combat room. Every room keeps its entry open. */
export function guardedConnection(plan: FloorPlan): readonly [DoorRef, DoorRef] | null {
  const stream = Stream.fromKey(`${plan.seed}:guarded-connections`);
  const candidates = plan.connections.filter((connection) => {
    const [from, to] = connection;
    return (
      !connection.puzzleGate &&
      to.room <= (plan.pressureWing?.pumpRoom ?? Infinity) &&
      plan.rooms[from.room]?.encounter != null &&
      (plan.rooms[to.room]?.depth ?? 0) > (plan.rooms[from.room]?.depth ?? 0) &&
      to.room !== plan.pressureWing?.gallery &&
      to.room !== plan.pressureWing?.pumpRoom
    );
  });
  return candidates.length > 0 && stream.next() < GUARDED_DOOR_CHANCE
    ? stream.pick(candidates)
    : null;
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

/** Generates the distinct industrial Upper Works floor without changing floor-one generation. */
export function generateUpperFloor(seed: string): FloorPlan {
  return generateFloor(seed, UPPER_FLOOR_PARAMS);
}

interface PressureWingFit {
  source: SealedDoor;
  corridorTurns: QuarterTurns;
  corridorDoor: string;
  corridorExitDoor: string;
  corridorPosition: readonly [number, number];
  studyTurns: QuarterTurns;
  studyDoor: string;
  studyPosition: readonly [number, number];
}

/**
 * Adds a deterministic, enemy-free side wing to a spare sealed door. The original floor data is
 * never mutated, and all selection/layout draws come from a pressure-wing-only keyed stream.
 */
export function attachPressureWing(
  plan: FloorPlan,
  templates: readonly RoomTemplate[] = GREYBOX_TEMPLATES,
  alternative = 0,
): FloorPlan {
  if (plan.pressureWing) return plan;
  const corridor = templates.find((t) => t.id === 'corridor');
  const study = templates.find((t) => t.id === 'study');
  if (!corridor || !study) return plan;

  let world: WorldRoom[];
  try {
    world = worldRooms(plan, templates);
  } catch {
    return plan;
  }
  const guardianPath = new Set<number>();
  const route = new Map<number, number[]>();
  for (const [a, b] of plan.connections) {
    route.set(a.room, [...(route.get(a.room) ?? []), b.room]);
    route.set(b.room, [...(route.get(b.room) ?? []), a.room]);
  }
  const queue: number[] = [0];
  const previous = new Map<number, number>([[0, -1]]);
  while (queue.length > 0) {
    const room = queue.shift() as number;
    if (room === plan.guardianRoom) break;
    for (const next of route.get(room) ?? []) {
      if (!previous.has(next)) {
        previous.set(next, room);
        queue.push(next);
      }
    }
  }
  for (let room = plan.guardianRoom; room >= 0; room = previous.get(room) ?? -1) {
    guardianPath.add(room);
    if (room === 0) break;
  }

  const fits: PressureWingFit[] = [];
  for (const source of plan.sealed) {
    if (source.room === plan.guardianRoom) continue;
    const host = world[source.room];
    const hostDoor = host?.doors.find((d) => d.id === source.door);
    if (!host || !hostDoor) continue;
    for (const corridorTurns of corridor.rotations) {
      const rotatedCorridor = rotateTemplate(corridor, corridorTurns);
      for (const corridorEntry of rotatedCorridor.doors) {
        if (corridorEntry.facing !== OPPOSITE[hostDoor.facing]) continue;
        const corridorPosition = [
          hostDoor.world[0] - corridorEntry.position[0],
          hostDoor.world[1] - corridorEntry.position[2],
        ] as const;
        const corridorWorld = worldRoom(corridor, corridorTurns, corridorPosition);
        if (world.some((room) => rectsOverlap(room.footprint, corridorWorld.footprint))) continue;
        const corridorExit = rotatedCorridor.doors.find((d) => d.id !== corridorEntry.id);
        if (!corridorExit) continue;
        for (const studyTurns of study.rotations) {
          const rotatedStudy = rotateTemplate(study, studyTurns);
          for (const studyDoor of rotatedStudy.doors) {
            if (studyDoor.facing !== OPPOSITE[corridorExit.facing]) continue;
            const studyPosition = [
              corridorPosition[0] + corridorExit.position[0] - studyDoor.position[0],
              corridorPosition[1] + corridorExit.position[2] - studyDoor.position[2],
            ] as const;
            const studyWorld = worldRoom(study, studyTurns, studyPosition);
            if (
              world.some((room) => rectsOverlap(room.footprint, studyWorld.footprint)) ||
              rectsOverlap(corridorWorld.footprint, studyWorld.footprint)
            )
              continue;
            fits.push({
              source,
              corridorTurns,
              corridorDoor: corridorEntry.id,
              corridorExitDoor: corridorExit.id,
              corridorPosition,
              studyTurns,
              studyDoor: studyDoor.id,
              studyPosition,
            });
          }
        }
      }
    }
  }
  if (fits.length === 0) return plan;

  const stream = Stream.fromKey(`${plan.seed}:pressure-wing`);
  const preferred = fits.filter((fit) => !guardianPath.has(fit.source.room));
  const candidates = preferred.length > 0 ? preferred : fits;
  const nearestDepth = Math.min(
    ...candidates.map((fit) => plan.rooms[fit.source.room]?.depth ?? Infinity),
  );
  const nearest = candidates.filter(
    (fit) => (plan.rooms[fit.source.room]?.depth ?? Infinity) === nearestDepth,
  );
  const fit = alternative
    ? fits[(fits.indexOf(stream.pick(nearest)) + alternative) % fits.length]
    : stream.pick(nearest);
  const gallery = plan.rooms.length;
  const pumpRoom = gallery + 1;
  const host = plan.rooms[fit.source.room] as PlacedRoom;
  const wing =
    host.wing >= 0 ? host.wing : Math.max(-1, ...plan.rooms.map((room) => room.wing)) + 1;
  const newRooms: PlacedRoom[] = [
    ...plan.rooms,
    {
      index: gallery,
      templateId: corridor.id,
      turns: fit.corridorTurns,
      position: fit.corridorPosition,
      role: 'corridor',
      wing,
      depth: host.depth + 1,
      encounter: null,
      loot: [],
    },
    {
      index: pumpRoom,
      templateId: study.id,
      turns: fit.studyTurns,
      position: fit.studyPosition,
      role: 'treasure',
      wing,
      depth: host.depth + 2,
      encounter: null,
      loot: [],
    },
  ];
  const galleryDoor: DoorRef = { room: gallery, door: fit.corridorDoor };
  const galleryExit: DoorRef = { room: gallery, door: fit.corridorExitDoor };
  const studyDoor: DoorRef = { room: pumpRoom, door: fit.studyDoor };
  const connections: FloorConnection[] = [
    ...plan.connections,
    [{ room: fit.source.room, door: fit.source.door }, galleryDoor] as const,
    [galleryExit, studyDoor] as const,
  ];
  const sealed = [
    ...plan.sealed
      .filter((door) => door.room !== fit.source.room || door.door !== fit.source.door)
      .map((door) => ({ ...door })),
    ...rotateTemplate(study, fit.studyTurns)
      .doors.filter((door) => door.id !== fit.studyDoor)
      .map((door) => ({ room: pumpRoom, door: door.id, style: 'wall' as const })),
  ];
  const result: FloorPlan = {
    ...plan,
    rooms: newRooms,
    connections,
    sealed,
    pressureWing: { gallery, pumpRoom, source: { room: fit.source.room, door: fit.source.door } },
  };
  if (
    plan.rooms[0]?.templateId === 'gear-shaft' &&
    !entryLandingFits(worldRooms(result, templates), result.sealed)
  )
    return plan;
  return result;
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
