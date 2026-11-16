// @vitest-environment node
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { afterEach, describe, expect, it } from 'vitest';
import {
  parseSentry,
  parseSentryManifest,
  SENTRY_CLIPS,
  SENTRY_SOCKETS,
  type SentryActor,
  type SentryAsset,
  type SentryManifest,
} from '../src/enemies/sentry-asset.ts';

const base = new URL('../public/assets/enemies/cog-sentry/', import.meta.url);
const manifest: SentryManifest = parseSentryManifest(
  JSON.parse(readFileSync(new URL('cog-sentry.manifest.json', base), 'utf8')),
);
const glbBytes = readFileSync(new URL(manifest.glb, base));

interface Accessor {
  count: number;
  max?: number[];
  min?: number[];
}
interface Gltf {
  nodes: { name: string; children?: number[]; mesh?: number; skin?: number }[];
  materials: { name: string }[];
  meshes: { primitives: { attributes: Record<string, number>; indices?: number }[] }[];
  skins: { joints: number[] }[];
  animations: { name: string; channels: unknown[]; samplers: { input: number }[] }[];
  accessors: Accessor[];
  images?: unknown[];
  textures?: unknown[];
}

function readGlbJson(bytes: Buffer): Gltf {
  expect(bytes.readUInt32LE(0)).toBe(0x46546c67);
  const length = bytes.readUInt32LE(12);
  return JSON.parse(bytes.subarray(20, 20 + length).toString('utf8'));
}

const gltf = readGlbJson(glbBytes);
const nodeNames = gltf.nodes.map((n) => n.name);

function glbArrayBuffer(): ArrayBuffer {
  return glbBytes.buffer.slice(
    glbBytes.byteOffset,
    glbBytes.byteOffset + glbBytes.byteLength,
  ) as ArrayBuffer;
}

describe('cog sentry asset (GLB + manifest)', () => {
  it('meets the PRD automaton budgets: <= 25k triangles, <= 4 materials, <= 40 bones', () => {
    let tris = 0;
    for (const mesh of gltf.meshes) {
      for (const p of mesh.primitives) {
        tris += (gltf.accessors[p.indices ?? -1]?.count ?? 0) / 3;
      }
    }
    expect(tris).toBe(manifest.budget.tris);
    expect(tris).toBeLessThanOrEqual(25_000);
    expect(gltf.materials.map((m) => m.name).sort()).toEqual(
      ['brass-aged', 'brass-polished', 'gunmetal', 'sentry-glow'].sort(),
    );
    expect(gltf.skins).toHaveLength(1);
    const joints = gltf.skins[0]?.joints ?? [];
    expect(joints.length).toBe(manifest.skeleton.bones);
    expect(joints.length).toBeLessThanOrEqual(40);
    expect(joints.map((j) => nodeNames[j]).sort()).toEqual([...manifest.skeleton.joints].sort());
    expect(gltf.images ?? []).toHaveLength(0);
    expect(gltf.textures ?? []).toHaveLength(0);
  });

  it('skins every primitive with at most 4 influences (one WEIGHTS set)', () => {
    for (const mesh of gltf.meshes) {
      for (const p of mesh.primitives) {
        expect(p.attributes.JOINTS_0).toBeDefined();
        expect(p.attributes.WEIGHTS_0).toBeDefined();
        expect(p.attributes.WEIGHTS_1).toBeUndefined();
        expect(p.attributes.TEXCOORD_0).toBeDefined();
      }
    }
    expect(manifest.skeleton.maxInfluences).toBeLessThanOrEqual(4);
  });

  it('ships exactly the five clips with the manifest durations and loop modes', () => {
    const clips = Object.fromEntries(
      gltf.animations.map((a) => [
        a.name,
        Math.max(...a.samplers.map((s) => gltf.accessors[s.input]?.max?.[0] ?? 0)),
      ]),
    );
    expect(Object.keys(clips).sort()).toEqual([...SENTRY_CLIPS].sort());
    for (const a of gltf.animations) expect(a.channels.length).toBeGreaterThan(0);
    const expected = { idle: 2, attack: 1.2, hit: 0.6, death: 2, frozen: 1 } as const;
    for (const clip of SENTRY_CLIPS) {
      expect(clips[clip]).toBeCloseTo(expected[clip], 2);
      expect(manifest.clips[clip].duration).toBeCloseTo(expected[clip], 2);
    }
    expect(manifest.clips.idle.loop).toBe('repeat');
    expect(manifest.clips.frozen.loop).toBe('repeat');
    expect(manifest.clips.frozen.held).toBe(true);
    for (const clip of ['attack', 'hit', 'death'] as const)
      expect(manifest.clips[clip].loop).toBe('once');
    expect(manifest.clips.death.endsOnFloor).toBe(true);
    expect(manifest.clips.attack.events.impact).toBeGreaterThan(0);
    expect(manifest.clips.attack.events.impact).toBeLessThan(manifest.clips.attack.duration);
  });

  it('names the root, mesh and sockets, stands on y = 0 and faces -Z', () => {
    for (const name of [manifest.root, 'root', ...SENTRY_SOCKETS])
      expect(nodeNames).toContain(name);
    expect(manifest.frame.forward).toBe('-Z');
    expect(manifest.bounds.min[1]).toBeCloseTo(0, 3);
    expect(manifest.bounds.max[1]).toBeGreaterThan(1.8);
    expect(manifest.bounds.max[1]).toBeLessThan(2.1);
    // The amber core faces the player: the hit socket sits in front of the chest (local -Z).
    const hit = manifest.sockets['socket-hit'];
    expect(hit.bone).toBe('chest');
    expect(hit.position[1]).toBeGreaterThan(1.3);
    expect(hit.position[2]).toBeLessThan(-0.1);
    expect(manifest.sockets['socket-eye'].position[1]).toBeGreaterThan(1.75);
  });
});

