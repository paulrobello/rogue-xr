import type { FloorPlan } from './generate.ts';

export const CONSERVATORY_SHELL_DEPTH = 1;

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
 * Rooms outside `nearSet` that may be seen through corridor-role rooms. Each step adds the rooms
 * beyond the corridor neighbours, then follows any corridors among those rooms. One shell step
 * reaches two doors from the current room. Shell rooms have no gameplay colliders or landings,
 * and run their actors at a reduced rate.
 */
export function shellSet(plan: FloorPlan, current: number, maxShellDepth = Infinity): Set<number> {
  const near = nearSet(plan, current);
  const shell = new Set<number>();
  const seen = new Set([current]);
  const through = (room: number) => plan.rooms[room]?.role === 'corridor';
  let frontier = neighbours(plan, current).filter((n) => {
    seen.add(n);
    return through(n);
  });
  for (let depth = 0; depth < maxShellDepth && frontier.length > 0; depth++) {
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
export function visibleSet(plan: FloorPlan, current: number, maxShellDepth?: number): Set<number> {
  return new Set([...nearSet(plan, current), ...shellSet(plan, current, maxShellDepth)]);
}
