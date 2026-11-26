import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import type { FloorPlan } from '../src/floor/generate.ts';
import { stabilizeConservatoryLights } from '../src/world/conservatory-warmup.ts';
import { floorTextures, runVeil } from '../src/world/veil.ts';

function fakeRenderer(log: string[]) {
  return {
    xr: { isPresenting: false },
    debug: { checkShaderErrors: false },
    compileAsync: vi.fn(async (target: THREE.Object3D) => {
      log.push(`compile:${target.name}`);
      return target;
    }),
    initTexture: vi.fn((t: THREE.Texture) => {
      log.push(`init:${t.name}`);
    }),
  };
}

const asRenderer = (r: ReturnType<typeof fakeRenderer>) => r as unknown as THREE.WebGLRenderer;

describe('runVeil', () => {
  it('primes linked program bindings under the veil without waiting on unrelated programs', async () => {
    const log: string[] = [];
    const renderer = fakeRenderer(log);
    const ready = {
      isReady: () => true,
      getUniforms: () => {
        expect(renderer.debug.checkShaderErrors).toBe(false);
        log.push('bind');
      },
    };
    const pending = { isReady: () => false, getUniforms: vi.fn() };
    const withPrograms = Object.assign(renderer, { info: { programs: [ready, pending] } });
    const texture = Object.assign(new THREE.Texture(), { name: 'room' });
    await runVeil(
      asRenderer(withPrograms),
      new THREE.Scene(),
      new THREE.PerspectiveCamera(),
      [texture],
      {
        primeProgramBindings: true,
        fadeFrames: 0,
        nextFrame: async () => {},
      },
    );
    expect(log).toEqual(['compile:', 'bind', 'init:room']);
    expect(pending.getUniforms).not.toHaveBeenCalled();
  });

  it('enables shader log reads only during explicitly opted-in warmup', async () => {
    const renderer = fakeRenderer([]);
    const getUniforms = vi.fn(() => {
      expect(renderer.debug.checkShaderErrors).toBe(true);
      throw new Error('binding failed');
    });
    const withPrograms = Object.assign(renderer, { info: { programs: [{ getUniforms }] } });
    renderer.compileAsync.mockImplementation(async (target) => {
      expect(renderer.debug.checkShaderErrors).toBe(false);
      return target;
    });
    await expect(
      runVeil(asRenderer(withPrograms), new THREE.Scene(), new THREE.PerspectiveCamera(), [], {
        nextFrame: async () => {
          expect(renderer.debug.checkShaderErrors).toBe(false);
        },
        checkShaderErrors: true,
      }),
    ).rejects.toThrow('binding failed');
    expect(getUniforms).toHaveBeenCalledOnce();
    expect(renderer.debug.checkShaderErrors).toBe(false);
  });

  it('compiles every program before uploading, and uploads a few textures per frame', async () => {
    const log: string[] = [];
    const renderer = fakeRenderer(log);
    const scene = new THREE.Scene();
    scene.name = 'main';
    const variant = new THREE.Group();
    variant.name = 'variant';
    const textures = ['a', 'b', 'c', 'd', 'e'].map((name) =>
      Object.assign(new THREE.Texture(), { name }),
    );
    const nextFrame = vi.fn(async () => {
      log.push('frame');
    });

    await runVeil(asRenderer(renderer), scene, new THREE.PerspectiveCamera(), textures, {
      variants: [variant],
      uploadsPerFrame: 2,
      fadeFrames: 3,
      nextFrame,
    });

    expect(renderer.compileAsync).toHaveBeenCalledTimes(2);
    expect(renderer.compileAsync).toHaveBeenLastCalledWith(variant, expect.anything(), scene);
    const firstInit = log.findIndex((e) => e.startsWith('init:'));
    const lastCompile = log.lastIndexOf('compile:variant');
    expect(lastCompile).toBeGreaterThan(-1);
    expect(firstInit).toBeGreaterThan(lastCompile);
    // 5 textures at 2 per frame: no frame carries more than 2 uploads.
    let run = 0;
    let longest = 0;
    for (const entry of log) {
      run = entry.startsWith('init:') ? run + 1 : 0;
      longest = Math.max(longest, run);
    }
    expect(longest).toBe(2);
    expect(renderer.initTexture).toHaveBeenCalledTimes(5);
  });

  it('leaves no veil mesh in the scene and reports its phases in order', async () => {
    const renderer = fakeRenderer([]);
    const scene = new THREE.Scene();
    const phases: string[] = [];
    let veilSeen = 0;
    await runVeil(asRenderer(renderer), scene, new THREE.PerspectiveCamera(), [], {
      fadeFrames: 2,
      nextFrame: async () => {
        if (scene.getObjectByName('load-veil')) veilSeen++;
      },
      onPhase: (p) => phases.push(p),
    });
    expect(veilSeen).toBeGreaterThan(0);
    expect(scene.getObjectByName('load-veil')).toBeUndefined();
    expect(phases).toEqual(['compile', 'upload', 'fade', 'done']);
  });

  it('removes the veil even when compilation fails', async () => {
    const renderer = fakeRenderer([]);
    renderer.compileAsync.mockRejectedValueOnce(new Error('link failed'));
    const scene = new THREE.Scene();
    await expect(
      runVeil(asRenderer(renderer), scene, new THREE.PerspectiveCamera(), [], {
        nextFrame: async () => {},
      }),
    ).rejects.toThrow('link failed');
    expect(scene.getObjectByName('load-veil')).toBeUndefined();
  });
});

