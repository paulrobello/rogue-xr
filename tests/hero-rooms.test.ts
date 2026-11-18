import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GREYBOX_TEMPLATES, type RoomTemplate } from '../src/content/rooms.ts';
import { generateFloor } from '../src/floor/generate.ts';
import { type FloorView, mountFloorView } from '../src/world/floor-view.ts';
import { buildFloorWorld, DOOR_HEIGHT } from '../src/world/floor-world.ts';
import { dressHeroRooms, fetchHeroRooms, loadHeroAssets } from '../src/world/hero-rooms.ts';
import {
  HERO_ROOMS,
  parseStudyManifest,
  rigidAngle,
  type StudyAsset,
  type StudyManifest,
} from '../src/world/study-room.ts';

/** SPIRE002 places all five baked templates and seals doors in the hall, corridor, gear-shaft and study. */
const SEED = 'SPIRE002';
const GEAR = 'gear-shaft_gear_ring';

const manifestOf = (id: string): StudyManifest =>
  parseStudyManifest(
    JSON.parse(
      readFileSync(join(process.cwd(), `public/assets/rooms/${id}/${id}.manifest.json`), 'utf8'),
    ),
  );
const MANIFESTS = new Map(HERO_ROOMS.map((id) => [id as string, manifestOf(id)]));

/** A stand-in asset: a model group named `<id>-model`, with the manifest's rigid nodes as children. */
function fakeAsset(manifest: StudyManifest): StudyAsset {
  return {
    manifest,
    textures: [],
    instantiate() {
      const model = new THREE.Group();
      model.name = `${manifest.template.id}-model`;
      for (const r of manifest.rigidNodes) {
        const node = new THREE.Object3D();
        node.name = r.node;
        model.add(node);
      }
      return model;
    },
    dispose() {},
  };
}

const fetchAll = (id: string): Promise<StudyManifest> =>
  Promise.resolve(MANIFESTS.get(id) as StudyManifest);

const roomsOf = (view: FloorView, id: string): number[] =>
  view.world.plan.rooms.flatMap((r, i) => (r.templateId === id ? [i] : []));

const greyboxOf = (id: string): RoomTemplate =>
  GREYBOX_TEMPLATES.find((t) => t.id === id) as RoomTemplate;

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => warn.mockRestore());

describe('hero room loading with missing assets', () => {
  it('keeps a room on its greybox when its manifest or model fails, and the run still starts', async () => {
    const set = await fetchHeroRooms(HERO_ROOMS, (id) =>
      id === 'hall' ? Promise.reject(new Error('404')) : fetchAll(id),
    );
    // The failed manifest: greybox template, never loaded.
    expect(set.templates.find((t) => t.id === 'hall')).toBe(greyboxOf('hall'));
    expect(set.manifests.map((m) => m.template.id).sort()).toEqual(
      ['corridor', 'gear-shaft', 'guardian-vault', 'study'].sort(),
    );
    // A loaded manifest swaps its baked template in (the gear-shaft's drive collider).
    expect(set.templates.find((t) => t.id === 'gear-shaft')).toBe(
      set.manifests.find((m) => m.template.id === 'gear-shaft')?.template,
    );

    const assets = await loadHeroAssets(set.manifests, (m) =>
      m.template.id === 'corridor'
        ? Promise.reject(new Error('bad glb'))
        : Promise.resolve(fakeAsset(m)),
    );
    expect(assets.map((a) => a.manifest.template.id).sort()).toEqual(
      ['gear-shaft', 'guardian-vault', 'study'].sort(),
    );

    const view = mountFloorView(new THREE.Scene(), new THREE.Group(), SEED, {
      templates: set.templates,
    });
    const dressed = dressHeroRooms(view, assets);
    const expected = ['gear-shaft', 'guardian-vault', 'study'].reduce(
      (n, id) => n + roomsOf(view, id).length,
      0,
    );
    expect(dressed).toBe(expected);
    for (const id of ['hall', 'corridor']) {
      const rooms = roomsOf(view, id);
      expect(rooms.length).toBeGreaterThan(0);
      for (const i of rooms) {
        const group = view.world.roomGroups[i] as THREE.Group;
        expect(group.getObjectByName('floor')).toBeDefined();
        expect(group.getObjectByName(`${id}-model`)).toBeUndefined();
      }
    }
    for (const id of ['gear-shaft', 'guardian-vault', 'study']) {
      for (const i of roomsOf(view, id)) {
        const group = view.world.roomGroups[i] as THREE.Group;
        expect(group.getObjectByName(`${id}-model`)).toBeDefined();
        expect(group.getObjectByName('floor')).toBeUndefined();
      }
    }
    // The run starts in the (greybox) entry hall.
    const spawn = view.world.spawnPoint();
    const entry = view.world.rooms[0]?.footprint;
    expect(spawn.x).toBeGreaterThan(entry?.min[0] ?? Number.NaN);
    expect(spawn.x).toBeLessThan(entry?.max[0] ?? Number.NaN);
    view.dispose();
  });

  it('builds the full greybox set when every manifest fails', async () => {
    const set = await fetchHeroRooms(HERO_ROOMS, () => Promise.reject(new Error('offline')));
    expect(set.manifests).toHaveLength(0);
    expect(set.templates).toBe(GREYBOX_TEMPLATES);
  });

  it('never loads a model whose layout disagrees with its greybox', async () => {
    const study = MANIFESTS.get('study') as StudyManifest;
    const moved = {
      ...study,
      template: { ...study.template, doors: study.template.doors.slice(1) },
    };
    const set = await fetchHeroRooms(['study'], () => Promise.resolve(moved));
    expect(set.manifests).toHaveLength(0);
    expect(set.templates).toBe(GREYBOX_TEMPLATES);
  });
});

