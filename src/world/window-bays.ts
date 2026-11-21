import * as THREE from 'three';
import { rotatePoint, rotateTemplate, templateById } from '../content/rooms.ts';
import type { FloorPlan, PlacedRoom } from '../floor/generate.ts';
import { roomStyleFor } from './room-styles.ts';

export interface WindowBay {
  readonly room: number;
  readonly x: number;
  readonly z: number;
}

interface Bay extends WindowBay {
  readonly halfWidth: number;
  readonly sill: number;
  readonly spring: number;
  readonly apex: number;
}

function bays(room: PlacedRoom): Bay[] {
  const definitions =
    room.templateId === 'hall'
      ? { xs: [2.6], z: -5, halfWidth: 0.6, sill: 1.4, spring: 2.55 }
      : room.templateId === 'study'
        ? { xs: [0], z: -4, halfWidth: 0.6, sill: 1.4, spring: 2.55 }
        : room.templateId === 'guardian-vault'
          ? { xs: [-2.6, 0, 2.6], z: -6, halfWidth: 0.55, sill: 1.7, spring: 3.1 }
          : null;
  if (!definitions) return [];
  const { xs, z, halfWidth, sill, spring } = definitions;
  return xs.map((x) => ({
    room: room.index,
    x,
    z,
    halfWidth,
    sill,
    spring,
    apex: spring + Math.sqrt(3) * halfWidth,
  }));
}

function isExposed(plan: FloorPlan, placed: PlacedRoom, bay: Bay): boolean {
  const [ax, , az] = rotatePoint([bay.x - bay.halfWidth, 0, bay.z], placed.turns);
  const [bx, , bz] = rotatePoint([bay.x + bay.halfWidth, 0, bay.z], placed.turns);
  const x0 = Math.min(ax, bx) + placed.position[0];
  const x1 = Math.max(ax, bx) + placed.position[0];
  const z0 = Math.min(az, bz) + placed.position[1];
  const z1 = Math.max(az, bz) + placed.position[1];
  const eps = 1e-5;
  return !plan.rooms.some((other) => {
    if (other.index === placed.index) return false;
    const footprint = rotateTemplate(templateById(other.templateId), other.turns).footprint;
    const minX = footprint.min[0] + other.position[0];
    const maxX = footprint.max[0] + other.position[0];
    const minZ = footprint.min[1] + other.position[1];
    const maxZ = footprint.max[1] + other.position[1];
    switch (placed.turns) {
      case 0:
        return Math.abs(maxZ - z0) < eps && Math.min(x1, maxX) - Math.max(x0, minX) > eps;
      case 1:
        return Math.abs(minX - x0) < eps && Math.min(z1, maxZ) - Math.max(z0, minZ) > eps;
      case 2:
        return Math.abs(minZ - z0) < eps && Math.min(x1, maxX) - Math.max(x0, minX) > eps;
      case 3:
        return Math.abs(maxX - x0) < eps && Math.min(z1, maxZ) - Math.max(z0, minZ) > eps;
    }
    return false;
  });
}

export function exposedWindowBays(plan: FloorPlan, floorNumber: 1 | 2 | 3): WindowBay[] {
  return plan.rooms.flatMap((room) =>
    roomStyleFor(plan, room.index, floorNumber)
      ? []
      : bays(room)
          .filter((bay) => isExposed(plan, room, bay))
          .map(({ room: index, x, z }) => ({ room: index, x, z })),
  );
}

