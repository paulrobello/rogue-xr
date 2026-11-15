import * as THREE from 'three';

/**
 * A card whose illustration window is a portal: painted layers sit at real depths behind the card
 * face and are drawn only where the window is visible, so head motion and stereo give true depth.
 *
 * The window disc writes a per-card stencil value and depth (it is the card's "glass"). Layers draw
 * after it with depth testing off and a stencil-equal test, so they always belong to their own card
 * even when another card or object sits between the face and the layer depth. The renderer must be
 * created with `stencil: true`.
 */

export interface HoloLayer {
  texture: THREE.Texture;
  /** Metres behind the card face. */
  depth: number;
  /** Plane edge length in window diameters. */
  size: number;
  /** Plane centre offset from the window centre, in window diameters (x right, y up). */
  offset?: readonly [number, number];
  /** Opaque layers fill the whole plane; use for the backmost layer. */
  opaque?: boolean;
  additive?: boolean;
  /** Peak opacity; additive layers pulse between 0.6 and 1 of this. */
  opacity?: number;
}

export interface HoloCardSpec {
  /** Card face with an alpha hole over the window. */
  frame: THREE.Texture;
  /** Card width in metres; height follows the frame texture's aspect. */
  width: number;
  /** Frame height over width. */
  aspect: number;
  /** Window centre (u from left, v from top, both 0..1) and radius as a fraction of card width. */
  window: { u: number; v: number; radius: number };
  layers: HoloLayer[];
  /** Strength of the view-dependent foil sheen on the window glass, 0 to disable. */
  foil?: number;
  backColor?: THREE.ColorRepresentation;
}

export interface HoloCard {
  group: THREE.Group;
  stencilRef: number;
  update(timeSeconds: number): void;
  dispose(): void;
}

/** Render order band for portal parts; normal opaque scene geometry stays below it. */
export const PORTAL_RENDER_ORDER = 900;

let lastRef = 0;
/** Stencil values 1..255, reused round-robin. Cards visible at once must not exceed 255. */
export function nextStencilRef(): number {
  lastRef = (lastRef % 255) + 1;
  return lastRef;
}

const FOIL_VERTEX = /* glsl */ `
varying vec2 vUv;
varying vec3 vViewDir;
varying vec3 vNormal;
void main() {
  vUv = uv;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vViewDir = normalize(-mv.xyz);
  vNormal = normalize(normalMatrix * normal);
  gl_Position = projectionMatrix * mv;
}`;

const FOIL_FRAGMENT = /* glsl */ `
uniform float uStrength;
uniform float uTime;
varying vec2 vUv;
varying vec3 vViewDir;
varying vec3 vNormal;
vec3 hue(float h) {
  return clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
}
void main() {
  float facing = clamp(dot(vNormal, vViewDir), 0.0, 1.0);
  float fresnel = pow(1.0 - facing, 2.0);
  vec2 tilt = vViewDir.xy - vNormal.xy * facing;
  float band = 0.5 + 0.5 * sin((vUv.x * 1.7 + vUv.y * 1.1 + tilt.x * 3.0 - tilt.y * 2.0) * 9.0 + uTime * 0.4);
  vec3 color = mix(hue(fract(vUv.x * 0.6 + vUv.y * 0.4 + tilt.x * 1.5 + tilt.y)), vec3(1.0, 0.85, 0.55), 0.35);
  float alpha = uStrength * (0.25 * band + fresnel);
  gl_FragColor = vec4(color * alpha, alpha);
}`;

function stencilEqual(material: THREE.Material, ref: number): void {
  material.stencilWrite = true;
  material.stencilRef = ref;
  material.stencilFunc = THREE.EqualStencilFunc;
  material.stencilFail = THREE.KeepStencilOp;
  material.stencilZFail = THREE.KeepStencilOp;
  material.stencilZPass = THREE.KeepStencilOp;
}

