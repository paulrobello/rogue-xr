import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { parseCardAtlas } from '../src/cards/card-atlas.ts';
import {
  ATLAS_CARD_WIDTH,
  addCardFaceAttributes,
  applyCardFaceArt,
  CARD_FOG,
  createCardFaceMaterial,
  FOG_DENSITY,
  writeCardBurn,
} from '../src/cards/card-face-material.ts';
import { GLOW_HOT } from '../src/enemies/glow.ts';
import { CardFan } from '../src/hand/card-fan.ts';
import { DEFAULT_FAN } from '../src/hand/fan-layout.ts';
import { PALETTE } from '../src/palette.ts';

const atlas = parseCardAtlas(
  JSON.parse(
    readFileSync(resolve(process.cwd(), 'public/assets/cards/atlas/card-atlas.json'), 'utf8'),
  ),
);
const pages = atlas.pages.map(() => new THREE.Texture());

const uniform = <T>(m: THREE.ShaderMaterial, name: string): T =>
  (m.uniforms[name] as THREE.IUniform<T>).value;

describe('card face portal depth (H8)', () => {
  it('shares one depth stack across every atlas card, so depths can be uniforms', () => {
    const stacks = Object.values(atlas.cards).map((c) =>
      ['back', 'mid', 'glow', 'front'].map((k) => c.stack[k as 'back'].depth),
    );
    for (const s of stacks) expect(s).toEqual(stacks[0]);
    // Back deepest, front shallowest: a parallax that runs the wrong way would read as a bulge.
    const [back, mid, glow, front] = stacks[0] as number[];
    expect(back).toBeGreaterThan(mid as number);
    expect(mid).toBeGreaterThan(glow as number);
    expect(glow).toBeGreaterThanOrEqual(front as number);
  });

  it('turns the atlas depths into window diameters on art load', () => {
    const material = createCardFaceMaterial();
    applyCardFaceArt(material, { atlas, pages });
    const frame = atlas.frames.attack;
    const stack = (Object.values(atlas.cards)[0] as (typeof atlas.cards)[string]).stack;
    const diameter = 2 * frame.window.radius * ATLAS_CARD_WIDTH;
    const depths = uniform<THREE.Vector4>(material, 'uDepths');
    expect(depths.x).toBeCloseTo(stack.back.depth / diameter, 9);
    expect(depths.y).toBeCloseTo(stack.mid.depth / diameter, 9);
    expect(depths.z).toBeCloseTo(stack.glow.depth / diameter, 9);
    expect(depths.w).toBeCloseTo(stack.front.depth / diameter, 9);
    // The back layer's margin (half its size less the window radius) covers the steepest slope the
    // shader follows (1.2) at its depth, so the parallax never shows the atlas cell edge.
    const sizes = uniform<THREE.Vector4>(material, 'uSizes');
    expect(sizes.x / 2 - 0.5).toBeGreaterThanOrEqual(depths.x * 1.2);
    material.dispose();
  });

  it('defaults the fan to the authored card width', () => {
    expect(DEFAULT_FAN.cardWidth).toBe(ATLAS_CARD_WIDTH);
  });

  it('hazes deep layers toward warm black and burns in the D11 amber', () => {
    const material = createCardFaceMaterial();
    const fog = uniform<THREE.Vector4>(material, 'uFog');
    const want = new THREE.Color(CARD_FOG);
    expect([fog.x, fog.y, fog.z]).toEqual([want.r, want.g, want.b]);
    expect(fog.w).toBe(FOG_DENSITY);
    expect(uniform<THREE.Color>(material, 'uHot').equals(new THREE.Color(GLOW_HOT))).toBe(true);
    expect(uniform<THREE.Color>(material, 'uEmber').equals(new THREE.Color(PALETTE.candle))).toBe(
      true,
    );
    material.dispose();
  });

  it('declares the uniforms and varyings the shaders read', () => {
    const material = createCardFaceMaterial();
    for (const name of ['uDepths', 'uFog', 'uEmber', 'uHot', 'uArtOnlyTexels']) {
      expect(material.uniforms[name]).toBeDefined();
      expect(material.fragmentShader).toContain(`uniform`);
      expect(material.fragmentShader).toContain(name);
    }
    for (const varying of ['vEye', 'vBurn']) {
      expect(material.vertexShader).toContain(`varying vec`);
      expect(material.vertexShader).toContain(varying);
      expect(material.fragmentShader).toContain(varying);
    }
    expect(material.vertexShader).toContain('attribute vec4 aBurn;');
    // Each art layer chooses one of the six art/frame samplers. The extra brass tap is edge-only.
    expect(material.fragmentShader.match(/uniform sampler2D/g)).toHaveLength(6);
    expect(material.fragmentShader.match(/textureGrad\(/g)).toHaveLength(7);
    expect(material.fragmentShader).toContain('if (frame.a > EDGE_MIN_ALPHA) {');
    expect(material.fragmentShader.match(/texture2D\(/g)).toHaveLength(1);
    material.dispose();
  });

  it('writes and clears the per-instance burn', () => {
    const geometry = new THREE.PlaneGeometry(1, 1);
    addCardFaceAttributes(geometry, 4);
    const burn = geometry.getAttribute('aBurn') as THREE.InstancedBufferAttribute;
    expect(burn.itemSize).toBe(4);
    expect(burn.count).toBe(4);
    writeCardBurn(geometry, 2, true, 0.5, 0.25, 0.75);
    expect([burn.getX(2), burn.getY(2), burn.getZ(2), burn.getW(2)]).toEqual([0.5, 0.25, 0.75, 1]);
    writeCardBurn(geometry, 2, false);
    expect([burn.getX(2), burn.getY(2), burn.getZ(2), burn.getW(2)]).toEqual([0, 0, 0, 0]);
    geometry.dispose();
  });

  it('wires the fan material to the atlas depths', () => {
    const fan = new CardFan({ syncLabels: false, loadArt: false });
    fan.setArt({ atlas, pages });
    const body = fan.root.getObjectByName('card-fan-bodies') as THREE.InstancedMesh;
    const depths = uniform<THREE.Vector4>(body.material as THREE.ShaderMaterial, 'uDepths');
    const diameter = 2 * atlas.frames.attack.window.radius * ATLAS_CARD_WIDTH;
    const back = (Object.values(atlas.cards)[0] as (typeof atlas.cards)[string]).stack.back.depth;
    expect(depths.x).toBeCloseTo(back / diameter, 9);
    fan.dispose();
  });
});
