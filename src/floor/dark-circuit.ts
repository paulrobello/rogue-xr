import { Stream } from '../core/rng.ts';
import type { FloorPlan } from './generate.ts';
import { attachRoom } from './return-passages.ts';
import { placeStairEntry } from './stairs.ts';

const TURNS = [0, 1, 2, 3] as const;

/** Append the control room and its single gated recess to an accessible service spur. */
export function attachDarkCircuit(
  base: FloorPlan,
  preservesRoutes: (candidate: FloorPlan) => boolean,
): FloorPlan {
  if (base.darkCircuit) return base;
  const stair = placeStairEntry(base);
  const reachable = new Set([0]);
  for (const room of reachable) {
    for (const edge of base.connections) {
      if (edge.puzzleGate) continue;
      if (edge[0].room === room) reachable.add(edge[1].room);
      if (edge[1].room === room) reachable.add(edge[0].room);
    }
  }
  const reserved = new Set([
    base.guardianRoom,
    base.armoryAlcove?.room,
    base.springTension?.workshop,
    base.dispatchRoom?.replyRoom,
    base.speakingPipes?.receiverRoom,
    base.reliquary?.clueRoom,
  ]);
  const random = Stream.fromKey(`${base.seed}:dark-circuit:layout`);
  const sites = random.shuffle(
    base.sealed.filter(
      (site) =>
        reachable.has(site.room) &&
        !reserved.has(site.room) &&
        (site.room !== stair?.room || site.door !== stair.door),
    ),
  );
  const switchboard = base.rooms.length;
  const recess = switchboard + 1;
  for (const site of sites) {
    for (const template of ['study', 'hall']) {
      for (const turn of random.shuffle(TURNS)) {
        const annex = attachRoom(base, site, turn, 'corridor', undefined, stair, template);
        if (!annex) continue;
        for (const exit of random.shuffle(
          annex.sealed.filter((door) => door.room === switchboard),
        )) {
          const gate = { room: exit.room, door: exit.door };
          for (const exitTurn of random.shuffle(TURNS)) {
            const next = attachRoom(
              annex,
              gate,
              exitTurn,
              'treasure',
              'dark-circuit',
              stair,
              'study',
            );
            if (!next) continue;
            const candidate = { ...next, darkCircuit: { switchboard, recess, gate } };
            if (preservesRoutes(candidate)) return candidate;
          }
        }
      }
    }
  }
  return base;
}
