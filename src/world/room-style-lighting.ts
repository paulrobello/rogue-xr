import * as THREE from 'three';
import type { InteriorPlacement } from './interior-furnishings.ts';
import { bakedRoomMaterial } from './study-room.ts';

const TILE = 128;
const FACES = 6;
type Lamp = { x: number; y: number; z: number; power: number };
type Shadow = {
  x: number;
  z: number;
  rx: number;
  rz: number;
  amount: number;
  cos: number;
  sin: number;
};

// Each wall, the deck and the ceiling has a chart. Half-texel insets keep the neighbouring chart out of the filter.
const atlasVertex = (edge: number, horizontalTile: boolean) => `
vec3 finishP = position;
float finishFace;
#ifdef USE_INSTANCING
  finishP = (instanceMatrix * vec4(position, 1.)).xyz;
  ${
    horizontalTile
      ? `finishFace = finishP.y < 2. ? 4. : 5.;
  vec2 finishUv = finishP.xz / ${(2 * edge).toFixed(1)} + .5;`
      : `
  vec2 centre = instanceMatrix[3].xz;
  finishFace = abs(centre.x) > abs(centre.y) ? (centre.x > 0. ? 1. : 3.) : (centre.y > 0. ? 2. : 0.);
  vec2 finishUv = vec2((mod(finishFace, 2.) < .5 ? finishP.x : finishP.z) / ${(2 * edge).toFixed(1)} + .5, finishP.y / 4.);`
  }
#else
  finishFace = finishP.y < 2. ? 4. : 5.;
  vec2 finishUv = finishP.xz / 8. + .5;
#endif
vLightMapUv = (vec2(mod(finishFace, 3.), floor(finishFace / 3.)) +
  (.5 + clamp(finishUv, 0., 1.) * ${TILE - 1}.) / ${TILE}.) / vec2(3., 2.);
`;

function footprint(
  shadows: Shadow[],
  x: number,
  z: number,
  yaw: number,
  dx: number,
  dz: number,
  rx: number,
  rz: number,
  amount: number,
): void {
  const cos = Math.cos(yaw),
    sin = Math.sin(yaw);
  shadows.push({
    x: x + dx * cos + dz * sin,
    z: z - dx * sin + dz * cos,
    cos,
    sin,
    rx,
    rz,
    amount,
  });
}

function contact(shadows: readonly Shadow[], x: number, z: number): number {
  let shade = 1;
  for (const s of shadows) {
    const dx = x - s.x,
      dz = z - s.z;
    const u = (dx * s.cos - dz * s.sin) / s.rx,
      v = (dz * s.cos + dx * s.sin) / s.rz;
    const r = u * u + v * v;
    if (r < 6) shade *= 1 - s.amount * Math.exp(-r);
  }
  return shade;
}

// Furniture lives under the room transform as a sibling of its architectural shell.
const diningMaterials = new WeakMap<THREE.Group, Set<THREE.Material>>();

export function releaseDiningLighting(room: THREE.Group): void {
  for (const m of diningMaterials.get(room) ?? []) m.dispose();
  diningMaterials.delete(room);
}

function lightDiningSet(room: THREE.Group, placements: readonly InteriorPlacement[]): void {
  const lamp = placements.find((p) => p.room === room.userData.room && p.root === 'Candelabrum');
  const flame = lamp?.object.getObjectByName('Candelabrum_FlameSocket_00');
  if (!flame) return;
  const at = flame.getWorldPosition(new THREE.Vector3());
  const lit = new Map<THREE.Material, THREE.Material>();
  const lightMaterial = (source: THREE.Material): THREE.Material => {
    if (!(source instanceof THREE.MeshStandardMaterial)) return source;
    const existing = lit.get(source);
    if (existing) return existing;
    const mat = source.clone();
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.diningCandle = { value: at };
      shader.fragmentShader =
        'uniform vec3 diningCandle;\n' +
        shader.fragmentShader.replace(
          '#include <lights_fragment_end>',
          `
#include <lights_fragment_end>
reflectedLight.directDiffuse *= .43;
reflectedLight.directSpecular *= .52;
reflectedLight.indirectDiffuse *= .48;
reflectedLight.indirectSpecular *= .64;
vec3 candleVector = (viewMatrix * vec4(diningCandle, 1.)).xyz - geometryPosition;
IncidentLight candle;
candle.direction = normalize(candleVector);
candle.color = vec3(3.8, 2.14, .97) / max(dot(candleVector,candleVector), .42);
candle.visible = true;
RE_Direct(candle, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight);
`,
        );
    };
    mat.customProgramCacheKey = () => 'dining-candle-v1';
    lit.set(source, mat);
    return mat;
  };
  for (const p of placements) {
    if (
      p.room !== room.userData.room ||
      !['DiningTable', 'DiningChair', 'Candelabrum'].includes(p.root)
    )
      continue;
    p.object.traverse((node) => {
      if (node instanceof THREE.Mesh)
        node.material = Array.isArray(node.material)
          ? node.material.map(lightMaterial)
          : lightMaterial(node.material);
    });
  }
  diningMaterials.set(room, new Set(lit.values()));
}

