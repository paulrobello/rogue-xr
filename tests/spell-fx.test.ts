// @vitest-environment node
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { IMPACT_SECONDS } from '../src/combat-view/impact-timing.ts';
import { BOLT_CAPACITY, SPELL_FX_POINTS, SpellFx } from '../src/combat-view/spell-fx.ts';

const from = { x: 0, y: 1, z: 0 };
const to = { x: 0, y: 1.3, z: -1.5 };

function run(fx: SpellFx, seconds: number): void {
  for (let t = 0; t < seconds - 1e-9; t += 1 / 72) fx.update(1 / 72);
}

describe('spell fx', () => {
  it('is one pre-sized additive points draw that never reallocates', () => {
    const fx = new SpellFx();
    const points = fx.getObjectByName('spell-fx-points') as THREE.Points;
    const material = points.material as THREE.PointsMaterial;
    expect(material.blending).toBe(THREE.AdditiveBlending);
    expect(material.toneMapped).toBe(false);
    const position = points.geometry.getAttribute('position') as THREE.BufferAttribute;
    expect(position.count).toBe(SPELL_FX_POINTS);
    const arrays = ['position', 'color', 'pointScale'].map(
      (name) => (points.geometry.getAttribute(name) as THREE.BufferAttribute).array,
    );
    fx.launch(from, to, 0.3, 1, 'sigil');
    run(fx, 0.2);
    fx.impact(to, from, 1);
    run(fx, 0.2);
    ['position', 'color', 'pointScale'].forEach((name, i) => {
      expect((points.geometry.getAttribute(name) as THREE.BufferAttribute).array).toBe(arrays[i]);
    });
    fx.dispose();
  });

  it('flies a bolt along its path and drops it on arrival', () => {
    const fx = new SpellFx();
    const points = fx.getObjectByName('spell-fx-points') as THREE.Points;
    expect(points.visible).toBe(false);
    fx.launch(from, to, 0.3, 0.5, 'card');
    expect(fx.flying).toBe(1);
    expect(points.visible).toBe(true);
    run(fx, 0.15);
    expect(fx.flying).toBe(1);
    run(fx, 0.2);
    expect(fx.flying).toBe(0);
    expect(fx.active).toBe(false);
    expect(points.visible).toBe(false);
    fx.dispose();
  });

  it('reuses the oldest bolt when every slot is flying', () => {
    const fx = new SpellFx();
    for (let i = 0; i <= BOLT_CAPACITY; i++) fx.launch(from, to, 1, 1, 'sigil');
    expect(fx.flying).toBe(BOLT_CAPACITY);
    fx.dispose();
  });

  it('flashes and throws sparks at contact, stops the bolt there, and burns out', () => {
    const fx = new SpellFx();
    fx.launch(from, to, 0.3, 1, 'sigil');
    run(fx, 0.29);
    fx.impact(to, from, 1);
    expect(fx.flying).toBe(0);
    expect(fx.flashing).toBe(1);
    run(fx, 0.05);
    const points = fx.getObjectByName('spell-fx-points') as THREE.Points;
    const color = points.geometry.getAttribute('color') as THREE.BufferAttribute;
    let lit = 0;
    for (let i = 0; i < color.count; i++) if (color.getX(i) > 0) lit++;
    expect(lit).toBeGreaterThan(10);
    run(fx, IMPACT_SECONDS + 0.6);
    expect(fx.flashing).toBe(0);
    expect(fx.active).toBe(false);
    fx.dispose();
  });
});
