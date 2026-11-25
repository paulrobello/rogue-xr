import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { floorTextures, runVeil } from '../src/world/veil.ts';

function fakeRenderer(log: string[]) {
  return {
    xr: { isPresenting: false },
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
