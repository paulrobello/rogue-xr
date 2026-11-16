import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { PALETTE } from '../palette.ts';
import { loadSentry, type SentryActor, type SentryClip } from './sentry-asset.ts';

const DEG = Math.PI / 180;

export interface SentryProofInfo {
  clip: SentryClip;
  time: number;
  calls: number;
  triangles: number;
  frozen: boolean;
  dead: boolean;
}

/**
 * Holds `actor` on one frame of `clip` for a still: the actor's own entry path (play, hit,
 * freeze, die) runs first so fades, rime and death state are real, then the clip time is pinned.
 */
export function holdSentryPose(actor: SentryActor, clip: SentryClip, time: number): void {
  actor.reset();
  if (clip === 'frozen') actor.freeze();
  else if (clip === 'death') void actor.die();
  else if (clip === 'hit') actor.hit();
  else if (clip === 'attack') actor.attack();
  else actor.play(clip, { fade: 0 });
  actor.update(0.4); // longer than every fade, shorter than every one-shot clip
  actor.action(clip).time = time;
  actor.mixer.update(0);
}

/**
 * Standalone in-engine proof of the P4-T6 sentry: its own renderer, a floor, warm candle
 * lighting, the shared brass sets, and the sentry placed by the encounter's heading convention
 * (rotation.y = -heading) facing a seated player at +Z. `window.__sentryProof.pose(clip, t)`
 * re-poses and renders. Driven by assets-source/enemies/cog-sentry/engine_shot.py.
 */
export async function mountStandaloneSentryProof(
  width: number,
  height: number,
): Promise<{ pose(clip: SentryClip, time: number): SentryProofInfo }> {
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

  const asset = await loadSentry({ anisotropy: renderer.capabilities.getMaxAnisotropy() });
  const actor = asset.spawn();
  // The seated player sits 2.6 m away at +Z; heading from the sentry to the player is 180 deg.
  const headingDeg = 180;
  actor.object.rotation.y = -headingDeg * DEG;
  scene.add(actor.object);

  const pose = (clip: SentryClip, time: number): SentryProofInfo => {
    holdSentryPose(actor, clip, time);
    if (clip === 'death') {
      camera.position.set(1.5, 1.5, 2.3);
      camera.lookAt(0, 0.25, -0.3);
    } else {
      camera.position.set(1.7, 1.3, 2.1);
      camera.lookAt(0, 1.0, 0);
    }
    renderer.render(scene, camera);
    return {
      clip,
      time,
      calls: renderer.info.render.calls,
      triangles: renderer.info.render.triangles,
      frozen: actor.frozen,
      dead: actor.dead,
    };
  };
  pose('idle', 0.5);
  await new Promise((resolve) => requestAnimationFrame(resolve));
  return { pose };
}
