// @vitest-environment node
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  configurePbrTexture,
  createPbrMaterial,
  ktx2File,
  parsePbrManifest,
  tileRepeat,
} from '../src/world/materials.ts';

const manifestPath = new URL('../public/assets/materials/materials.json', import.meta.url);

describe('parsePbrManifest', () => {
  it('accepts the built manifest with all six core materials', () => {
    const manifest = parsePbrManifest(JSON.parse(readFileSync(manifestPath, 'utf8')));
    expect(Object.keys(manifest).sort()).toEqual([
      'brass-aged',
      'brass-polished',
      'stained-glass',
      'stone-floor',
      'wallpaper',
      'walnut',
    ]);
    expect(manifest['stained-glass']?.maps.emissive).toBe('stained-glass.emissive.png');
  });

  it('rejects a missing role, an unknown role and a bad tile size', () => {
    const maps = { basecolor: 'a.png', normal: 'b.png', orm: 'c.png' };
    expect(() => parsePbrManifest({ m: { tileMeters: 1, maps: { basecolor: 'a.png' } } })).toThrow(
      /normal/,
    );
    expect(() =>
      parsePbrManifest({ m: { tileMeters: 1, maps: { ...maps, height: 'h.png' } } }),
    ).toThrow(/unknown role/);
    expect(() => parsePbrManifest({ m: { tileMeters: 0, maps } })).toThrow(/tileMeters/);
  });
});

describe('configurePbrTexture', () => {
  it('treats colour roles as sRGB and data roles as linear, all tiling', () => {
    for (const [role, space] of [
      ['basecolor', THREE.SRGBColorSpace],
      ['emissive', THREE.SRGBColorSpace],
      ['normal', THREE.NoColorSpace],
      ['orm', THREE.NoColorSpace],
    ] as const) {
      const texture = configurePbrTexture(new THREE.Texture(), role);
      expect(texture.colorSpace).toBe(space);
      expect(texture.wrapS).toBe(THREE.RepeatWrapping);
      expect(texture.wrapT).toBe(THREE.RepeatWrapping);
    }
  });
});

describe('createPbrMaterial', () => {
  it('binds the packed ORM texture to AO, roughness and metalness', () => {
    const orm = new THREE.Texture();
    const material = createPbrMaterial({
      basecolor: new THREE.Texture(),
      normal: new THREE.Texture(),
      orm,
    });
    expect(material.aoMap).toBe(orm);
    expect(material.roughnessMap).toBe(orm);
    expect(material.metalnessMap).toBe(orm);
    expect(material.roughness).toBe(1);
    expect(material.metalness).toBe(1);
    expect(material.emissiveMap).toBeNull();
  });

  it('starts emissive materials dark so lighting decides the glow', () => {
    const emissive = new THREE.Texture();
    const material = createPbrMaterial({
      basecolor: new THREE.Texture(),
      normal: new THREE.Texture(),
      orm: new THREE.Texture(),
      emissive,
    });
    expect(material.emissiveMap).toBe(emissive);
    expect(material.emissiveIntensity).toBe(0);
  });
});

describe('KTX2 copies', () => {
  it('sit beside every manifest PNG with the same stem', () => {
    const manifest = parsePbrManifest(JSON.parse(readFileSync(manifestPath, 'utf8')));
    for (const [name, entry] of Object.entries(manifest)) {
      for (const file of Object.values(entry.maps)) {
        const path = new URL(
          `../public/assets/materials/${name}/${ktx2File(file)}`,
          import.meta.url,
        );
        expect(readFileSync(path).subarray(0, 12).toString('latin1')).toBe('«KTX 20»\r\n\u001a\n');
      }
    }
  });

  it('keep their own mip chain instead of generating one', () => {
    const compressed = configurePbrTexture(new THREE.CompressedTexture([], 4, 4), 'normal');
    expect(compressed.generateMipmaps).toBe(false);
    expect(configurePbrTexture(new THREE.Texture(), 'normal').generateMipmaps).toBe(true);
  });
});

describe('tileRepeat', () => {
  it('converts metres to tiles', () => {
    const repeat = tileRepeat(
      { tileMeters: 0.5, maps: { basecolor: '', normal: '', orm: '' } },
      3,
      1,
    );
    expect(repeat.x).toBe(6);
    expect(repeat.y).toBe(2);
  });
});