it('warms each point-light count and restores the original lights between compile calls', async () => {
  const renderer = fakeRenderer([]);
  const scene = new THREE.Scene();
  const near = new THREE.Group().add(new THREE.PointLight());
  const distant = new THREE.Group().add(new THREE.PointLight());
  distant.visible = false;
  scene.add(near, distant, new THREE.PointLight());
  const roomPointLights = [near.children[0], distant.children[0]] as THREE.PointLight[];
  const counts: number[] = [];
  renderer.compileAsync.mockImplementation(async (root) => {
    let count = 0;
    root.traverseVisible((node) => {
      if (node instanceof THREE.PointLight) count++;
    });
    counts.push(count);
    await Promise.resolve();
    expect(roomPointLights.every((light) => light.visible)).toBe(true);
    expect(scene.children).toHaveLength(4); // Original lights, rooms and the veil.
    return root;
  });
  await runVeil(asRenderer(renderer), scene, new THREE.PerspectiveCamera(), [], {
    roomPointLights,
    nextFrame: async () => {},
    fadeFrames: 0,
  });
  expect(counts).toEqual([1, 2, 3]);
  expect(scene.children).toHaveLength(3);
  expect(distant.visible).toBe(false);
});

it('collects unique floor textures through culled groups without reinitializing render targets', () => {
  const texture = new THREE.Texture();
  const lightMap = new THREE.DataTexture();
  const renderTarget = new THREE.WebGLRenderTarget();
  const shared = new THREE.MeshStandardMaterial({ map: texture });
  const hidden = new THREE.Group();
  hidden.visible = false;
  const geometry = new THREE.BoxGeometry();
  hidden.add(
    new THREE.Mesh(geometry, [
      shared,
      new THREE.MeshStandardMaterial({
        map: texture,
        lightMap,
        envMap: renderTarget.texture,
      }),
    ]),
  );
  const root = new THREE.Group().add(new THREE.Mesh(geometry, shared), hidden);
  expect([...floorTextures(root)]).toEqual([texture, lightMap]);
  renderTarget.dispose();
});

it('keeps one bounded room light count through visibility changes', () => {
  const plan: FloorPlan = {
    seed: 'TEST',
    guardianRoom: -1,
    sealed: [],
    rooms: [0, 1, 2, 3, 4].map((index) => ({
      index,
      templateId: 'hall',
      turns: 0,
      position: [0, index * 10],
      role: index === 0 ? 'entry' : 'corridor',
      wing: 0,
      depth: index,
      encounter: null,
      loot: [],
    })),
    connections: [0, 1, 2, 3].map((room) => [
      { room, door: 'n' },
      { room: room + 1, door: 's' },
    ]),
  };
  const groups = plan.rooms.map(({ index }) => {
    const group = new THREE.Group();
    group.visible = index <= 2;
    if (index % 2 === 0) group.add(new THREE.PointLight());
    const hidden = new THREE.Group();
    hidden.visible = false;
    group.add(hidden.add(new THREE.PointLight()));
    return group;
  });
  const root = new THREE.Group().add(...groups);
  const lighting = stabilizeConservatoryLights(plan, root, groups, 0);
  if (!lighting) throw new Error('Expected the reachable light count to fit the budget');
  expect(lighting.count).toBe(3);
  const visibleLights = () => {
    const lights: THREE.PointLight[] = [];
    root.traverseVisible((node) => {
      if (node instanceof THREE.PointLight) lights.push(node);
    });
    return lights;
  };
  expect(visibleLights()).toHaveLength(3);
  expect(visibleLights().filter((light) => light.intensity === 0)).toHaveLength(1);
  for (const [index, group] of groups.entries()) group.visible = index >= 3;
  lighting.update();
  expect(visibleLights()).toHaveLength(3);
  expect(visibleLights().filter((light) => light.intensity === 0)).toHaveLength(2);

  groups[1].add(new THREE.PointLight(), new THREE.PointLight());
  const originalChildren = root.children.length;
  expect(stabilizeConservatoryLights(plan, root, groups, 0)).toBeNull();
  expect(root.children.length).toBe(originalChildren);
});
