import * as THREE from 'three';
import { expect, it } from 'vitest';
import { createHandMenuGlyph } from '../src/xr/hand-menu-glyph.ts';

it('presses once from the visible side, following the moving palm through hold and release', () => {
  const glyph = createHandMenuGlyph();
  const palm = {
    position: new THREE.Vector3(0, 0.2, -0.5),
    forward: new THREE.Vector3(0, 1, 0),
    backNormal: new THREE.Vector3(0, 0, 1),
    surfaceOffset: 0.017,
  };
  const eye = new THREE.Vector3();
  const tip = (depth: number, x = 0) =>
    palm.position.clone().add(new THREE.Vector3(x, 0, palm.surfaceOffset + depth));
  expect(glyph.update(palm, tip(0.041), eye)).toBe(false);
  expect(glyph.root.visible).toBe(true);
  expect(glyph.root.position.z - palm.position.z).toBeCloseTo(palm.surfaceOffset);
  expect(glyph.update(palm, tip(0.005, 0.04), eye)).toBe(false);
  expect(glyph.update(palm, tip(0.042), eye)).toBe(false);
  expect(glyph.update(palm, tip(0.005), eye)).toBe(true);
  expect(glyph.held).toBe(true);
  palm.position.z += 0.08;
  expect(glyph.update(palm, tip(0.005), eye)).toBe(false);
  expect(glyph.held).toBe(true);
  expect(glyph.update(palm, tip(0.043), eye)).toBe(false);
  expect(glyph.held).toBe(false);
  expect(glyph.update(palm, tip(0.005), eye)).toBe(true);
});

it('requires a tracked palm facing the player and a new approach after tracking is lost', () => {
  const glyph = createHandMenuGlyph();
  const palm = {
    position: new THREE.Vector3(),
    forward: new THREE.Vector3(0, 1, 0),
    backNormal: new THREE.Vector3(0, 0, 1),
    surfaceOffset: 0.028,
  };
  const eye = new THREE.Vector3(0, 0, -0.4);
  const near = new THREE.Vector3(0, 0, palm.surfaceOffset + 0.003);
  const far = new THREE.Vector3(0, 0, palm.surfaceOffset + 0.04);
  glyph.update(palm, far, eye);
  expect(glyph.update(palm, near, eye)).toBe(false);
  expect(glyph.root.visible).toBe(false);
  eye.z = 0.4;
  glyph.update(palm, far, eye);
  expect(glyph.update(palm, near, eye)).toBe(true);
  expect(glyph.update(null, near, eye)).toBe(false);
  expect(glyph.root.visible).toBe(false);
  expect(glyph.update(palm, near, eye)).toBe(false);
});
