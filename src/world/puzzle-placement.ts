import * as THREE from 'three';
import { templateById } from '../content/rooms.ts';
import { Stream } from '../core/rng.ts';
import type { FloorWorld } from './floor-world.ts';
import type { InteriorPlacement } from './interior-furnishings.ts';

export interface PuzzleMount {
  room: number;
  center: THREE.Vector3;
  wallSurface: THREE.Vector3;
  yaw: number;
}
/** All wall scans use the unrotated template; fixture colliders arrive in world space. */
function mountingPoint(
  world: FloorWorld,
  room: number,
  props: readonly InteriorPlacement[],
  stream: Stream | undefined,
  halfWidth: number,
  depth: number,
  fullHeight: number | undefined,
): PuzzleMount | null {
  const template = templateById(world.plan.rooms[room].templateId);
  const { min, max } = template.footprint;
  const parent = world.roomGroups[room];
  parent.updateWorldMatrix(true, true);
  const inverse = parent.matrixWorld.clone().invert();
  const obstacles = world.colliders[room].map((b) =>
    new THREE.Box3(new THREE.Vector3(...b.min), new THREE.Vector3(...b.max)).applyMatrix4(inverse),
  );
  const furnishingBounds = props
    .filter((p) => p.room === room)
    .map((p) => new THREE.Box3().setFromObject(p.object).applyMatrix4(inverse));
  // Authored sconces and shelf trim can project through a plaque without a physics collider.
  const surfaces: THREE.Object3D[] = [];
  for (const child of parent.children)
    child.traverseVisible((node) => {
      if (node instanceof THREE.Mesh && !node.material?.transparent) surfaces.push(node);
    });
  const probe = new THREE.Raycaster();
  const rayPoint = new THREE.Vector3();
  const walls = ['S', 'E', 'W', 'N'] as const;
  for (const wall of stream?.shuffle(walls) ?? walls) {
    const ns = wall === 'N' || wall === 'S';
    const lo = ns ? min[0] : min[1],
      hi = ns ? max[0] : max[1];
    const edge = wall === 'N' ? min[1] : wall === 'S' ? max[1] : wall === 'W' ? min[0] : max[0];
    const yaw = { S: Math.PI, E: -Math.PI / 2, W: Math.PI / 2, N: 0 }[wall];
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    const inward = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
    const sockets = template.doors.filter((d) => d.facing === wall);
    const slots = Array.from(
      { length: Math.floor((hi - lo - 2) / 0.5) + 1 },
      (_, i) => lo + 1 + i * 0.5,
    );
    for (const along of stream?.shuffle(slots) ?? slots.sort((a, b) => Math.abs(a) - Math.abs(b))) {
      if (
        sockets.some(
          (d) => Math.abs(along - d.position[ns ? 0 : 2]) < d.width / 2 + halfWidth + 0.2,
        )
      )
        continue;
      if (
        wall === 'N' &&
        ((template.id === 'hall' && Math.abs(along - 2.6) < 1.5) ||
          (template.id === 'study' && Math.abs(along) < 1.5))
      )
        continue;
      const center = new THREE.Vector3(ns ? along : edge, 1.48, ns ? edge : along).addScaledVector(
        inward,
        0.13,
      );
      const space = new THREE.Box3(
        new THREE.Vector3(-halfWidth, fullHeight ? -1.48 : -0.75, 0.07),
        new THREE.Vector3(halfWidth, fullHeight ? fullHeight - 1.48 : 0.65, depth),
      ).applyMatrix4(new THREE.Matrix4().compose(center, q, new THREE.Vector3(1, 1, 1)));
      if (obstacles.some((b) => space.intersectsBox(b))) continue;
      const back = new THREE.Box3(
        new THREE.Vector3(-halfWidth - 0.08, fullHeight ? -1.48 : -0.49, -0.18),
        new THREE.Vector3(halfWidth + 0.08, fullHeight ? fullHeight - 1.48 : 0.49, depth),
      ).applyMatrix4(new THREE.Matrix4().compose(center, q, new THREE.Vector3(1, 1, 1)));
      if (furnishingBounds.some((b) => back.intersectsBox(b))) continue;
      const direction = inward.clone().negate().transformDirection(parent.matrixWorld);
      probe.far = 0.93;
      const wallSurface = center.clone();
      const samples = fullHeight
        ? [-halfWidth, -halfWidth / 2, 0, halfWidth / 2, halfWidth]
        : [-0.6, -0.3, 0, 0.3, 0.6];
      const heights = fullHeight
        ? [0.16 - 1.48, 0.68 - 1.48, 0, 0.34, fullHeight - 1.48]
        : [-0.34, 0, 0.34];
      const clear = samples.every((x) =>
        heights.every((y) => {
          rayPoint.set(x, y, 0.63).applyQuaternion(q).add(center).applyMatrix4(parent.matrixWorld);
          probe.set(rayPoint, direction);
          const hit = probe.intersectObjects(surfaces, false)[0];
          if (hit && x === 0 && y === 0) wallSurface.copy(hit.point).applyMatrix4(inverse);
          return hit !== undefined && hit.distance >= 0.625;
        }),
      );
      if (clear) return { room, center, wallSurface, yaw };
    }
  }
  return null;
}

export function findPuzzleMount(
  world: FloorWorld,
  rooms: readonly number[],
  props: readonly InteriorPlacement[],
  placementKey?: string,
  halfWidth = 0.66,
  depth = 1.4,
  fullHeight?: number,
): PuzzleMount | null {
  const stream = placementKey
    ? Stream.fromKey(`${world.plan.seed}:mount:${placementKey}`)
    : undefined;
  const offered = world.plan.hiddenPassage
    ? rooms.filter((room) => room !== world.plan.hiddenPassage?.treasureRoom)
    : rooms;
  for (const room of stream?.shuffle(offered) ?? offered) {
    const mount = mountingPoint(world, room, props, stream, halfWidth, depth, fullHeight);
    if (mount) return mount;
  }
  return null;
}

export function kitPart(model: THREE.Object3D, name: string): THREE.Object3D {
  const node = model.getObjectByName(name);
  if (!node) throw Error(`Missing authored puzzle part: ${name}`);
  return node;
}
