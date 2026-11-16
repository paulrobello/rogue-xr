import type * as THREE from 'three';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';

/** Where the Basis transcoder is served from; scripts/prepare-assets.ts stages it into `public/`. */
export const TRANSCODER_PATH = '/vendor/basis/';

/** One KTX2Loader configured with the self-hosted transcoder and this GPU's format support. */
export function createKtx2Loader(renderer: THREE.WebGLRenderer): KTX2Loader {
  const loader = new KTX2Loader().setTranscoderPath(TRANSCODER_PATH);
  loader.detectSupport(renderer);
  return loader;
}
