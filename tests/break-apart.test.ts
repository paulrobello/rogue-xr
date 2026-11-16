// @vitest-environment node
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { describe, expect, it } from 'vitest';
import { Stream } from '../src/core/rng.ts';
import {
  BreakApart,
  type BreakApartOptions,
  type Burst,
  lowestPoint,
  STEP,
} from '../src/enemies/break-apart.ts';
import { parseEnemyAsset, parseEnemyManifest } from '../src/enemies/enemy-asset.ts';

/** A box spanning y0..y0+1 whose vertices all ride `bone` (in skin slot `slot`). */
function boneBox(y0: number, bone: number, slot = 0): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(0.4, 1, 0.3).translate(0, y0 + 0.5, 0);
  const n = g.getAttribute('position').count;
  const index = new Uint16Array(n * 4);
  const weight = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    index[i * 4 + slot] = bone;
    weight[i * 4 + slot] = 1;
  }
  g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(index, 4));
  g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(weight, 4));
  return g;
}

interface Rig {
  root: THREE.Group;
  meshes: THREE.SkinnedMesh[];
  bones: THREE.Bone[];
}

/**
 * Three stacked boxes on a three-bone chain (root, a at y 1, b at y 2) in mesh 0, plus a second
 * mesh (another material, the glow) riding bone a. Bone b's box uses skin slot 1.
 */
function buildRig(): Rig {
  const root = new THREE.Group();
  root.name = 'rig';
  const bones = ['root', 'a', 'b'].map((name) => Object.assign(new THREE.Bone(), { name }));
  const [b0, b1, b2] = bones as [THREE.Bone, THREE.Bone, THREE.Bone];
  b1.position.y = 1;
  b2.position.y = 1;
  b0.add(b1);
  b1.add(b2);
  root.add(b0);
  const body = mergeGeometries([boneBox(0, 0), boneBox(1, 1), boneBox(2, 2, 1)]);
  const glowGeometry = boneBox(1, 1).scale(0.5, 0.5, 1.5);
  const position = glowGeometry.getAttribute('position');
  const island = new Float32Array(position.count * 4);
  for (let i = 0; i < position.count; i++) {
    island.set([position.getX(i), position.getY(i), position.getZ(i), 0.1], i * 4);
  }
  glowGeometry.setAttribute('glowIsland', new THREE.BufferAttribute(island, 4));
  const metal = new THREE.MeshStandardMaterial({ name: 'brass-polished' });
  const glow = new THREE.MeshStandardMaterial({ name: 'glow' });
  const meshes = [new THREE.SkinnedMesh(body, metal), new THREE.SkinnedMesh(glowGeometry, glow)];
  const skeleton = new THREE.Skeleton(bones);
  root.updateMatrixWorld(true);
  for (const mesh of meshes) {
    root.add(mesh);
    mesh.updateMatrixWorld(true);
    mesh.bind(skeleton, mesh.matrixWorld);
  }
  return { root, meshes, bones };
}

/** Poses the rig the way a death clip might: moved, turned, and bent at both joints. */
function pose(rig: Rig): void {
  rig.root.position.set(2, 0.5, -1);
  rig.root.rotation.y = 0.7;
  (rig.bones[1] as THREE.Bone).rotation.z = 0.9;
  (rig.bones[2] as THREE.Bone).rotation.x = -0.6;
  rig.root.updateMatrixWorld(true);
}

const QUIET: Partial<BreakApartOptions> = { cogs: 0, sparks: 0 };

function sortedPoints(points: THREE.Vector3[]): number[][] {
  return points
    .map((p) => [p.x, p.y, p.z])
    .sort(
      (a, b) =>
        (a[0] as number) - (b[0] as number) ||
        (a[1] as number) - (b[1] as number) ||
        (a[2] as number) - (b[2] as number),
    );
}

function expectClose(actual: number[][], expected: number[][]): void {
  expect(actual.length).toBe(expected.length);
  actual.forEach((row, i) => {
    row.forEach((value, k) => {
      expect(value).toBeCloseTo((expected[i] as number[])[k] as number, 5);
    });
  });
}

