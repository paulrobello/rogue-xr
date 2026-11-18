/**
 * Room-template manifests: the contract between authored rooms (greybox now, baked Blender
 * templates in P4/P5) and the floor generator, world builder and locomotion.
 *
 * Coordinates are room-local metres, y up, origin at the floor centre. North is -Z, east +X.
 * Footprint edges and door centres snap to a whole-metre `GRID`, so rooms rotated by quarter turns
 * and joined door to door land on exact coordinates and overlap tests stay exact.
 */

export const GRID = 1;
export const DOOR_WIDTH = 1.6;
export const MAX_LIGHT_SOCKETS = 4;
/** PRD budgets per room template. */
export const BUDGET_LIMITS = { tris: 100_000, materials: 16, texturePx: 2048 } as const;

export const FACINGS = ['N', 'E', 'S', 'W'] as const;
export type Facing = (typeof FACINGS)[number];
export type QuarterTurns = 0 | 1 | 2 | 3;

export const ROOM_KINDS = ['entry', 'corridor', 'combat', 'treasure', 'rest', 'guardian'] as const;
export type RoomKind = (typeof ROOM_KINDS)[number];

export type Vec3 = readonly [number, number, number];

export interface Rect {
  /** Min and max corners on the floor plane, as [x, z]. */
  min: readonly [number, number];
  max: readonly [number, number];
}

export interface Box {
  min: Vec3;
  max: Vec3;
}

export interface Door {
  id: string;
  facing: Facing;
  /** Door centre on the floor, on the footprint edge its facing names. */
  position: Vec3;
  width: number;
}

export interface Socket {
  id: string;
  position: Vec3;
  /** Yaw in degrees, 0 faces north (-Z), increasing clockwise seen from above. */
  yaw: number;
}

export interface RoomTemplate {
  id: string;
  kinds: readonly RoomKind[];
  footprint: Rect;
  doors: readonly Door[];
  rotations: readonly QuarterTurns[];
  enemySockets: readonly Socket[];
  lootSockets: readonly Socket[];
  dressingSockets: readonly Socket[];
  lightSockets: readonly Socket[];
  probe: Vec3;
  walkable: readonly Rect[];
  colliders: readonly Box[];
  budget: { tris: number; materials: number; texturePx: number };
}

const EPS = 1e-6;

function onGrid(value: number): boolean {
  const k = value / GRID;
  return Math.abs(k - Math.round(k)) < EPS;
}

function insideRect(r: Rect, x: number, z: number, margin = 0): boolean {
  return (
    x >= r.min[0] - margin - EPS &&
    x <= r.max[0] + margin + EPS &&
    z >= r.min[1] - margin - EPS &&
    z <= r.max[1] + margin + EPS
  );
}

