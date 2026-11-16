import type * as THREE from 'three';
import type { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { createKtx2Loader } from '../world/ktx2.ts';

/**
 * Runs `run` once, with the renderer, the first time `object` is drawn. Views that are never
 * rendered (unit tests, hidden proofs) never start their texture loads, and modules that are not
 * handed the renderer can still configure a KTX2 loader for it. `object` must be a renderable
 * (Mesh, Line, Points, Sprite): three.js only calls `onBeforeRender` on those.
 */
export function onFirstRender(
  object: THREE.Object3D,
  run: (renderer: THREE.WebGLRenderer) => void,
): void {
  const previous = object.onBeforeRender;
  object.onBeforeRender = function (this: THREE.Object3D, renderer, ...rest) {
    object.onBeforeRender = previous;
    run(renderer);
    previous.call(this, renderer, ...rest);
  };
}

const loaders = new WeakMap<THREE.WebGLRenderer, KTX2Loader>();

/** One KTX2 loader (and transcoder worker pool) per renderer, shared by every UI texture load. */
export function sharedKtx2Loader(renderer: THREE.WebGLRenderer): KTX2Loader {
  let loader = loaders.get(renderer);
  if (!loader) {
    loader = createKtx2Loader(renderer);
    loaders.set(renderer, loader);
  }
  return loader;
}