/** World positions of the posed skinned vertices riding `boneName`. */
function skinnedWorld(rig: Rig, boneName: string): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  for (const mesh of rig.meshes) {
    const skinIndex = mesh.geometry.getAttribute('skinIndex');
    const skinWeight = mesh.geometry.getAttribute('skinWeight');
    const count = mesh.geometry.getAttribute('position').count;
    for (let i = 0; i < count; i++) {
      let slot = 0;
      for (let k = 1; k < 4; k++)
        if (skinWeight.getComponent(i, k) > skinWeight.getComponent(i, slot)) slot = k;
      const bone = mesh.skeleton.bones[skinIndex.getComponent(i, slot)];
      if (bone?.name !== boneName) continue;
      const v = mesh.getVertexPosition(i, new THREE.Vector3());
      out.push(mesh.localToWorld(v));
    }
  }
  return out;
}

/** World positions of every vertex in a shattered piece's parts. */
function pieceWorld(burst: Burst, boneName: string): THREE.Vector3[] {
  const holder = burst.bodies.find((b) => b.object.name === `piece-${boneName}`)?.object;
  if (!holder) throw new Error(`no piece for ${boneName}`);
  holder.updateMatrixWorld(true);
  const out: THREE.Vector3[] = [];
  for (const child of holder.children) {
    const mesh = child as THREE.Mesh;
    const position = mesh.geometry.getAttribute('position');
    for (let i = 0; i < position.count; i++) {
      out.push(new THREE.Vector3().fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld));
    }
  }
  return out;
}

const rngFor = (key: string) => Stream.fromKey(`TEST0001:shatter:${key}`);

function shattered(options: Partial<BreakApartOptions> = QUIET, key = 'one') {
  const rig = buildRig();
  pose(rig);
  const scene = new THREE.Scene();
  scene.add(rig.root);
  const system = new BreakApart(scene, options);
  system.prepare(rig, rig.root, { glowMaterial: 'glow', glowColor: '#f08c2c' });
  const burst = system.shatter(rig, rig.root, rngFor(key));
  if (!burst) throw new Error('nothing shattered');
  return { rig, scene, system, burst };
}

