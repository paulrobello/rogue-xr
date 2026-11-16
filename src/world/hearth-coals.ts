import * as THREE from 'three';
import { Stream } from '../core/rng.ts';

/** Radius of the coal heap, inside the bowl's rim. */
const HEAP_RADIUS = 0.31;
/** How far the heap's crown rises above the rim. */
const HEAP_CROWN = 0.11;
const MAX_LUMPS = 110;
const FLAME_COUNT = 5;
const SPARK_COUNT = 10;

/** Glow ramp, edge to core (sRGB hex, converted to linear by THREE.Color). */
const DEEP_RED = new THREE.Color('#8a1204');
const AMBER = new THREE.Color('#ff5e0a');
const CORE = new THREE.Color('#ffb52e');
const CRUST = new THREE.Color('#1e130d');
const ASH_DARK = new THREE.Color('#161413');
const ASH_LIGHT = new THREE.Color('#4f4b47');
const EMBER = new THREE.Color('#a01a06');

/** The glow colour `heat` (0 at the heap's edge, 1 at its core) shows. */
export function coalGlow(heat: number, out = new THREE.Color()): THREE.Color {
  const t = THREE.MathUtils.clamp(heat, 0, 1);
  return t < 0.5 ? out.lerpColors(DEEP_RED, AMBER, t * 2) : out.lerpColors(AMBER, CORE, t * 2 - 1);
}

/** Height of the heap's surface above the rim at `r` metres from the bowl's axis. */
function heapSurface(r: number): number {
  const u = Math.min(1, r / HEAP_RADIUS);
  return HEAP_CROWN * (1 - u * u);
}

/**
 * The glowing bed under the lumps, its top at the rim: a low mound just under the heap's surface
 * whose vertex colours run from hot core to deep-red edge. It shows between lumps as glowing seams.
 */
export function coalBedGeometry(radius: number): THREE.BufferGeometry {
  const geometry = new THREE.SphereGeometry(radius, 20, 6, 0, Math.PI * 2, 0, Math.PI / 2);
  const position = geometry.attributes.position as THREE.BufferAttribute;
  const colors = new Float32Array(position.count * 3);
  const c = new THREE.Color();
  for (let i = 0; i < position.count; i++) {
    const r = Math.hypot(position.getX(i), position.getZ(i));
    position.setY(i, heapSurface(r) * 0.72 + 0.004);
    // A fixed ripple of brighter and duller patches, so the seams do not read as one flat wash.
    const patch = 0.78 + 0.22 * Math.sin(i * 12.9898) * Math.sin(i * 4.1414);
    coalGlow((1 - r / radius) ** 1.3, c)
      .multiplyScalar(patch)
      .toArray(colors, i * 3);
  }
  geometry.computeBoundingSphere();
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geometry;
}

interface Lump {
  readonly x: number;
  readonly z: number;
  readonly y: number;
  readonly radius: number;
}

/**
 * A heaped scatter of lumps: rejection-sampled over the heap's disc, each sitting on its surface.
 * Large lumps go down first, then smaller pieces fill the gaps between them.
 */
function scatterLumps(stream: Stream): Lump[] {
  const lumps: Lump[] = [];
  for (let attempt = 0; attempt < 4000 && lumps.length < MAX_LUMPS; attempt++) {
    const small = attempt >= 2000;
    const radius = small ? 0.016 + 0.014 * stream.next() : 0.03 + 0.028 * stream.next();
    const r = (HEAP_RADIUS - radius * 0.4) * Math.sqrt(stream.next());
    const angle = stream.next() * Math.PI * 2;
    const x = Math.cos(angle) * r;
    const z = Math.sin(angle) * r;
    // Lumps may overlap a little, but leave seams where the glowing bed shows through.
    const clear = lumps.every((o) => Math.hypot(o.x - x, o.z - z) > (o.radius + radius) * 0.7);
    if (!clear) continue;
    lumps.push({ x, z, y: heapSurface(r) - radius * 0.3, radius });
  }
  return lumps;
}

/**
 * One merged geometry of faceted coal lumps for the hearth `key`. Attributes: `color` is the lit
 * look (dark crust, glowing undersides and seams, hot core to red edge), `ashColor` the spent look
 * (grey ash with a few faint embers) and `seed` a per-lump flicker phase. Same key, same heap.
 */
