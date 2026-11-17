import type { FloorPlan } from './generate.ts';

/** Rooms joined to `room` by a door. */
export function neighbours(plan: FloorPlan, room: number): number[] {
  const out: number[] = [];
  for (const [a, b] of plan.connections) {
    if (a.room === room) out.push(b.room);
    else if (b.room === room) out.push(a.room);
  }
  return out;
}

/** The current room and its door neighbours: the rooms gameplay reaches (colliders, landings). */
export function nearSet(plan: FloorPlan, current: number): Set<number> {
  return new Set([current, ...neighbours(plan, current)]);
}

/**
 * Rooms outside `nearSet` that the player can see down a corridor. A corridor's two doors face
 * each other on one straight axis, and corridors join door to door, so a chain of corridors is a
 * single sight-line: from the current room, each corridor neighbour shows the room beyond it, and
 * so on while that room is itself a corridor. Rooms seen only this way are drawn as a lit shell.
 */
export function shellSet(plan: FloorPlan, current: number): Set<number> {
  const near = nearSet(plan, current);
  const shell = new Set<number>();
  const seen = new Set([current]);
  const through = (room: number) => plan.rooms[room]?.role === 'corridor';
  let frontier = neighbours(plan, current).filter((n) => {
    seen.add(n);
    return through(n);
  });
  while (frontier.length > 0) {
    const next: number[] = [];
    for (const corridor of frontier) {
      for (const beyond of neighbours(plan, corridor)) {
        if (seen.has(beyond)) continue;
        seen.add(beyond);
        if (!near.has(beyond)) shell.add(beyond);
        if (through(beyond)) next.push(beyond);
      }
    }
    frontier = next;
  }
  return shell;
}

/** Every room drawn from `current`: the near set at full detail plus the corridor-seen shells. */
export function visibleSet(plan: FloorPlan, current: number): Set<number> {
  return new Set([...nearSet(plan, current), ...shellSet(plan, current)]);
}