describe('cog sentry engine lifecycle (GLTFLoader + AnimationMixer)', () => {
  let asset: SentryAsset | null = null;
  const actors: SentryActor[] = [];
  afterEach(() => {
    for (const a of actors.splice(0)) a.dispose();
    asset?.dispose();
    asset = null;
  });

  const step = (actor: SentryActor, seconds: number, dt = 1 / 60): void => {
    for (let t = 0; t < seconds; t += dt) actor.update(dt);
  };
  const weight = (actor: SentryActor, clip: (typeof SENTRY_CLIPS)[number]): number =>
    actor.action(clip).isScheduled() ? actor.action(clip).getEffectiveWeight() : 0;
  const totalWeight = (actor: SentryActor): number =>
    SENTRY_CLIPS.reduce((sum, clip) => sum + weight(actor, clip), 0);

  it('spawns, plays, interrupts, freezes, dies and disposes without leaks', async () => {
    asset = await parseSentry(glbArrayBuffer(), manifest);
    const actor = asset.spawn();
    actors.push(actor);
    const scene = new THREE.Scene();
    scene.add(actor.object);

    // Spawn: idle at full weight, skinned meshes bound to a 21-joint skeleton.
    expect(actor.state).toBe('idle');
    let skinned = 0;
    actor.object.traverse((o) => {
      if (o instanceof THREE.SkinnedMesh) {
        skinned++;
        expect(o.skeleton.bones.length).toBe(manifest.skeleton.bones);
      }
    });
    expect(skinned).toBeGreaterThan(0);
    step(actor, 0.5);
    expect(weight(actor, 'idle')).toBeCloseTo(1, 5);

    // Attack, then interrupt mid-swing with a hit: weights blend and always sum to 1.
    const events: string[] = [];
    actor.onEvent = (e) => events.push(e);
    actor.attack();
    step(actor, 0.4);
    expect(actor.state).toBe('attack');
    const head = actor.object.getObjectByName('head') as THREE.Object3D;
    const before = head.getWorldPosition(new THREE.Vector3());
    actor.hit();
    actor.update(0.02);
    const mid = weight(actor, 'attack');
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
    expect(totalWeight(actor)).toBeCloseTo(1, 5);
    // A blend, not a pop: the head moves a few centimetres in the first 20 ms.
    expect(head.getWorldPosition(new THREE.Vector3()).distanceTo(before)).toBeLessThan(0.05);
    step(actor, 0.2);
    expect(weight(actor, 'attack')).toBe(0);
    expect(actor.state).toBe('hit');
    // The hit clip ends and hands back to idle on its own.
    step(actor, 1.0);
    expect(actor.state).toBe('idle');
    expect(totalWeight(actor)).toBeCloseTo(1, 5);

    // A full attack fires its impact event.
    actor.attack();
    step(actor, 1.0);
    expect(events).toContain('impact');

    // Freeze holds the frozen pose and rimes the brass; unfreeze returns to idle.
    step(actor, 1.0);
    actor.freeze();
    step(actor, 0.5);
    expect(actor.frozen).toBe(true);
    expect(actor.state).toBe('frozen');
    expect(weight(actor, 'frozen')).toBeCloseTo(1, 5);
    actor.unfreeze();
    expect(actor.frozen).toBe(false);
    step(actor, 0.5);
    expect(actor.state).toBe('idle');

    // Death resolves when its clip ends, lying low; nothing but death plays afterwards.
    const died = actor.die();
    let resolved = false;
    void died.then(() => {
      resolved = true;
    });
    step(actor, 1.0);
    await Promise.resolve();
    expect(resolved).toBe(false);
    step(actor, 1.3);
    await died;
    actor.hit();
    expect(actor.state).toBe('death');
    actor.object.updateMatrixWorld(true);
    expect(head.getWorldPosition(new THREE.Vector3()).y).toBeLessThan(0.6);

    // Pool reuse: reset restores idle at full weight with the head back up.
    actor.reset();
    expect(actor.dead).toBe(false);
    expect(actor.state).toBe('idle');
    actor.object.updateMatrixWorld(true);
    expect(head.getWorldPosition(new THREE.Vector3()).y).toBeGreaterThan(1.6);

    // Despawn: no mixer actions or listeners left, removed from the scene.
    const mixer = actor.mixer;
    actor.dispose();
    actors.length = 0;
    expect(mixer.stats.actions.total).toBe(0);
    expect(mixer.stats.actions.inUse).toBe(0);
    expect(
      (mixer as unknown as { _listeners?: Record<string, unknown[]> })._listeners?.finished ?? [],
    ).toHaveLength(0);
    expect(actor.object.parent).toBeNull();
    expect(actor.disposed).toBe(true);
  });

  it('pools: two actors share geometry but own their materials and mixers', async () => {
    asset = await parseSentry(glbArrayBuffer(), manifest);
    const a = asset.spawn();
    const b = asset.spawn();
    actors.push(a, b);
    const meshes = (o: THREE.Object3D) => {
      const out: THREE.Mesh[] = [];
      o.traverse((c) => {
        if (c instanceof THREE.Mesh) out.push(c);
      });
      return out;
    };
    const [ma, mb] = [meshes(a.object), meshes(b.object)];
    expect(ma[0]?.geometry).toBe(mb[0]?.geometry);
    expect(ma[0]?.material).not.toBe(mb[0]?.material);
    expect(a.mixer).not.toBe(b.mixer);
    a.freeze();
    expect(a.frozen).toBe(true);
    expect(b.frozen).toBe(false);
    // The glow material is per instance: a hit flash on one leaves the other unchanged.
    const glow = (o: THREE.Object3D) =>
      meshes(o)
        .map((m) => m.material as THREE.MeshStandardMaterial)
        .find((m) => m.name === manifest.emissive.material);
    b.hit();
    b.update(0.01);
    expect(glow(b.object)?.emissiveIntensity ?? 0).toBeGreaterThan(
      glow(a.object)?.emissiveIntensity ?? 0,
    );
  });

  it('survives 20 spawn/play/dispose cycles with nothing left on any mixer', async () => {
    asset = await parseSentry(glbArrayBuffer(), manifest);
    const scene = new THREE.Scene();
    for (let i = 0; i < 20; i++) {
      const actor = asset.spawn();
      scene.add(actor.object);
      actor.attack();
      step(actor, 0.3);
      actor.hit();
      void actor.die();
      step(actor, 0.2);
      const mixer = actor.mixer;
      actor.dispose();
      expect(mixer.stats.actions.total).toBe(0);
      expect(mixer.stats.bindings.total).toBe(0);
    }
    expect(scene.children).toHaveLength(0);
  });

  it('rejects corrupt bytes and contract-invalid data, so the caller keeps its greybox fallback', async () => {
    await expect(parseSentry(new ArrayBuffer(64), manifest)).rejects.toThrow();
    const noDeath = { ...manifest, clips: { ...manifest.clips, death: undefined } };
    expect(() => parseSentryManifest(noDeath)).toThrow(/death/);
    expect(() =>
      parseSentryManifest({ ...manifest, frame: { ...manifest.frame, forward: '+Z' } }),
    ).toThrow(/forward/);
  });
});
