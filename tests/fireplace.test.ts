import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { describe, expect, it } from 'vitest';
import { generateFloor } from '../src/floor/generate.ts';
import {
  buildFireplaceFire,
  dressFireplace,
  FIRE_NODE,
  FIREBOXES,
  type Firebox,
  fireboxBounds,
  fireboxMatrix,
  stripBakedFire,
} from '../src/world/fireplace.ts';
import { mountFloorView } from '../src/world/floor-view.ts';
import {
  FLAME_KIND,
  type FlameQuad,
  fireboxFlameGeometry,
  fireboxFlameQuads,
  flameMaterial,
  flameReach,
} from '../src/world/hearth-coals.ts';
import { flameSlot } from '../src/world/study-room.ts';

const HALL = FIREBOXES.hall as Firebox;
const EPS = 1e-6;

/** Positions and index of the hall GLB's `hall_flame` primitive, read straight from the file. */
function hallFlameGeometry(): THREE.BufferGeometry {
  const bytes = readFileSync(join(process.cwd(), 'public/assets/rooms/hall/hall.glb'));
  const jsonLength = bytes.readUInt32LE(12);
  const gltf = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString('utf8')) as {
    materials: { name: string }[];
    meshes: {
      primitives: { material: number; indices: number; attributes: { POSITION: number } }[];
    }[];
    accessors: {
      bufferView: number;
      byteOffset?: number;
      componentType: number;
      count: number;
      type: string;
    }[];
    bufferViews: { byteOffset?: number; byteStride?: number }[];
  };
  const bin = 20 + jsonLength + 8;
  const read = (index: number): number[] => {
    const a = gltf.accessors[index];
    if (!a) throw new Error(`accessor ${index}`);
    const view = gltf.bufferViews[a.bufferView] ?? {};
    const parts = a.type === 'VEC3' ? 3 : 1;
    const size = a.componentType === 5126 || a.componentType === 5125 ? 4 : 2;
    const stride = view.byteStride ?? size * parts;
    const start = bin + (view.byteOffset ?? 0) + (a.byteOffset ?? 0);
    const out: number[] = [];
    for (let i = 0; i < a.count; i++) {
      for (let p = 0; p < parts; p++) {
        const at = start + i * stride + p * size;
        out.push(
          a.componentType === 5126
            ? bytes.readFloatLE(at)
            : a.componentType === 5125
              ? bytes.readUInt32LE(at)
              : bytes.readUInt16LE(at),
        );
      }
    }
    return out;
  };
  const flame = gltf.materials.findIndex((m) => m.name === 'hall_flame');
  const primitive = gltf.meshes.flatMap((m) => m.primitives).find((p) => p.material === flame);
  if (!primitive) throw new Error('hall.glb has no hall_flame primitive');
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(read(primitive.attributes.POSITION), 3),
  );
  geometry.setIndex(read(primitive.indices));
  return geometry;
}

const triangles = (g: THREE.BufferGeometry): number => (g.index?.count ?? 0) / 3;

/** The local firebox box, shrunk by `margin` so touching a wall counts as poking through. */
const localBox = (f: Firebox, margin = 0): THREE.Box3 =>
  new THREE.Box3(
    new THREE.Vector3(-f.halfWidth + margin, 0, f.back),
    new THREE.Vector3(f.halfWidth - margin, f.height - margin, f.front - margin),
  );

