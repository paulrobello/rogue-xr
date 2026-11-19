import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { generateFloor } from '../src/floor/generate.ts';
import { pressureTarget } from '../src/rules/pressure.ts';
import { buildFloorWorld } from '../src/world/floor-world.ts';
import { PressureNotes } from '../src/world/pressure-notes.ts';

describe('pressure notes', () => {
  it('places exactly three value notes in distinct non-guardian rooms with seeded values', () => {
    const world = buildFloorWorld(generateFloor('SPIRE002'));
    const notes = new PressureNotes(world);
    const values = pressureTarget('SPIRE002');
    const valuesNotes = notes.placements.filter((p) => p.id !== 'dispatch');
    expect(valuesNotes).toHaveLength(3);
    expect(new Set(valuesNotes.map((p) => p.room)).size).toBe(3);
    expect(valuesNotes.every((p) => p.room !== world.plan.guardianRoom)).toBe(true);
    for (const [i, id] of ['A', 'B', 'C'].entries())
      expect(valuesNotes.find((n) => n.id === id)?.body).toContain(String(values[i]));
    notes.dispose();
    world.dispose();
  });

  it('varies the physical source mix while keeping chest and drop notes gated', () => {
    const mixes = new Set<string>();
    for (const seed of ['SPIRE001', 'SPIRE002', 'SPIRE003', 'SPIRE005', 'SPIRE034']) {
      const world = buildFloorWorld(generateFloor(seed));
      const notes = new PressureNotes(world);
      mixes.add(
        notes.placements
          .filter((p) => p.id !== 'dispatch')
          .map((p) => p.source)
          .join(','),
      );
      const chest = notes.placements.find((p) => p.source === 'chest');
      if (chest) {
        expect(chest.object.visible).toBe(false);
        notes.sync(
          [],
          () => false,
          (room, socket) => room === chest.room && socket === chest.socketId,
        );
        expect(chest.object.visible).toBe(true);
      }
      const drop = notes.placements.find((p) => p.source === 'drop');
      if (drop) {
        expect(drop.object.visible).toBe(false);
        notes.sync(
          [],
          (room) => room === drop.room,
          () => false,
        );
        expect(drop.object.visible).toBe(true);
      }
      notes.dispose();
      world.dispose();
    }
    expect(mixes.size).toBeGreaterThan(1);
  });

  it('picks a visible paper within four metres and hides collected notes', () => {
    const world = buildFloorWorld(generateFloor('SPIRE001'));
    world.group.updateMatrixWorld(true);
    const notes = new PressureNotes(world);
    const placement = notes.placements[0];
    if (!placement) throw new Error('note missing');
    notes.sync(
      [],
      () => true,
      () => true,
    );
    world.update(placement.location.x, placement.location.z);
    const origin = placement.location.clone().add(new THREE.Vector3(0, 1, 0));
    const picked = notes.pick(origin, placement.location.clone().sub(origin));
    expect(picked?.id).toBe(placement.id);
    expect(picked?.distance).toBeLessThan(4);
    notes.sync(
      [placement.id],
      () => true,
      () => true,
    );
    expect(notes.near(placement.location, 1)).not.toContain(placement);
    notes.dispose();
    world.dispose();
  });
});