/** Returns every contract violation; an empty list means the template is valid. */
export function templateErrors(t: RoomTemplate): string[] {
  const errors: string[] = [];
  const fp = t.footprint;
  const at = (what: string) => `${t.id}: ${what}`;
  if (!t.id) errors.push('template id missing');
  if (t.kinds.length === 0) errors.push(at('no room kinds'));
  for (const kind of t.kinds)
    if (!ROOM_KINDS.includes(kind)) errors.push(at(`unknown kind ${kind}`));
  if (!(fp.max[0] > fp.min[0] && fp.max[1] > fp.min[1])) errors.push(at('empty footprint'));
  for (const v of [...fp.min, ...fp.max])
    if (!onGrid(v)) errors.push(at(`footprint edge ${v} off the ${GRID} m grid`));
  if (t.rotations.length === 0) errors.push(at('no allowed rotations'));
  if (t.doors.length === 0) errors.push(at('no doors'));

  const ids = new Set<string>();
  const unique = (id: string) => {
    if (ids.has(id)) errors.push(at(`duplicate id ${id}`));
    ids.add(id);
  };
  for (const door of t.doors) {
    unique(door.id);
    const [x, , z] = door.position;
    const edge =
      door.facing === 'N'
        ? z === fp.min[1]
        : door.facing === 'S'
          ? z === fp.max[1]
          : door.facing === 'E'
            ? x === fp.max[0]
            : x === fp.min[0];
    if (!edge) errors.push(at(`door ${door.id} is not on its ${door.facing} edge`));
    const along = door.facing === 'N' || door.facing === 'S' ? x : z;
    const [lo, hi] =
      door.facing === 'N' || door.facing === 'S' ? [fp.min[0], fp.max[0]] : [fp.min[1], fp.max[1]];
    if (along - door.width / 2 < lo - EPS || along + door.width / 2 > hi + EPS) {
      errors.push(at(`door ${door.id} is outside the footprint`));
    }
    if (!onGrid(along)) errors.push(at(`door ${door.id} is off the ${GRID} m grid`));
    if (!(door.width > 0)) errors.push(at(`door ${door.id} has no width`));
  }
  const sockets: [string, readonly Socket[]][] = [
    ['enemy', t.enemySockets],
    ['loot', t.lootSockets],
    ['dressing', t.dressingSockets],
    ['light', t.lightSockets],
  ];
  for (const [kind, list] of sockets) {
    for (const s of list) {
      unique(s.id);
      if (!insideRect(fp, s.position[0], s.position[2]))
        errors.push(at(`${kind} socket ${s.id} is outside the footprint`));
    }
  }
  if (t.lightSockets.length > MAX_LIGHT_SOCKETS) {
    errors.push(at(`${t.lightSockets.length} light sockets, at most ${MAX_LIGHT_SOCKETS}`));
  }
  if (!insideRect(fp, t.probe[0], t.probe[2])) errors.push(at('probe is outside the footprint'));
  if (t.walkable.length === 0) errors.push(at('no walkable area'));
  for (const w of t.walkable) {
    if (!insideRect(fp, w.min[0], w.min[1]) || !insideRect(fp, w.max[0], w.max[1])) {
      errors.push(at('walkable rect leaves the footprint'));
    }
  }
  for (const s of t.enemySockets) {
    if (!t.walkable.some((w) => insideRect(w, s.position[0], s.position[2]))) {
      errors.push(at(`enemy socket ${s.id} is not on walkable floor`));
    }
  }
  for (const c of t.colliders) {
    if (!(c.max[0] > c.min[0] && c.max[1] > c.min[1] && c.max[2] > c.min[2]))
      errors.push(at('empty collider'));
  }
  const b = t.budget;
  if (b.tris > BUDGET_LIMITS.tris)
    errors.push(at(`budget ${b.tris} tris over ${BUDGET_LIMITS.tris}`));
  if (b.materials > BUDGET_LIMITS.materials)
    errors.push(at(`budget ${b.materials} materials over ${BUDGET_LIMITS.materials}`));
  if (b.texturePx > BUDGET_LIMITS.texturePx)
    errors.push(at(`budget ${b.texturePx} px textures over ${BUDGET_LIMITS.texturePx}`));
  return errors;
}

/** Validates an untrusted manifest (e.g. a Blender template's JSON) and returns it typed. */
export function parseRoomTemplate(raw: unknown): RoomTemplate {
  if (typeof raw !== 'object' || raw === null) throw new Error('room template: expected an object');
  const t = raw as RoomTemplate;
  for (const key of [
    'kinds',
    'doors',
    'rotations',
    'enemySockets',
    'lootSockets',
    'dressingSockets',
    'lightSockets',
    'walkable',
    'colliders',
  ] as const) {
    if (!Array.isArray(t[key]))
      throw new Error(`room template ${t.id ?? '?'}: ${key} must be an array`);
  }
  if (!t.footprint || !t.probe || !t.budget)
    throw new Error(`room template ${t.id ?? '?'}: missing footprint, probe or budget`);
  const errors = templateErrors(t);
  if (errors.length > 0) throw new Error(`room template invalid:\n${errors.join('\n')}`);
  return t;
}

/** Turns clockwise seen from above: N -> E -> S -> W. */
export function rotateFacing(facing: Facing, turns: QuarterTurns): Facing {
  return FACINGS[(FACINGS.indexOf(facing) + turns) % 4] as Facing;
}

/** Rotates a room-local point clockwise (seen from above) by quarter turns about the origin. */
export function rotatePoint(p: Vec3, turns: QuarterTurns): Vec3 {
  let [x, y, z] = p;
  for (let i = 0; i < turns; i++) [x, z] = [-z, x];
  return [x + 0, y, z + 0];
}

export function rotateRect(r: Rect, turns: QuarterTurns): Rect {
  const a = rotatePoint([r.min[0], 0, r.min[1]], turns);
  const b = rotatePoint([r.max[0], 0, r.max[1]], turns);
  return {
    min: [Math.min(a[0], b[0]), Math.min(a[2], b[2])],
    max: [Math.max(a[0], b[0]), Math.max(a[2], b[2])],
  };
}