describe('the firebox fire geometry', () => {
  const quads = fireboxFlameQuads('hall', HALL);

  it('is the same fire on every load and differs by key', () => {
    const a = fireboxFlameGeometry('hall', HALL);
    const b = fireboxFlameGeometry('hall', HALL);
    const c = fireboxFlameGeometry('other', HALL);
    const array = (g: THREE.BufferGeometry, name: string): number[] =>
      Array.from((g.attributes[name] as THREE.BufferAttribute).array);
    expect(array(a, 'position')).toEqual(array(b, 'position'));
    expect(array(a, 'params')).toEqual(array(b, 'params'));
    expect(array(a, 'position')).not.toEqual(array(c, 'position'));
    for (const g of [a, b, c]) g.dispose();
  });

  it('holds several crossed tongues, an ember bed, a back glow and a few sparks', () => {
    const count = (kind: number): number => quads.filter((q) => q.kind === kind).length;
    expect(count(FLAME_KIND.cardX)).toBeGreaterThanOrEqual(6);
    expect(count(FLAME_KIND.cardZ)).toBeGreaterThanOrEqual(6);
    expect(count(FLAME_KIND.bed)).toBe(1);
    expect(count(FLAME_KIND.backGlow)).toBe(1);
    expect(count(FLAME_KIND.spark)).toBeGreaterThanOrEqual(6);
    const heights = quads.filter((q) => q.kind === FLAME_KIND.cardX).map((q) => q.height);
    // Tongues vary: the tallest at least twice the shortest.
    expect(Math.max(...heights)).toBeGreaterThan(2 * Math.min(...heights));
  });

  it('stays inside the opening at the top of its animation, clear of the lintel and the walls', () => {
    const reach = flameReach(quads);
    const inside = localBox(HALL, 0.005);
    expect(inside.containsBox(reach)).toBe(true);
    // Tongues top out 0.1 m under the 0.8 m lintel.
    expect(reach.max.y).toBeLessThanOrEqual(0.7 + EPS);
    // Each quad on its own, so one wide quad cannot hide another poking out.
    for (const q of quads) expect(inside.containsBox(flameReach([q as FlameQuad]))).toBe(true);
  });

  it('bounds its animated reach, so the fire culls with its room rather than never', () => {
    const geometry = fireboxFlameGeometry('hall', HALL);
    const sphere = geometry.boundingSphere as THREE.Sphere;
    const reach = flameReach(quads);
    for (const corner of [reach.min, reach.max])
      expect(sphere.distanceToPoint(corner)).toBeLessThanOrEqual(EPS);
    geometry.dispose();
  });
});

describe('the flame material', () => {
  it('keeps the hearth defaults and lets a fire soften its motion', () => {
    const hearth = flameMaterial();
    expect(hearth.uniforms.uMotion?.value).toBe(1);
    expect(hearth.uniforms.uFade?.value).toBe(1);
    expect((hearth.uniforms.uCore as THREE.IUniform<THREE.Color>).value.getHexString()).toBe(
      new THREE.Color('#ffd27a').getHexString(),
    );
    expect(hearth.blending).toBe(THREE.AdditiveBlending);
    expect(hearth.depthWrite).toBe(false);
    expect(hearth.toneMapped).toBe(false);
    const calm = buildFireplaceFire('hall', HALL, true);
    expect(calm.material.uniforms.uMotion?.value).toBeLessThan(0.5);
    const lively = buildFireplaceFire('hall', HALL, false);
    expect(lively.material.uniforms.uMotion?.value).toBe(1);
    hearth.dispose();
    calm.dispose();
    lively.dispose();
  });
});

