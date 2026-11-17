import { describe, expect, it } from 'vitest';
import type { RoomKind } from '../src/content/rooms.ts';
import { type FloorPlan, generateFloor } from '../src/floor/generate.ts';
import { nearSet, neighbours, shellSet, visibleSet } from '../src/floor/visibility.ts';

/** A plan holding only what the sight rule reads: room roles and door connections. */
function plan(
  roles: readonly RoomKind[],
  links: readonly (readonly [number, number])[],
): FloorPlan {
  return {
    seed: 'TEST0000',
    rooms: roles.map((role, index) => ({
      index,
      templateId: role === 'corridor' ? 'corridor' : 'hall',
      turns: 0,
      position: [index * 20, 0],
      role,
      wing: 0,
      depth: index,
      encounter: null,
      loot: [],
    })),
    connections: links.map(([a, b]) => [
      { room: a, door: `to-${b}` },
      { room: b, door: `to-${a}` },
    ]),
    sealed: [],
    guardianRoom: roles.indexOf('guardian'),
  };
}

const sorted = (s: Set<number>) => [...s].sort((a, b) => a - b);

describe('shellSet', () => {
  // 0 entry - 1 corridor - 2 corridor - 3 combat - 5 guardian, and 0 - 4 rest.
  const chain = plan(
    ['entry', 'corridor', 'corridor', 'combat', 'rest', 'guardian'],
    [
      [0, 1],
      [1, 2],
      [2, 3],
      [0, 4],
      [3, 5],
    ],
  );

  it('sees down a chain of corridors to the room at the far end, and no further', () => {
    expect(sorted(nearSet(chain, 0))).toEqual([0, 1, 4]);
    expect(sorted(shellSet(chain, 0))).toEqual([2, 3]);
  });

  it('from inside a corridor, sees past a corridor neighbour only', () => {
    expect(sorted(nearSet(chain, 1))).toEqual([0, 1, 2]);
    expect(sorted(shellSet(chain, 1))).toEqual([3]);
    expect(sorted(shellSet(chain, 2))).toEqual([0]);
  });

  it('works both ways along the chain and stops at a room that is not a corridor', () => {
    expect(sorted(shellSet(chain, 3))).toEqual([0, 1]);
    expect(sorted(shellSet(chain, 5))).toEqual([]);
    // The rest room's only neighbour is the entry, a room, so its view stops there.
    expect(sorted(shellSet(chain, 4))).toEqual([]);
  });

  it('adds nothing for a dead-end corridor or a neighbour that is a room', () => {
    const deadEnd = plan(
      ['entry', 'corridor', 'combat', 'rest'],
      [
        [0, 1],
        [0, 2],
        [2, 3],
      ],
    );
    expect(sorted(shellSet(deadEnd, 0))).toEqual([]);
    expect(sorted(visibleSet(deadEnd, 0))).toEqual([0, 1, 2]);
  });

  it('over generated floors: near is the door neighbourhood, shells are disjoint and corridor-seen', () => {
    let withShell = 0;
    for (let i = 0; i < 300; i++) {
      const p = generateFloor(`SIGHT${String(i).padStart(3, '0')}`);
      for (let current = 0; current < p.rooms.length; current++) {
        const near = nearSet(p, current);
        const shell = shellSet(p, current);
        expect(sorted(near)).toEqual(sorted(new Set([current, ...neighbours(p, current)])));
        expect(shell.has(current)).toBe(false);
        for (const s of shell) {
          expect(near.has(s)).toBe(false);
          // Each shell room hangs off a corridor that is itself drawn.
          const via = neighbours(p, s).filter(
            (n) => p.rooms[n]?.role === 'corridor' && (near.has(n) || shell.has(n)),
          );
          expect(via.length).toBeGreaterThan(0);
        }
        expect(sorted(visibleSet(p, current))).toEqual(sorted(new Set([...near, ...shell])));
        if (shell.size > 0) withShell++;
      }
    }
    expect(withShell).toBeGreaterThan(0);
  });
});
