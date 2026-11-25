import { describe, expect, it } from 'vitest';
import { chooseEncounter, ENCOUNTER_CONTENT_VERSION } from '../src/combat/encounter-choice.ts';
import {
  DUNGEON_SHOWCASE_NICHE_ROOM,
  DUNGEON_SHOWCASE_SEED,
  DUNGEON_SHOWCASE_STONE_HALLS,
  DUNGEON_SHOWCASE_UPPER_SEED,
} from '../src/floor/dungeon-showcase.ts';
import type { FloorPlan } from '../src/floor/generate.ts';
import { placeStairEntry } from '../src/floor/stairs.ts';
import { stoneRoomsFor } from '../src/floor/stone-rooms.ts';
import { TEST_SEEDS } from '../src/flow/test-seeds.ts';
import { conservatoryFormula } from '../src/rules/alchemy.ts';
import { calibrationPlan } from '../src/rules/calibration.ts';
import { commissionPlan } from '../src/rules/commissions.ts';
import { floorSeedFor } from '../src/rules/run.ts';
import { playableFloorPlan } from '../src/world/floor-view.ts';

const version = ENCOUNTER_CONTENT_VERSION;

function showcaseFloor(floor: 1 | 2 | 3) {
  return playableFloorPlan(floorSeedFor(DUNGEON_SHOWCASE_SEED, floor), version, floor);
}

function openReach(plan: FloorPlan): Set<number> {
  const reached = new Set([0]);
  for (const room of reached) {
    for (const edge of plan.connections) {
      if (edge.puzzleGate) continue;
      const [a, b] = edge;
      if (a.room === room) reached.add(b.room);
      if (b.room === room) reached.add(a.room);
    }
  }
  return reached;
}

describe('dungeon showcase seed', () => {
  it('gives the Upper Works a route through both stone fights and all three late fixtures', () => {
    expect(TEST_SEEDS.some(({ seed }) => seed === DUNGEON_SHOWCASE_SEED)).toBe(true);
    const lower = showcaseFloor(1);
    const upper = showcaseFloor(2);
    expect(upper.seed).toBe(DUNGEON_SHOWCASE_UPPER_SEED);
    const reached = openReach(upper);
    const styles = stoneRoomsFor(upper, 2);
    expect(placeStairEntry(lower)?.room).toBe(0);
    expect(placeStairEntry(upper)?.room).toBe(0);
    expect(DUNGEON_SHOWCASE_STONE_HALLS).toContain(DUNGEON_SHOWCASE_NICHE_ROOM);

    const dungeon = DUNGEON_SHOWCASE_STONE_HALLS.map((index) => {
      const room = upper.rooms[index];
      expect(room.templateId).toBe('hall');
      expect(room.encounter?.tier).toBe('regular');
      expect(room.encounter?.socketIds).toHaveLength(1);
      expect(styles.get(index)).toBe('dungeon');
      expect(reached.has(index)).toBe(true);
      return chooseEncounter(upper.seed, index, 'regular', 1, version, 2, true).id;
    });
    expect(dungeon).toEqual(['mortar-scarab', 'lantern-bailiff']);
    expect(upper.armoryAlcove?.room).toBe(13);
    expect(upper.rooms[13]?.encounter?.tier).toBe('regular');
    expect(upper.springTension?.workshop).toBe(14);
    expect(upper.darkCircuit?.switchboard).toBe(16);
    for (const room of [13, 14, 16]) expect(reached.has(room)).toBe(true);
  });

  it('offers the lower exploration variants and the Trellis Keeper with the mirror archive', () => {
    const lower = showcaseFloor(1);
    const conservatory = showcaseFloor(3);
    expect(lower.valvehouse && lower.floatElevator && lower.shadowStencil).toBeTruthy();
    expect(commissionPlan(DUNGEON_SHOWCASE_SEED)).toBe('recovery');
    expect(calibrationPlan(DUNGEON_SHOWCASE_SEED).kind).toBe('gears');
    expect(conservatoryFormula(DUNGEON_SHOWCASE_SEED, version).recipe).toBe('looking-glass');
    expect(conservatory.drumGallery).toBeDefined();
    expect(conservatory.rooms[2]?.encounter?.tier).toBe('regular');
    expect(chooseEncounter(conservatory.seed, 2, 'regular', 1, version, 3).id).toBe(
      'trellis-keeper',
    );
    expect(openReach(conservatory).has(2)).toBe(true);
  });
});
