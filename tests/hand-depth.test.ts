import * as THREE from 'three';
import { expect, it, vi } from 'vitest';
import { createHandDepthPass } from '../src/xr/hand-depth.ts';

it('draws hand depth and boards in one render and restores live hand properties', () => {
  const world = new THREE.Scene();
  const boards = new THREE.Scene();
  const board = new THREE.Mesh();
  boards.add(board);
  const hands = new THREE.Group();
  const rig = new THREE.Group();
  const hand = new THREE.Mesh();
  const original = hand.material;
  rig.add(hand);
  hands.add(rig);
  world.add(hands);
  const camera = new THREE.PerspectiveCamera();
  const render = vi.fn();
  const depth = createHandDepthPass({ render }, world, hands);
  rig.visible = false;
  depth.render(boards, camera);
  expect(render).toHaveBeenCalledOnce();
  expect(render).toHaveBeenCalledWith(boards, camera);
  render.mockClear();
  rig.visible = true;
  render.mockImplementationOnce((scene, view) => {
    expect(scene).toBe(boards);
    expect(scene.children).toEqual([board, hands]);
    expect(view).toBe(camera);
    expect(hand.material).toMatchObject({ colorWrite: false, depthWrite: true });
    expect(rig.renderOrder).toBeLessThan(board.renderOrder);
    expect(hand.renderOrder).toBeLessThan(board.renderOrder);
  });
  depth.render(boards, camera);
  expect(render).toHaveBeenCalledTimes(1);
  expect(world.children).toEqual([hands]);
  expect(hand.material).toBe(original);
  expect(hand.renderOrder).toBe(0);
  expect(rig.renderOrder).toBe(0);
  render.mockImplementationOnce(() => {
    throw new Error('render failure');
  });
  expect(() => depth.render(boards, camera)).toThrow('render failure');
  expect(hands.parent).toBe(world);
  expect(hand.material).toBe(original);
  expect(rig.renderOrder).toBe(0);
  depth.dispose();
});
