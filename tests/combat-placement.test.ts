import { describe, expect, it } from 'vitest';
import {
  type CombatRoom,
  combatRoom,
  forwardOf,
  headingDelta,
  headingTo,
  MAX_TABLE_HEIGHT,
  MIN_TABLE_HEIGHT,
  placeEnemies,
  placeTable,
  planEncounter,
  rightOf,
  TABLE_HALF_DEPTH,
  TABLE_HALF_WIDTH,
  type TablePose,
  tableCandidates,
  tableHeightFor,
} from '../src/combat/placement.ts';
import { GREYBOX_TEMPLATES, rotatePoint, templateById } from '../src/content/rooms.ts';
import { generateFloor, worldRoom, worldRooms } from '../src/floor/generate.ts';

const SEEDS = ['SPIRE001', 'SPIRE002', 'GEARS777', 'BRASS042', 'VA1T9QZK'];
const HEADINGS = [0, 45, 90, 135, 180, 225, 270, 315];

function hall(): CombatRoom {
  return combatRoom(worldRoom(templateById('hall'), 0, [0, 0]));
}

/** Player seats on a 1 m grid across a room's walkable rects. */
function seats(room: CombatRoom): [number, number][] {
  const out: [number, number][] = [];
  for (const w of room.walkable) {
    for (let x = w.min[0] + 0.5; x <= w.max[0] - 0.5; x += 1) {
      for (let z = w.min[1] + 0.5; z <= w.max[1] - 0.5; z += 1) out.push([x, z]);
    }
  }
  return out;
}

function inWalkable(room: CombatRoom, x: number, z: number): boolean {
  return room.walkable.some(
    (w) => x >= w.min[0] && x <= w.max[0] && z >= w.min[1] && z <= w.max[1],
  );
}

/** True when the point is strictly inside a collider that rises above the floor. */
function insideCollider(room: CombatRoom, x: number, z: number): boolean {
  return room.colliders.some(
    (b) =>
      b.max[1] > 0.05 &&
      x > b.min[0] + 1e-9 &&
      x < b.max[0] - 1e-9 &&
      z > b.min[2] + 1e-9 &&
      z < b.max[2] - 1e-9,
  );
}

/** Independent of the implementation: samples the table rectangle on a 5 cm grid. */
function tableIsClear(room: CombatRoom, t: TablePose): boolean {
  const [fx, fz] = forwardOf(t.yaw);
  const [rx, rz] = rightOf(t.yaw);
  for (let u = -TABLE_HALF_WIDTH; u <= TABLE_HALF_WIDTH + 1e-9; u += 0.05) {
    for (let v = -TABLE_HALF_DEPTH; v <= TABLE_HALF_DEPTH + 1e-9; v += 0.05) {
      const x = t.x + rx * u + fx * v;
      const z = t.z + rz * u + fz * v;
      if (!inWalkable(room, x, z) || insideCollider(room, x, z)) return false;
    }
  }
  return true;
}

/** Distance from a point to the nearest collider footprint that rises above the floor. */
function colliderDistance(room: CombatRoom, x: number, z: number): number {
  let best = Number.POSITIVE_INFINITY;
  for (const b of room.colliders) {
    if (!(b.max[1] > 0.05)) continue;
    const dx = Math.max(b.min[0] - x, 0, x - b.max[0]);
    const dz = Math.max(b.min[2] - z, 0, z - b.max[2]);
    best = Math.min(best, Math.hypot(dx, dz));
  }
  return best;
}

