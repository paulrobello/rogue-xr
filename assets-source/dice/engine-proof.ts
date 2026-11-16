// In-engine stills of the P5-T7 dice, loaded by assets-source/dice/engine_shot.py through the
// running Vite dev server (it serves and transforms this file; it is outside src/, biome and tsc).
// Uses the real runtime path: loadDice() for the GLBs and the UI atlas KTX2 pages bound with
// bindFaceMaps(), posed with the presenter's correction (correctionRotation from identity).
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { type DiceAsset, loadDice } from '/src/dice/dice-asset.ts';
import { correctionRotation, D8_CIRCUMRADIUS, type DieKind } from '/src/dice/faces.ts';
import { QUAT_IDENTITY } from '/src/dice/quat.ts';
import { sharedKtx2Loader } from '/src/ui/first-render.ts';
import { loadUiAtlas, UI_ATLAS_BASE } from '/src/ui/icon-atlas.ts';

const REST = { d6: 0.02, d8: D8_CIRCUMRADIUS / Math.sqrt(3) };

export async function mountDiceProof(w: number, h: number) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setSize(w, h);
  renderer.setPixelRatio(1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.AgXToneMapping;
  renderer.shadowMap.enabled = true;
  document.body.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#1c140e');
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.35;
  const key = new THREE.DirectionalLight('#ffd9a0', 2.2);
  key.position.set(-0.4, 0.9, 0.6);
  key.castShadow = true;
  key.shadow.camera.left = key.shadow.camera.bottom = -0.4;
  key.shadow.camera.right = key.shadow.camera.top = 0.4;
  key.shadow.mapSize.set(1024, 1024);
  scene.add(key, new THREE.HemisphereLight('#f3be65', '#231d1a', 0.35));
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(2, 2),
    new THREE.MeshStandardMaterial({ color: '#583c26', roughness: 0.7 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);
  const camera = new THREE.PerspectiveCamera(30, w / h, 0.005, 10);

  const asset: DiceAsset = await loadDice();
  const atlas = await loadUiAtlas();
  const ktx2 = sharedKtx2Loader(renderer);
  const page = async (name: 'dice-d6' | 'dice-d8') => {
    const t = await ktx2.loadAsync(`${UI_ATLAS_BASE}/${atlas.pages[name]?.ktx2}`);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    return t;
  };
  asset.bindFaceMaps({ d6: await page('dice-d6'), d8: await page('dice-d8') });

  const group = new THREE.Group();
  scene.add(group);
  const place = (kind: DieKind, face: number, x: number, z: number) => {
    const mesh = asset.spawn(kind);
    const c = correctionRotation(QUAT_IDENTITY, asset.diceAssetFaces(kind), face);
    mesh.quaternion.set(c.x, c.y, c.z, c.w);
    mesh.position.set(x, REST[kind], z);
    group.add(mesh);
    return mesh;
  };
  const clear = () => {
    for (const child of [...group.children]) child.removeFromParent();
  };

  return {
    /** `hero`: face 0 up beside a second die, seated three-quarter view. `lineup`: every face up. */
    show(kind: DieKind, mode: 'hero' | 'lineup') {
      clear();
      const count = kind === 'd6' ? 6 : 8;
      if (mode === 'hero') {
        place(kind, 0, -0.028, 0);
        place(kind, count - 2, 0.03, 0.012);
        camera.fov = 30;
        camera.position.set(0.07, 0.19, 0.16);
        camera.lookAt(0, 0.012, 0);
      } else {
        for (let i = 0; i < count; i++) place(kind, i, (i - (count - 1) / 2) * 0.06, 0);
        camera.fov = 40;
        camera.position.set(0, kind === 'd6' ? 0.27 : 0.37, kind === 'd6' ? 0.23 : 0.31);
        camera.lookAt(0, 0, 0.0);
      }
      camera.updateProjectionMatrix();
      renderer.info.reset();
      renderer.render(scene, camera);
      return {
        calls: renderer.info.render.calls,
        triangles: renderer.info.render.triangles,
        programs: renderer.info.programs?.length ?? 0,
        dice: group.children.length,
      };
    },
    /** Mean ms per frame for `n` dice of `kind` over `frames` frames, glFinish-bounded (desktop ranking only). */
    bench(kind: DieKind, n: number, frames: number, opaqueFace: boolean) {
      clear();
      const side = Math.ceil(Math.sqrt(n));
      for (let i = 0; i < n; i++) {
        place(kind, i % (kind === 'd6' ? 6 : 8), ((i % side) - side / 2) * 0.05, (Math.floor(i / side) - side / 2) * 0.05);
      }
      camera.fov = 40;
      camera.position.set(0, 0.5, 0.5);
      camera.lookAt(0, 0, 0);
      camera.updateProjectionMatrix();
      const mats = (group.children[0] as THREE.Mesh).material as THREE.MeshStandardMaterial[];
      const face = mats.find((m) => m.name.endsWith('-face')) as THREE.MeshStandardMaterial;
      const was = { transparent: face.transparent, opacity: face.opacity };
      if (opaqueFace) {
        face.transparent = false;
        face.opacity = 1;
        face.needsUpdate = true;
      }
      const gl = renderer.getContext();
      for (let i = 0; i < 20; i++) renderer.render(scene, camera);
      gl.finish();
      const t0 = performance.now();
      for (let i = 0; i < frames; i++) {
        group.rotation.y += 0.001;
        renderer.render(scene, camera);
      }
      gl.finish();
      const ms = (performance.now() - t0) / frames;
      face.transparent = was.transparent;
      face.opacity = was.opacity;
      face.needsUpdate = true;
      return { kind, n, opaqueFace, msPerFrame: Math.round(ms * 1000) / 1000, calls: renderer.info.render.calls };
    },
  };
}