export function createHoloCard(spec: HoloCardSpec, stencilRef = nextStencilRef()): HoloCard {
  const width = spec.width;
  const height = width * spec.aspect;
  const radius = spec.window.radius * width;
  const diameter = radius * 2;
  const centre = new THREE.Vector2((spec.window.u - 0.5) * width, (0.5 - spec.window.v) * height);

  const group = new THREE.Group();
  group.name = 'holo-card';
  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];
  const pulsing: THREE.MeshBasicMaterial[] = [];
  const own = <G extends THREE.BufferGeometry, M extends THREE.Material>(g: G, m: M) => {
    geometries.push(g);
    materials.push(m);
    return new THREE.Mesh(g, m);
  };

  const face = own(
    new THREE.PlaneGeometry(width, height),
    new THREE.MeshBasicMaterial({ map: spec.frame, alphaTest: 0.5, side: THREE.FrontSide }),
  );
  face.name = 'face';
  group.add(face);

  const back = own(
    new THREE.PlaneGeometry(width, height),
    new THREE.MeshBasicMaterial({ color: spec.backColor ?? '#5a3a22', side: THREE.FrontSide }),
  );
  back.name = 'back';
  back.rotation.y = Math.PI;
  group.add(back);

  const maskMaterial = new THREE.MeshBasicMaterial({
    colorWrite: false,
    depthWrite: true,
    side: THREE.FrontSide,
    stencilWrite: true,
    stencilRef,
    stencilFunc: THREE.AlwaysStencilFunc,
    stencilZPass: THREE.ReplaceStencilOp,
  });
  const mask = own(new THREE.CircleGeometry(radius, 64), maskMaterial);
  mask.name = 'window-mask';
  mask.position.set(centre.x, centre.y, 0);
  mask.renderOrder = PORTAL_RENDER_ORDER;
  group.add(mask);

  spec.layers.forEach((layer, i) => {
    const material = new THREE.MeshBasicMaterial({
      map: layer.texture,
      transparent: !layer.opaque,
      opacity: layer.opacity ?? 1,
      depthTest: false,
      depthWrite: false,
      blending: layer.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    stencilEqual(material, stencilRef);
    if (layer.additive) pulsing.push(material);
    const size = layer.size * diameter;
    const mesh = own(new THREE.PlaneGeometry(size, size), material);
    mesh.name = `layer-${i}`;
    const [ox, oy] = layer.offset ?? [0, 0];
    mesh.position.set(centre.x + ox * diameter, centre.y + oy * diameter, -layer.depth);
    mesh.renderOrder = PORTAL_RENDER_ORDER + 1 + i;
    group.add(mesh);
  });

  let foil: THREE.ShaderMaterial | undefined;
  if (spec.foil && spec.foil > 0) {
    foil = new THREE.ShaderMaterial({
      vertexShader: FOIL_VERTEX,
      fragmentShader: FOIL_FRAGMENT,
      uniforms: { uStrength: { value: spec.foil }, uTime: { value: 0 } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const sheen = own(new THREE.CircleGeometry(radius, 64), foil);
    sheen.name = 'foil';
    sheen.position.set(centre.x, centre.y, 0.0002);
    sheen.renderOrder = PORTAL_RENDER_ORDER + 1 + spec.layers.length;
    group.add(sheen);
  }

  // Painted card art shows its authored colours; scene tone mapping would desaturate it.
  for (const m of materials) m.toneMapped = false;
  const peaks = pulsing.map((m) => m.opacity);
  return {
    group,
    stencilRef,
    update(t) {
      pulsing.forEach((m, i) => {
        m.opacity = (peaks[i] ?? 1) * (0.8 + 0.2 * Math.sin(t * 2.4));
      });
      if (foil?.uniforms.uTime) foil.uniforms.uTime.value = t;
    },
    dispose() {
      for (const g of geometries) g.dispose();
      for (const m of materials) m.dispose();
    },
  };
}

/** A soft radial glow texture for additive layers. */
export function createGlowTexture(color: THREE.ColorRepresentation, size = 256): THREE.Texture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const c = new THREE.Color(color);
  if (ctx) {
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    const rgb = `${Math.round(c.r * 255)}, ${Math.round(c.g * 255)}, ${Math.round(c.b * 255)}`;
    g.addColorStop(0, `rgba(${rgb}, 1)`);
    g.addColorStop(0.35, `rgba(${rgb}, 0.45)`);
    g.addColorStop(1, `rgba(${rgb}, 0)`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}