function rotateBox(box: Box, turns: QuarterTurns): Box {
  const r = rotateRect({ min: [box.min[0], box.min[2]], max: [box.max[0], box.max[2]] }, turns);
  return { min: [r.min[0], box.min[1], r.min[1]], max: [r.max[0], box.max[1], r.max[1]] };
}

function rotateSocket(s: Socket, turns: QuarterTurns): Socket {
  return { ...s, position: rotatePoint(s.position, turns), yaw: (s.yaw + 90 * turns) % 360 };
}

/** The template as it sits after a clockwise rotation; still room-local, still valid. */
export function rotateTemplate(t: RoomTemplate, turns: QuarterTurns): RoomTemplate {
  if (turns === 0) return t;
  return {
    ...t,
    footprint: rotateRect(t.footprint, turns),
    doors: t.doors.map((d) => ({
      ...d,
      facing: rotateFacing(d.facing, turns),
      position: rotatePoint(d.position, turns),
    })),
    enemySockets: t.enemySockets.map((s) => rotateSocket(s, turns)),
    lootSockets: t.lootSockets.map((s) => rotateSocket(s, turns)),
    dressingSockets: t.dressingSockets.map((s) => rotateSocket(s, turns)),
    lightSockets: t.lightSockets.map((s) => rotateSocket(s, turns)),
    probe: rotatePoint(t.probe, turns),
    walkable: t.walkable.map((w) => rotateRect(w, turns)),
    colliders: t.colliders.map((c) => rotateBox(c, turns)),
  };
}

const WALL_HEIGHT = 4;
const WALL_THICKNESS = 0.2;

/** Wall boxes along the footprint edges with a gap at every door. */
export function perimeterColliders(footprint: Rect, doors: readonly Door[]): Box[] {
  const boxes: Box[] = [];
  const [x0, z0] = footprint.min;
  const [x1, z1] = footprint.max;
  const t = WALL_THICKNESS / 2;
  const edges: [Facing, number, number, number][] = [
    ['N', z0, x0, x1],
    ['S', z1, x0, x1],
    ['W', x0, z0, z1],
    ['E', x1, z0, z1],
  ];
  for (const [facing, fixed, lo, hi] of edges) {
    const gaps = doors
      .filter((d) => d.facing === facing)
      .map((d) => {
        const along = facing === 'N' || facing === 'S' ? d.position[0] : d.position[2];
        return [along - d.width / 2, along + d.width / 2] as const;
      })
      .sort((a, b) => a[0] - b[0]);
    let start = lo;
    for (const [g0, g1] of [...gaps, [hi, hi] as const]) {
      if (g0 > start + EPS) {
        boxes.push(
          facing === 'N' || facing === 'S'
            ? { min: [start, 0, fixed - t], max: [g0, WALL_HEIGHT, fixed + t] }
            : { min: [fixed - t, 0, start], max: [fixed + t, WALL_HEIGHT, g0] },
        );
      }
      start = Math.max(start, g1);
    }
  }
  return boxes;
}

const GREYBOX_BUDGET = { tris: 2_000, materials: 4, texturePx: 0 };

function socket(id: string, x: number, z: number, yaw = 0, y = 0): Socket {
  return { id, position: [x, y, z], yaw };
}

function door(id: string, facing: Facing, x: number, z: number): Door {
  return { id, facing, position: [x, 0, z], width: DOOR_WIDTH };
}

function template(
  spec: Omit<RoomTemplate, 'colliders' | 'walkable' | 'budget'> & {
    extraColliders?: Box[];
    walkable?: Rect[];
  },
): RoomTemplate {
  const { extraColliders = [], walkable, ...rest } = spec;
  const fp = spec.footprint;
  const inset = 0.4;
  return {
    ...rest,
    walkable: walkable ?? [
      { min: [fp.min[0] + inset, fp.min[1] + inset], max: [fp.max[0] - inset, fp.max[1] - inset] },
    ],
    colliders: [...perimeterColliders(fp, spec.doors), ...extraColliders],
    budget: GREYBOX_BUDGET,
  };
}

const ALL_TURNS: QuarterTurns[] = [0, 1, 2, 3];

