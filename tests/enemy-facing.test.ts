import { describe, expect, it } from 'vitest';
import { GREYBOX_TEMPLATES, type Rect } from '../src/content/rooms.ts';
import { generateFloor, worldRoom } from '../src/floor/generate.ts';
import { enemyHeading, enemyLocalRotationY } from '../src/world/enemy-facing.ts';
import { buildFloorWorld } from '../src/world/floor-world.ts';

/** World forward of a model facing local -Z after `rotation.y = y`, as [x, z]. */
const forward = (y: number): [number, number] => [-Math.sin(y), -Math.cos(y)];

function centreOf(fp: Rect): [number, number] {
  return [(fp.min[0] + fp.max[0]) / 2, (fp.min[1] + fp.max[1]) / 2];
}

/** The point an enemy at `at` is meant to face: its entry door, or the centre when at the door. */
function targetOf(at: readonly [number, number], door: readonly [number, number] | null, fp: Rect) {
  const far = door && Math.hypot(door[0] - at[0], door[1] - at[1]) >= 1.5;
  return far && door ? door : centreOf(fp);
}

/** Dot product of a facing vector with the unit direction from `at` to `target`. */
function alignment(
  f: readonly [number, number],
  at: readonly [number, number],
  target: readonly number[],
) {
  const dx = (target[0] ?? 0) - at[0];
  const dz = (target[1] ?? 0) - at[1];
  return (f[0] * dx + f[1] * dz) / Math.hypot(dx, dz);
}

describe('enemyHeading', () => {
  const fp: Rect = { min: [-5, -5], max: [5, 5] };
  it('uses compass degrees, 0 = -Z, clockwise', () => {
    expect(enemyHeading([0, 3], [0, -5], fp)).toBeCloseTo(0);
    expect(enemyHeading([-3, 0], [5, 0], fp)).toBeCloseTo(90);
    expect(enemyHeading([0, -3], [0, 5], fp)).toBeCloseTo(180);
  });
  it('falls back to the room centre with no door or when standing at the door', () => {
    expect(enemyHeading([3, 0], null, fp)).toBeCloseTo(-90);
    expect(enemyHeading([0, 4.5], [0, 5], fp)).toBeCloseTo(0);
  });
});

describe('every template at every rotation', () => {
  for (const t of GREYBOX_TEMPLATES) {
    for (const turns of t.rotations) {
      it(`${t.id} turns=${turns}: every enemy socket faces each possible entry door or the centre, into the room`, () => {
        const w = worldRoom(t, turns, [10, -7]);
        for (const door of w.doors) {
          for (const s of w.template.enemySockets) {
            const at: [number, number] = [s.position[0] + 10, s.position[2] - 7];
            const f = forward(enemyLocalRotationY(enemyHeading(at, door.world, w.footprint), 0));
            expect(alignment(f, at, targetOf(at, door.world, w.footprint))).toBeCloseTo(1, 5);
            const ahead: [number, number] = [at[0] + f[0] * 0.5, at[1] + f[1] * 0.5];
            expect(ahead[0]).toBeGreaterThan(w.footprint.min[0]);
            expect(ahead[0]).toBeLessThan(w.footprint.max[0]);
            expect(ahead[1]).toBeGreaterThan(w.footprint.min[1]);
            expect(ahead[1]).toBeLessThan(w.footprint.max[1]);
          }
        }
      });
    }
  }
});

describe('placed enemy bodies', () => {
  it('face their entry door or room centre in world space, for every generated room and turn', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 40; i++) {
      const plan = generateFloor(`FACE00${String(i).padStart(2, '0')}`);
      const world = buildFloorWorld(plan);
      world.group.updateMatrixWorld(true);
      plan.rooms.forEach((placed, room) => {
        const rotated = world.rooms[room];
        if (!rotated) throw new Error('room missing');
        const entry = plan.connections.find(([, own]) => own.room === room)?.[1].door;
        const doorAt = rotated.doors.find((d) => d.id === entry)?.world ?? null;
        for (const body of world.enemies.get(room) ?? []) {
          seen.add(`${placed.templateId}/${placed.turns}`);
          const m = body.matrixWorld.elements;
          const at: [number, number] = [m[12] ?? 0, m[14] ?? 0];
          const f: [number, number] = [-(m[8] ?? 0), -(m[10] ?? 0)];
          expect(alignment(f, at, targetOf(at, doorAt, rotated.footprint))).toBeCloseTo(1, 5);
        }
      });
      world.dispose();
    }
    expect(seen.size).toBeGreaterThan(3);
  });
});
