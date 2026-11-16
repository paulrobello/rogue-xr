import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { TRANSCODER_PATH } from '../src/world/ktx2.ts';
import {
  type LightmapLoader,
  type LightmapSpec,
  lightmapFileNames,
  loadRoomLightmap,
  selectLightmapFile,
  type TemplateManifest,
} from '../src/world/lightmap.ts';

function manifestFor(template: string, file: string, intensity = 3 * Math.PI): TemplateManifest {
  const lightmap: LightmapSpec = { file, uv: 1, encoding: 'srgb-scaled', scale: 3, intensity };
  return { template, glb: `${template}.glb`, lightmap };
}

function fakeLoader(texture: THREE.Texture = new THREE.Texture()) {
  const loadAsync = vi.fn(async (_url: string) => texture);
  return { loader: { loadAsync } satisfies LightmapLoader, loadAsync, texture };
}

function room(): THREE.Group {
  const geometry = new THREE.PlaneGeometry();
  geometry.setAttribute('uv1', geometry.getAttribute('uv').clone());
  const group = new THREE.Group();
  group.add(
    new THREE.Mesh(geometry, new THREE.MeshStandardMaterial()),
    new THREE.Mesh(geometry, new THREE.MeshStandardMaterial()),
  );
  return group;
}

describe('exact lightmap filename', () => {
  it('lists only <template>.lightmap.ktx2 and .png, KTX2 first', () => {
    expect(lightmapFileNames('study')).toEqual(['study.lightmap.ktx2', 'study.lightmap.png']);
  });

  it('never picks a near-miss name from a directory listing', () => {
    const decoys = [
      'study-lightmap-old.ktx2',
      'xstudy.lightmap.ktx2',
      'study.lightmap.ktx2.bak',
      'study.lightmap-old.ktx2',
      'study.lightmap.KTX2',
      'study_lightmap.ktx2',
      'study.normal.ktx2',
      'lightmap.ktx2',
    ];
    expect(selectLightmapFile('study', decoys)).toBeUndefined();
    expect(selectLightmapFile('study', [...decoys, 'study.lightmap.ktx2'])).toBe(
      'study.lightmap.ktx2',
    );
  });

  it('prefers KTX2 over PNG when both ship', () => {
    expect(selectLightmapFile('study', ['study.lightmap.png', 'study.lightmap.ktx2'])).toBe(
      'study.lightmap.ktx2',
    );
    expect(selectLightmapFile('study', ['study.lightmap.png'])).toBe('study.lightmap.png');
  });

  it('rejects a manifest that names a near-miss file, before any load starts', async () => {
    const { loader, loadAsync } = fakeLoader();
    for (const file of ['study-lightmap-old.ktx2', 'xstudy.lightmap.ktx2', 'other.lightmap.ktx2']) {
      await expect(loadRoomLightmap(manifestFor('study', file), '/rooms', loader)).rejects.toThrow(
        /lightmap file/,
      );
    }
    expect(loadAsync).not.toHaveBeenCalled();
  });
});

describe('loadRoomLightmap', () => {
  it('requests exactly <base>/<template>.lightmap.ktx2', async () => {
    const { loader, loadAsync } = fakeLoader();
    const result = await loadRoomLightmap(
      manifestFor('study', 'study.lightmap.ktx2'),
      '/assets/rooms/',
      loader,
    );
    expect(loadAsync).toHaveBeenCalledTimes(1);
    expect(loadAsync).toHaveBeenCalledWith('/assets/rooms/study.lightmap.ktx2');
    expect(result.url).toBe('/assets/rooms/study.lightmap.ktx2');
  });

  it('puts the texture on UV channel 1 as sRGB, unflipped', async () => {
    const { loader, texture } = fakeLoader();
    const { texture: loaded } = await loadRoomLightmap(
      manifestFor('study', 'study.lightmap.png'),
      '/r',
      loader,
    );
    expect(loaded).toBe(texture);
    expect(loaded.channel).toBe(1);
    expect(loaded.colorSpace).toBe(THREE.SRGBColorSpace);
    expect(loaded.flipY).toBe(false);
    expect(loaded.generateMipmaps).toBe(true);
  });

  it('binds lightMap and the manifest intensity on every material under root', async () => {
    const { loader, texture } = fakeLoader();
    const root = room();
    const intensity = 2.5 * Math.PI;
    const result = await loadRoomLightmap(
      manifestFor('study', 'study.lightmap.ktx2', intensity),
      '/r',
      loader,
      root,
    );
    expect(result.bound).toBe(2);
    root.traverse((node) => {
      const mesh = node as THREE.Mesh;
      if (!mesh.isMesh) return;
      const material = mesh.material as THREE.MeshStandardMaterial;
      expect(material.lightMap).toBe(texture);
      expect(material.lightMap?.channel).toBe(1);
      expect(material.lightMapIntensity).toBeCloseTo(intensity);
    });
  });

  it('does not let a compressed texture generate mipmaps', async () => {
    const mip = { data: new Uint8Array(16), width: 4, height: 4 };
    const compressed = new THREE.CompressedTexture([mip, mip, mip], 4, 4);
    const { loader } = fakeLoader(compressed);
    const { texture } = await loadRoomLightmap(
      manifestFor('study', 'study.lightmap.ktx2'),
      '/r',
      loader,
    );
    expect(texture.generateMipmaps).toBe(false);
    expect(texture.minFilter).toBe(THREE.LinearMipmapLinearFilter);
    expect(texture.channel).toBe(1);
  });

  it('refuses to bind a mesh with no uv1', async () => {
    const { loader } = fakeLoader();
    const root = new THREE.Group();
    root.add(new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.MeshStandardMaterial()));
    await expect(
      loadRoomLightmap(manifestFor('study', 'study.lightmap.ktx2'), '/r', loader, root),
    ).rejects.toThrow(/uv1/);
  });

  it('matches the shipped room-proof fixture', async () => {
    const dir = join(process.cwd(), 'public/assets/fixtures/room-proof');
    const manifest = JSON.parse(
      readFileSync(join(dir, 'room-proof.manifest.json'), 'utf8'),
    ) as TemplateManifest;
    const { loader, loadAsync } = fakeLoader();
    await loadRoomLightmap(manifest, '/assets/fixtures/room-proof', loader);
    expect(loadAsync).toHaveBeenCalledWith('/assets/fixtures/room-proof/room-proof.lightmap.png');
  });
});

describe('self-hosted transcoder', () => {
  it('is served from /vendor/basis/', () => {
    expect(TRANSCODER_PATH).toBe('/vendor/basis/');
  });
});
