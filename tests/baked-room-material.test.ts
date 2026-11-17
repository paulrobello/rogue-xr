// @vitest-environment node
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { bakedRoomMaterial } from '../src/world/study-room.ts';

/** Runs the material's patch over three's real MeshStandardMaterial fragment shader. */
function patchedFragment(): string {
  const material = bakedRoomMaterial(new THREE.MeshStandardMaterial());
  const shader = {
    vertexShader: THREE.ShaderLib.standard.vertexShader,
    fragmentShader: THREE.ShaderLib.standard.fragmentShader,
    uniforms: {},
  } as unknown as Parameters<THREE.Material['onBeforeCompile']>[0];
  material.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
  return shader.fragmentShader;
}

describe('bakedRoomMaterial (lightmap contract)', () => {
  it('leaves only the lightmap as diffuse light: no ambient, hemisphere or probe diffuse', () => {
    const src = patchedFragment();
    const maps = src.indexOf('#include <lights_fragment_maps>');
    const end = src.indexOf('#include <lights_fragment_end>');
    expect(maps).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(maps);
    // Ambient and hemisphere irradiance are cleared before the lightmap is added.
    expect(src.lastIndexOf('irradiance = vec3( 0.0 );', maps)).toBeGreaterThan(0);
    // The probe's diffuse rides in iblIrradiance into RE_IndirectSpecular (lights_fragment_end).
    const ibl = src.indexOf('iblIrradiance = vec3( 0.0 );');
    expect(ibl).toBeGreaterThan(maps);
    expect(ibl).toBeLessThan(end);
    // Dynamic lights keep their specular only.
    expect(src.indexOf('reflectedLight.directDiffuse = vec3( 0.0 );')).toBeGreaterThan(end);
  });

  it('keeps the probe specular: iblRadiance is untouched', () => {
    expect(patchedFragment()).not.toMatch(/iblRadiance\s*=\s*vec3\(\s*0\.0\s*\)/);
  });
});
