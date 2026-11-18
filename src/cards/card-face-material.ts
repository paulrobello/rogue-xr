import * as THREE from 'three';
import type { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { GLOW_HOT } from '../enemies/glow.ts';
import { PALETTE } from '../palette.ts';
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
 * shader composites back, mid, glow and front inside the frame window and shows the frame
 * everywhere else. The window is a portal: each layer is sampled where the view ray meets its plane
 * at the atlas depth behind the face (the holo card's depths, offset per eye, no extra texture
 * taps), deeper layers sink into a warm haze, and the window lip shades the art nearest the eye.
 * The three art pages and the frame page are four sampler uniforms; a card's layers always share
 * one page, so the shader branches once.
 *
 * `aBurn` drives the played-card burn (`card-burn.ts`): an amber flare, then a noise-broken burn
 * front that eats the card from its edges inward with a hot rim. It is zero on hand cards.
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
attribute vec4 aBurn;
attribute vec3 aTint;
varying vec2 vUv;
varying vec4 vFrameUv;
varying vec4 vBackUv;
varying vec4 vMidUv;
varying vec4 vFrontUv;
varying vec4 vOffsets;
varying vec4 vGlowPage;
varying vec4 vBurn;
varying vec3 vTint;
// Card-local vector from the surface toward the eye (x right, y up, z out of the face), metres.
varying vec3 vEye;
void main() {
  vUv = uv;
  vFrameUv = aFrameUv;
  vBackUv = aBackUv;
  vMidUv = aMidUv;
  vFrontUv = aFrontUv;
  vOffsets = aOffsets;
  vGlowPage = aGlowPage;
  vBurn = aBurn;
  vTint = aTint;
#ifdef USE_INSTANCING
  mat4 cardView = modelViewMatrix * instanceMatrix;
#else
  mat4 cardView = modelViewMatrix;
#endif
  vec4 viewPos = cardView * vec4(position, 1.0);
  // The instance scale is (width, height, 1), so the axes are normalised before projecting.
  vec3 e = -viewPos.xyz;
  vEye = vec3(
    dot(e, normalize(cardView[0].xyz)),
    dot(e, normalize(cardView[1].xyz)),
    dot(e, normalize(cardView[2].xyz))
  );
  gl_Position = projectionMatrix * viewPos;
}`;

/**
 * The frame's window edge. The atlas frame is straight (not premultiplied) alpha, and the RGB under
 * its transparent hole is left over from the key (dark green, `(0, 56, 0)` on the skill frame), so
 * a filtered tap on the hole's edge mixes that green in at partial alpha. The shader therefore takes
 * the edge's colour from a second tap this far out into the opaque brass (frame texels, plus screen
 * footprints so it holds under minification, at most `FRAME_EDGE_MAX_TEXELS`), uses the edge tap's
 * alpha only as coverage, and draws the art under the frame out to the same distance, so no fragment
 * between the painted window and the opaque brass is discarded.
 */
export const FRAME_EDGE_TEXELS = 2;
export const FRAME_EDGE_FOOTPRINTS = 1.5;
export const FRAME_EDGE_MAX_TEXELS = 8;

const glslFloat = (v: number): string => (Number.isInteger(v) ? `${v}.0` : String(v));

const FRAGMENT = /* glsl */ `
uniform sampler2D uFrame;
uniform sampler2D uPage0;
uniform sampler2D uPage1;
uniform sampler2D uPage2;
uniform sampler2D uPage3;
uniform float uHasArt;
// Window centre (u from left, v from top), radius as a fraction of width; card height over width.
uniform vec4 uWindow;
// Layer plane sizes in window diameters: back, mid, glow, front.
uniform vec4 uSizes;
// Layer depths behind the face in window diameters: back, mid, glow, front.
uniform vec4 uDepths;
// Depth haze colour (linear rgb) and its density per window diameter of depth.
uniform vec4 uFog;
// Burn colours (linear): the ember at the char line and the hot core at the burn front.
uniform vec3 uEmber;
uniform vec3 uHot;
varying vec2 vUv;
varying vec4 vFrameUv;
varying vec4 vBackUv;
varying vec4 vMidUv;
varying vec4 vFrontUv;
varying vec4 vOffsets;
varying vec4 vGlowPage;
varying vec4 vBurn;
varying vec3 vTint;
varying vec3 vEye;

// Steepest view slope the parallax follows; the back layer's margin runs out beyond it.
const float MAX_SLOPE = 1.2;
// Depth of the window's inner wall, window diameters: the lip shadow shifts by this much.
const float WALL = 0.12;
// Width of the glowing burn front and of the char band behind it, in burn-field units.
const float RIM = 0.05;
const float CHAR = 0.12;
const float EDGE_TEXELS = ${glslFloat(FRAME_EDGE_TEXELS)};
const float EDGE_FOOTPRINTS = ${glslFloat(FRAME_EDGE_FOOTPRINTS)};
const float EDGE_MAX_TEXELS = ${glslFloat(FRAME_EDGE_MAX_TEXELS)};
// Below this coverage the hole colour cannot show, so the window's middle skips the second tap.
const float EDGE_MIN_ALPHA = 0.02;

vec4 pageSample(float page, vec2 uv, vec2 gx, vec2 gy) {
  if (page < 0.5) return textureGrad(uPage0, uv, gx, gy);
  if (page < 1.5) return textureGrad(uPage1, uv, gx, gy);
  if (page < 2.5) return textureGrad(uPage2, uv, gx, gy);
  return textureGrad(uPage3, uv, gx, gy);
}

// 1 inside the layer square, 0 outside, so a layer never samples its neighbouring atlas cell.
float inside(vec2 l) {
  vec2 s = step(vec2(0.0), l) * step(l, vec2(1.0));
  return s.x * s.y;
}

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float valueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 s = f * f * (3.0 - 2.0 * f);
  float a = hash12(i);
  float b = hash12(i + vec2(1.0, 0.0));
  float c = hash12(i + vec2(0.0, 1.0));
  float d = hash12(i + vec2(1.0, 1.0));
  return mix(mix(a, b, s.x), mix(c, d, s.x), s.y);
}