/** Five greybox templates in the shape the baked Blender templates will take. */
export const GREYBOX_TEMPLATES: readonly RoomTemplate[] = [
  template({
    id: 'hall',
    kinds: ['entry', 'combat', 'rest'],
    footprint: { min: [-5, -5], max: [5, 5] },
    doors: [
      door('n', 'N', -1, -5),
      door('e', 'E', 5, 1),
      door('s', 'S', 1, 5),
      door('w', 'W', -5, -1),
    ],
    rotations: ALL_TURNS,
    enemySockets: [socket('enemy-a', 0, -2.5, 180), socket('enemy-b', 2, -2, 200)],
    lootSockets: [socket('chest', -3.5, 3.5, 45)],
    dressingSockets: [
      socket('bench-w', -4, 2, 90),
      socket('bench-e', 4, -2, 270),
      socket('rug', 0, 0),
    ],
    lightSockets: [socket('sconce-nw', -4.6, -4.6, 0, 2.2), socket('sconce-se', 4.6, 4.6, 0, 2.2)],
    probe: [0, 1.6, 0],
  }),
  template({
    id: 'corridor',
    kinds: ['corridor'],
    footprint: { min: [-1, -4], max: [1, 4] },
    doors: [door('n', 'N', 0, -4), door('s', 'S', 0, 4)],
    rotations: [0, 1],
    enemySockets: [],
    lootSockets: [],
    dressingSockets: [socket('banner', -0.8, 0, 90)],
    lightSockets: [socket('lamp', 0.8, 0, 0, 2.2)],
    probe: [0, 1.6, 0],
  }),
  template({
    id: 'study',
    kinds: ['combat', 'treasure', 'rest'],
    footprint: { min: [-4, -4], max: [4, 4] },
    doors: [door('s', 'S', -1, 4), door('e', 'E', 4, -1)],
    rotations: ALL_TURNS,
    enemySockets: [socket('enemy-a', -1, -2, 180), socket('enemy-b', 1.5, -2.2, 200)],
    lootSockets: [socket('desk-drawer', 2.6, 2.6, 270)],
    dressingSockets: [
      socket('desk', 2.4, 2.4, 225),
      socket('shelf-w', -3.6, 0, 90),
      socket('gear-shaft', 0, 0),
    ],
    lightSockets: [socket('candles', 2.4, 2.4, 0, 1.1), socket('window', 0, -3.8, 0, 2.5)],
    probe: [0, 1.6, 1],
    extraColliders: [{ min: [-0.6, 0, -0.6], max: [0.6, 4, 0.6] }],
  }),
  template({
    id: 'gear-shaft',
    kinds: ['combat', 'corridor'],
    footprint: { min: [-4, -6], max: [4, 6] },
    doors: [door('n', 'N', 1, -6), door('s', 'S', -1, 6), door('w', 'W', -4, 1)],
    rotations: ALL_TURNS,
    enemySockets: [
      socket('enemy-a', 0, -3.5, 180),
      socket('enemy-b', -2, -3, 160),
      socket('enemy-c', 2, -3, 200),
    ],
    lootSockets: [],
    dressingSockets: [socket('shaft', 0, 0), socket('crate', 3, 4.5)],
    lightSockets: [
      socket('furnace', 0, 0, 0, 0.5),
      socket('lamp-n', 3.6, -5.6, 0, 2.4),
      socket('lamp-s', -3.6, 5.6, 0, 2.4),
    ],
    probe: [2, 1.6, 2],
    extraColliders: [{ min: [-1.2, 0, -1.2], max: [1.2, 4, 1.2] }],
  }),
  template({
    id: 'guardian-vault',
    kinds: ['guardian'],
    footprint: { min: [-6, -6], max: [6, 6] },
    doors: [door('s', 'S', 1, 6)],
    rotations: ALL_TURNS,
    enemySockets: [socket('guardian', 0, -3, 180)],
    lootSockets: [socket('reward', 0, -5, 180)],
    dressingSockets: [
      socket('pillar-nw', -4, -4),
      socket('pillar-ne', 4, -4),
      socket('pillar-sw', -4, 4),
      socket('pillar-se', 4, 4),
    ],
    lightSockets: [
      socket('brazier-nw', -4, -4, 0, 1.4),
      socket('brazier-ne', 4, -4, 0, 1.4),
      socket('brazier-sw', -4, 4, 0, 1.4),
      socket('brazier-se', 4, 4, 0, 1.4),
    ],
    probe: [0, 2, 0],
    extraColliders: [-4, 4].flatMap((x) =>
      [-4, 4].map((z): Box => ({ min: [x - 0.5, 0, z - 0.5], max: [x + 0.5, 4, z + 0.5] })),
    ),
  }),
];

export function templateById(id: string): RoomTemplate {
  const t = GREYBOX_TEMPLATES.find((candidate) => candidate.id === id);
  if (!t) throw new Error(`unknown room template ${id}`);
  return t;
}
