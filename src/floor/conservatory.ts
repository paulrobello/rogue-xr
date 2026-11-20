import { type QuarterTurns, templateById } from '../content/rooms.ts';
import { Stream } from '../core/rng.ts';
import type { FloorPlan, PlacedRoom } from './generate.ts';
import { worldRoom } from './generate.ts';
import { joinDoors } from './return-passages.ts';

/** Six halls with coincident door sockets; only the collection beyond the thorn gate is optional. */
export function conservatoryPlan(seed: string): FloorPlan {
  const kit = templateById('hall');
  const rotation = Stream.fromKey(seed + ':conservatory-plan').int(0, 3) as QuarterTurns;
  const cells = [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
    [2, 1],
    [2, 0],
  ];
  const owlRoom = Stream.fromKey(seed + ':owl-roost').pick([1, 2, 4]);
  const rooms: PlacedRoom[] = cells.map(([x, z], index) => {
    let px = x * 10,
      pz = z * 10;
    for (let i = 0; i < rotation; i++) [px, pz] = [-pz, px];
    return {
      index,
      templateId: 'hall',
      turns: ((x + z + rotation) % 4) as QuarterTurns,
      position: [px, pz],
      role:
        index === 0
          ? 'entry'
          : index === 5
            ? 'treasure'
            : index === owlRoom
              ? 'combat'
              : 'corridor',
      wing: 0,
      depth: [0, 1, 1, 2, 3, 2][index],
      encounter:
        index === owlRoom ? { tier: 'regular', socketIds: [kit.enemySockets[0].id] } : null,
      loot: index === 5 ? [{ socketId: 'chest', kind: 'card' }] : [],
    };
  });
  const sites = rooms.map((r) => worldRoom(kit, r.turns, r.position).doors);
  let plan: FloorPlan = {
    seed,
    rooms,
    guardianRoom: -1,
    connections: [],
    sealed: sites.flatMap((doors, room) =>
      doors.map((d) => ({ room, door: d.id, style: 'wall' as const })),
    ),
  };
  for (const [a, b] of [
    [0, 1],
    [0, 2],
    [1, 3],
    [2, 3],
    [3, 4],
    [1, 5],
  ]) {
    const da = sites[a].find((d) =>
      sites[b].some((e) => d.world[0] === e.world[0] && d.world[1] === e.world[1]),
    );
    const db = da && sites[b].find((e) => da.world[0] === e.world[0] && da.world[1] === e.world[1]);
    if (!da || !db) throw Error('Misaligned Conservatory doorway');
    plan = joinDoors(
      plan,
      { room: a, door: da.id },
      { room: b, door: db.id },
      b === 5 ? 'thorn' : undefined,
    );
  }
  return plan;
}
