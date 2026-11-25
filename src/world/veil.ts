import * as THREE from 'three';
import { PALETTE } from '../palette.ts';

/** The actual dressed floor includes lightmaps and puzzle textures missing from the source kits. */
export function floorTextures(root: THREE.Object3D): Set<THREE.Texture> {
  const textures = new Set<THREE.Texture>();
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) {
      for (const value of Object.values(material)) {
        if (value instanceof THREE.Texture && !value.isRenderTargetTexture) textures.add(value);
      }
    }
  });
  return textures;
}

export interface VeilOptions {
  /**
   * Extra objects whose programs must exist before play, such as every room variant that is not
   * in `scene` yet. Each is compiled against `scene`, so the lights in `scene` must already be the
   * worst-case rig (4 room lights plus the lantern): a program is keyed by its light counts, and a
   * different count at runtime links a new program mid-session.
   */
  variants?: readonly THREE.Object3D[];
  /** Unshadowed point lights whose parent rooms can be culled during play. */
  roomPointLights?: readonly THREE.PointLight[];
  /** Textures uploaded per frame. A 2048 px texture is several MB, so keep this small. */
  uploadsPerFrame?: number;
  /** Frames the veil takes to fade out once everything is resident. */
  fadeFrames?: number;
  /** Frame scheduler. Defaults to the XR session's when presenting, else `requestAnimationFrame`. */
  nextFrame?: () => Promise<void>;
  /** Called after each phase, for tests and loading indicators. */
  onPhase?: (phase: 'compile' | 'upload' | 'fade' | 'done') => void;
}

/** A sphere around the head, so the veil covers the view in XR where a DOM overlay is invisible. */
function createVeilSphere(): THREE.Mesh {
  const material = new THREE.MeshBasicMaterial({
    color: PALETTE.void,
    side: THREE.BackSide,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    fog: false,
    toneMapped: false,
  });
  const sphere = new THREE.Mesh(new THREE.SphereGeometry(5, 16, 12), material);
  sphere.name = 'load-veil';
  sphere.renderOrder = 1000;
  sphere.frustumCulled = false;
  return sphere;
}

function defaultNextFrame(renderer: THREE.WebGLRenderer): () => Promise<void> {
  return () =>
    new Promise((resolve) => {
      const session = renderer.xr.isPresenting ? renderer.xr.getSession() : null;
      if (!session) {
        requestAnimationFrame(() => resolve());
        return;
      }
      const finish = () => {
        session.removeEventListener('end', finish);
        resolve();
      };
      session.addEventListener('end', finish, { once: true });
      session.requestAnimationFrame(finish);
    });
}

async function compileRoomLightVariants(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  roomLights: readonly THREE.PointLight[],
): Promise<void> {
  if (roomLights.length === 0) {
    await renderer.compileAsync(scene, camera);
    return;
  }
  const previous = roomLights.map((light) => light.visible);
  const compileLights = new THREE.Group();
  for (let count = 0; count <= roomLights.length; count++) {
    // Three.js keys programs by light count. Its scene walk runs synchronously before the link wait.
    scene.add(compileLights);
    for (const light of roomLights) light.visible = false;
    let linking: Promise<THREE.Object3D>;
    try {
      linking = renderer.compileAsync(scene, camera);
    } finally {
      compileLights.removeFromParent();
      roomLights.forEach((light, i) => {
        light.visible = previous[i];
      });
    }
    await linking;
    if (count < roomLights.length) compileLights.add(new THREE.PointLight(0, 0));
  }
}

/**
 * Hides the world behind a veil while it precompiles shader programs
 * (`renderer.compileAsync`), then spreads texture uploads (`renderer.initTexture`) over several
 * frames, then fades out. The veil mesh is added to `scene` and removed again when done.
 *
 * `textures` should be decoded already (ImageBitmap-backed or KTX2). Decode with
 * `createImageBitmap` before calling, so the frames spent here are GPU uploads only.
 */
export async function runVeil(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  textures: readonly THREE.Texture[],
  options: VeilOptions = {},
): Promise<void> {
  const {
    variants = [],
    roomPointLights = [],
    uploadsPerFrame = 2,
    fadeFrames = 24,
    onPhase,
  } = options;
  const nextFrame = options.nextFrame ?? defaultNextFrame(renderer);
  const batch = Math.max(1, Math.floor(uploadsPerFrame));
  const veil = createVeilSphere();
  const material = veil.material as THREE.MeshBasicMaterial;
  const head = new THREE.Vector3();
  const follow = () => veil.position.copy(camera.getWorldPosition(head));

  scene.add(veil);
  material.opacity = 1;
  try {
    follow();
    // One frame so the veil is on screen before the first long task.
    await nextFrame();

    await compileRoomLightVariants(renderer, scene, camera, roomPointLights);
    for (const variant of variants) await renderer.compileAsync(variant, camera, scene);
    onPhase?.('compile');

    for (let i = 0; i < textures.length; i += batch) {
      for (const texture of textures.slice(i, i + batch)) renderer.initTexture(texture);
      follow();
      await nextFrame();
    }
    onPhase?.('upload');

    for (let frame = 1; frame <= fadeFrames; frame++) {
      material.opacity = 1 - frame / fadeFrames;
      follow();
      await nextFrame();
    }
    onPhase?.('fade');
  } finally {
    veil.removeFromParent();
    veil.geometry.dispose();
    material.dispose();
  }
  onPhase?.('done');
}
