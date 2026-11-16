import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { runVeil } from '../src/world/veil.ts';

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