describe('replacing the hall fire', () => {
  it('drops exactly the eight firebox triangles of the baked flame slot, keeping the candles', () => {
    const geometry = hallFlameGeometry();
    expect(triangles(geometry)).toBe(56);
    const flame = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ name: 'hall_flame' }));
    const root = new THREE.Group();
    root.add(flame);
    expect(stripBakedFire(root, fireboxBounds(HALL), flameSlot)).toBe(8);
    expect(flame.visible).toBe(true);
    expect(triangles(flame.geometry)).toBe(48);
    // The source geometry is untouched, so other holders of it keep the full fire.
    expect(triangles(geometry)).toBe(56);
    // What remains is the hall's candles, every one well above the firebox.
    flame.geometry.computeBoundingBox();
    const position = flame.geometry.getAttribute('position') as THREE.BufferAttribute;
    const index = flame.geometry.index as THREE.BufferAttribute;
    let lowest = Number.POSITIVE_INFINITY;
    for (let i = 0; i < index.count; i++) lowest = Math.min(lowest, position.getY(index.getX(i)));
    expect(lowest).toBeGreaterThan(1.5);
  });

  it('leaves other slots in the firebox alone and hides a flame mesh left empty', () => {
    const inBox = (): THREE.BufferGeometry => {
      const g = new THREE.PlaneGeometry(0.2, 0.2);
      g.translate(-3.55, 0.3, -4.75);
      return g;
    };
    const root = new THREE.Group();
    const logs = new THREE.Mesh(inBox(), new THREE.MeshStandardMaterial({ name: 'hall_walnut' }));
    const tips = new THREE.Mesh(
      inBox(),
      new THREE.MeshStandardMaterial({ name: 'hall_tip_flame' }),
    );
    const candle = new THREE.Mesh(
      new THREE.PlaneGeometry(0.05, 0.1).translate(-4.8, 1.8, -4.8),
      new THREE.MeshStandardMaterial({ name: 'hall_hot_flame' }),
    );
    root.add(logs, tips, candle);
    expect(stripBakedFire(root, fireboxBounds(HALL), flameSlot)).toBe(2);
    expect(logs.visible).toBe(true);
    expect(triangles(logs.geometry)).toBe(2);
    expect(tips.visible).toBe(false);
    expect(candle.visible).toBe(true);
    expect(triangles(candle.geometry)).toBe(2);
  });

  it('adds one fire mesh, one draw call, in the firebox of a template with a fireplace only', () => {
    const model = new THREE.Group();
    const fire = dressFireplace('hall', model, flameSlot);
    expect(fire).not.toBeNull();
    const meshes = model.children.filter((c) => (c as THREE.Mesh).isMesh);
    expect(meshes.map((m) => m.name)).toEqual([FIRE_NODE]);
    const mesh = meshes[0] as THREE.Mesh;
    expect(Array.isArray(mesh.material)).toBe(false);
    expect(mesh.castShadow).toBe(false);
    expect(mesh.frustumCulled).toBe(true);
    expect(dressFireplace('study', new THREE.Group(), flameSlot)).toBeNull();
    fire?.dispose();
  });

  it('lands the fire in the firebox for every room rotation', () => {
    const quads = fireboxFlameQuads('hall', HALL);
    const reach = flameReach(quads);
    const corners = [0, 1, 2, 3, 4, 5, 6, 7].map(
      (i) =>
        new THREE.Vector3(
          i & 1 ? reach.max.x : reach.min.x,
          i & 2 ? reach.max.y : reach.min.y,
          i & 4 ? reach.max.z : reach.min.z,
        ),
    );
    const box = fireboxBounds(HALL);
    const toTemplate = fireboxMatrix(HALL);
    for (const turns of [0, 1, 2, 3]) {
      const room = new THREE.Group();
      room.position.set(12, 0, -24);
      room.rotation.y = (-Math.PI / 2) * turns;
      const model = new THREE.Group();
      room.add(model);
      const fire = dressFireplace('hall', model, flameSlot);
      if (!fire) throw new Error('hall has a fireplace');
      room.updateMatrixWorld(true);
      const toRoomLocal = room.matrixWorld.clone().invert();
      // The fire sits at the firebox centre in template space, whatever the room's turn.
      const centre = fire.mesh.getWorldPosition(new THREE.Vector3()).applyMatrix4(toRoomLocal);
      expect(centre.distanceTo(new THREE.Vector3(...HALL.centre))).toBeLessThan(EPS);
      for (const corner of corners) {
        const world = corner.clone().applyMatrix4(fire.mesh.matrixWorld);
        expect(box.containsPoint(world.applyMatrix4(toRoomLocal))).toBe(true);
        // And the same point through the firebox frame directly.
        const direct = corner.clone().applyMatrix4(toTemplate);
        expect(direct.distanceTo(corner.clone().applyMatrix4(fire.mesh.matrix))).toBeLessThan(EPS);
      }
      fire.dispose();
    }
  });

  it('runs on the floor clock only while the hall shows', () => {
    const scene = new THREE.Scene();
    const rig = new THREE.Group();
    const view = mountFloorView(scene, rig, 'SPIRE002');
    const halls = view.world.plan.rooms.filter((r) => r.templateId === 'hall').length;
    expect(halls).toBeGreaterThan(0);
    const fires: ReturnType<typeof buildFireplaceFire>[] = [];
    const dressed = view.useRoomAsset('hall', () => {
      const model = new THREE.Group();
      const fire = dressFireplace('hall', model, flameSlot);
      if (fire) fires.push(fire);
      return model;
    });
    expect(dressed).toBe(halls);
    const head = new THREE.Object3D();
    const entry = view.world.roomGroups[0];
    if (!entry) throw new Error('room 0');
    entry.visible = true;
    view.update(head, 0.5);
    // Room 0 of SPIRE002 is the hall: its fire took the floor clock.
    expect(fires[0]?.material.uniforms.uTime?.value).toBeCloseTo(0.5, 6);
    for (const group of view.world.roomGroups) group.visible = false;
    for (const f of fires) (f.material.uniforms.uTime as THREE.IUniform<number>).value = -1;
    view.update(head, 0.5);
    // Hidden halls hold still.
    for (const f of fires) expect(f.material.uniforms.uTime?.value).toBe(-1);
    view.dispose();
    for (const f of fires) f.dispose();
    expect(generateFloor('SPIRE002').rooms[0]?.templateId).toBe('hall');
  });
});

