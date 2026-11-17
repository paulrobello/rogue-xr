// @vitest-environment node
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  bakedRoomMaterial,
  emitterSlot,
  roomLightsFragmentBegin,
  untonedEmitterIntensity,
} from '../src/world/study-room.ts';

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
    const ibl = src.indexOf('\niblIrradiance = vec3( 0.0 );', maps);
    expect(ibl).toBeGreaterThan(maps);
    expect(ibl).toBeLessThan(end);
    // Dynamic lights keep their specular only.
    expect(src.indexOf('reflectedLight.directDiffuse = vec3( 0.0 );')).toBeGreaterThan(end);
  });

  it('lets metals reflect the lightmap, weighted by metalness, without a second diffuse path', () => {
    const src = patchedFragment();
    const maps = src.indexOf('#include <lights_fragment_maps>');
    const ibl = src.indexOf('\niblIrradiance = vec3( 0.0 );', maps);
    const metal = src.indexOf(
      'radiance += metalnessFactor * lightMapIrradiance * RECIPROCAL_PI;',
      maps,
    );
    expect(metal).toBeGreaterThan(ibl);
    expect(metal).toBeLessThan(src.indexOf('#include <lights_fragment_end>'));
    // Guarded: lightMapIrradiance only exists when the slot has a lightmap.
    expect(
      src.lastIndexOf('#if defined( USE_LIGHTMAP ) && defined( RE_IndirectSpecular )', metal),
    ).toBeGreaterThan(ibl);
    // The lightmap never enters iblIrradiance, which RE_IndirectSpecular spends as diffuse.
    expect(src).not.toMatch(/iblIrradiance\s*\+=\s*lightMap/);
  });

  it('keeps the probe specular: iblRadiance is untouched', () => {
    expect(patchedFragment()).not.toMatch(/iblRadiance\s*=\s*vec3\(\s*0\.0\s*\)/);
  });

  it('skips directional and sun lights but keeps point and spot lights', () => {
    const src = patchedFragment();
    expect(src).not.toContain('#include <lights_fragment_begin>');
    expect(src).not.toContain('NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct )');
    expect(src).not.toContain('NUM_SUN_LIGHTS > 0 ) && defined( RE_Direct )');
    expect(src).toContain('#if ( NUM_POINT_LIGHTS > 0 ) && defined( RE_Direct )');
    expect(src).toContain('#if ( NUM_SPOT_LIGHTS > 0 ) && defined( RE_Direct )');
    // The inlined chunk still declares what lights_fragment_maps and _end use, ahead of them.
    const begin = src.indexOf('vec3 iblIrradiance = vec3( 0.0 );');
    expect(begin).toBeGreaterThan(0);
    expect(begin).toBeLessThan(src.indexOf('#include <lights_fragment_maps>'));
  });

  it('fails loudly when three renames a distant-light loop', () => {
    expect(() =>
      roomLightsFragmentBegin('#if ( NUM_POINT_LIGHTS > 0 ) && defined( RE_Direct )'),
    ).toThrow(/NUM_DIR_LIGHTS/);
  });
});

describe('untonedEmitterIntensity (hue-preserving emitter peak)', () => {
  it('caps the intensity so the strongest linear channel lands at 1.0', () => {
    const fire = new THREE.MeshStandardMaterial({ emissive: '#896335', emissiveIntensity: 5.6 });
    const capped = untonedEmitterIntensity(fire);
    const out = fire.emissive.clone().multiplyScalar(capped);
    expect(Math.max(out.r, out.g, out.b)).toBeCloseTo(1, 6);
    // Channel ratios (the hue) are the authored ones, not clipped.
    expect(out.g / out.r).toBeCloseTo(fire.emissive.g / fire.emissive.r, 6);
  });

  it('leaves an emitter that never clips untouched', () => {
    const dim = new THREE.MeshStandardMaterial({ emissive: '#683815', emissiveIntensity: 1.5 });
    expect(untonedEmitterIntensity(dim)).toBe(1.5);
    const off = new THREE.MeshStandardMaterial({ emissive: 0x000000, emissiveIntensity: 3 });
    expect(untonedEmitterIntensity(off)).toBe(3);
  });
});

describe('emitterSlot (baked colour of emitting slots)', () => {
  it('leaves non-emitting slots tone-mapped and reflecting the probe', () => {
    expect(emitterSlot(new THREE.MeshStandardMaterial({ color: '#bf9759' }))).toEqual({
      toneMapped: true,
      reflectsProbe: true,
    });
  });

  it('takes constant emitters (flame, coals, lamp glass) out of tone mapping only', () => {
    const flame = new THREE.MeshStandardMaterial({ emissive: '#895121', emissiveIntensity: 5.6 });
    expect(emitterSlot(flame)).toEqual({ toneMapped: false, reflectsProbe: true });
  });

  it('keeps emissive-mapped glass tone-mapped but out of the probe', () => {
    const glass = new THREE.MeshStandardMaterial({
      emissive: 0xffffff,
      emissiveIntensity: 0.8,
      emissiveMap: new THREE.Texture(),
    });
    expect(emitterSlot(glass)).toEqual({ toneMapped: true, reflectsProbe: false });
  });

  it('treats a dark or zero-intensity emissive as no emitter', () => {
    const unlit = new THREE.MeshStandardMaterial({ emissiveMap: new THREE.Texture() });
    unlit.emissive.set(1, 1, 1);
    unlit.emissiveIntensity = 0;
    expect(emitterSlot(unlit)).toEqual({ toneMapped: true, reflectsProbe: true });
    const black = new THREE.MeshStandardMaterial({ emissive: 0x000000, emissiveIntensity: 3 });
    expect(emitterSlot(black)).toEqual({ toneMapped: true, reflectsProbe: true });
  });
});
