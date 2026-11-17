import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { applyGlowLook, writeGlowIslands } from '/src/enemies/glow.ts';
import { PALETTE } from '/src/palette.ts';
import { loadPbrSet } from '/src/world/materials.ts';

/**
 * Standalone in-engine stills of one automaton (P5-T3, P5-T4): its own three.js renderer, the shipped GLB
 * and manifest from public/assets/enemies/<id>/, the shared P4-T3 sets bound by slot name exactly
 * as the sentry runtime binds them, warm candle lighting, and the model turned by the encounter's
 * heading convention (rotation.y = -heading) toward a seated player 2.6 m away at +Z, eye height
 * 1.2 m. The glow slot gets the runtime D11 look (glow islands, untonemapped amber ramp) exactly as
 * enemy-asset.ts binds it. Clips are posed directly on an AnimationMixer, so the shots show the
 * authored clips, not the runtime actor's freeze tint or hit flash. `view` 'close' frames the upper
 * body for the glow evidence. Served by Vite; driven by engine_shot.py.
 */
export async function mountAutomatonProof(id: string, width: number, height: number) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(width, height);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.AgXToneMapping;
  document.body.append(renderer.domElement);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(PALETTE.void);
  const camera = new THREE.PerspectiveCamera(50, width / height, 0.05, 50);
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(8, 8),
    new THREE.MeshStandardMaterial({ color: PALETTE.walnut, roughness: 0.8 }),
  );
  floor.rotation.x = -Math.PI / 2;
  scene.add(floor);
  const candle = new THREE.PointLight(PALETTE.candle, 6, 0, 1.6);
  candle.position.set(-1.0, 1.8, 1.4);
  const key = new THREE.DirectionalLight('#ffe2b8', 1.8);
  key.position.set(1.4, 2.6, 2.0);
  const rim = new THREE.DirectionalLight('#ffb070', 1.2);
  rim.position.set(-0.6, 2.0, -2.4);
  scene.add(candle, key, rim, new THREE.HemisphereLight('#ffe8c8', '#2a2018', 0.35));
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.45;
  pmrem.dispose();

  const base = `/assets/enemies/${id}`;
  const manifest = await (await fetch(`${base}/${id}.manifest.json`)).json();
  const [gltf, set] = await Promise.all([
    new GLTFLoader().loadAsync(`${base}/${manifest.glb}`),
    loadPbrSet('/assets/materials', { anisotropy: renderer.capabilities.getMaxAnisotropy() }),
  ]);
  const bound = new Map<THREE.Material, THREE.Material>();
  const bind = (source: THREE.Material): THREE.Material => {
    const cached = bound.get(source);
    if (cached) return cached;
    const slot = manifest.materialSlots[source.name];
    const shared = slot?.set ? set.materials.get(slot.set) : undefined;
    let material: THREE.Material = source;
    if (shared) {
      const clone = shared.clone();
      clone.normalScale.set(slot.normalScale ?? 1, slot.normalScale ?? 1);
      if (slot.tint)
        clone.color.multiply(new THREE.Color().setRGB(...slot.tint, THREE.LinearSRGBColorSpace));
      clone.name = source.name;
      material = clone;
    } else if (slot?.tint && source instanceof THREE.MeshStandardMaterial) {
      const clone = source.clone();
      clone.color.multiply(new THREE.Color().setRGB(...slot.tint, THREE.LinearSRGBColorSpace));
      material = clone;
    }
    bound.set(source, material);
    return material;
  };
  const unbound: string[] = [];
  const glowName = manifest.emissive.material;
  let glowLooks = 0;
  gltf.scene.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    if (!Array.isArray(o.material) && o.material.name === glowName) {
      writeGlowIslands(o.geometry);
      const glow = (o.material as THREE.MeshStandardMaterial).clone();
      applyGlowLook(glow, manifest.emissive.color);
      o.material = glow;
      glowLooks += 1;
    } else {
      o.material = Array.isArray(o.material) ? o.material.map(bind) : bind(o.material);
    }
    if (o instanceof THREE.SkinnedMesh && manifest.cull) {
      const [x, y, z] = manifest.cull.center;
      o.boundingSphere = new THREE.Sphere(new THREE.Vector3(x, y, z), manifest.cull.radius);
    }
  });
  for (const [name, slot] of Object.entries(manifest.materialSlots) as [
    string,
    { set: string | null },
  ][]) {
    if (slot.set && !set.materials.has(slot.set)) unbound.push(name);
  }
  const root = gltf.scene;
  root.rotation.y = -Math.PI; // heading 180 deg: facing the player at +Z
  scene.add(root);
  const mixer = new THREE.AnimationMixer(root);
  const top = manifest.bounds.max[1] as number;

  const pose = (clip: string, time: number, view = 'seat') => {
    // phase-change (guardian only) is posed like any other clip; it is not in the runtime clip list yet.
    const anim = gltf.animations.find((a) => a.name === clip);
    if (!anim) throw new Error(`clip ${clip} missing`);
    mixer.stopAllAction();
    const action = mixer.clipAction(anim);
    action.reset();
    action.setLoop(THREE.LoopOnce, 1);
    action.clampWhenFinished = true;
    action.play();
    action.time = time;
    mixer.update(0);
    // Taller models (warden rings, the 3.2 m guardian) need a wider lens at the same seat.
    camera.fov = top > 2.9 ? 64 : top > 2.3 ? 56 : 50;
    // 'close' is the seat camera narrowed to the upper body (core, head, eye slits): at this model's
    // height the seat lens is already 50 degrees, so a 50 degree close shot would repeat the idle frame.
    const close = view === 'close';
    if (close) camera.fov = 30;
    camera.updateProjectionMatrix();
    camera.position.set(0.7, 1.2, 2.6);
    camera.lookAt(0, clip === 'death' ? 0.3 : close ? top * 0.75 : top * 0.5, 0);
    renderer.render(scene, camera);
    return {
      clip,
      time,
      calls: renderer.info.render.calls,
      triangles: renderer.info.render.triangles,
      unbound,
      glowLooks,
    };
  };
  pose('idle', 0.5);
  await new Promise((resolve) => requestAnimationFrame(resolve));
  return { pose };
}