describe('splitting a rigid skin per bone', () => {
  it('gives one piece per skinned bone, with each bone’s vertices from every mesh', () => {
    const rig = buildRig();
    const system = new BreakApart(new THREE.Scene(), QUIET);
    const model = system.prepare(rig, rig.root, { glowMaterial: 'glow' });
    expect(model.skinnedBones).toBe(3);
    expect(model.crossBoneTriangles).toBe(0);
    const byBone = Object.fromEntries(
      model.pieces.map((p) => [p.boneName, p.parts.map((part) => part.vertices)]),
    );
    expect(byBone).toEqual({ root: [24], a: [24, 24], b: [24] });
    expect(model.drawCalls).toBe(4);
    expect(
      model.pieces.every((p) => p.parts.every((part) => !part.geometry.getAttribute('skinIndex'))),
    ).toBe(true);
    // The same key returns the cached split.
    expect(system.prepare(rig, rig.root)).toBe(model);
  });

  it('places every piece exactly on the posed mesh at the moment of the split', () => {
    const { rig, burst } = shattered();
    for (const name of ['root', 'a', 'b']) {
      expectClose(sortedPoints(pieceWorld(burst, name)), sortedPoints(skinnedWorld(rig, name)));
    }
  });

  it('throws every piece and cog away from the player the model faced (its local +Z)', () => {
    const { rig, burst } = shattered({ cogs: 4, sparks: 0 });
    const back = new THREE.Vector3(0, 0, 1).applyQuaternion(rig.root.quaternion);
    expect(burst.bodies).toHaveLength(7);
    for (const body of burst.bodies) {
      expect(body.velocity.x * back.x + body.velocity.z * back.z).toBeGreaterThan(0);
    }
  });

  it('hides the model’s meshes, not its root, and parents the pieces under the system’s parent', () => {
    const { rig, scene, burst } = shattered();
    expect(rig.root.visible).toBe(true);
    expect(rig.meshes.every((m) => !m.visible)).toBe(true);
    expect(burst.root.parent).toBe(scene);
    expect(burst.bodies).toHaveLength(3);
  });

  it('folds the smallest pieces into their nearest ancestor beyond the cap, still on the pose', () => {
    const { rig, burst, system } = shattered({ ...QUIET, maxPieces: 2 });
    const model = system.templateOf(rig);
    expect(model?.pieces.map((p) => p.boneName)).toEqual(['root', 'a']);
    expect(model?.pieces.map((p) => p.vertices)).toEqual([24, 72]);
    const chain = [...skinnedWorld(rig, 'a'), ...skinnedWorld(rig, 'b')];
    expectClose(sortedPoints(pieceWorld(burst, 'a')), sortedPoints(chain));
  });

  it('gives the glow parts a non-skinned glow clone and moves their island centres with them', () => {
    const { rig, burst, system } = shattered();
    const glow = rig.meshes[1]?.material as THREE.Material;
    const part = system.templateOf(rig)?.pieces.find((p) => p.boneName === 'a')?.parts[1];
    expect(part?.material).not.toBe(glow);
    expect(part?.material.name).toBe('glow');
    expect(part?.material.customProgramCacheKey()).toBe('automaton-glow');
    const island = part?.geometry.getAttribute('glowIsland');
    const position = part?.geometry.getAttribute('position');
    for (let i = 0; i < (position?.count ?? 0); i++) {
      expect(island?.getX(i)).toBeCloseTo(position?.getX(i) as number, 6);
      expect(island?.getY(i)).toBeCloseTo(position?.getY(i) as number, 6);
      expect(island?.getW(i)).toBeCloseTo(0.1, 6);
    }
    expect(burst.bodies.length).toBe(3);
  });
});

