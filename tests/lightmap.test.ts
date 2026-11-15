import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  bindLightmap,
  configureLightmapTexture,
  type LightmapSpec,
  parseTemplateManifest,
} from '../src/world/lightmap.ts';

const spec: LightmapSpec = {
  file: 'room.lightmap.png',
  uv: 1,
  encoding: 'srgb-scaled',
  scale: 2,
  intensity: 2 * Math.PI,
};
const manifest = { template: 'room', glb: 'room.glb', lightmap: spec };

function mesh(withUv1: boolean): THREE.Mesh {
  const geometry = new THREE.PlaneGeometry();
  if (withUv1) geometry.setAttribute('uv1', geometry.getAttribute('uv').clone());
  return new THREE.Mesh(geometry, new THREE.MeshStandardMaterial());
}

describe('parseTemplateManifest', () => {
  it('accepts the contract shape', () => {
    expect(parseTemplateManifest(structuredClone(manifest)).lightmap.intensity).toBeCloseTo(
      2 * Math.PI,
    );
  });

  it('binds the lightmap only by its exact filename', () => {
    for (const file of [
      'room.normal.png',
      'room-lightmap.png',
      'other.lightmap.png',
      'room.orm.png',
    ]) {
      expect(() => parseTemplateManifest({ ...manifest, lightmap: { ...spec, file } })).toThrow(
        /lightmap file/,
      );
    }
    expect(
      parseTemplateManifest({ ...manifest, lightmap: { ...spec, file: 'room.lightmap.ktx2' } })
        .lightmap.file,
    ).toBe('room.lightmap.ktx2');
  });

  it('rejects the wrong channel, encoding or a non-positive intensity', () => {
    expect(() => parseTemplateManifest({ ...manifest, lightmap: { ...spec, uv: 0 } })).toThrow(
      /UV/,
    );
    expect(() =>
      parseTemplateManifest({ ...manifest, lightmap: { ...spec, encoding: 'rgbm' } }),
    ).toThrow(/encoding/);
    expect(() =>
      parseTemplateManifest({ ...manifest, lightmap: { ...spec, intensity: 0 } }),
    ).toThrow(/intensity/);
  });
});

describe('bindLightmap', () => {
  it('sets channel 1, sRGB and glTF orientation on the texture', () => {
    const texture = configureLightmapTexture(new THREE.Texture(), spec);
    expect(texture.channel).toBe(1);
    expect(texture.colorSpace).toBe(THREE.SRGBColorSpace);
    expect(texture.flipY).toBe(false);
  });

  it('binds every material with the manifest intensity', () => {
    const root = new THREE.Group();
    root.add(mesh(true), mesh(true));
    const texture = new THREE.Texture();
    expect(bindLightmap(root, texture, spec)).toBe(2);
    root.traverse((node) => {
      const m = (node as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
      if (!m) return;
      expect(m.lightMap).toBe(texture);
      expect(m.lightMapIntensity).toBeCloseTo(2 * Math.PI);
    });
  });

  it('refuses a mesh without a second UV set', () => {
    const root = new THREE.Group();
    root.add(mesh(false));
    expect(() => bindLightmap(root, new THREE.Texture(), spec)).toThrow(/uv1/);
  });
});
