import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import studyManifest from '../public/assets/rooms/study/study.manifest.json';
import { GREYBOX_TEMPLATES, parseRoomTemplate } from '../src/content/rooms.ts';
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

  it('tosses only the carrier’s slip, then lets the player pick it up from the floor', () => {
    const world = buildFloorWorld(generateFloor('SPIRE002'));
    const notes = new PressureNotes(world);
    const drop = notes.placements.find((p) => p.source === 'drop');
    const carrier = drop && world.enemies.get(drop.room)?.[0];
    if (!drop || !carrier) throw new Error('missing automaton and slip');

    const other = new THREE.Object3D();
    other.userData = { ...carrier.userData, socketId: 'other-socket' };
    notes.tossFrom(other);
    expect(drop.object.visible).toBe(false);
    const home = drop.object.position.clone();
    const actor = new THREE.Object3D();
    expect(world.replaceEnemy(drop.room, carrier, actor)).toBe(true);
    world.update(drop.location.x, drop.location.z);
    const viewer = new THREE.Object3D();
    notes.tossFrom(actor);
    const launched = drop.object.position.clone();
    expect(drop.object.visible).toBe(true);
    expect(launched.x).toBeCloseTo(actor.position.x);
    expect(launched.z).toBeCloseTo(actor.position.z);
    notes.sync(
      [],
      () => false,
      () => false,
      drop.room,
    );
    notes.update(viewer, 0.4);
    expect(drop.object.position.y).toBeGreaterThan(launched.y + 0.35);
    const inAir = drop.object.getWorldPosition(new THREE.Vector3());
    const eye = inAir.clone().add(new THREE.Vector3(0, 0.5, 0));
    expect(notes.pick(eye, new THREE.Vector3(0, -1, 0))?.id).not.toBe(drop.id);
    expect(notes.near(inAir, 1)).not.toContain(drop);

    notes.sync(
      [],
      () => false,
      () => false,
    );
    expect(drop.object.visible).toBe(false);
    expect(drop.object.position.equals(home)).toBe(true);
    notes.tossFrom(actor);
    notes.sync(
      [],
      (room) => room === drop.room,
      () => false,
    );
    notes.update(viewer, 1.1);
    expect(drop.location.y).toBeCloseTo(home.y);
    expect(notes.near(drop.location, 0.05)).toContain(drop);
    const above = drop.location.clone().add(new THREE.Vector3(0, 1, 0));
    expect(notes.pick(above, new THREE.Vector3(0, -1, 0))?.id).toBe(drop.id);
    notes.tossFrom(actor);
    expect(drop.location.y).toBeCloseTo(home.y);
    notes.sync(
      [drop.id],
      () => true,
      () => false,
    );
    expect(drop.object.visible).toBe(false);
    notes.dispose();
    world.dispose();
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
    const beside = origin.clone().add(new THREE.Vector3(0.4, 0, 0));
    expect(notes.pick(beside, new THREE.Vector3(0, -1, 0))?.id).not.toBe(placement.id);
    notes.sync(
      [placement.id],
      () => true,
      () => true,
    );
    expect(notes.near(placement.location, 1)).not.toContain(placement);
    notes.dispose();
    world.dispose();
  });

  it('presents the letter upright and picks its corners from either side of an open chest', () => {
    const templates = GREYBOX_TEMPLATES.map((t) =>
      t.id === 'study' ? parseRoomTemplate(studyManifest) : t,
    );
    const world = buildFloorWorld(generateFloor('SPIRE002'), templates);
    const notes = new PressureNotes(world);
    const note = notes.placements.find((p) => p.source === 'chest');
    if (!note) throw new Error('missing chest letter');
    expect(note.object.parent?.scale.x).not.toBe(note.object.parent?.scale.y);
    const sheet = note.object.children.find((p) => p.userData.noteSurface);
    if (!sheet) throw new Error('missing printed paper');
    world.update(note.location.x, note.location.z);
    notes.sync(
      [],
      () => false,
      (room, id) => room === note.room && id === note.socketId,
    );
    const viewer = new THREE.Object3D();
    for (const approach of [
      [0.3, 0.35, -0.45],
      [-0.4, 0.14, 0.35],
    ]) {
      viewer.position.copy(note.location).add(new THREE.Vector3(...approach));
      notes.update(viewer);
      note.object.updateWorldMatrix(true, true);
      const towardEye = viewer.position.clone().sub(note.location).normalize();
      const normal = new THREE.Vector3(0, 0, 1).applyNormalMatrix(
        new THREE.Matrix3().getNormalMatrix(sheet.matrixWorld),
      );
      expect(normal.dot(towardEye)).toBeGreaterThan(0.999);
      const top = new THREE.Vector3(0, 1, 0).transformDirection(sheet.matrixWorld);
      expect(top.y).toBeGreaterThan(0);
      const corner = sheet.localToWorld(new THREE.Vector3(0.12, 0.08, 0));
      expect(notes.pick(viewer.position, corner.sub(viewer.position))?.id).toBe(note.id);
    }
    notes.dispose();
    world.dispose();
  });
});
