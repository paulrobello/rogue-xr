import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { removePumpRoomSunlight } from '../src/world/pump-room-floor.ts';

describe('removePumpRoomSunlight', () => {
  it('changes only the pump floor lightmap and preserves shared room assets', () => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0], 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute([0.25, 0.75], 2));
    geometry.setAttribute('uv1', new THREE.Float32BufferAttribute([10 / 2048, 1510 / 2048], 2));
    const material = new THREE.MeshStandardMaterial();
    material.name = 'study_stone-floor';
    material.lightMapIntensity = 11.886377;
    const pump = new THREE.Mesh(geometry, material);
    const otherStudy = new THREE.Mesh(geometry, material);
    const wall = new THREE.Mesh(
      geometry,
      new THREE.MeshStandardMaterial({ name: 'study_wallpaper' }),
    );
    const root = new THREE.Group();
    root.add(pump, wall);
    const replacement = new THREE.Texture();
    const resources = removePumpRoomSunlight(root, replacement);
    expect(pump.geometry).not.toBe(geometry);
    expect(pump.material).not.toBe(material);
    expect(otherStudy.geometry).toBe(geometry);
    expect(otherStudy.material).toBe(material);
    expect(wall.geometry).toBe(geometry);
    expect(pump.geometry.getAttribute('uv').getX(0)).toBeCloseTo(0.25);
    expect(pump.geometry.getAttribute('uv1').getX(0)).toBeCloseTo(10 / 550);
    expect(pump.geometry.getAttribute('uv1').getY(0)).toBeCloseTo(10 / 548);
    expect(pump.material.lightMap).toBe(replacement);
    expect(pump.material.lightMapIntensity).toBe(11.886377);

    expect(resources).toEqual({
      geometries: [pump.geometry],
      materials: [pump.material],
    });
  });
});