/** Suppress the direct colored footprint in legacy lightmaps where a former lancet is opaque. */
function shadeClosedWindowFloor(
  source: THREE.MeshStandardMaterial,
  local: THREE.Matrix4,
  bays: readonly Bay[],
): THREE.MeshStandardMaterial {
  const material = source.clone();
  const number = (value: number): string => value.toFixed(4);
  const apertures = bays.map(({ x, z, halfWidth, sill, spring, apex }) =>
    [x, z, halfWidth, sill, spring, apex].map(number).join(', '),
  );
  const mask = apertures.reduce(
    (body, aperture) => `${body}\n  closedCast = max(closedCast, formerLancet(${aperture}));`,
    'float closedCast = 0.0;',
  );
  material.customProgramCacheKey = () =>
    `${source.customProgramCacheKey()}:opaque-window:${apertures}`;
  material.onBeforeCompile = (shader, renderer) => {
    source.onBeforeCompile(shader, renderer);
    shader.uniforms.roomWindowToLocal = { value: local };
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nvarying vec3 vRoomWindowPoint;\nuniform mat4 roomWindowToLocal;',
      )
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\nvRoomWindowPoint = (roomWindowToLocal * vec4(position, 1.0)).xyz;',
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec3 vRoomWindowPoint;
float formerLancet(float x, float z, float halfWidth, float sill, float spring, float apex) {
  // The source bakes use the same sun direction: (0.12, -0.65, 0.75) in game axes.
  float travel = vRoomWindowPoint.z - z;
  float height = vRoomWindowPoint.y + travel * (0.65 / 0.75);
  float offset = abs(vRoomWindowPoint.x - x - travel * (0.12 / 0.75));
  float rise = max(0.0, height - spring);
  float halfArch = sqrt(max(0.0, 4.0 * halfWidth * halfWidth - rise * rise)) - halfWidth;
  return (1.0 - smoothstep(halfArch - 0.05, halfArch + 0.18, offset))
    * smoothstep(sill - 0.20, sill - 0.01, height)
    * (1.0 - smoothstep(apex, apex + 0.18, height));
}`,
      )
      .replace(
        '#include <lights_fragment_maps>',
        THREE.ShaderChunk.lights_fragment_maps.replace(
          'irradiance += lightMapIrradiance;',
          `${mask}
        vec3 candleTint = vec3(1.0, 0.70, 0.49);
        vec3 neutral = lightMapIrradiance / candleTint;
        float fill = min(neutral.r, min(neutral.g, neutral.b));
        lightMapIrradiance = mix(lightMapIrradiance, candleTint * fill, closedCast);
        irradiance += lightMapIrradiance;`,
        ),
      );
  };
  return material;
}

/** Replaces shared-wall windows in a cloned room instance; the returned function releases owned resources. */
export function dressWindowBays(
  model: THREE.Object3D,
  plan: FloorPlan,
  room: number,
  floorNumber: 1 | 2 | 3,
): () => void {
  const placed = plan.rooms[room];
  if (!placed || roomStyleFor(plan, room, floorNumber)) return () => {};
  const allBays = bays(placed);
  if (!allBays.length) return () => {};
  const blocked = allBays.map((bay) => !isExposed(plan, placed, bay));
  const closedBays = allBays.filter((_, i) => blocked[i]);
  const modules = allBays.map((bay, i) => {
    const group = new THREE.Group();
    group.name = `window-bay-${i}`;
    group.userData.windowBay = { room, x: bay.x, z: bay.z, exposed: !blocked[i] };
    return group;
  });
  const extracted: THREE.BufferGeometry[] = [];
  model.updateWorldMatrix(true, true);
  const inverse = model.matrixWorld.clone().invert();
  const changed: {
    mesh: THREE.Mesh;
    original: THREE.BufferGeometry;
    replacement: THREE.BufferGeometry;
  }[] = [];
  const maskedFloors: {
    mesh: THREE.Mesh;
    original: THREE.MeshStandardMaterial;
    replacement: THREE.MeshStandardMaterial;
  }[] = [];
  let wallpaper: THREE.MeshStandardMaterial | undefined;
  const point = new THREE.Vector3();
  model.traverse((node) => {
    if (!(node instanceof THREE.Mesh) || Array.isArray(node.material)) return;
    if (
      node.material.name.includes('wallpaper') &&
      node.material instanceof THREE.MeshStandardMaterial
    )
      wallpaper = node.material;
    if (
      closedBays.length &&
      node.material instanceof THREE.MeshStandardMaterial &&
      node.material.lightMap &&
      node.material.name.endsWith('_stone-floor')
    ) {
      const original = node.material;
      const local = new THREE.Matrix4().multiplyMatrices(inverse, node.matrixWorld);
      const replacement = shadeClosedWindowFloor(original, local, closedBays);
      node.material = replacement;
      maskedFloors.push({ mesh: node, original, replacement });
    }
    if (!/stained-glass|walnut|wallpaper/.test(node.material.name)) return;
    const geometry = node.geometry;
    const position = geometry.getAttribute('position');
    if (!position) return;
    const transform = new THREE.Matrix4().multiplyMatrices(inverse, node.matrixWorld);
    const inside = new Int16Array(position.count).fill(-1);
    for (let i = 0; i < position.count; i++) {
      point.fromBufferAttribute(position, i).applyMatrix4(transform);
      inside[i] = allBays.findIndex(
        (b) =>
          Math.abs(point.x - b.x) <= b.halfWidth + 0.18 &&
          point.y >= b.sill - 0.11 &&
          point.y <= b.apex + 0.14 &&
          point.z >= b.z - 0.02 &&
          point.z <= b.z + 0.27,
      );
    }
    const index = geometry.index;
    const count = index?.count ?? position.count;
    const kept: number[] = [];
    const selected: number[][] = allBays.map(() => []);
    for (let i = 0; i < count; i += 3) {
      const a = index ? index.getX(i) : i;
      const b = index ? index.getX(i + 1) : i + 1;
      const c = index ? index.getX(i + 2) : i + 2;
      const bayIndex = inside[a];
      if (bayIndex >= 0 && inside[b] === bayIndex && inside[c] === bayIndex)
        selected[bayIndex].push(a, b, c);
      else kept.push(a, b, c);
    }
    if (kept.length === count) return;
    const replacement = geometry.clone();
    replacement.setIndex(kept);
    replacement.clearGroups();
    selected.forEach((indices, i) => {
      if (!indices.length || blocked[i]) return;
      const part = geometry.clone();
      part.setIndex(indices);
      part.clearGroups();
      const mesh = new THREE.Mesh(part, node.material);
      mesh.name = `window-part-${node.name}`;
      mesh.matrixAutoUpdate = false;
      mesh.matrix.copy(transform);
      mesh.castShadow = node.castShadow;
      mesh.receiveShadow = node.receiveShadow;
      modules[i].add(mesh);
      extracted.push(part);
    });
    node.geometry = replacement;
    changed.push({ mesh: node, original: geometry, replacement });
  });
  const patches: THREE.Mesh[] = [];
  const material = wallpaper?.clone() ?? new THREE.MeshStandardMaterial({ color: 0x777064 });
  material.lightMap = null;
  for (const [i, bay] of allBays.entries()) {
    model.add(modules[i]);
    if (!blocked[i]) continue;
    const height = bay.apex - bay.sill + 0.28;
    const centerY = (bay.sill + bay.apex) / 2;
    const geometry = new THREE.PlaneGeometry((bay.halfWidth + 0.18) * 2, height);
    const position = geometry.getAttribute('position');
    const uv = geometry.getAttribute('uv');
    for (let vertex = 0; vertex < position.count; vertex++) {
      const x = bay.x + position.getX(vertex);
      const y = centerY + position.getY(vertex);
      uv.setXY(vertex, x / 0.75, 1 + y / 0.75);
    }
    const patch = new THREE.Mesh(geometry, material);
    patch.name = 'shared-window-wall';
    patch.position.set(bay.x, centerY, bay.z + 0.012);
    modules[i].add(patch);
    patches.push(patch);
  }
  return () => {
    for (const { mesh, original, replacement } of changed) {
      if (mesh.geometry === replacement) mesh.geometry = original;
      replacement.dispose();
    }
    for (const patch of patches) {
      patch.removeFromParent();
      patch.geometry.dispose();
    }
    for (const module of modules) module.removeFromParent();
    for (const geometry of extracted) geometry.dispose();
    for (const { mesh, original, replacement } of maskedFloors) {
      mesh.material = original;
      replacement.dispose();
    }
    material.dispose();
  };
}