describe('replacing the gear-shaft furnaces', () => {
  it('uses all four authored openings and keeps coals and the live fire bounded', async () => {
    const bytes = readFileSync(
      join(process.cwd(), 'public/assets/rooms/gear-shaft/gear-shaft.glb'),
    );
    const gltf = await new Promise<{ scene: THREE.Object3D }>((resolve, reject) => {
      const start = bytes.byteOffset;
      new GLTFLoader().parse(
        bytes.buffer.slice(start, start + bytes.byteLength),
        '',
        resolve,
        reject,
      );
    });
    const flameMeshes: THREE.Mesh[] = [];
    const coalMeshes: THREE.Mesh[] = [];
    gltf.scene.traverse((node) => {
      const mesh = node as THREE.Mesh;
      if (!mesh.isMesh || Array.isArray(mesh.material)) return;
      if (mesh.material.name.endsWith('_flame')) flameMeshes.push(mesh);
      if (mesh.material.name.endsWith('_coals')) coalMeshes.push(mesh);
    });
    expect(flameMeshes.length).toBeGreaterThan(0);
    expect(coalMeshes.length).toBeGreaterThan(0);
    const beforeCoals = coalMeshes.map((mesh) => mesh.visible);
    const fire = dressFireplace('gear-shaft', gltf.scene, flameSlot);
    expect(fire).not.toBeNull();
    expect(gltf.scene.getObjectsByProperty('name', FIRE_NODE)).toHaveLength(4);
    expect(fire?.extras).toHaveLength(3);
    expect(beforeCoals.every((visible, i) => visible === coalMeshes[i]?.visible)).toBe(true);
    const boxes = (FIREBOXES['gear-shaft'] as readonly Firebox[]).map(fireboxBounds);
    for (const mesh of flameMeshes) {
      const positions = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
      const index = mesh.geometry.index;
      const toRoot = gltf.scene.matrixWorld.clone().invert().multiply(mesh.matrixWorld);
      for (let i = 0; i < (index?.count ?? 0); i += 3) {
        const centroid = new THREE.Vector3();
        for (let j = 0; j < 3; j++) {
          const vertex = new THREE.Vector3().fromBufferAttribute(
            positions,
            index?.getX(i + j) ?? 0,
          );
          centroid.add(vertex);
        }
        centroid.multiplyScalar(1 / 3).applyMatrix4(toRoot);
        expect(boxes.some((box) => box.containsPoint(centroid))).toBe(false);
      }
    }
    expect(fire?.mesh.geometry.boundingSphere?.radius ?? 0).toBeGreaterThan(0);
    expect(fire?.mesh.geometry.boundingSphere?.radius).toBeLessThan(0.8);
    fire?.dispose();
  });

  it('keeps every furnace fire inside its opening for all room rotations', () => {
    const configured = FIREBOXES['gear-shaft'];
    expect(Array.isArray(configured)).toBe(true);
    const fireboxes = configured as readonly Firebox[];
    expect(fireboxes).toHaveLength(4);
    for (const turns of [0, 1, 2, 3]) {
      const room = new THREE.Group();
      room.rotation.y = (-Math.PI / 2) * turns;
      const model = new THREE.Group();
      room.add(model);
      const fire = dressFireplace('gear-shaft', model, flameSlot);
      if (!fire) throw new Error('gear-shaft has furnaces');
      room.updateMatrixWorld(true);
      const toRoomLocal = room.matrixWorld.clone().invert();
      const bounds = fireboxes.map((firebox) => fireboxBounds(firebox));
      for (const mesh of [fire.mesh, ...(fire.extras ?? [])]) {
        const points = mesh.geometry.getAttribute('position');
        for (let i = 0; i < points.count; i++) {
          const point = new THREE.Vector3()
            .fromBufferAttribute(points, i)
            .applyMatrix4(mesh.matrixWorld)
            .applyMatrix4(toRoomLocal);
          expect(bounds.some((box) => box.containsPoint(point))).toBe(true);
        }
      }
      fire.dispose();
    }
  });
});
