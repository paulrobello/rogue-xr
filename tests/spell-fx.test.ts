// @vitest-environment node
import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { IMPACT_SECONDS } from '../src/combat-view/impact-timing.ts';
import {
  attackVisualKind,
  BOLT_CAPACITY,
  SPELL_FX_POINTS,
  SpellFx,
} from '../src/combat-view/spell-fx.ts';

const from = { x: 0, y: 1, z: 0 };
const to = { x: 0, y: 1.3, z: -1.5 };

function run(fx: SpellFx, seconds: number): void {
  for (let t = 0; t < seconds - 1e-9; t += 1 / 72) fx.update(1 / 72);
}

describe('spell fx', () => {
  it('selects a stable visual family for every attack card, including upgrades', () => {
    expect(attackVisualKind('strike')).toBe('physical');
    expect(attackVisualKind('strike+')).toBe('physical');
    expect(attackVisualKind('cog-toss')).toBe('cog');
    expect(attackVisualKind('ratchet-flurry')).toBe('flurry');
    expect(attackVisualKind('rivet-volley')).toBe('volley');
    expect(attackVisualKind('escapement-hammer')).toBe('hammer');
    expect(attackVisualKind('cogstorm')).toBe('storm');
    expect(attackVisualKind('furnace-brand')).toBe('furnace');
    expect(attackVisualKind('arc-bolt')).toBe('lightning');
    expect(attackVisualKind(null)).toBe('lightning');
  });

  it('keeps family colour on the pooled bolt and family impact through its lifetime', () => {
    const physical = new SpellFx();
    const lightning = new SpellFx();
    const physicalPoints = physical.getObjectByName('spell-fx-points') as THREE.Points;
    const lightningPoints = lightning.getObjectByName('spell-fx-points') as THREE.Points;
    physical.launch(from, to, 0.3, 1, 'card', 0, attackVisualKind('strike'));
    lightning.launch(from, to, 0.3, 1, 'card', 0, attackVisualKind('arc-bolt'));
    physical.update(0.05);
    lightning.update(0.05);
    const p = physicalPoints.geometry.getAttribute('color') as THREE.BufferAttribute;
    const l = lightningPoints.geometry.getAttribute('color') as THREE.BufferAttribute;
    const component = (attribute: THREE.BufferAttribute, axis: number, i: number): number =>
      axis === 0 ? attribute.getX(i) : axis === 1 ? attribute.getY(i) : attribute.getZ(i);
    const coloursDiffer = Array.from({ length: p.count }, (_, i) =>
      [0, 1, 2].some((axis) => Math.abs(component(p, axis, i) - component(l, axis, i)) > 1e-6),
    ).some(Boolean);
    expect(coloursDiffer).toBe(true);
    physical.impact(to, from, 1, attackVisualKind('strike'));
    expect(physical.flashing).toBe(1);
    run(physical, 1);
    expect(physical.active).toBe(false);
    physical.dispose();
    lightning.dispose();
  });

  it('reuses each metal projectile mesh across casts and frees its geometry once', () => {
    const fx = new SpellFx();
    const mesh = fx.getObjectByName('attack-solid-0') as THREE.Mesh;
    const geometries = [];
    for (const kind of ['cog', 'volley', 'hammer', 'cog'] as const) {
      fx.launch(from, to, 0.3, 1, 'card', 0, kind);
      fx.update(1 / 72);
      expect(mesh.visible).toBe(true);
      geometries.push(mesh.geometry);
      fx.reset();
      expect(mesh.visible).toBe(false);
    }
    expect(new Set(geometries).size).toBe(3);
    expect(geometries[3]).toBe(geometries[0]);
    const dispose = vi.spyOn(mesh.geometry, 'dispose');
    fx.dispose();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('keeps the additive trails and sparks in one fixed points buffer', () => {
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
