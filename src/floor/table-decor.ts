import { Stream } from '../core/rng.ts';

/**
 * Seeded table decorations (Paul's 2026-11-17 playtest: "some random decorations placed on them
 * would help break up the stamped look"). Pure: no rendering. Positions are template-local, the
 * frame a room group already turns into place, so they are never rotated a second time.
 */

/** The decoration props, one node each in `public/assets/props/table-decor/table-decor.glb`. */
export const DECOR_KINDS = ['candle', 'books', 'vase'] as const;
export type DecorKind = (typeof DECOR_KINDS)[number];

/**
 * Radius of each prop's footprint circle about its origin, metres (the generator's base sizes,
 * scripts/assets/build-table-decor.py): the candle's dish, the book stack's diagonal, the vase belly.
 */
export const DECOR_RADIUS: Readonly<Record<DecorKind, number>> = {
  candle: 0.072,
  books: 0.11,
  vase: 0.07,
};

/**
 * Meshes per kind (`<node>`, `<node>_1`, ... in the GLB): the book stack has three arrangements of
 * its three baked books, the candle and vase one each. Every variant fits its kind's footprint.
 */
export const DECOR_VARIANTS: Readonly<Record<DecorKind, number>> = {
  candle: 1,
  books: 3,
  vase: 1,
};

/** A small table top in template-local runtime coordinates (x, z; y up). */
export interface DecorTable {
  id: string;
  x: number;
  z: number;
  halfX: number;
  halfZ: number;
  /** Height of the top surface the props stand on. */
  top: number;
  /** Clearance kept from every edge (more where trim rises above the top). */
  margin: number;
}

/**
 * Every small table in the baked rooms, from the generators' own constants
 * (scripts/assets/room_kit.py `bench` and `crate`, placed by build-room-kit.py):
 * - hall: the two backless walnut benches, 0.42 x 0.9 m tops at 0.47 m, long axis along z.
 * - gear-shaft: the walnut parts crate, a 0.8 m square top at 0.80 m whose brass corner straps rise
 *   10 mm above it over the outer 70 mm, so the margin clears them.
 * The study desk is left out: it is a 1.3 m writing desk that already carries candles and a rack.
 */
export const DECOR_TABLES: Readonly<Record<string, readonly DecorTable[]>> = {
  hall: [
    { id: 'bench-w', x: -4, z: 2, halfX: 0.21, halfZ: 0.45, top: 0.47, margin: 0.025 },
    { id: 'bench-e', x: 4, z: -2, halfX: 0.21, halfZ: 0.45, top: 0.47, margin: 0.025 },
  ],
  'gear-shaft': [{ id: 'crate', x: 3, z: 4.5, halfX: 0.4, halfZ: 0.4, top: 0.8, margin: 0.09 }],
};

/** Chance of 0, 1, 2 or 3 props on one table. */
export const DECOR_COUNT_WEIGHTS = [0.15, 0.35, 0.3, 0.2] as const;
/** Air kept between two props' footprint circles, metres. */
export const DECOR_GAP = 0.015;
/** Position draws per prop before it is dropped (a crowded bench top). */
const TRIES = 24;

export interface DecorPlacement {
  /** Plan room index. */
  room: number;
  table: string;
  kind: DecorKind;
  /** Template-local position of the prop's base centre. */
  x: number;
  y: number;
  z: number;
  /** Radians about +y. */
  yaw: number;
  /** Which of the kind's `DECOR_VARIANTS` meshes stands here. */
  variant: number;
}

/** The keyed stream every floor's table decorations draw from (not a saved `RunRng` stream). */
export function decorStream(seed: string): Stream {
  return Stream.fromKey(`${seed}:table-decor`);
}

function drawCount(stream: Stream): number {
  let u = stream.next();
  for (let n = 0; n < DECOR_COUNT_WEIGHTS.length; n++) {
    u -= DECOR_COUNT_WEIGHTS[n] as number;
    if (u < 0) return n;
  }
  return DECOR_COUNT_WEIGHTS.length - 1;
}

function dressTable(stream: Stream, room: number, t: DecorTable): DecorPlacement[] {
  const count = drawCount(stream);
  const kinds = stream.shuffle(DECOR_KINDS).slice(0, count);
  const placed: DecorPlacement[] = [];
  for (const kind of kinds) {
    const r = DECOR_RADIUS[kind];
    const ax = t.halfX - t.margin - r;
    const az = t.halfZ - t.margin - r;
    let spot: [number, number] | null = null;
    for (let i = 0; i < TRIES && ax >= 0 && az >= 0; i++) {
      const x = t.x + (stream.next() * 2 - 1) * ax;
      const z = t.z + (stream.next() * 2 - 1) * az;
      const clear = placed.every(
        (p) => Math.hypot(p.x - x, p.z - z) >= DECOR_RADIUS[p.kind] + r + DECOR_GAP,
      );
      if (clear) {
        spot = [x, z];
        break;
      }
    }
    const yaw = stream.next() * Math.PI * 2;
    if (spot)
      placed.push({ room, table: t.id, kind, x: spot[0], y: t.top, z: spot[1], yaw, variant: 0 });
  }
  return placed;
}

/**
 * Props for every table of a floor, in plan order then table order. `templateIds[i]` is plan room
 * i's template. Every table draws from the stream whether or not its room is later dressed, so a
 * room that falls back to its greybox never shifts another room's props.
 */
export function placeTableDecor(seed: string, templateIds: readonly string[]): DecorPlacement[] {
  const stream = decorStream(seed);
  const out: DecorPlacement[] = [];
  templateIds.forEach((id, room) => {
    for (const t of DECOR_TABLES[id] ?? []) out.push(...dressTable(stream, room, t));
  });
  // Variants draw after every position and yaw, so adding them moved no existing seed's props.
  for (const p of out) {
    const n = DECOR_VARIANTS[p.kind];
    if (n > 1) p.variant = stream.int(0, n - 1);
  }
  return out;
}
