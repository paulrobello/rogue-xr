import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { FoundryFx } from '../src/combat-view/foundry-fx.ts';

describe('Foundry card FX', () => {
  it('keeps the Rivet Plate snap and fade with three lit parts per layer', () => {
    const fx = new FoundryFx(false);
    const at = new THREE.Vector3(0, 1, -1);
    const player = new THREE.Vector3(0, 1.5, 0);
    const plates = fx.getObjectByName('fx-rivet-plate');
    if (!plates) throw new Error('Missing Rivet Plate effect');
    expect(plates.children).toHaveLength(3);
    for (const layer of plates.children) {
      expect(layer.children).toHaveLength(3);
      expect(layer.children[2]).toBeInstanceOf(THREE.Mesh);
      expect(layer.children.map((part) => part.renderOrder)).toEqual([0, 1, 2]);
      const panel = layer.children[1] as THREE.Mesh;
      expect(panel.material).toBeInstanceOf(THREE.MeshStandardMaterial);
    }
    fx.play('rivet-plate', at, player, [], at, 0.07);
    fx.update(0.195);
    expect(plates.visible).toBe(true);
    expect(plates.children.map((plate) => plate.position.x)).toEqual([-0.065, 0, 0.065]);
    fx.update(0.125);
    expect(plates.children.map((plate) => Math.abs(plate.position.x))).toEqual([0, 0, 0]);
    fx.update(0.6);
    expect(plates.visible).toBe(false);
    fx.dispose();
  });

  it('starts each defensive/status silhouette once and expires it from a bounded pool', () => {
    const fx = new FoundryFx(true);
    const origin = new THREE.Vector3(0, 1, -1);
    const player = new THREE.Vector3(0, 1.5, 0);
    const target = new THREE.Vector3(0, 1, -2);
    for (const id of [
      'rivet-plate',
      'brass-bulwark',
      'anchor-glyph',
      'rust-spray',
      'quench-seal',
      'counterstroke',
    ]) {
      fx.play(`${id}+`, origin, player, [target], origin, 0.15);
      fx.update(0.1);
      expect(fx.children.some((child) => child.visible)).toBe(false);
      fx.update(0.08);
      expect(fx.getObjectByName(`fx-${id}`)?.visible).toBe(true);
      expect(fx.children.some((child) => child.visible)).toBe(true);
      for (let frame = 0; frame < 40; frame++) fx.update(1 / 30);
    }
    expect(fx.children.filter((child) => child.visible)).toHaveLength(0);
    fx.dispose();
  });
});
