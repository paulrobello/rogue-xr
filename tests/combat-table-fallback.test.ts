// @vitest-environment node
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadCombatTable } from '../src/combat/table-asset-proof.ts';

const manifest = JSON.parse(
  readFileSync(
    new URL('../public/assets/props/combat-table/combat-table.manifest.json', import.meta.url),
    'utf8',
  ),
);
const renderer = {} as THREE.WebGLRenderer;

function factorScene(): THREE.Object3D {
  const root = new THREE.Group();
  root.add(
    new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial({ name: 'walnut' })),
  );
  return root;
}

afterEach(() => vi.restoreAllMocks());

describe('combat table fallbacks', () => {
  it('keeps the greybox when the manifest fetch fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const loadGltf = vi.fn();
    const asset = await loadCombatTable(renderer, {
      fetchJson: () => Promise.reject(new Error('404')),
      loadGltf,
    });
    expect(asset).toBeNull();
    expect(loadGltf).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      'combat table asset unavailable, greybox kept',
      expect.any(Error),
    );
  });

  it('keeps the greybox when the GLB fails to load', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const asset = await loadCombatTable(renderer, {
      fetchJson: async () => manifest,
      loadGltf: () => Promise.reject(new Error('bad glb')),
    });
    expect(asset).toBeNull();
  });

  it('keeps the factor materials when the material bind fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const scene = factorScene();
    const before = (scene.children[0] as THREE.Mesh).material;
    const asset = await loadCombatTable(renderer, {
      fetchJson: async () => manifest,
      loadGltf: async () => ({ scene }),
      bind: () => Promise.reject(new Error('ktx2 failed')),
    });
    expect(asset).not.toBeNull();
    expect(asset?.scene).toBe(scene);
    expect(asset?.top).toBe(manifest.authoredTopHeight);
    expect((scene.children[0] as THREE.Mesh).material).toBe(before);
    expect(warn).toHaveBeenCalledWith(
      'combat table materials fell back to factors',
      expect.any(Error),
    );
  });
});