describe('the debris integrator', () => {
  it('throws the pieces up, drops them, bounces them and lays them to rest, never under the floor', () => {
    const { burst, system } = shattered({ ...QUIET, restitution: 0.5, upward: [2, 2.5] });
    const floor = burst.floorY;
    expect(floor).toBeCloseTo(0.5, 9);
    const startY = burst.bodies.map((b) => b.object.position.y);
    let rose = false;
    let fell = false;
    let bounced = 0;
    const lastVy = burst.bodies.map((b) => b.velocity.y);
    for (let t = 0; t < 12 && burst.phase === 'tumble'; t += STEP) {
      system.update(STEP);
      burst.bodies.forEach((body, i) => {
        const y = body.object.position.y;
        if (y > (startY[i] as number) + 0.05) rose = true;
        if (rose && y < (startY[i] as number) - 0.05) fell = true;
        if ((lastVy[i] as number) < -0.5 && body.velocity.y > 0) bounced++;
        lastVy[i] = body.velocity.y;
        const h = body.half.clone().multiply(body.object.scale);
        expect(lowestPoint(y, body.object.quaternion, h)).toBeGreaterThanOrEqual(floor - 1e-9);
      });
    }
    expect(rose).toBe(true);
    expect(fell).toBe(true);
    expect(bounced).toBeGreaterThan(0);
    expect(burst.phase).toBe('hold');
    expect(burst.age).toBeLessThan(5);
    for (const body of burst.bodies) {
      expect(body.asleep).toBe(true);
      expect(body.lowest).toBeCloseTo(floor, 6);
      // Lying flat: one local box axis points straight up or down.
      const q = body.object.quaternion;
      const ups = [
        new THREE.Vector3(1, 0, 0),
        new THREE.Vector3(0, 1, 0),
        new THREE.Vector3(0, 0, 1),
      ].map((axis) => Math.abs(axis.applyQuaternion(q).y));
      expect(Math.max(...ups)).toBeGreaterThan(0.99);
    }
    const rest = burst.bodies.map((b) => b.object.position.clone());
    system.update(0.5);
    expect(burst.bodies.map((b) => b.object.position)).toEqual(rest);
  });

  it('replays exactly for a seed and frame rate, and settles the same at 72 and 90 Hz', () => {
    const run = (key: string, dt: number): number[] => {
      const { burst, system } = shattered(QUIET, key);
      for (let t = 0; t < 12 && burst.phase === 'tumble'; t += dt) system.update(dt);
      expect(burst.phase).toBe('hold');
      return burst.bodies.flatMap((b) => [
        ...b.object.position.toArray(),
        ...b.object.quaternion.toArray(),
      ]);
    };
    const a = run('one', 1 / 72);
    expect(run('one', 1 / 72)).toEqual(a);
    const b = run('one', 1 / 90);
    for (const [i, v] of a.entries()) expect(b[i]).toBeCloseTo(v, 9);
    const other = run('two', 1 / 72);
    expect(other).not.toEqual(a);
  });

  it('sinks the pile, then removes it and frees its per-burst resources but keeps the cache', () => {
    const { rig, scene, burst, system } = shattered({ cogs: 3, sparks: 6 });
    const model = system.templateOf(rig);
    expect(burst.bodies).toHaveLength(6);
    const sparks = burst.root.children.find((c) => c instanceof THREE.InstancedMesh);
    expect(sparks).toBeDefined();
    let sparksFreed = false;
    sparks?.addEventListener('dispose', () => {
      sparksFreed = true;
    });
    const freed: string[] = [];
    for (const g of model?.geometries ?? [])
      g.addEventListener('dispose', () => freed.push('geometry'));
    for (const m of model?.ownedMaterials ?? [])
      m.addEventListener('dispose', () => freed.push('glow'));
    const source = rig.meshes[0]?.material as THREE.Material;
    source.addEventListener('dispose', () => freed.push('source'));

    let sank = false;
    for (let t = 0; t < 15 && system.bursts.length > 0; t += 1 / 72) {
      system.update(1 / 72);
      if (burst.phase === 'sink') sank = true;
    }
    expect(sank).toBe(true);
    expect(system.bursts).toHaveLength(0);
    expect(burst.root.parent).toBeNull();
    expect(scene.getObjectByName('break-apart')).toBeUndefined();
    expect(sparksFreed).toBe(true);
    expect(freed).toEqual([]);

    // A second death of the same kind reuses the cached parts.
    const again = buildRig();
    pose(again);
    scene.add(again.root);
    expect(system.shatter(rig, again.root, rngFor('again'))).not.toBeNull();
    expect(system.templateOf(rig)).toBe(model);

    system.dispose();
    expect(system.bursts).toHaveLength(0);
    expect(freed.filter((f) => f === 'geometry')).toHaveLength(model?.geometries.length ?? -1);
    expect(freed.filter((f) => f === 'glow')).toHaveLength(1);
    expect(freed).not.toContain('source');
  });

  it('clear() drops live bursts at once (the floor teardown)', () => {
    const { scene, system } = shattered();
    system.update(0.1);
    system.clear();
    expect(system.bursts).toHaveLength(0);
    expect(scene.getObjectByName('break-apart')).toBeUndefined();
  });
});

