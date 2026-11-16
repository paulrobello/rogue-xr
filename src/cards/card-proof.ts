import * as THREE from 'three';
import {
  type CARD_LAYER_IDS,
  type CardAtlas,
  cardArt,
  loadCardAtlas,
  loadCardPages,
  regionTexture,
} from './card-atlas.ts';
import { createGlowTexture, createHoloCard, type HoloCard, type HoloLayer } from './holo-card.ts';

/** Card width in metres; the fan uses the same (`hand/fan-layout.ts`). */
const CARD_WIDTH = 0.063;

/**
 * The holo card spec for one atlas card: the frame region, the frame's window and aspect, and the
 * back, mid, glow and front layers at the depths and sizes the atlas records. Layer textures are
 * views onto the shared atlas pages (offset and repeat onto the region, clamped).
 */
export function holoLayers(atlas: CardAtlas, pages: readonly THREE.Texture[], cardId: string) {
  const { card, frame } = cardArt(atlas, cardId);
  const page = (i: number): THREE.Texture => {
    const texture = pages[i];
    if (!texture) throw new RangeError(`card atlas page ${i} is not loaded`);
    return texture;
  };
  const layer = (id: (typeof CARD_LAYER_IDS)[number]): HoloLayer => {
    const stack = card.stack[id];
    const region = card.layers[id];
    return {
      texture: regionTexture(page(region.page), region.uv),
      depth: stack.depth,
      size: stack.size,
      ...(stack.offset ? { offset: stack.offset } : {}),
      ...(stack.opaque ? { opaque: true } : {}),
    };
  };
  const glow = card.stack.glow;
  const layers: HoloLayer[] = [
    layer('back'),
    layer('mid'),
    {
      texture: createGlowTexture(card.glow),
      depth: glow.depth,
      size: glow.size,
      ...(glow.offset ? { offset: glow.offset } : {}),
      additive: true,
    },
    layer('front'),
  ];
  return {
    frame: regionTexture(page(frame.page), frame.uv),
    aspect: frame.aspect,
    window: frame.window,
    layers,
  };
}

/**
 * `?view=card-proof`: one atlas card (`&card=<id>`, default `strike`) with a portal window, swaying
 * so the layer parallax shows. `&yaw=<deg>&pitch=<deg>` freezes it at a fixed angle for comparison
 * screenshots. The proof has no renderer handle, so it loads the PNG pages (about 4x the GPU memory
 * of the KTX2 pages the fan uses).
 */
export async function mountCardProof(
  scene: THREE.Scene,
  rig: THREE.Group,
): Promise<{ update(timeSeconds: number, presenting: boolean): void }> {
  scene.background = new THREE.Color('#1c120b');
  const params = new URLSearchParams(location.search);
  const atlas = await loadCardAtlas();
  const pages = await loadCardPages(atlas);
  const card: HoloCard = createHoloCard({
    ...holoLayers(atlas, pages, params.get('card') ?? 'strike'),
    width: CARD_WIDTH,
    foil: 0.35,
  });
  rig.add(card.group);

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
