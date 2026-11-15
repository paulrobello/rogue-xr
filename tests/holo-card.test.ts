import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  createHoloCard,
  type HoloCardSpec,
  nextStencilRef,
  PORTAL_RENDER_ORDER,
} from '../src/cards/holo-card.ts';

const tex = (): THREE.Texture => new THREE.Texture();
const spec = (): HoloCardSpec => ({
  frame: tex(),
  width: 0.06,
  aspect: 1.5,
  window: { u: 0.5, v: 0.25, radius: 0.4 },
  foil: 0.3,
  layers: [
    { texture: tex(), depth: 0.03, size: 2.5, opaque: true },
    { texture: tex(), depth: 0.01, size: 1, offset: [0.1, -0.1] },
    { texture: tex(), depth: 0.005, size: 0.5, additive: true, opacity: 0.8 },
  ],
});
const part = (card: ReturnType<typeof createHoloCard>, name: string) => {
  const mesh = card.group.getObjectByName(name) as THREE.Mesh | undefined;
  if (!mesh) throw new Error(`missing ${name}`);
  return { mesh, material: mesh.material as THREE.Material };
};

describe('createHoloCard', () => {
  it('stamps the window into the stencil as an invisible, depth-writing disc', () => {
    const card = createHoloCard(spec(), 7);
    const { mesh, material } = part(card, 'window-mask');
    expect(material.colorWrite).toBe(false);
    expect(material.depthWrite).toBe(true);
    expect(material.stencilWrite).toBe(true);
    expect(material.stencilRef).toBe(7);
    expect(material.stencilFunc).toBe(THREE.AlwaysStencilFunc);
    expect(material.stencilZPass).toBe(THREE.ReplaceStencilOp);
    // Window centre: u 0.5 -> x 0; v 0.25 of a 0.09 m tall card -> y 0.0225.
    expect(mesh.position.x).toBeCloseTo(0);
    expect(mesh.position.y).toBeCloseTo(0.0225);
    expect(mesh.renderOrder).toBe(PORTAL_RENDER_ORDER);
  });

  it('draws layers behind the face, inside its own stencil, after the mask and back to front', () => {
    const card = createHoloCard(spec(), 9);
    const layers = [0, 1, 2].map((i) => part(card, `layer-${i}`));
    layers.forEach(({ mesh, material }, i) => {
      expect(material.stencilFunc).toBe(THREE.EqualStencilFunc);
      expect(material.stencilRef).toBe(9);
      expect(material.stencilZPass).toBe(THREE.KeepStencilOp);
      expect(material.depthTest).toBe(false);
      expect(mesh.position.z).toBeLessThan(0);
      expect(mesh.renderOrder).toBe(PORTAL_RENDER_ORDER + 1 + i);
    });
    expect(layers[0]?.material.transparent).toBe(false);
    expect(layers[2]?.material.blending).toBe(THREE.AdditiveBlending);
    // Offset is in window diameters: 0.1 x 0.048 m.
    expect(layers[1]?.mesh.position.x).toBeCloseTo(0.0048);
    expect(part(card, 'foil').mesh.renderOrder).toBe(PORTAL_RENDER_ORDER + 4);
  });

  it('pulses additive layers below their peak opacity', () => {
    const card = createHoloCard(spec(), 3);
    const glow = part(card, 'layer-2').material;
    for (const t of [0, 0.4, 1.3, 2.2]) {
      card.update(t);
      expect(glow.opacity).toBeGreaterThanOrEqual(0.8 * 0.6 - 1e-9);
      expect(glow.opacity).toBeLessThanOrEqual(0.8 + 1e-9);
    }
  });

  it('hands out stencil refs within 1..255', () => {
    const refs = Array.from({ length: 600 }, () => nextStencilRef());
    expect(Math.min(...refs)).toBe(1);
    expect(Math.max(...refs)).toBe(255);
  });
});