describe('the shipped automatons', () => {
  const IDS = ['cog-sentry', 'spring-hound', 'bellows-golem', 'orrery-warden', 'grand-escapement'];
  const load = async (id: string) => {
    const base = new URL(`../public/assets/enemies/${id}/`, import.meta.url);
    const manifest = parseEnemyManifest(
      JSON.parse(readFileSync(new URL(`${id}.manifest.json`, base), 'utf8')),
      id,
    );
    const bytes = readFileSync(new URL(manifest.glb, base));
    return parseEnemyAsset(new Uint8Array(bytes).slice().buffer, manifest);
  };

  it.each(IDS)('%s splits into at most 30 rigid pieces that keep every triangle', async (id) => {
    const asset = await load(id);
    const system = new BreakApart(new THREE.Scene());
    const started = performance.now();
    const model = system.prepareAsset(asset);
    const splitMs = performance.now() - started;
    let sourceIndices = 0;
    asset.template.traverse((o) => {
      if (o instanceof THREE.SkinnedMesh) {
        sourceIndices += o.geometry.getIndex()?.count ?? o.geometry.getAttribute('position').count;
      }
    });
    const partIndices = model.pieces
      .flatMap((p) => p.parts)
      .reduce((sum, part) => sum + (part.geometry.getIndex()?.count ?? 0), 0);
    console.info(
      `${id}: ${model.skinnedBones} skinned bones -> ${model.pieces.length} pieces, ` +
        `${model.drawCalls} draw calls, ${model.crossBoneTriangles} cross-bone triangles, ` +
        `split in ${splitMs.toFixed(1)} ms`,
    );
    expect(model.pieces.length).toBeGreaterThan(1);
    expect(model.pieces.length).toBeLessThanOrEqual(30);
    // Rigid skin: stretched spring triangles aside, every triangle rides one bone.
    expect(model.crossBoneTriangles).toBeLessThan(sourceIndices / 3 / 50);
    expect(partIndices).toBe(sourceIndices);
    system.dispose();
    asset.dispose();
  });

  it('shatters a cog sentry where its death clip leaves it, and cleans up after itself', async () => {
    const asset = await load('cog-sentry');
    const scene = new THREE.Scene();
    const actor = asset.spawn();
    actor.object.position.set(1, 0, -2);
    scene.add(actor.object);
    void actor.die();
    for (let t = 0; t < 10 && actor.action('death').isRunning(); t += 1 / 72) actor.update(1 / 72);
    expect(actor.action('death').isRunning()).toBe(false);
    const system = new BreakApart(scene);
    const burst = system.shatterActor(actor, rngFor('sentry'));
    expect(burst).not.toBeNull();
    expect(burst?.floorY).toBeCloseTo(0, 6);
    let meshes = 0;
    actor.object.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        meshes++;
        expect(o.visible).toBe(false);
      }
    });
    expect(meshes).toBeGreaterThan(0);
    // The pieces cover exactly the lying model (the posed skinned vertices), give or take the
    // few millimetres a piece whose box dips under the floor is lifted by.
    const posed = new THREE.Box3();
    actor.object.traverse((o) => {
      if (!(o instanceof THREE.SkinnedMesh)) return;
      const count = o.geometry.getAttribute('position').count;
      for (let i = 0; i < count; i++) {
        posed.expandByPoint(o.localToWorld(o.getVertexPosition(i, new THREE.Vector3())));
      }
    });
    const pieces = new THREE.Box3();
    for (const body of burst?.bodies ?? []) {
      if (body.object.name === 'loose-cog') continue;
      body.object.updateMatrixWorld(true);
      for (const child of body.object.children) {
        const mesh = child as THREE.Mesh;
        const position = mesh.geometry.getAttribute('position');
        for (let i = 0; i < position.count; i++) {
          pieces.expandByPoint(
            new THREE.Vector3().fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld),
          );
        }
      }
    }
    expect(posed.min.x).toBeLessThan(0.9);
    for (const axis of ['x', 'z'] as const) {
      expect(pieces.min[axis]).toBeCloseTo(posed.min[axis], 3);
      expect(pieces.max[axis]).toBeCloseTo(posed.max[axis], 3);
    }
    expect(Math.abs(pieces.min.y - posed.min.y)).toBeLessThan(0.05);
    expect(Math.abs(pieces.max.y - posed.max.y)).toBeLessThan(0.05);
    for (let t = 0; t < 15 && system.bursts.length > 0; t += 1 / 72) system.update(1 / 72);
    expect(system.bursts).toHaveLength(0);
    actor.dispose();
    system.dispose();
    asset.dispose();
  });
});
