import { describe, expect, it } from 'vitest';
import {
  GREYBOX_TEMPLATES,
  parseRoomTemplate,
  perimeterColliders,
  type QuarterTurns,
  type RoomTemplate,
  rotateFacing,
  rotatePoint,
  rotateTemplate,
  templateErrors,
} from '../src/content/rooms.ts';
import { buildGreyboxRoom, createGreyboxMaterials } from '../src/world/greybox.ts';

const hall = GREYBOX_TEMPLATES.find((t) => t.id === 'hall') as RoomTemplate;

function variant(patch: Record<string, unknown>): unknown {
  return JSON.parse(JSON.stringify({ ...hall, ...patch }));
}

describe('greybox templates', () => {
  it('ships the five slice templates and every one validates', () => {
    expect(GREYBOX_TEMPLATES.map((t) => t.id)).toEqual([
      'hall',
      'corridor',
      'study',
      'gear-shaft',
      'guardian-vault',
    ]);
    for (const t of GREYBOX_TEMPLATES) {
      expect(templateErrors(t)).toEqual([]);
      expect(parseRoomTemplate(JSON.parse(JSON.stringify(t)))).toEqual(t);
    }
  });

  it('every allowed rotation of every template still validates', () => {
    for (const t of GREYBOX_TEMPLATES) {
      for (const turns of t.rotations) expect(templateErrors(rotateTemplate(t, turns))).toEqual([]);
    }
  });

  it('has exactly one guardian template and an entry template', () => {
    expect(GREYBOX_TEMPLATES.filter((t) => t.kinds.includes('guardian'))).toHaveLength(1);
    expect(GREYBOX_TEMPLATES.some((t) => t.kinds.includes('entry'))).toBe(true);
  });
});

describe('parseRoomTemplate rejects malformed manifests', () => {
  it('a door outside the footprint', () => {
    const doors = [{ id: 'n', facing: 'N', position: [9, 0, -5], width: 1.6 }];
    expect(() => parseRoomTemplate(variant({ doors }))).toThrow(/outside the footprint/);
  });

  it('a door not on the edge its facing names', () => {
    const doors = [{ id: 'n', facing: 'N', position: [0, 0, 5], width: 1.6 }];
    expect(() => parseRoomTemplate(variant({ doors }))).toThrow(/not on its N edge/);
  });

  it('more than four light sockets', () => {
    const lightSockets = [1, 2, 3, 4, 5].map((i) => ({
      id: `l${i}`,
      position: [0, 2, i - 3],
      yaw: 0,
    }));
    expect(() => parseRoomTemplate(variant({ lightSockets }))).toThrow(/5 light sockets/);
  });

  it('a socket outside the footprint, an off-grid footprint and an over-budget template', () => {
    const lootSockets = [{ id: 'far', position: [20, 0, 0], yaw: 0 }];
    expect(() => parseRoomTemplate(variant({ lootSockets }))).toThrow(/outside the footprint/);
    expect(() =>
      parseRoomTemplate(variant({ footprint: { min: [-5.5, -5], max: [5, 5] } })),
    ).toThrow(/off the 1 m grid/);
    expect(() =>
      parseRoomTemplate(variant({ budget: { tris: 150_000, materials: 4, texturePx: 1024 } })),
    ).toThrow(/tris over/);
  });

  it('missing arrays and non-objects', () => {
    expect(() => parseRoomTemplate(null)).toThrow(/expected an object/);
    expect(() => parseRoomTemplate({ ...hall, doors: undefined })).toThrow(
      /doors must be an array/,
    );
  });
});

describe('rotation', () => {
  it('turns facings and points clockwise seen from above', () => {
    expect(rotateFacing('N', 1)).toBe('E');
    expect(rotateFacing('W', 1)).toBe('N');
    expect(rotateFacing('E', 2)).toBe('W');
    // North of the origin (-Z) turns to east (+X).
    expect(rotatePoint([0, 1, -3], 1)).toEqual([3, 1, 0]);
    expect(rotatePoint([2, 0, 1], 4 as QuarterTurns)).toEqual([2, 0, 1]);
  });

  it('keeps each door on the edge its new facing names', () => {
    const turned = rotateTemplate(hall, 1);
    const north = turned.doors.find((d) => d.id === 'w');
    expect(north?.facing).toBe('N');
    expect(north?.position[2]).toBe(turned.footprint.min[1]);
  });
});

describe('perimeterColliders', () => {
  it('leaves a door-width gap in the wall', () => {
    const boxes = perimeterColliders({ min: [-2, -2], max: [2, 2] }, [
      { id: 'n', facing: 'N', position: [0, 0, -2], width: 1.6 },
    ]);
    const north = boxes.filter((b) => b.min[2] < -1.9 && b.max[2] < -1.8);
    expect(north.map((b) => [b.min[0], b.max[0]])).toEqual([
      [-2, -0.8],
      [0.8, 2],
    ]);
    expect(boxes).toHaveLength(5);
  });
});

describe('buildGreyboxRoom', () => {
  it('builds a floor, one mesh per collider and markers for sockets', () => {
    const room = buildGreyboxRoom(hall, createGreyboxMaterials());
    expect(room.getObjectByName('floor')).toBeDefined();
    expect(room.children.filter((c) => c.name.startsWith('collider-'))).toHaveLength(
      hall.colliders.length,
    );
    expect(room.getObjectByName('light-sconce-nw')).toBeDefined();
    expect(room.userData.templateId).toBe('hall');
  });
});
