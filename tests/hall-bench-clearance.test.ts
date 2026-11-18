// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  type Box,
  type Door,
  parseRoomTemplate,
  rotateTemplate,
  templateById,
} from '../src/content/rooms.ts';
import { DECOR_TABLES } from '../src/floor/table-decor.ts';

const hall = templateById('hall');
const tables = DECOR_TABLES.hall ?? [];

function checkClearance(boxes: readonly Box[], doors: readonly Door[]): void {
  for (const box of boxes) {
    for (const door of doors) {
      const [x, , z] = door.position;
      const half = door.width / 2;
      const apron =
        door.facing === 'N'
          ? { minX: x - half, maxX: x + half, minZ: z, maxZ: z + 1 }
          : door.facing === 'S'
            ? { minX: x - half, maxX: x + half, minZ: z - 1, maxZ: z }
            : door.facing === 'E'
              ? { minX: x - 1, maxX: x, minZ: z - half, maxZ: z + half }
              : { minX: x, maxX: x + 1, minZ: z - half, maxZ: z + half };
      const overlaps =
        box.min[0] < apron.maxX &&
        box.max[0] > apron.minX &&
        box.min[2] < apron.maxZ &&
        box.max[2] > apron.minZ;
      expect(overlaps, `bench overlaps ${door.id} doorway`).toBe(false);
    }
  }
}

function checkRotations(boxes: Box[]): void {
  for (const turns of hall.rotations) {
    const rotated = rotateTemplate({ ...hall, colliders: boxes }, turns);
    checkClearance(rotated.colliders, rotated.doors);
  }
}

describe('hall bench clearance', () => {
  it('checks source bench placement, sockets and door aprons in every rotation', () => {
    const source = readFileSync('scripts/assets/build-room-kit.py', 'utf8');
    const specs = readFileSync('scripts/assets/room_kit.py', 'utf8');
    const placements = [
      ...source.matchAll(/kit\.bench\(b, (-?\d+\.\d+), (-?\d+\.\d+), 0\.9, high\)/g),
    ];
    expect(placements).toHaveLength(2);
    const boxes: Box[] = placements.map((match) => {
      const x = Number(match[1]);
      const z = -Number(match[2]);
      const table = tables.find((t) => t.x === x && t.z === z);
      expect(table).toBeDefined();
      expect(hall.dressingSockets.find((s) => s.id === table?.id)?.position).toEqual([x, 0, z]);
      expect(
        specs.includes(`_sock("${table?.id}", ${x}, ${z},`),
        `${table?.id} source socket`,
      ).toBe(true);
      return { min: [x - 0.215, 0, z - 0.455], max: [x + 0.215, 0.47, z + 0.455] };
    });
    checkRotations(boxes);
  });

  it('checks baked bench colliders and door aprons in every rotation', () => {
    const baked = parseRoomTemplate(
      JSON.parse(readFileSync('public/assets/rooms/hall/hall.manifest.json', 'utf8')),
    );
    const boxes = tables.map((table) => {
      expect(baked.dressingSockets.find((s) => s.id === table.id)?.position).toEqual([
        table.x,
        0,
        table.z,
      ]);
      const box = baked.colliders.find(
        (c) =>
          c.max[1] < 1.5 &&
          c.min[0] <= table.x - table.halfX &&
          c.max[0] >= table.x + table.halfX &&
          c.min[2] <= table.z - table.halfZ &&
          c.max[2] >= table.z + table.halfZ,
      );
      expect(box, `${table.id} collider`).toBeDefined();
      return box as Box;
    });
    for (const turns of baked.rotations) {
      const rotated = rotateTemplate({ ...baked, colliders: boxes }, turns);
      checkClearance(rotated.colliders, rotated.doors);
    }
  });
});
