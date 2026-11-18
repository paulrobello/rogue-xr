import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { FoundryFx } from '../src/combat-view/foundry-fx.ts';

describe('Foundry card FX', () => {
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