describe('headings and conversion', () => {
  it('forward, right and heading agree with locomotion conventions', () => {
    expect(forwardOf(0)[1]).toBeCloseTo(-1);
    expect(forwardOf(90)[0]).toBeCloseTo(1);
    expect(rightOf(0)[0]).toBeCloseTo(1);
    expect(rightOf(90)[1]).toBeCloseTo(1);
    expect(headingTo([0, 0], [0, -3])).toBeCloseTo(0);
    expect(headingTo([0, 0], [3, 0])).toBeCloseTo(90);
    expect(headingTo([0, 0], [0, 3])).toBeCloseTo(180);
    expect(headingTo([0, 0], [-3, 0])).toBeCloseTo(270);
    expect(headingDelta(350, 10)).toBeCloseTo(20);
  });

  it('puts the room-local template into world space for every rotation and offset', () => {
    for (const t of GREYBOX_TEMPLATES) {
      for (const turns of t.rotations) {
        const room = combatRoom(worldRoom(t, turns, [23, -17]));
        for (const w of room.walkable) {
          expect(w.min[0]).toBeGreaterThanOrEqual(room.footprint.min[0] - 1e-9);
          expect(w.max[0]).toBeLessThanOrEqual(room.footprint.max[0] + 1e-9);
          expect(w.min[1]).toBeGreaterThanOrEqual(room.footprint.min[1] - 1e-9);
          expect(w.max[1]).toBeLessThanOrEqual(room.footprint.max[1] + 1e-9);
        }
        for (const b of room.colliders) {
          expect(b.min[0]).toBeGreaterThanOrEqual(room.footprint.min[0] - 0.11);
          expect(b.max[0]).toBeLessThanOrEqual(room.footprint.max[0] + 0.11);
        }
        // The same rotation and offset the world builder applies to a socket lands it in the walkable rects.
        for (const s of t.enemySockets) {
          const p = rotatePoint(s.position, turns);
          expect(inWalkable(room, p[0] + 23, p[2] - 17)).toBe(true);
        }
      }
    }
  });
});

describe('tableHeightFor', () => {
  it('drops 0.75 m below the eye and clamps', () => {
    expect(tableHeightFor(1.6)).toBeCloseTo(0.85);
    expect(tableHeightFor(1.2)).toBeCloseTo(0.6);
    expect(tableHeightFor(0.8)).toBe(MIN_TABLE_HEIGHT);
    expect(tableHeightFor(2.5)).toBe(MAX_TABLE_HEIGHT);
    expect(tableHeightFor(Number.NaN)).toBeCloseTo(0.85);
  });
});

