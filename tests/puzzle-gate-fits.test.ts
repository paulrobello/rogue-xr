// @vitest-environment node
import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { expect, it } from 'vitest';
import { SteamPuffs } from '../src/combat-view/steam-puffs.ts';
import { templateById } from '../src/content/rooms.ts';
import { generateFloor } from '../src/floor/generate.ts';
import { playableFloorPlan } from '../src/world/floor-view.ts';
import { buildFloorWorld } from '../src/world/floor-world.ts';
import { PuzzleGateVisual } from '../src/world/puzzle-gates.ts';
import { ServicePanels } from '../src/world/service-panels.ts';
import { nodeGeometryLoader } from './helpers/gltf-node.ts';

async function loadArt(path: string): Promise<THREE.Group> {
  const bytes = await readFile(`public/assets/${path}.glb`);
  return (
    await nodeGeometryLoader().parseAsync(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      '',
    )
  ).scene;
}

function hits(
  root: THREE.Object3D,
  origin: THREE.Vector3,
  direction: THREE.Vector3,
): THREE.Intersection[] {
  root.updateWorldMatrix(true, true);
  const drawn: THREE.Mesh[] = [];
  root.traverseVisible((child) => {
    if (child instanceof THREE.Mesh) drawn.push(child);
  });
  const ray = new THREE.Raycaster(
    root.localToWorld(origin),
    direction.transformDirection(root.matrixWorld),
    0,
    3,
  );
  return ray.intersectObjects(drawn, false);
}

it.each(['pressure', 'counterweight'] as const)(
  'seats the %s gate and retracts the entire leaf between the floors',
  (kind) => {
    const world = buildFloorWorld(playableFloorPlan('MAPTEST2', 6, 1));
    const edge = world.plan.connections.find((e) => e.puzzleGate === kind);
    if (!edge) throw Error('Missing showcase gate connection');
    const door = world.rooms[edge[0].room].doors.find((d) => d.id === edge[0].door);
    if (!door) throw Error('Missing showcase gate doorway');
    const gateAt = new THREE.Vector3(door.world[0], 0, door.world[1]);
    const gate = world.roomGroups[edge[0].room]
      .getObjectsByProperty('name', `puzzle-gate-${kind}`)
      .find((object) => object.getWorldPosition(new THREE.Vector3()).distanceTo(gateAt) < 1e-5);
    if (!gate) throw Error('Missing showcase gate');
    const leaf = gate.getObjectByName(
      kind === 'pressure' ? 'pressure-door-panel' : 'counterweight-grille',
    );
    if (!leaf) throw Error('Missing gate leaf');
    for (const [side, room] of [
      [1, edge[0].room],
      [-1, edge[1].room],
    ]) {
      const { min, max } = world.rooms[room].footprint;
      world.update((min[0] + max[0]) / 2, (min[1] + max[1]) / 2);
      const axis = new THREE.Vector3(0, 0, -side);
      for (const x of kind === 'pressure' ? [-0.69, 0.12, 0.69] : [-0.705, 0.423, 0.705]) {
        for (const y of [0.065, 1.64, 2.305, 2.385])
          expect(hits(leaf, new THREE.Vector3(x, y, side), axis.clone()).length).toBeGreaterThan(0);
      }
      expect(
        world.pickPuzzleGate(
          gate.localToWorld(new THREE.Vector3(0, 1.05, side)),
          axis.transformDirection(gate.matrixWorld),
        )?.kind,
      ).toBe(kind);
    }
    const bounds = new THREE.Box3();
    const steel = new THREE.MeshStandardMaterial({
      map: new THREE.Texture(),
      normalMap: new THREE.Texture(),
    });
    const brass = steel.clone(),
      environment = new THREE.Texture();
    world.dressPuzzleGates(
      {
        materials: new Map([
          ['brass-aged', steel],
          ['brass-polished', brass],
        ]),
        manifest: {},
      },
      environment,
    );
    leaf.traverse((n) => {
      if (n instanceof THREE.Mesh) {
        expect(n.material.map).toBe(steel.map);
        expect(n.material.normalMap).toBe(steel.normalMap);
        expect(n.material.envMap).toBe(environment);
      }
    });
    world.setPuzzleGateOpen(kind, true);
    world.updateAnimations(0.1);
    expect(bounds.setFromObject(leaf).max.y).toBeGreaterThan(0);
    expect(bounds.max.y).toBeLessThan(2);
    for (let i = 0; i < 100; i++) world.updateAnimations(1 / 60);
    expect(bounds.setFromObject(leaf).max.y).toBeLessThan(0);
    for (const side of [-1, 1])
      for (const x of [-0.735, 0, 0.735])
        for (const y of [0.05, 1.15, 2.35, 2.65, 3.2])
          expect(
            hits(gate, new THREE.Vector3(x, y, side), new THREE.Vector3(0, 0, -side)),
          ).toHaveLength(0);
    world.setPuzzleGateOpen(kind, false, true);
    expect(
      hits(gate, new THREE.Vector3(0, 1.05, 1), new THREE.Vector3(0, 0, -1)).length,
    ).toBeGreaterThan(0);
    world.dispose();
  },
);

