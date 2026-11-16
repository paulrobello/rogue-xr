import * as THREE from 'three';

/**
 * Decision D11, the automaton glow. AgX tone mapping desaturates the GLBs' F08C2C emissive to pale
 * peach, so the glow material skips tone mapping and lighting and draws a fixed amber ramp: the hot
 * colour at the centre of each glow island (an eye, the grille, a chimney mouth) where it faces the
 * viewer, the manifest's emissive colour toward the island's rim and at grazing angles. Colours
 * were sampled from the concept sheets' glow pixels (hot p90 about 255,240,95; dim p25 about
 * 230,135,40). Brightness follows `emissiveIntensity`, so the actor's freeze dim and hit flash keep
 * driving it; the GLB's baked emissive factor (its build `GLOW_STRENGTH`) is ignored.
 */
export const GLOW_HOT = '#FFEC5A';
/** Exponent on the facing term: higher keeps the hot colour to surfaces turned square to the eye. */
export const GLOW_FALLOFF = 2;
/** Exponent on the radial term: higher widens the hot core before the rim colour takes over. */
export const GLOW_CORE = 2;
/** Per-vertex island centre (xyz, bind pose) and radius (w) that the radial ramp reads. */
export const GLOW_ISLAND_ATTRIBUTE = 'glowIsland';

/**
 * Writes {@link GLOW_ISLAND_ATTRIBUTE} on a glow geometry: every vertex gets the centroid and
 * radius of its connected island, with seam-split vertices welded by position. Shared geometry, so
 * this runs once per asset. Returns the island count.
 */
export function writeGlowIslands(geometry: THREE.BufferGeometry): number {
  const position = geometry.getAttribute('position');
  if (!position) return 0;
  const count = position.count;
  const parent = new Int32Array(count).map((_, i) => i);
  const find = (i: number): number => {
    let r = i;
    while (parent[r] !== r) r = parent[r] as number;
    while (parent[i] !== r) {
      const next = parent[i] as number;
      parent[i] = r;
      i = next;
    }
    return r;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };
  const welded = new Map<string, number>();
  for (let i = 0; i < count; i++) {
    const key = `${position.getX(i).toFixed(5)},${position.getY(i).toFixed(5)},${position.getZ(i).toFixed(5)}`;
    const first = welded.get(key);
    if (first === undefined) welded.set(key, i);
    else union(first, i);
  }
  const index = geometry.getIndex();
  const triangles = index ? index.count : count;
  for (let t = 0; t + 2 < triangles; t += 3) {
    const [a, b, c] = index
      ? [index.getX(t), index.getX(t + 1), index.getX(t + 2)]
      : [t, t + 1, t + 2];
    union(a, b);
    union(a, c);
  }
  const sums = new Map<number, { x: number; y: number; z: number; n: number; r: number }>();
  for (let i = 0; i < count; i++) {
    const root = find(i);
    const s = sums.get(root) ?? { x: 0, y: 0, z: 0, n: 0, r: 0 };
    s.x += position.getX(i);
    s.y += position.getY(i);
    s.z += position.getZ(i);
    s.n += 1;
    sums.set(root, s);
  }
  for (const s of sums.values()) {
    s.x /= s.n;
    s.y /= s.n;
    s.z /= s.n;
  }
  const centre = new THREE.Vector3();
  const p = new THREE.Vector3();
  for (let i = 0; i < count; i++) {
    const s = sums.get(find(i));
    if (!s) continue;
    s.r = Math.max(s.r, p.fromBufferAttribute(position, i).distanceTo(centre.set(s.x, s.y, s.z)));
  }
  const data = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    const s = sums.get(find(i));
    if (!s) continue;
    data.set([s.x, s.y, s.z, Math.max(s.r, 1e-4)], i * 4);
  }
  geometry.setAttribute(GLOW_ISLAND_ATTRIBUTE, new THREE.BufferAttribute(data, 4));
  return sums.size;
}

const VERTEX_HEAD = `attribute vec4 ${GLOW_ISLAND_ATTRIBUTE};
varying vec3 vGlowOffset;
void main() {`;

// Skins the island centre with the vertex's own weights, so the ramp follows the animated pose.
const VERTEX_SKIN = `#include <skinning_vertex>
vec3 glowCentre = ${GLOW_ISLAND_ATTRIBUTE}.xyz;
#ifdef USE_SKINNING
  vec4 glowBind = bindMatrix * vec4( glowCentre, 1.0 );
  vec4 glowSkinned = boneMatX * glowBind * skinWeight.x + boneMatY * glowBind * skinWeight.y
    + boneMatZ * glowBind * skinWeight.z + boneMatW * glowBind * skinWeight.w;
  glowCentre = ( bindMatrixInverse * glowSkinned ).xyz;
#endif
vGlowOffset = ( transformed - glowCentre ) / ${GLOW_ISLAND_ATTRIBUTE}.w;`;

const FRAGMENT_HEAD = `uniform vec3 glowHot;
uniform vec3 glowRim;
uniform float glowFalloff;
uniform float glowCore;
varying vec3 vGlowOffset;
void main() {`;

const FRAGMENT_EMISSIVE = `#include <emissivemap_fragment>
float glowFacing = pow( saturate( dot( normal, normalize( vViewPosition ) ) ), glowFalloff );
float glowRadial = 1.0 - pow( saturate( length( vGlowOffset ) ), glowCore );
totalEmissiveRadiance = mix( glowRim, glowHot, glowFacing * glowRadial ) * emissive;`;

/** Turns `material` (an actor's own clone) into the D11 glow, with `rim` as the rim colour. */
export function applyGlowLook(
  material: THREE.MeshStandardMaterial,
  rim: THREE.ColorRepresentation,
): void {
  const uniforms = {
    glowHot: { value: new THREE.Color(GLOW_HOT) },
    glowRim: { value: new THREE.Color(rim) },
    glowFalloff: { value: GLOW_FALLOFF },
    glowCore: { value: GLOW_CORE },
  };
  material.toneMapped = false;
  material.color.set(0x000000);
  // White, so the `emissive` uniform carries emissiveIntensity alone as a grey scale.
  material.emissive.set(0xffffff);
  material.userData.glow = uniforms;
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('void main() {', VERTEX_HEAD)
      .replace('#include <skinning_vertex>', VERTEX_SKIN);
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', FRAGMENT_HEAD)
      .replace('#include <emissivemap_fragment>', FRAGMENT_EMISSIVE)
      .replace(
        'vec3 outgoingLight = totalDiffuse + totalSpecular + totalEmissiveRadiance;',
        'vec3 outgoingLight = totalEmissiveRadiance;',
      );
  };
  material.customProgramCacheKey = () => 'automaton-glow';
  material.needsUpdate = true;
}