describe('hero room lifecycle', () => {
  it('rebuilding the floor disposes the previous rooms and gear spinners', async () => {
    const set = await fetchHeroRooms(HERO_ROOMS, fetchAll);
    const assets = await loadHeroAssets(set.manifests, (m) => Promise.resolve(fakeAsset(m)));
    const scene = new THREE.Scene();
    const rig = new THREE.Group();
    scene.add(rig);
    const baseline = scene.children.length;
    const counts: { children: number; spinners: number }[] = [];
    let previous: FloorView | null = null;
    for (let run = 0; run < 3; run++) {
      previous?.dispose();
      if (previous) {
        expect(previous.spinnerCount).toBe(0);
        expect(scene.children.length).toBe(baseline);
      }
      const view = mountFloorView(scene, rig, SEED, { templates: set.templates });
      dressHeroRooms(view, assets);
      counts.push({ children: scene.children.length, spinners: view.spinnerCount });
      previous = view;
    }
    previous?.dispose();
    expect(scene.children.length).toBe(baseline);
    // One spinner per rigid node of each placed gear-shaft, and no growth across New Runs.
    const shafts = generateFloor(SEED).rooms.filter((r) => r.templateId === 'gear-shaft').length;
    const nodes = MANIFESTS.get('gear-shaft')?.rigidNodes.length ?? 0;
    expect(shafts).toBeGreaterThan(0);
    expect(nodes).toBeGreaterThan(1);
    expect(counts).toEqual(
      Array(3).fill({ children: counts[0]?.children, spinners: shafts * nodes }),
    );
  });
});

describe('gear-shaft crown gear spin', () => {
  it('wraps the angle to one turn and keeps its sign', () => {
    expect(rigidAngle(0.35, 2)).toBeCloseTo(0.7);
    expect(rigidAngle(Math.PI, 3)).toBeCloseTo(Math.PI);
    expect(rigidAngle(-1, 1)).toBeCloseTo(Math.PI * 2 - 1);
    expect(rigidAngle(0.35, 1e6)).toBeLessThan(Math.PI * 2);
  });

  async function shaftView(): Promise<{ view: FloorView; ring: THREE.Object3D; room: number }> {
    const set = await fetchHeroRooms(HERO_ROOMS, fetchAll);
    const assets = await loadHeroAssets(set.manifests, (m) => Promise.resolve(fakeAsset(m)));
    const view = mountFloorView(new THREE.Scene(), new THREE.Group(), SEED, {
      templates: set.templates,
    });
    dressHeroRooms(view, assets);
    const room = roomsOf(view, 'gear-shaft')[0] as number;
    const ring = view.world.roomGroups[room]?.getObjectByName(GEAR) as THREE.Object3D;
    return { view, ring, room };
  }

  /** The camera stands at the spawn, far from every automaton, so no fight starts. */
  function step(view: FloorView, frames: number, dt: number): void {
    const head = new THREE.Object3D();
    const at = view.world.spawnPoint();
    head.position.set(at.x, 1.6, at.z);
    head.updateMatrixWorld(true);
    for (let i = 0; i < frames; i++) view.update(head, dt);
  }

  it('turns at radPerSec about the manifest axis, independent of frame rate', async () => {
    const rate = (MANIFESTS.get('gear-shaft')?.rigidNodes[0]?.radPerSec ?? 0) as number;
    expect(rate).toBeGreaterThan(0);
    const a = await shaftView();
    const b = await shaftView();
    for (const v of [a, b]) (v.view.world.roomGroups[v.room] as THREE.Group).visible = true;
    step(a.view, 60, 1 / 30);
    step(b.view, 120, 1 / 60);
    expect(a.ring.quaternion.angleTo(b.ring.quaternion)).toBeLessThan(1e-6);
    const expected = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rate * 2);
    expect(a.ring.quaternion.angleTo(expected)).toBeLessThan(1e-6);
    // Every rigid node turns from the same clock at its own signed rate.
    const group = a.view.world.roomGroups[a.room] as THREE.Group;
    for (const r of MANIFESTS.get('gear-shaft')?.rigidNodes ?? []) {
      const node = group.getObjectByName(r.node) as THREE.Object3D;
      const want = new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(...r.axis).normalize(),
        rigidAngle(r.radPerSec, 2),
      );
      expect(node.quaternion.angleTo(want)).toBeLessThan(1e-6);
    }
    a.view.dispose();
    b.view.dispose();
  });

  it('holds still while its room is hidden, and stops for good once the floor is disposed', async () => {
    const { view, ring, room } = await shaftView();
    const group = view.world.roomGroups[room] as THREE.Group;
    group.visible = false;
    view.world.update = () => false; // keep the visibility this test set
    step(view, 30, 1 / 60);
    expect(ring.quaternion.equals(new THREE.Quaternion())).toBe(true);
    group.visible = true;
    step(view, 30, 1 / 60);
    const turned = ring.quaternion.clone();
    expect(turned.equals(new THREE.Quaternion())).toBe(false);
    view.dispose();
    expect(view.spinnerCount).toBe(0);
  });
});