it('vents a short burst from both faces when the locked pressure door panel is clicked', () => {
  const world = buildFloorWorld(playableFloorPlan('MAPTEST2', 6, 1));
  const gate = world.group.getObjectByName('puzzle-gate-pressure');
  const edge = world.plan.connections.find((c) => c.puzzleGate === 'pressure');
  const steam = gate?.getObjectByName('pressure-gate-steam');
  if (!gate || !edge || !(steam instanceof SteamPuffs))
    throw Error('Missing pressure door or steam');
  expect(steam.visible).toBe(false);
  expect(
    world.group.getObjectByName('puzzle-gate-counterweight')?.getObjectByName(steam.name),
  ).toBeUndefined();
  for (const [side, room] of [
    [1, edge[0].room],
    [-1, edge[1].room],
  ]) {
    const { min, max } = world.rooms[room].footprint;
    world.update((min[0] + max[0]) / 2, (min[1] + max[1]) / 2);
    const at = gate.localToWorld(new THREE.Vector3(0.4, 1.42, side));
    const direction = new THREE.Vector3(0, 0, -side).transformDirection(gate.matrixWorld);
    const hit = world.pickPuzzleGate(at, direction);
    expect(hit?.kind).toBe('pressure');
    if (!hit) throw Error('Missing pressure door hit');
    world.rattlePuzzleGate(hit.kind);
    expect(steam.visible).toBe(true);
    const firstSize = steam.puffData[3];
    world.updateAnimations(0.28);
    for (let i = 0; i < 6; i++) {
      expect(steam.lookData[i * 2]).toBeGreaterThan(0);
      expect(steam.puffData[i * 4 + 2] * (i % 2 ? -1 : 1)).toBeGreaterThan(0.15);
    }
    expect(steam.puffData[3]).toBeGreaterThan(firstSize);
    world.updateAnimations(0.6);
    expect(steam.visible).toBe(false);
  }
  world.rattlePuzzleGate('pressure');
  world.setPuzzleGateOpen('pressure', true);
  expect(steam.visible).toBe(false);
  expect(world.rattlePuzzleGate('pressure')).toBeUndefined();
  expect(steam.visible).toBe(false);
  world.dispose();
});

it('keeps the reduced-motion steam hint still while it fades', () => {
  const door = new PuzzleGateVisual('pressure', 1.6, 2.4);
  const steam = door.object.getObjectByName('pressure-gate-steam');
  if (!(steam instanceof SteamPuffs)) throw Error('Missing pressure steam');
  door.rattle(true);
  const pose = steam.puffData.slice();
  const alpha = steam.lookData[0];
  door.update(0.25);
  expect(door.pickTarget.position.x).toBe(0);
  expect(steam.puffData).toEqual(pose);
  expect(steam.lookData[0]).toBeLessThan(alpha);
  expect(steam.visible).toBe(true);
  door.update(0.4);
  expect(steam.visible).toBe(false);
  door.dispose();
});