export function coalLumpGeometry(key: string): THREE.BufferGeometry {
  const stream = Stream.fromKey(`hearth-coals:${key}`);
  const lumps = scatterLumps(stream);
  const template = new THREE.IcosahedronGeometry(1, 0);
  const base = template.attributes.position as THREE.BufferAttribute;
  const per = base.count;
  const positions = new Float32Array(lumps.length * per * 3);
  const lit = new Float32Array(lumps.length * per * 3);
  const ash = new Float32Array(lumps.length * per * 3);
  const seeds = new Float32Array(lumps.length * per);
  const v = new THREE.Vector3();
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const n = new THREE.Vector3();
  const glow = new THREE.Color();
  const crust = new THREE.Color();
  const grey = new THREE.Color();
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const local: THREE.Vector3[] = [];
  lumps.forEach((lump, index) => {
    // Shared corners get the same jitter so the faceted lump stays closed.
    const jitter = new Map<string, number>();
    const flat = 0.55 + 0.25 * stream.next();
    const stretch = 0.85 + 0.35 * stream.next();
    e.set(stream.next() * 0.6 - 0.3, stream.next() * Math.PI * 2, stream.next() * 0.6 - 0.3);
    m.compose(
      new THREE.Vector3(lump.x, lump.y, lump.z),
      q.setFromEuler(e),
      new THREE.Vector3(lump.radius * stretch, lump.radius * flat, lump.radius),
    );
    const r = Math.hypot(lump.x, lump.z) / HEAP_RADIUS;
    const heat = THREE.MathUtils.clamp(1 - r + (stream.next() - 0.5) * 0.3, 0, 1);
    const hot = stream.next() < 0.12;
    const ember = stream.next() < 0.3 && heat > 0.3;
    const ashTone = stream.next();
    const phase = stream.next();
    local.length = 0;
    for (let i = 0; i < per; i++) {
      v.fromBufferAttribute(base, i);
      const id = `${v.x.toFixed(4)},${v.y.toFixed(4)},${v.z.toFixed(4)}`;
      let k = jitter.get(id);
      if (k === undefined) {
        k = 0.8 + 0.35 * stream.next();
        jitter.set(id, k);
      }
      local.push(v.clone().multiplyScalar(k));
    }
    for (let f = 0; f < per; f += 3) {
      const corners = [local[f], local[f + 1], local[f + 2]].map((p) =>
        (p as THREE.Vector3).clone().applyMatrix4(m),
      ) as [THREE.Vector3, THREE.Vector3, THREE.Vector3];
      n.crossVectors(
        a.subVectors(corners[1], corners[0]),
        b.subVectors(corners[2], corners[0]),
      ).normalize();
      // A fixed top-left key light baked into the facets, so unlit lumps still read as solid.
      const shade = 0.45 + 0.55 * Math.max(0, n.y * 0.75 + n.x * 0.25 - n.z * 0.2);
      // Now and then a facet cracks open and glows, more often toward the hot core.
      const crack = stream.next() < 0.04 + 0.08 * heat ? 0.45 + 0.4 * heat : 0;
      for (let c = 0; c < 3; c++) {
        const i = f + c;
        const p = corners[c];
        const o = index * per + i;
        p.toArray(positions, o * 3);
        // -1 at the lump's underside, +1 at its crown.
        const height = THREE.MathUtils.clamp((p.y - lump.y) / (lump.radius * flat), -1, 1);
        let g = THREE.MathUtils.smoothstep(-height, 0, 0.95) * (0.5 + 0.5 * heat);
        if (hot) g = Math.max(g, 0.45 + 0.35 * heat);
        g = Math.max(g, crack);
        coalGlow(heat * 0.85 + g * 0.15, glow);
        // The crust catches a little of the glow around it, warmer toward the core.
        crust
          .copy(CRUST)
          .multiplyScalar(0.6 + 0.8 * shade)
          .lerp(glow, 0.03 + 0.07 * heat);
        crust.lerp(glow, g).toArray(lit, o * 3);
        grey.lerpColors(ASH_DARK, ASH_LIGHT, ashTone * 0.6 + Math.max(0, height) * 0.4);
        grey.multiplyScalar(0.4 + 0.6 * shade);
        if (ember) {
          grey.lerp(EMBER, THREE.MathUtils.smoothstep(-height, 0, 0.9) * 0.55 * heat);
          if (crack > 0) grey.lerp(EMBER, 0.25 + 0.15 * heat);
        }
        grey.toArray(ash, o * 3);
        seeds[o] = phase;
      }
    }
  });
  template.dispose();
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(lit, 3));
  geometry.setAttribute('ashColor', new THREE.BufferAttribute(ash, 3));
  geometry.setAttribute('seed', new THREE.BufferAttribute(seeds, 1));
  geometry.computeBoundingSphere();
  return geometry;
}

/** Lumps shade by their baked colours, flicker per lump while lit, and fade to their ash colours. */
export function coalLumpMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: 'hearth-coal-lumps',
    toneMapped: false,
    uniforms: { uTime: { value: 0 }, uDim: { value: 0 } },
    vertexShader: /* glsl */ `
      attribute vec3 color;
      attribute vec3 ashColor;
      attribute float seed;
      uniform float uTime;
      uniform float uDim;
      varying vec3 vColor;
      void main() {
        float flicker = 0.84 + 0.16 * sin(uTime * (2.2 + seed * 3.1) + seed * 40.0)
          * sin(uTime * 1.3 + seed * 17.0);
        vColor = mix(color * flicker, ashColor, uDim);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vColor;
      void main() {
        gl_FragColor = vec4(vColor, 1.0);
        #include <colorspace_fragment>
      }
    `,
  });
}

/**
 * A few flame tongues licking up from the heap's crown and sparks rising off it, merged into one
 * geometry of camera-facing quads (one draw call). `position` is each quad's base on the heap;
 * `corner` its corner and `params` (seed, width, height, kind: 0 flame, 1 spark).
 */
