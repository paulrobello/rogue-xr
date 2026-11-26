import type { StandardHand } from '@par/xr-workspace';
import * as THREE from 'three';
import { expect, it } from 'vitest';
import { createHandCalibration } from '../src/xr/hand-calibration.ts';

function visual(indexBone: number, indexSkin: number, thumbSkin: number): StandardHand {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute([indexSkin, 0, 0, thumbSkin, 0, 0], 3),
  );
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute([0, 0, 0, 0, 1, 0, 0, 0], 4));
  geometry.setAttribute(
    'skinWeight',
    new THREE.Float32BufferAttribute([1, 0, 0, 0, 1, 0, 0, 0], 4),
  );
  const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshBasicMaterial());
  const index = new THREE.Bone();
  index.name = 'index-finger-tip';
  index.position.x = indexBone;
  const thumb = new THREE.Bone();
  thumb.name = 'thumb-tip';
  mesh.add(index, thumb);
  mesh.bind(new THREE.Skeleton([index, thumb]));
  mesh.skeleton.update();
  return {
    root: new THREE.Group().add(mesh),
    indexTip: new THREE.Vector3(indexBone, 0, 0),
    thumbTip: new THREE.Vector3(1.013, 0, 0),
  } as StandardHand;
}

it('compares paired fingertip surfaces in game space even when the other thumb is unavailable', () => {
  const rig = new THREE.Group();
  rig.position.x = 1;
  const reference = {} as XRReferenceSpace;
  const left = new Map([
    ['index-finger-tip', { x: 0 }],
    ['thumb-tip', { x: 0.012 }],
  ]);
  const right = new Map([['index-finger-tip', { x: 0.02 }]]);
  const frame = {
    getJointPose: ({ x }: { x: number }) => ({
      radius: 0.005,
      transform: { position: { x, y: 0, z: 0 } },
    }),
  } as unknown as XRFrame;
  const calibration = createHandCalibration(rig);
  calibration.sample(frame, reference, [
    {
      input: { handedness: 'left', hand: left } as unknown as XRInputSource,
      visual: visual(1.003, 1.007, 1.011),
    },
    {
      input: { handedness: 'right', hand: right } as unknown as XRInputSource,
      visual: visual(1.025, 1.023, 1.06),
    },
  ]);
  const [sample] = calibration.log().samples;
  expect(sample.crossIndex).toEqual({
    jointCentreMm: 20,
    trackedSurfaceEstimateMm: 10,
    renderedBoneMm: 22,
    sampledSkinMm: 16,
  });
  expect(sample.left?.indexBoneErrorMm).toBe(3);
  expect(sample.left?.pinch?.sampledSkinMm).toBe(4);
  expect(sample.right?.pinch).toBeNull();
});
