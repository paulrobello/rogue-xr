import * as THREE from 'three';
import { expect, it } from 'vitest';
import { createMenuTouch } from '../src/xr/menu-touch.ts';

const createFixture = () => {
  const menu = new THREE.Group();
  menu.position.set(1, 0.8, -1);
  menu.rotation.set(0.3, 0.7, 0);
  menu.scale.setScalar(0.432);
  const geometry = new THREE.PlaneGeometry(0.18, 0.13);
  const material = new THREE.MeshBasicMaterial();
  const buttons = ['map', 'settings'].map((name, index) => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.x = index * 0.2;
    mesh.name = name;
    menu.add(mesh);
    return mesh;
  });
  menu.updateMatrixWorld(true);
  const touch = createMenuTouch();
  const front = new THREE.Vector3(0, 0, 1).transformDirection(menu.matrixWorld);
  const tip = (x: number, depth: number) =>
    menu.localToWorld(new THREE.Vector3(x, 0, 0)).addScaledVector(front, depth);
  const sample = (x: number, depth: number) =>
    touch.sample(tip(x, depth), front, [menu], (object) => object.name);
  return { buttons, front, sample, touch };
};

it('presses tilted, scaled menu buttons once per approach and rearms after withdrawal', () => {
  const { sample, touch } = createFixture();
  expect(sample(0, 0.04).pressed).toBeNull();
  expect(sample(0, 0.013)).toEqual({ hovered: 'map', pressed: null });
  expect(sample(0, 0.007).pressed).toBe('map');
  expect(touch.held).toBe(true);
  expect(sample(0.2, 0.004).pressed).toBeNull();
  expect(sample(0.2, 0.028).pressed).toBeNull();
  expect(touch.held).toBe(false);
  expect(sample(0.2, 0.006).pressed).toBe('settings');
});

it('ignores side and rear entry, hidden controls, and a tip reacquired on a button', () => {
  const { buttons, front, sample, touch } = createFixture();
  expect(sample(0, -0.02).pressed).toBeNull();
  expect(sample(0, 0.007).pressed).toBeNull();
  expect(sample(0, 0.033).pressed).toBeNull();
  buttons[0].visible = false;
  expect(sample(0, 0.006)).toEqual({ hovered: null, pressed: null });
  buttons[0].visible = true;
  expect(sample(0.25, 0.006).pressed).toBeNull();
  touch.sample(null, front, [], () => '');
  expect(sample(0, 0.006).pressed).toBeNull();
  expect(sample(0, 0.04).pressed).toBeNull();
  expect(sample(0, 0.001).pressed).toBe('map');
});