/** Stationary practicals, chairs and desk only need to light the architecture once, at floor dressing. */
export function lightRoomStyle(room: THREE.Group, placements: readonly InteriorPlacement[]): void {
  if (!room.userData.roomStyle || room.userData.finishLightMap) return;
  const lamps: Lamp[] = [],
    shadows: Shadow[] = [];
  const matrix = new THREE.Matrix4(),
    centre = new THREE.Vector3();
  const stone =
    room.userData.roomStyle === 'stone-dungeon' ||
    room.userData.roomStyle === 'stone-cloister' ||
    room.userData.roomStyle === 'stone-cistern';
  const skylight = room.userData.stoneSkylight as readonly [number, number, number] | undefined;
  const torchSockets: readonly THREE.Object3D[] = room.userData.stoneTorchSockets ?? [];
  for (const socket of torchSockets) {
    room.worldToLocal(socket.getWorldPosition(centre));
    lamps.push({ x: centre.x, y: centre.y, z: centre.z, power: 1.8 });
  }
  const stoneShelf = room.getObjectByName('StoneShelf');
  if (stoneShelf)
    footprint(
      shadows,
      stoneShelf.position.x,
      stoneShelf.position.z,
      stoneShelf.rotation.y,
      0,
      0,
      0.7,
      0.31,
      0.56,
    );
  room.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) return;
    const material = node.material;
    if (node instanceof THREE.InstancedMesh && material.name === 'PracticalAmberGlass') {
      const g = node.geometry;
      g.computeBoundingBox();
      for (let i = 0; i < node.count; i++) {
        node.getMatrixAt(i, matrix);
        g.boundingBox.getCenter(centre).applyMatrix4(matrix);
        lamps.push({ x: centre.x, y: centre.y, z: centre.z, power: 1.2 });
      }
    } else if (node.name === 'timber-writing-desk-study_flame') {
      node.geometry.computeBoundingBox();
      node.geometry.boundingBox.getCenter(centre);
      lamps.push({ x: centre.x, y: centre.y, z: centre.z, power: 0.62 });
      footprint(shadows, 2.4, 2.4, 0, 0, 0, 0.96, 0.84, 0.52);
    }
  });
  for (const p of placements) {
    if (p.room !== room.userData.room) continue;
    const { x, z } = p.position;
    if (p.root === 'Candelabrum') {
      const tip = p.object.getObjectByName('Candelabrum_FlameSocket_00');
      if (tip) {
        room.worldToLocal(tip.getWorldPosition(centre));
        lamps.push({ x: centre.x, y: centre.y, z: centre.z, power: 1.8 });
      }
    }
    if (p.root !== 'DiningChair' && p.root !== 'DiningTable') continue;
    const table = p.root === 'DiningTable';
    footprint(
      shadows,
      x,
      z,
      p.yaw,
      0,
      0,
      table ? 1.03 : 0.41,
      table ? 0.6 : 0.38,
      table ? 0.53 : 0.43,
    );
    for (const signX of [-1, 1])
      for (const signZ of [-1, 1])
        footprint(
          shadows,
          x,
          z,
          p.yaw,
          signX * (table ? 0.7 : 0.23),
          signZ * (table ? 0.3 : 0.2),
          0.12,
          0.12,
          0.67,
        );
  }
  const edge: number = room.userData.finishEdge ?? 4;
  const timber = room.userData.roomStyle === 'timber';
  if (timber) lightDiningSet(room, placements);
  const pixels = new Uint8Array(TILE * TILE * FACES * 4);
  for (let face = 0; face < FACES; face++) {
    for (let j = 0; j < TILE; j++)
      for (let i = 0; i < TILE; i++) {
        const u = (2 * edge * i) / (TILE - 1) - edge,
          v = j / (TILE - 1);
        const x = face === 1 ? edge : face === 3 ? -edge : u;
        const y = face === 4 ? 0 : face === 5 ? 4 : 4 * v;
        const z = face === 0 ? -edge : face === 2 ? edge : face < 4 ? u : (2 * v - 1) * edge;
        let glow = 0;
        for (const l of lamps) {
          const dx = x - l.x,
            dy = y - l.y,
            dz = z - l.z;
          glow += l.power / (0.82 + dx * dx + dy * dy * 0.78 + dz * dz);
        }
        const ao = face === 4 ? contact(shadows, x, z) : 1;
        const base =
          (face === 5 ? 0.65 : face === 4 ? 0.78 : 0.74) *
          (stone ? (skylight ? 0.57 : 0.39) : timber ? 0.46 : 0.65);
        let daylight = 0;
        if (skylight) {
          const drop = skylight[1] - y;
          const dx = x - skylight[0] - 0.4 * drop,
            dz = z - skylight[2] + 0.19 * drop;
          const width = 0.57 + drop * 0.11;
          daylight = 0.76 * Math.exp(-(dx * dx + dz * dz) / (width * width));
        }
        const k = 4 * (((Math.floor(face / 3) * TILE + j) * 3 + (face % 3)) * TILE + i);
        pixels[k] = Math.min(255, 128 * ao * (base + glow + daylight));
        pixels[k + 1] = Math.min(
          255,
          128 * ao * (base + glow * (room.userData.conservatory ? 0.85 : 0.63) + daylight * 0.94),
        );
        pixels[k + 2] = Math.min(
          255,
          128 * ao * (base + glow * (room.userData.conservatory ? 1.1 : 0.36) + daylight * 0.79),
        );
        pixels[k + 3] = 255;
      }
  }
  const texture = new THREE.DataTexture(pixels, TILE * 3, TILE * 2, THREE.RGBAFormat);
  texture.name = 'room-finish-lighting';
  texture.magFilter = texture.minFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  room.userData.finishLightMap = texture;
  const wallMaterials = new Map<THREE.Material, THREE.Material>();
  const surfaceMaterials = new Map<THREE.Material, THREE.Material>();
  const shade = (source: THREE.Material, mesh: THREE.Mesh): THREE.Material => {
    const stoneShell = mesh.userData.stoneShell === true;
    const horizontalTile = mesh.userData.stoneSurface === true;
    if (
      !(source instanceof THREE.MeshStandardMaterial) ||
      (!stoneShell && !['BoilerFinish', 'TimberFinish'].includes(source.name))
    )
      return source;
    const materials = horizontalTile ? surfaceMaterials : wallMaterials;
    const existing = materials.get(source);
    if (existing) return existing;
    const m = bakedRoomMaterial(source.userData.roomStyleOwned ? source : source.clone());
    m.userData.roomStyleOwned = true;
    m.lightMap = texture;
    m.envMapIntensity *= timber ? 0.6 : 0.45;
    m.lightMapIntensity = 1.5 * Math.PI;
    const bake = m.onBeforeCompile;
    m.onBeforeCompile = (shader, renderer) => {
      bake.call(m, shader, renderer);
      if (room.userData.conservatory) {
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <map_fragment>',
          `#include <map_fragment>
          float grain = dot(diffuseColor.rgb, vec3(.42,.46,.12));
          diffuseColor.rgb = mix(vec3(.012,.028,.054), vec3(.24,.52,.49), sqrt(clamp(grain,0.,1.))) *
            (.62 + grain*1.7);`,
        );
      }
      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>\n${atlasVertex(edge, horizontalTile)}`,
      );
    };
    m.customProgramCacheKey = () =>
      `room-finish-lighting-${edge}-${!!room.userData.conservatory}-${horizontalTile}`;
    materials.set(source, m);
    return m;
  };
  room.traverse((node) => {
    if (node instanceof THREE.Mesh)
      node.material = Array.isArray(node.material)
        ? node.material.map((material) => shade(material, node))
        : shade(node.material, node);
  });
}