export function flameGeometry(key: string): THREE.BufferGeometry {
  const stream = Stream.fromKey(`hearth-flames:${key}`);
  const quads = FLAME_COUNT + SPARK_COUNT;
  const positions = new Float32Array(quads * 4 * 3);
  const corners = new Float32Array(quads * 4 * 2);
  const params = new Float32Array(quads * 4 * 4);
  const index: number[] = [];
  const quadCorners = [
    [-1, 0],
    [1, 0],
    [1, 1],
    [-1, 1],
  ] as const;
  for (let qd = 0; qd < quads; qd++) {
    const spark = qd >= FLAME_COUNT;
    const r = (spark ? 0.22 : 0.13) * Math.sqrt(stream.next());
    const angle = stream.next() * Math.PI * 2;
    const x = Math.cos(angle) * r;
    const z = Math.sin(angle) * r;
    const y = heapSurface(r) + (spark ? 0.02 : -0.015);
    const seed = stream.next();
    const width = spark ? 0.012 + 0.008 * stream.next() : 0.06 + 0.035 * stream.next();
    const height = spark ? width : 0.12 + 0.1 * stream.next() * (1 - r / 0.13);
    for (let c = 0; c < 4; c++) {
      const o = qd * 4 + c;
      positions.set([x, y, z], o * 3);
      corners.set(quadCorners[c] as readonly [number, number], o * 2);
      params.set([seed, width, height, spark ? 1 : 0], o * 4);
    }
    const s = qd * 4;
    index.push(s, s + 1, s + 2, s, s + 2, s + 3);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setIndex(index);
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('corner', new THREE.BufferAttribute(corners, 2));
  geometry.setAttribute('params', new THREE.BufferAttribute(params, 4));
  return geometry;
}

/** Additive, unlit flames and sparks; `uTime` animates them and `uFade` (1 lit, 0 out) fades them. */
export function flameMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: 'hearth-flames',
    toneMapped: false,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uTime: { value: 0 },
      uFade: { value: 1 },
      uCore: { value: new THREE.Color('#ffd27a') },
      uMid: { value: new THREE.Color('#ff7a14') },
      uTip: { value: new THREE.Color('#c42a06') },
      uSpark: { value: new THREE.Color('#ffb040') },
    },
    vertexShader: /* glsl */ `
      attribute vec2 corner;
      attribute vec4 params;
      uniform float uTime;
      varying vec2 vUv;
      varying float vKind;
      varying float vLife;
      varying float vSeed;
      void main() {
        float seed = params.x;
        float width = params.y;
        float height = params.z;
        vec3 base = position;
        float life = 0.0;
        vec2 offset = corner;
        if (params.w > 0.5) {
          life = fract(uTime * (0.3 + seed * 0.35) + seed * 7.0);
          base.y += life * 0.42;
          base.x += sin(uTime * 1.7 + seed * 30.0) * 0.035 * life;
          base.z += cos(uTime * 1.3 + seed * 20.0) * 0.035 * life;
          offset.y -= 0.5;
          height = width;
        } else {
          height *= 0.8 + 0.2 * sin(uTime * (6.0 + seed * 4.0) + seed * 10.0)
            + 0.12 * sin(uTime * 2.3 + seed * 5.0);
        }
        vec4 world = modelMatrix * vec4(base, 1.0);
        vec3 right = normalize(vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]));
        world.xyz += right * offset.x * width * 0.5 + vec3(0.0, offset.y * height, 0.0);
        gl_Position = projectionMatrix * viewMatrix * world;
        vUv = corner;
        vKind = params.w;
        vLife = life;
        vSeed = seed;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform float uFade;
      uniform vec3 uCore;
      uniform vec3 uMid;
      uniform vec3 uTip;
      uniform vec3 uSpark;
      varying vec2 vUv;
      varying float vKind;
      varying float vLife;
      varying float vSeed;
      void main() {
        vec3 color;
        float alpha;
        if (vKind > 0.5) {
          float d = length(vec2(vUv.x, vUv.y * 2.0 - 1.0));
          alpha = smoothstep(1.0, 0.1, d) * (1.0 - vLife) * smoothstep(0.0, 0.08, vLife);
          color = mix(uSpark, uTip, vLife);
        } else {
          float y = vUv.y;
          float x = vUv.x + sin(uTime * 4.3 + vSeed * 9.0 + y * 5.0) * 0.28 * y;
          float width = pow(1.0 - y, 0.7) * smoothstep(0.0, 0.2, y + 0.06);
          float d = abs(x) / max(width, 0.001);
          alpha = smoothstep(1.0, 0.25, d) * smoothstep(1.0, 0.5, y);
          color = mix(uCore, uMid, smoothstep(0.05, 0.45, y + d * 0.35));
          color = mix(color, uTip, smoothstep(0.45, 0.95, y));
        }
        gl_FragColor = vec4(color, alpha * uFade);
        #include <colorspace_fragment>
      }
    `,
  });
}
