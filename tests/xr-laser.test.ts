import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { createLaser, LASER_IDLE_LENGTH } from '../src/xr/laser.ts';

const tipOf = (laser: ReturnType<typeof createLaser>) =>
  new THREE.Vector3().setFromMatrixPosition(laser.tip.matrixWorld);

describe('controller laser', () => {
  const pointedRay = () => {
    const rig = new THREE.Group();
    rig.position.set(0, 0.5, 0);
    const ray = new THREE.Object3D();
    ray.position.set(0.2, 1, 0);
    ray.rotation.y = Math.PI / 2; // -Z now points along -X
    rig.add(ray);
    return ray;
  };

  it('starts hidden and lives in the given root', () => {
    const root = new THREE.Scene();
    const laser = createLaser(root);
    expect(root.children).toContain(laser.beam);
    expect(laser.beam.visible).toBe(false);
    expect(laser.tip.visible).toBe(false);
  });

  it('ends the beam on a hit along the ray -Z in world space', () => {
    const laser = createLaser(new THREE.Scene());
    laser.follow(pointedRay(), 2, true);
    expect(laser.beam.visible).toBe(true);
    expect(laser.tip.visible).toBe(true);
    const tip = tipOf(laser);
    expect(tip.x).toBeCloseTo(0.2 - 2);
    expect(tip.y).toBeCloseTo(1.5);
    expect(tip.z).toBeCloseTo(0);
    const far = new THREE.Vector3(0, 0, -1).applyMatrix4(laser.beam.matrixWorld);
    expect(far.distanceTo(tip)).toBeCloseTo(0);
  });

  it('draws the idle length without a tip when nothing is hit', () => {
    const laser = createLaser(new THREE.Scene());
    laser.follow(pointedRay(), null, true);
    expect(laser.tip.visible).toBe(false);
    const start = new THREE.Vector3().applyMatrix4(laser.beam.matrixWorld);
    const end = new THREE.Vector3(0, 0, -1).applyMatrix4(laser.beam.matrixWorld);
    expect(start.distanceTo(end)).toBeCloseTo(LASER_IDLE_LENGTH);
  });

  it('hides both parts and frees GPU resources on dispose', () => {
    const root = new THREE.Scene();
    const laser = createLaser(root);
    laser.follow(pointedRay(), 1, true);
    laser.follow(pointedRay(), 1, false);
    expect(laser.beam.visible || laser.tip.visible).toBe(false);
    laser.dispose();
    expect(root.children).toHaveLength(0);
  });
});