describe('sealed doors', () => {
  const box = new THREE.Box3();
  const centre = new THREE.Vector3();
  const normal = new THREE.Vector3();

  for (const seed of ['SPIRE002', 'SPIRE003', 'SPIRE004', 'SPIRE006']) {
    it(`${seed}: fills only the doorway up to the lintel, on the wall line, facing into the room`, () => {
      const plan = generateFloor(seed);
      const world = buildFloorWorld(plan);
      world.group.updateMatrixWorld(true);
      expect(world.sealedDoors).toHaveLength(plan.sealed.length);
      for (const s of plan.sealed) {
        const door = world.rooms[s.room]?.doors.find((d) => d.id === s.door);
        const cap = world.group.getObjectByName(`sealed-${s.room}-${s.door}`) as THREE.Mesh;
        if (!door || !cap) throw new Error(`sealed ${s.room}/${s.door} missing`);
        box.setFromObject(cap);
        expect(box.min.y).toBeCloseTo(0, 6);
        expect(box.max.y).toBeCloseTo(DOOR_HEIGHT, 6);
        const ew = door.facing === 'E' || door.facing === 'W';
        const [along, across] = ew ? (['z', 'x'] as const) : (['x', 'z'] as const);
        expect(box.max[along] - box.min[along]).toBeCloseTo(door.width, 6);
        // Flat on the wall line: nothing proud of the wall into the room or behind it.
        expect(box.max[across] - box.min[across]).toBeCloseTo(0, 6);
        expect(box.getCenter(centre)[across]).toBeCloseTo(ew ? door.world[0] : door.world[1], 6);
        // The visible side faces the room's centre.
        const fp = world.rooms[s.room]?.footprint;
        if (!fp) throw new Error('no footprint');
        const toCentre = new THREE.Vector3(
          (fp.min[0] + fp.max[0]) / 2 - door.world[0],
          0,
          (fp.min[1] + fp.max[1]) / 2 - door.world[1],
        );
        normal.set(0, 0, 1).applyQuaternion(cap.getWorldQuaternion(new THREE.Quaternion()));
        expect(normal.dot(toCentre)).toBeGreaterThan(0);
        // The greybox fill closes the wall above a boarded door's lintel, or the whole gap of a
        // wall-style door, on the room side of the line.
        const boarded = s.style === 'boarded';
        const fill = world.group.getObjectByName(
          `${boarded ? 'lintel-fill' : 'door-fill'}-${s.room}-${s.door}`,
        ) as THREE.Mesh;
        box.setFromObject(fill);
        expect(box.min.y).toBeCloseTo(boarded ? DOOR_HEIGHT : 0, 6);
        expect(box.max.y).toBeCloseTo(4, 6);
        const inward = normal[across];
        const line = ew ? door.world[0] : door.world[1];
        expect(inward > 0 ? box.min[across] : box.max[across]).toBeCloseTo(line, 6);
        expect(fill.parent).toBe(world.roomGroups[s.room]);
      }
      world.dispose();
    });
  }

  it('a dressed room drops the greybox fill and keeps the door leaf, which takes the room material', () => {
    const plan = generateFloor(SEED);
    const world = buildFloorWorld(plan);
    const s = plan.sealed[0];
    if (!s) throw new Error('no sealed door');
    world.dressRoom(s.room, new THREE.Group());
    const group = world.roomGroups[s.room] as THREE.Group;
    expect(group.getObjectByName(`lintel-fill-${s.room}-${s.door}`)).toBeUndefined();
    const cap = group.getObjectByName(`sealed-${s.room}-${s.door}`) as THREE.Mesh;
    expect(cap).toBeDefined();
    const walnut = new THREE.MeshStandardMaterial();
    world.dressSealedDoors(walnut, 0.5);
    expect(world.sealedDoors.every((c) => c.material === walnut)).toBe(true);
    // One texture tile per 0.5 m: the 1.6 x 2.4 m leaf spans 3.2 x 4.8 tiles.
    const uv = cap.geometry.getAttribute('uv') as THREE.BufferAttribute;
    const us = Array.from({ length: uv.count }, (_, i) => uv.getX(i));
    const vs = Array.from({ length: uv.count }, (_, i) => uv.getY(i));
    expect(Math.max(...us) - Math.min(...us)).toBeCloseTo(3.2, 5);
    expect(Math.max(...vs) - Math.min(...vs)).toBeCloseTo(4.8, 5);
    world.dispose();
  });
});
