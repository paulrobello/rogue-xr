import * as THREE from 'three';
import { createGlowTexture, createHoloCard, type HoloCard } from './holo-card.ts';

const BASE = '/assets/cards/attack-strike';

async function load(url: string): Promise<THREE.Texture> {
  const texture = await new THREE.TextureLoader().loadAsync(url);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

/**
 * `?view=card-proof`: one attack card with a portal window, swaying so the layer parallax shows.
 * `&yaw=<deg>&pitch=<deg>` freezes it at a fixed angle for comparison screenshots.
 */
export async function mountCardProof(
  scene: THREE.Scene,
  rig: THREE.Group,
): Promise<{ update(timeSeconds: number, presenting: boolean): void }> {
  scene.background = new THREE.Color('#1c120b');
  const [frame, back, mid, front] = await Promise.all([
    load(`${BASE}/frame.png`),
    load(`${BASE}/back.jpg`),
    load(`${BASE}/mid.png`),
    load(`${BASE}/front.png`),
  ]);
  const card: HoloCard = createHoloCard({
    frame,
    width: 0.063,
    aspect: 1086 / 716,
    window: { u: 350 / 716, v: 408 / 1086, radius: 288 / 716 },
    foil: 0.35,
    layers: [
      { texture: back, depth: 0.03, size: 2.6, opaque: true },
      { texture: mid, depth: 0.016, size: 0.95 },
      {
        texture: createGlowTexture('#ff6a2a'),
        depth: 0.007,
        size: 0.7,
        offset: [0.27, 0.24],
        additive: true,
      },
      { texture: front, depth: 0.005, size: 1.05, offset: [0.04, -0.02] },
    ],
  });
  rig.add(card.group);

  const params = new URLSearchParams(location.search);
  const fixedYaw = params.get('yaw');
  const fixedPitch = params.get('pitch');
  const distance = Number(params.get('dist') ?? 0.16);
  const deg = THREE.MathUtils.degToRad;
  (window as unknown as { __cardProofReady: boolean }).__cardProofReady = true;

  return {
    update(t, presenting) {
      // Desktop camera sits at rig-local eye height 1.6 m; in XR the seated eye is about 1.2 m.
      if (presenting) card.group.position.set(0, 1.1, -0.32);
      else card.group.position.set(0, 1.6, -distance);
      const yaw = fixedYaw !== null ? deg(Number(fixedYaw)) : deg(32) * Math.sin(t * 0.6);
      const pitch = fixedPitch !== null ? deg(Number(fixedPitch)) : deg(14) * Math.sin(t * 0.43);
      card.group.rotation.set(pitch, yaw, 0);
      card.update(t);
    },
  };
}
