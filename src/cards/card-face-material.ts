import * as THREE from 'three';
import type { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import {
  type CardAtlas,
  type CardAtlasCard,
  cardArt,
  loadCardAtlas,
  loadCardPages,
  type Rect4,
} from './card-atlas.ts';

/**
 * The flat card face for the fanned hand: one ShaderMaterial on one InstancedMesh draws every card.
 * Each instance carries its frame rect, its three art layer rects and its art page; the fragment
 * shader composites back, mid, glow and front inside the frame window (the holo card's layers
 * without parallax) and shows the frame everywhere else. The three art pages and the frame page are
 * four sampler uniforms; a card's layers always share one page, so the shader branches once.
 *
 * Until `setArt` provides pages, cards draw as a flat per-instance tint.
 */

/** Per-instance attributes, each a vec4. */
export const CARD_FACE_ATTRIBUTES = [
  'aFrameUv',
  'aBackUv',
  'aMidUv',
  'aFrontUv',
  'aOffsets',
  'aGlowPage',
] as const;
export type CardFaceAttribute = (typeof CARD_FACE_ATTRIBUTES)[number];

const VERTEX = /* glsl */ `
attribute vec4 aFrameUv;
attribute vec4 aBackUv;
attribute vec4 aMidUv;
attribute vec4 aFrontUv;
attribute vec4 aOffsets;
attribute vec4 aGlowPage;
attribute vec3 aTint;
varying vec2 vUv;
varying vec4 vFrameUv;
varying vec4 vBackUv;
varying vec4 vMidUv;
varying vec4 vFrontUv;
varying vec4 vOffsets;
varying vec4 vGlowPage;
varying vec3 vTint;
void main() {
  vUv = uv;
  vFrameUv = aFrameUv;
  vBackUv = aBackUv;
  vMidUv = aMidUv;
  vFrontUv = aFrontUv;
  vOffsets = aOffsets;
  vGlowPage = aGlowPage;
  vTint = aTint;
  vec4 local = vec4(position, 1.0);
#ifdef USE_INSTANCING
  local = instanceMatrix * local;
#endif
  gl_Position = projectionMatrix * modelViewMatrix * local;
}`;

const FRAGMENT = /* glsl */ `
uniform sampler2D uFrame;
uniform sampler2D uPage0;
uniform sampler2D uPage1;
uniform sampler2D uPage2;
uniform float uHasArt;
// Window centre (u from left, v from top), radius as a fraction of width; card height over width.
uniform vec4 uWindow;
// Layer plane sizes in window diameters: back, mid, glow, front.
uniform vec4 uSizes;
varying vec2 vUv;
varying vec4 vFrameUv;
varying vec4 vBackUv;
varying vec4 vMidUv;
varying vec4 vFrontUv;
varying vec4 vOffsets;
varying vec4 vGlowPage;
varying vec3 vTint;

vec4 pageSample(float page, vec2 uv, vec2 gx, vec2 gy) {
  if (page < 0.5) return textureGrad(uPage0, uv, gx, gy);
  if (page < 1.5) return textureGrad(uPage1, uv, gx, gy);
  return textureGrad(uPage2, uv, gx, gy);
}

// 1 inside the layer square, 0 outside, so a layer never samples its neighbouring atlas cell.
float inside(vec2 l) {
  vec2 s = step(vec2(0.0), l) * step(l, vec2(1.0));
  return s.x * s.y;
}

void main() {
  if (uHasArt < 0.5) {
    gl_FragColor = vec4(vTint, 1.0);
    #include <colorspace_fragment>
    return;
  }
  // Window space: x right, y up, in window diameters from the window centre.
  float diameter = 2.0 * uWindow.z;
  vec2 w = vec2(vUv.x - uWindow.x, ((1.0 - vUv.y) - uWindow.y) * uWindow.w);
  bool inWindow = length(w) < uWindow.z;
  vec2 q = vec2(w.x, -w.y) / diameter;
  vec2 qx = dFdx(q);
  vec2 qy = dFdy(q);

  vec2 frameUv = mix(vFrameUv.xy, vFrameUv.zw, vUv);
  vec4 frame = texture2D(uFrame, frameUv);
  if (!inWindow && frame.a < 0.5) discard;
  vec3 color = frame.rgb;

  if (inWindow) {
    float page = vGlowPage.w;
    vec2 backL = q / uSizes.x + 0.5;
    vec2 midL = q / uSizes.y + 0.5;
    vec2 frontL = (q - vOffsets.xy) / uSizes.w + 0.5;
    vec2 backSpan = vBackUv.zw - vBackUv.xy;
    vec2 midSpan = vMidUv.zw - vMidUv.xy;
    vec2 frontSpan = vFrontUv.zw - vFrontUv.xy;
    vec3 art = pageSample(page, vBackUv.xy + backL * backSpan, qx / uSizes.x * backSpan, qy / uSizes.x * backSpan).rgb;
    vec4 mid = pageSample(page, vMidUv.xy + clamp(midL, 0.0, 1.0) * midSpan, qx / uSizes.y * midSpan, qy / uSizes.y * midSpan);
    art = mix(art, mid.rgb, mid.a * inside(midL));
    // The holo card's radial glow texture: 1 at the centre, 0.45 at 35%, 0 at the edge.
    float r = length(q - vOffsets.zw) / (0.5 * uSizes.z);
    float glow = r < 0.35 ? mix(1.0, 0.45, r / 0.35) : mix(0.45, 0.0, clamp((r - 0.35) / 0.65, 0.0, 1.0));
    art += vGlowPage.rgb * glow * 0.9;
    vec4 front = pageSample(page, vFrontUv.xy + clamp(frontL, 0.0, 1.0) * frontSpan, qx / uSizes.w * frontSpan, qy / uSizes.w * frontSpan);
    art = mix(art, front.rgb, front.a * inside(frontL));
    color = mix(art, frame.rgb, frame.a);
  }
  gl_FragColor = vec4(color, 1.0);
  #include <colorspace_fragment>
}`;

export interface CardFaceArt {
  readonly atlas: CardAtlas;
  /** Atlas pages in manifest order; the frames live on one page, card layers on the others. */
  readonly pages: readonly THREE.Texture[];
}

const placeholder = (): THREE.Texture => {
  const texture = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  texture.needsUpdate = true;
  return texture;
};

export function createCardFaceMaterial(): THREE.ShaderMaterial {
  const blank = placeholder();
  return new THREE.ShaderMaterial({
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    uniforms: {
      uFrame: { value: blank },
      uPage0: { value: blank },
      uPage1: { value: blank },
      uPage2: { value: blank },
      uHasArt: { value: 0 },
      uWindow: { value: new THREE.Vector4(0.5, 0.37, 0.41, 1.5) },
      uSizes: { value: new THREE.Vector4(2.6, 0.95, 0.7, 1.05) },
    },
    side: THREE.FrontSide,
    // Painted card art shows its authored colours; scene tone mapping would desaturate it.
    toneMapped: false,
  });
}

/**
 * Points the material at the atlas pages. Window, aspect and layer sizes are shared by every frame
 * and card in the slice atlas (checked by tests), so they are uniforms; the rest is per instance.
 */
export function applyCardFaceArt(material: THREE.ShaderMaterial, art: CardFaceArt): void {
  const { atlas, pages } = art;
  const frame = atlas.frames.attack;
  const sample = Object.values(atlas.cards)[0] as CardAtlasCard;
  const artPages = [...new Set(Object.values(atlas.cards).map((c) => c.layers.back.page))].sort();
  const u = material.uniforms as Record<string, THREE.IUniform>;
  (u.uFrame as THREE.IUniform).value = pages[frame.page];
  artPages.slice(0, 3).forEach((page, i) => {
    (u[`uPage${i}`] as THREE.IUniform).value = pages[page];
  });
  (u.uWindow as THREE.IUniform<THREE.Vector4>).value.set(
    frame.window.u,
    frame.window.v,
    frame.window.radius,
    frame.aspect,
  );
  (u.uSizes as THREE.IUniform<THREE.Vector4>).value.set(
    sample.stack.back.size,
    sample.stack.mid.size,
    sample.stack.glow.size,
    sample.stack.front.size,
  );
  (u.uHasArt as THREE.IUniform).value = 1;
}

export interface CardFaceInstance {
  frameUv: Rect4;
  backUv: Rect4;
  midUv: Rect4;
  frontUv: Rect4;
  /** Front offset xy, glow offset xy, in window diameters. */
  offsets: Rect4;
  /** Glow colour rgb (linear) and the shader page slot of the card's layers. */
  glowPage: Rect4;
}

/** The per-instance data for one card; `id` may be an upgraded id (`strike+`). */
export function cardFaceInstance(atlas: CardAtlas, id: string): CardFaceInstance {
  const { card, frame } = cardArt(atlas, id);
  const artPages = [...new Set(Object.values(atlas.cards).map((c) => c.layers.back.page))].sort();
  const slot = artPages.indexOf(card.layers.back.page);
  const glow = new THREE.Color(card.glow);
  const front = card.stack.front.offset ?? [0, 0];
  const glowAt = card.stack.glow.offset ?? [0, 0];
  return {
    frameUv: frame.uv,
    backUv: card.layers.back.uv,
    midUv: card.layers.mid.uv,
    frontUv: card.layers.front.uv,
    offsets: [front[0], front[1], glowAt[0], glowAt[1]],
    glowPage: [glow.r, glow.g, glow.b, slot],
  };
}

/** Adds the per-instance attributes (zeroed) for `capacity` instances to a card body geometry. */
export function addCardFaceAttributes(geometry: THREE.BufferGeometry, capacity: number): void {
  for (const name of CARD_FACE_ATTRIBUTES) {
    geometry.setAttribute(
      name,
      new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4),
    );
  }
  geometry.setAttribute(
    'aTint',
    new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3).fill(1), 3),
  );
}

