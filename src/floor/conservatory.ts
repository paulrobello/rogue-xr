import { type QuarterTurns, templateById } from '../content/rooms.ts';
import { Stream } from '../core/rng.ts';
import type { FloorPlan, PlacedRoom } from './generate.ts';
import { worldRoom } from './generate.ts';
import { joinDoors } from './return-passages.ts';

/** Six halls and a seeded side archive with matching, offset door sockets. */
export function conservatoryPlan(seed: string): FloorPlan {
  const kit = templateById('hall');
  const rotation = Stream.fromKey(seed + ':conservatory-plan').int(0, 3) as QuarterTurns;
  const sourceRoom = Stream.fromKey(seed + ':archive-room').pick([2, 3, 4] as const);
  const archiveCell = ({ 2: [-1, 1], 3: [1, 2], 4: [3, 1] } as const)[sourceRoom];
  const cells: readonly (readonly [number, number])[] = [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
    [2, 1],
    [2, 0],
    archiveCell,
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
          : index === 5 || index === 6
            ? 'treasure'
            : index === owlRoom
              ? 'combat'
              : 'corridor',
      wing: 0,
      depth: [0, 1, 1, 2, 3, 2][index],
      encounter:
        index === owlRoom ? { tier: 'regular', socketIds: [kit.enemySockets[0].id] } : null,
      loot: index === 5 || index === 6 ? [{ socketId: 'chest', kind: 'card' }] : [],
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
  // The archive branches from a seeded spare doorway in rooms 2-4. The original
  // six rooms and their connections remain unchanged, while joinDoors removes
  // both wall plugs at this aligned, full-sized doorway.
  const pair = sites[sourceRoom].flatMap((sourceDoor) =>
    sites[6]
      .filter(
        (archiveDoor) =>
          archiveDoor.world[0] === sourceDoor.world[0] &&
          archiveDoor.world[1] === sourceDoor.world[1],
      )
      .map((archiveDoor) => [sourceDoor, archiveDoor] as const),
  )[0];
  const source =
    pair && plan.sealed.find((sealed) => sealed.room === sourceRoom && sealed.door === pair[0].id);
  const archiveDoor = pair?.[1];
  if (!source) throw Error('Conservatory archive has no spare doorway');
  if (!archiveDoor) throw Error('Conservatory archive doorway is not aligned');
  return joinDoors(plan, source, { room: 6, door: archiveDoor.id }, 'archive');
}