// The played-card burn: x front 0..1, y noise seed, z flare 0..1, w 1 while burning.
vec3 burnCard(vec3 color) {
  vec2 c = abs(vUv - 0.5) * 2.0;
  float edge = 1.0 - max(c.x, c.y);
  vec2 p = vec2(vUv.x, vUv.y * uWindow.w) * 6.0 + vBurn.y * 17.0;
  float n = 0.65 * valueNoise(p) + 0.35 * valueNoise(p * 2.7 + 5.0);
  // 0 at the card edge, about 1 at the centre, broken up by noise: the edges go first.
  float field = 0.55 * edge + 0.45 * n;
  float d = field - mix(-0.2, 1.05, vBurn.x);
  if (d < 0.0) discard;
  float rim = 1.0 - smoothstep(0.0, RIM, d);
  float charred = 1.0 - smoothstep(RIM, RIM + CHAR, d);
  color = mix(color, color * 0.22, charred);
  color = mix(color, color + uHot * 0.6, vBurn.z);
  return mix(color, mix(uEmber, uHot, rim * rim), rim);
}

void main() {
  vec3 color;
  if (uHasArt < 0.5) {
    color = vTint;
  } else {
    // Window space: x right, y up, in window diameters from the window centre.
    float diameter = 2.0 * uWindow.z;
    vec2 w = vec2(vUv.x - uWindow.x, ((1.0 - vUv.y) - uWindow.y) * uWindow.w);
    float dist = length(w);
    vec2 q = vec2(w.x, -w.y) / diameter;
    vec2 qx = dFdx(q);
    vec2 qy = dFdy(q);

    vec2 frameUv = mix(vFrameUv.xy, vFrameUv.zw, vUv);
    vec2 fx = dFdx(frameUv);
    vec2 fy = dFdy(frameUv);
    // One frame texel in card widths (the units of w), and a screen pixel in frame texels.
    vec2 frameTexels = abs(vFrameUv.zw - vFrameUv.xy) * vec2(textureSize(uFrame, 0));
    float texel = 1.0 / frameTexels.x;
    float footprint = max(1.0, fwidth(dist) / texel);
    float edge = min(EDGE_TEXELS + EDGE_FOOTPRINTS * footprint, EDGE_MAX_TEXELS) * texel;
    // The art runs under the frame out to the opaque brass, so nothing on the edge is discarded.
    bool inWindow = dist < uWindow.z + edge;
    vec4 frame = texture2D(uFrame, frameUv);
    if (!inWindow && frame.a < 0.5) discard;
    color = frame.rgb;

    if (inWindow) {
      // Portal depth: each layer is sampled where the view ray meets its plane behind the face.
      vec3 eye = normalize(vEye);
      vec2 slope = vec2(eye.x, -eye.y) / max(eye.z, 0.2);
      float steep = length(slope);
      if (steep > MAX_SLOPE) slope *= MAX_SLOPE / steep;
      float page = vGlowPage.w;
      vec2 backL = clamp((q - slope * uDepths.x) / uSizes.x + 0.5, 0.0, 1.0);
      vec2 midL = (q - slope * uDepths.y) / uSizes.y + 0.5;
      vec2 frontL = (q - slope * uDepths.w - vOffsets.xy) / uSizes.w + 0.5;
      vec2 backSpan = vBackUv.zw - vBackUv.xy;
      vec2 midSpan = vMidUv.zw - vMidUv.xy;
      vec2 frontSpan = vFrontUv.zw - vFrontUv.xy;
      vec3 art = pageSample(page, vBackUv.xy + backL * backSpan, qx / uSizes.x * backSpan, qy / uSizes.x * backSpan).rgb;
      art = mix(art, uFog.rgb, 1.0 - exp(-uDepths.x * uFog.w));
      vec4 mid = pageSample(page, vMidUv.xy + clamp(midL, 0.0, 1.0) * midSpan, qx / uSizes.y * midSpan, qy / uSizes.y * midSpan);
      vec3 midRgb = mix(mid.rgb, uFog.rgb, 1.0 - exp(-uDepths.y * uFog.w));
      art = mix(art, midRgb, mid.a * inside(midL));
      // The holo card's radial glow texture: 1 at the centre, 0.45 at 35%, 0 at the edge.
      float r = length(q - slope * uDepths.z - vOffsets.zw) / (0.5 * uSizes.z);
      float glow = r < 0.35 ? mix(1.0, 0.45, r / 0.35) : mix(0.45, 0.0, clamp((r - 0.35) / 0.65, 0.0, 1.0));
      art += vGlowPage.rgb * glow * 0.9;
      vec4 front = pageSample(page, vFrontUv.xy + clamp(frontL, 0.0, 1.0) * frontSpan, qx / uSizes.w * frontSpan, qy / uSizes.w * frontSpan);
      art = mix(art, front.rgb, front.a * inside(frontL));
      // The window's inner lip: a soft ring of shade, deeper on the side nearer the eye.
      float lip = length(q + slope * WALL) * 2.0;
      float ring = length(q) * 2.0;
      art *= max(0.0, 1.0 - 0.6 * smoothstep(0.7, 1.05, lip) - 0.25 * smoothstep(0.8, 1.0, ring));
      vec3 brass = frame.rgb;
      if (frame.a > EDGE_MIN_ALPHA) {
        // The edge's colour from the opaque brass, pushed out along the radius (w.y runs down the
        // card, frame v runs up it); its own alpha stays the coverage.
        vec2 outward = w / max(dist, 1e-5) * edge;
        vec2 push = vec2(outward.x, -outward.y / uWindow.w) * (vFrameUv.zw - vFrameUv.xy);
        brass = textureGrad(uFrame, frameUv + push, fx, fy).rgb;
      }
      color = mix(art, brass, frame.a);
    }
  }
  if (vBurn.w > 0.5) color = burnCard(color);
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

/** Warm black from the art bible: the haze deeper layers sink into. */
export const CARD_FOG = '#231d1a';
/** Haze density per window diameter of depth: the back layer (about 0.57) takes about a quarter. */
export const FOG_DENSITY = 0.5;
/** The holo card width (metres) the atlas layer depths were authored for (`card-proof.ts`). */
export const ATLAS_CARD_WIDTH = 0.063;

export function createCardFaceMaterial(): THREE.ShaderMaterial {
  const blank = placeholder();
  const fog = new THREE.Color(CARD_FOG);
  return new THREE.ShaderMaterial({
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    uniforms: {
      uFrame: { value: blank },
      uPage0: { value: blank },
      uPage1: { value: blank },
      uPage2: { value: blank },
      uPage3: { value: blank },
      uHasArt: { value: 0 },
      uWindow: { value: new THREE.Vector4(0.5, 0.37, 0.41, 1.5) },
      uSizes: { value: new THREE.Vector4(2.6, 0.95, 0.7, 1.05) },
      uDepths: { value: new THREE.Vector4(0.57, 0.3, 0.13, 0.1) },
      uFog: { value: new THREE.Vector4(fog.r, fog.g, fog.b, FOG_DENSITY) },
      uEmber: { value: new THREE.Color(PALETTE.candle) },
      uHot: { value: new THREE.Color(GLOW_HOT) },
    },
    side: THREE.FrontSide,
    // Painted card art shows its authored colours; scene tone mapping would desaturate it.
    toneMapped: false,
  });
}

/**
 * Points the material at the atlas pages. Window, aspect, layer sizes and depths are shared by
 * every frame and card in the slice atlas (checked by tests), so they are uniforms; the rest is per
 * instance. Depths are metres on a card `cardWidth` wide, turned into window diameters so a card
 * drawn at any scale keeps the same portal proportions.
 */
export function applyCardFaceArt(
  material: THREE.ShaderMaterial,
  art: CardFaceArt,
  cardWidth = ATLAS_CARD_WIDTH,
): void {
  const { atlas, pages } = art;
  const frame = atlas.frames.attack;
  const sample = Object.values(atlas.cards)[0] as CardAtlasCard;
  const artPages = [...new Set(Object.values(atlas.cards).map((c) => c.layers.back.page))].sort(
    (a, b) => a - b,
  );
  const u = material.uniforms as Record<string, THREE.IUniform>;
  (u.uFrame as THREE.IUniform).value = pages[frame.page];
  if (artPages.length > 4) throw new Error('Card atlas exceeds the four art samplers');
  artPages.forEach((page, i) => {
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
  const diameter = 2 * frame.window.radius * cardWidth;
  (u.uDepths as THREE.IUniform<THREE.Vector4>).value.set(
    sample.stack.back.depth / diameter,
    sample.stack.mid.depth / diameter,
    sample.stack.glow.depth / diameter,
    sample.stack.front.depth / diameter,
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
  const artPages = [...new Set(Object.values(atlas.cards).map((c) => c.layers.back.page))].sort(
    (a, b) => a - b,
  );
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
  geometry.setAttribute(
    'aBurn',
    new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4),
  );
}

/**
 * Writes the burn state at `index`: front 0..1, noise seed 0..1 and flare 0..1 while `burning`,
 * all zero otherwise (a hand card).
 */
export function writeCardBurn(
  geometry: THREE.BufferGeometry,
  index: number,
  burning: boolean,
  front = 0,
  seed = 0,
  flare = 0,
): void {
  const attribute = geometry.getAttribute('aBurn') as THREE.InstancedBufferAttribute;
  if (burning) attribute.setXYZW(index, front, seed, flare, 1);
  else attribute.setXYZW(index, 0, 0, 0, 0);
  attribute.needsUpdate = true;
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
let loaded: CardFaceArt | null = null;

/** The shared card art once `requestCardFaceArt` has loaded it, else null (no load starts). */
export function loadedCardFaceArt(): CardFaceArt | null {
  return loaded;
}

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
    shared.then(
      (art) => {
        loaded = art;
      },
      () => {
        shared = null;
      },
    );
  }
  return shared;
}
