import * as THREE from 'three';
import { loadLightmappedTemplate } from './lightmap.ts';

/**
 * `?view=lightmap-proof`: the room-proof fixture lit only by its lightmap, framed like the Blender
 * reference render (runtime eye (0, 1.6, 2.4) looking -Z, 70 degree vertical FOV, no tone mapping)
 * so the two images can be compared pixel for pixel.
 */
export async function mountLightmapProof(
  scene: THREE.Scene,
  rig: THREE.Group,
  camera: THREE.PerspectiveCamera,
  renderer: THREE.WebGLRenderer,
): Promise<void> {
  renderer.toneMapping = THREE.NoToneMapping;
  // The Blender world colour seen through the window: (0.25, 0.35, 0.55) at strength 0.6.
  scene.background = new THREE.Color().setRGB(0.15, 0.21, 0.33, THREE.LinearSRGBColorSpace);
  rig.position.set(0, 0, 2.4);
  camera.fov = 70;
  camera.updateProjectionMatrix();
  scene.add(await loadLightmappedTemplate('/assets/fixtures/room-proof', 'room-proof'));
  (window as unknown as { __lightmapProofReady: boolean }).__lightmapProofReady = true;
}