describe('placeTable', () => {
  it('puts the table 0.65 m straight ahead at waist height in open space', () => {
    const r = placeTable({ x: 0, z: 0, yaw: 90, eyeHeight: 1.5 }, hall());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.pose.x).toBeCloseTo(0.65);
    expect(r.pose.z).toBeCloseTo(0);
    expect(r.pose.yaw).toBeCloseTo(90);
    expect(r.pose.height).toBeCloseTo(0.75);
    expect(r.offsetDeg).toBe(0);
    expect(r.distance).toBeCloseTo(0.65);
  });

  it('falls back to a shorter distance, then a rotated heading, beside a wall', () => {
    const room = hall();
    // Facing the north wall 0.3 m away: the ideal spot is outside the room.
    const wall = placeTable({ x: 0, z: -4.0, yaw: 0 }, room);
    expect(wall.ok).toBe(true);
    if (wall.ok) {
      expect(wall.offsetDeg === 0 && wall.distance === 0.65).toBe(false);
      expect(tableIsClear(room, wall.pose)).toBe(true);
    }
    // Pressed against the wall: the table must turn away.
    const pressed = placeTable({ x: 0, z: -4.5, yaw: 0 }, room);
    expect(pressed.ok).toBe(true);
    if (pressed.ok) {
      expect(Math.abs(pressed.offsetDeg)).toBeGreaterThanOrEqual(45);
      expect(tableIsClear(room, pressed.pose)).toBe(true);
    }
  });

  it('avoids a pillar directly ahead', () => {
    const room = combatRoom(worldRoom(templateById('study'), 0, [0, 0]));
    const r = placeTable({ x: 0, z: 1.6, yaw: 0 }, room);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(tableIsClear(room, r.pose)).toBe(true);
    expect(r.offsetDeg === 0 && r.distance === 0.65).toBe(false);
  });

  it('reports failure instead of placing a table where it cannot fit', () => {
    const corridor = combatRoom(worldRoom(templateById('corridor'), 0, [0, 0]));
    const r = placeTable({ x: 0, z: 0, yaw: 0 }, corridor);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/no table placement/);
    expect(tableCandidates({ x: 0, z: 0, yaw: 0 }, corridor)).toHaveLength(0);
  });

  it('faces the player, sits 0.5 to 0.65 m away at waist height and is clear on every generated floor', () => {
    let placed = 0;
    let central = 0;
    let centralOk = 0;
    for (const seed of SEEDS) {
      for (const wr of worldRooms(generateFloor(seed))) {
        const room = combatRoom(wr);
        for (const [x, z] of seats(room)) {
          for (const yaw of HEADINGS) {
            const r = placeTable({ x, z, yaw, eyeHeight: 1.6 }, room);
            // Seats at least 3 m from every wall and pillar always have a clear table spot.
            if (colliderDistance(room, x, z) >= 3) {
              central++;
              if (r.ok) centralOk++;
            }
            if (!r.ok) continue;
            placed++;
            const dx = r.pose.x - x;
            const dz = r.pose.z - z;
            expect(Math.hypot(dx, dz)).toBeGreaterThanOrEqual(0.5 - 1e-9);
            expect(Math.hypot(dx, dz)).toBeLessThanOrEqual(0.65 + 1e-9);
            // Faces the player: its forward axis points from the player to the table centre.
            expect(headingDelta(r.pose.yaw, headingTo([x, z], [r.pose.x, r.pose.z]))).toBeLessThan(
              1e-6,
            );
            expect(headingDelta(r.pose.yaw, yaw + r.offsetDeg)).toBeLessThan(1e-6);
            expect(r.pose.height).toBeCloseTo(0.85);
            expect(tableIsClear(room, r.pose)).toBe(true);
          }
        }
      }
    }
    expect(placed).toBeGreaterThan(500);
    expect(central).toBeGreaterThan(0);
    expect(centralOk).toBe(central);
  });
});