it.each(['hall', 'corridor', 'study', 'guardian-vault', 'gear-shaft'])(
  'draws a single surface on every baked %s jamb and lintel',
  async (id) => {
    let plan = generateFloor('MAPTEST2');
    for (let n = 0; !plan.rooms.some((r) => r.templateId === id) && n < 100; n++)
      plan = generateFloor(`GK${String(n).padStart(6, '0')}`);
    const room = plan.rooms.findIndex((r) => r.templateId === id);
    expect(room).toBeGreaterThanOrEqual(0);
    const world = buildFloorWorld(plan);
    const model = await loadArt(`rooms/${id}/${id}`);
    world.dressRoom(room, model);
    model.updateWorldMatrix(true, true);
    for (const door of templateById(id).doors) {
      const frame = model.getObjectByName(`door-frame-${door.id}`);
      if (!frame) throw Error('Missing baked door frame');
      const [x, , z] = door.position;
      const dx = { N: 0, S: 0, E: -1, W: 1 }[door.facing],
        dz = { N: 1, S: -1, E: 0, W: 0 }[door.facing];
      for (const depth of [0.009, 0.028, 0.043])
        for (const side of [-1, 0, 1]) {
          const origin = new THREE.Vector3(x + depth * dx, side ? 1.613 : 2, z + depth * dz);
          const direction = side
            ? new THREE.Vector3(dz * side, 0, -dx * side)
            : new THREE.Vector3(0, 1, 0);
          const ray = new THREE.Raycaster(
            model.localToWorld(origin),
            direction.transformDirection(model.matrixWorld),
            0,
            1,
          );
          const contacts = ray
            .intersectObject(frame, true)
            .filter((hit) => Math.abs(hit.distance - (side ? 0.8 : 0.4)) < 0.001);
          expect(contacts, `${id}/${door.id} depth=${depth} side=${side}`).toHaveLength(1);
        }
    }
    world.dispose();
  },
);

it('seats the service-panel frame inside the architectural opening with a distinct reveal on all three edges', async () => {
  const world = buildFloorWorld(playableFloorPlan('MAPTEST3', 6, 2));
  const panels = new ServicePanels(world, await loadArt('props/panel-kit/panel-kit'), true);
  const architecture = await loadArt('props/architectural-finishes/architectural-finishes');
  const boiler = architecture.getObjectByName('BoilerDoor');
  const { root } = panels.panel,
    frame = root.getObjectByName('PanelFrame');
  if (!frame || !boiler) throw Error('Missing service or architectural frame');
  for (const side of [-1, 0, 1]) {
    const origin = new THREE.Vector3(0, side ? 1.613 : 2, 0);
    const direction = side ? new THREE.Vector3(side, 0, 0) : new THREE.Vector3(0, 1, 0);
    const hit = hits(frame, origin.clone(), direction.clone())[0];
    expect(hit).toBeDefined();
    const at = root.worldToLocal(hit.point);
    expect(side ? Math.abs(at.x) : at.y).toBeCloseTo(side ? 0.79 : 2.39, 4);
    for (const depth of [0.0095, 0.0105, 0.0115, 0.0125, 0.06]) {
      const from = origin.clone();
      from.z = depth;
      const contacts = hits(boiler, from, direction.clone()).filter(
        (h) => Math.abs(h.distance - (side ? 0.8 : 0.4)) < 0.0001,
      );
      expect(contacts, `boiler depth=${depth} side=${side}`).toHaveLength(1);
    }
  }
  panels.dispose();
  world.dispose();
});
