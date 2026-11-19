import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

/** Preserve material texture references while testing geometry without browser image decoding. */
export function nodeGeometryLoader(): GLTFLoader {
  const loader = new GLTFLoader();
  loader.register(() => ({
    name: 'node-texture-placeholder',
    loadTexture: async () => new THREE.Texture(),
  }));
  return loader;
}
