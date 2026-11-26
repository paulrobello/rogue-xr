import * as THREE from 'three';
import type { FloorPlan } from '../floor/generate.ts';
import { CONSERVATORY_SHELL_DEPTH, neighbours, visibleSet } from '../floor/visibility.ts';

// Cap the number of point-light slots shaded by every visible PBR material.
const MAX_FIXED_ROOM_LIGHTS = 4;

/** Keeps reachable views on one shader variant by padding their real room lights with zero energy. */
export function stabilizeConservatoryLights(
  plan: FloorPlan,
  root: THREE.Group,
  groups: readonly THREE.Group[],
  arrivalRoom: number,
): { count: number; update: () => void } | null {
  const lightsByRoom = groups.map((group) => {
    const lights: THREE.PointLight[] = [];
    for (const child of group.children)
      child.traverseVisible((node) => {
        if (node instanceof THREE.PointLight) lights.push(node);
      });
    return lights;
  });
  let count = 0;
  const visited = new Set([arrivalRoom]);
  const queue = [arrivalRoom];
  for (const room of queue) {
    let visibleCount = 0;
    for (const visible of visibleSet(plan, room, CONSERVATORY_SHELL_DEPTH))
      visibleCount += lightsByRoom[visible]?.length ?? 0;
    count = Math.max(count, visibleCount);
    if (count > MAX_FIXED_ROOM_LIGHTS) return null;
    for (const neighbour of neighbours(plan, room)) {
      if (visited.has(neighbour)) continue;
      queue.push(neighbour);
      visited.add(neighbour);
    }
  }
  const padding = Array.from({ length: count }, () => new THREE.PointLight(0, 0));
  for (const light of padding) root.add(light);
  const update = () => {
    let active = 0;
    for (const [room, group] of groups.entries()) {
      if (!group.visible) continue;
      for (const light of lightsByRoom[room]) if (light.visible) active++;
    }
    for (const [index, light] of padding.entries()) light.visible = index < count - active;
  };
  update();
  return { count, update };
}