/** Writes one card's instance data at `index`. */
export function writeCardFace(
  geometry: THREE.BufferGeometry,
  index: number,
  face: CardFaceInstance,
): void {
  const values: Record<CardFaceAttribute, Rect4> = {
    aFrameUv: face.frameUv,
    aBackUv: face.backUv,
    aMidUv: face.midUv,
    aFrontUv: face.frontUv,
    aOffsets: face.offsets,
    aGlowPage: face.glowPage,
  };
  for (const name of CARD_FACE_ATTRIBUTES) {
    const attribute = geometry.getAttribute(name) as THREE.InstancedBufferAttribute;
    const [x, y, z, w] = values[name];
    attribute.setXYZW(index, x, y, z, w);
    attribute.needsUpdate = true;
  }
}

/** Writes the flat fallback tint at `index`. */
export function writeCardTint(
  geometry: THREE.BufferGeometry,
  index: number,
  color: THREE.Color,
): void {
  const attribute = geometry.getAttribute('aTint') as THREE.InstancedBufferAttribute;
  attribute.setXYZ(index, color.r, color.g, color.b);
  attribute.needsUpdate = true;
}

let shared: Promise<CardFaceArt> | null = null;

/**
 * Loads the card atlas once per page load (KTX2 pages through `ktx2` when given, PNG otherwise) and
 * shares it between every fan. A failed load is forgotten so a later call can retry.
 */
export function requestCardFaceArt(ktx2?: KTX2Loader | null): Promise<CardFaceArt> {
  if (!shared) {
    shared = (async () => {
      const atlas = await loadCardAtlas();
      return { atlas, pages: await loadCardPages(atlas, ktx2) };
    })();
    shared.catch(() => {
      shared = null;
    });
  }
  return shared;
}