describe('placeEnemies', () => {
  const table: TablePose = { x: 0, z: 0.65, yaw: 0, height: 0.85 };

  it('spreads enemies 2.5 m beyond the table centre in open space', () => {
    const r = placeEnemies(table, 3, hall(), { player: [0, 0] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.placements).toHaveLength(3);
    r.placements.forEach((p, i) => {
      expect(p.distance).toBeCloseTo(2.5);
      expect(Math.hypot(p.x - table.x, p.z - table.z)).toBeCloseTo(2.5);
      expect(p.lateral).toBeCloseTo((i - 1) * 1.2);
      expect(p.forward).toBeGreaterThan(2);
      // Facing the player at the origin.
      expect(headingDelta(p.yaw, headingTo([p.x, p.z], [0, 0]))).toBeLessThan(1e-6);
    });
    // Left to right: the first enemy is on the player's left.
    expect(r.placements[0]?.lateral).toBeLessThan(r.placements[2]?.lateral ?? 0);
  });

  it('pulls closer and shrinks the spread when a wall is behind the preferred spot', () => {
    const room = hall();
    // Facing the north wall (z = -5): 2.5 m beyond the table is past the walkable edge at -4.6.
    const t: TablePose = { x: 0, z: -1.6, yaw: 0, height: 0.85 };
    const r = placeEnemies(t, 2, room, { player: [0, -0.95] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.placements.every((p) => p.distance < 2.5)).toBe(true);
    for (const p of r.placements) {
      expect(p.distance).toBeGreaterThanOrEqual(2 - 1e-9);
      expect(p.distance).toBeLessThanOrEqual(3 + 1e-9);
      expect(inWalkable(room, p.x, p.z)).toBe(true);
      expect(colliderDistance(room, p.x, p.z)).toBeGreaterThanOrEqual(0.5 - 1e-9);
    }
  });

  it('reports failed slots and leaves them unplaced when nothing fits', () => {
    const corridor = combatRoom(worldRoom(templateById('corridor'), 0, [0, 0]));
    const r = placeEnemies({ x: 0, z: 3, yaw: 0, height: 0.85 }, 2, corridor, {
      player: [0, 3.65],
    });
    expect(r.ok).toBe(false);
    expect(r.failed.length).toBeGreaterThan(0);
    for (const i of r.failed) expect(r.placements[i]).toBeNull();
    for (const p of r.placements) {
      if (p) expect(inWalkable(corridor, p.x, p.z)).toBe(true);
    }
  });

  it('keeps the placed enemies apart', () => {
    const r = placeEnemies(table, 3, hall(), { player: [0, 0] });
    if (!r.ok) throw new Error('expected placement');
    for (let i = 0; i < r.placements.length; i++) {
      for (let j = i + 1; j < r.placements.length; j++) {
        const a = r.placements[i];
        const b = r.placements[j];
        expect(Math.hypot((a?.x ?? 0) - (b?.x ?? 0), (a?.z ?? 0) - (b?.z ?? 0))).toBeGreaterThan(
          0.9,
        );
      }
    }
  });
});

describe('planEncounter on generated floors', () => {
  it('places the table and every encounter enemy 2 to 3 m beyond it, in bounds and clear of colliders', () => {
    let plans = 0;
    let ok = 0;
    for (const seed of SEEDS) {
      const plan = generateFloor(seed);
      const rooms = worldRooms(plan);
      plan.rooms.forEach((placed, i) => {
        const enc = placed.encounter;
        const wr = rooms[i];
        if (!enc || !wr) return;
        const room = combatRoom(wr);
        const radius = enc.tier === 'guardian' ? 0.8 : 0.5;
        const count = enc.socketIds.length;
        for (const [x, z] of seats(room)) {
          for (const yaw of HEADINGS) {
            plans++;
            const r = planEncounter({ x, z, yaw, eyeHeight: 1.6 }, count, room, {
              enemies: { radius },
            });
            if (!r.ok) continue;
            ok++;
            const t = r.table.pose;
            expect(tableIsClear(room, t)).toBe(true);
            expect(r.enemies).toHaveLength(count);
            for (const e of r.enemies) {
              const d = Math.hypot(e.x - t.x, e.z - t.z);
              expect(d).toBeGreaterThanOrEqual(2 - 1e-9);
              expect(d).toBeLessThanOrEqual(3 + 1e-9);
              expect(e.forward).toBeGreaterThan(0);
              expect(
                room.walkable.some(
                  (w) =>
                    e.x - radius >= w.min[0] &&
                    e.x + radius <= w.max[0] &&
                    e.z - radius >= w.min[1] &&
                    e.z + radius <= w.max[1],
                ),
              ).toBe(true);
              expect(colliderDistance(room, e.x, e.z)).toBeGreaterThanOrEqual(radius - 1e-9);
              expect(headingDelta(e.yaw, headingTo([e.x, e.z], [x, z]))).toBeLessThan(1e-6);
            }
          }
        }
      });
    }
    expect(plans).toBeGreaterThan(300);
    // The seats that cannot host a fight are the ones jammed against walls and pillars.
    expect(ok / plans).toBeGreaterThan(0.8);
  });

  it('fails explicitly when no room is left', () => {
    const corridor = combatRoom(worldRoom(templateById('corridor'), 0, [0, 0]));
    const r = planEncounter({ x: 0, z: 0, yaw: 0 }, 2, corridor);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason.length).toBeGreaterThan(0);
  });

  it('turns the table away from a wall so the enemies still fit', () => {
    const room = hall();
    const r = planEncounter({ x: 0, z: -4.4, yaw: 0 }, 2, room);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Math.abs(r.table.offsetDeg)).toBeGreaterThan(0);
    for (const e of r.enemies) expect(inWalkable(room, e.x, e.z)).toBe(true);
  });
});
