import * as THREE from 'three';
import type { RoomTemplate } from '../content/rooms.ts';
import { PALETTE } from '../palette.ts';

export interface GreyboxMaterials {
  floor: THREE.Material;
  wall: THREE.Material;
  marker: THREE.Material;
  light: THREE.Material;
}

export function createGreyboxMaterials(): GreyboxMaterials {
  return {
    floor: new THREE.MeshStandardMaterial({ color: PALETTE.walnut, roughness: 0.85 }),
    wall: new THREE.MeshStandardMaterial({ color: PALETTE.brassDark, roughness: 0.7 }),
    marker: new THREE.MeshStandardMaterial({
      color: PALETTE.brass,
      metalness: 0.6,
      roughness: 0.4,
    }),
    light: new THREE.MeshBasicMaterial({ color: PALETTE.candle }),
  };
}

const unitBox = new THREE.BoxGeometry(1, 1, 1);
const markerGeometry = new THREE.CylinderGeometry(0.15, 0.2, 0.5, 8);
const lightGeometry = new THREE.SphereGeometry(0.08, 8, 6);

/**
 * Builds a room-local greybox from a template: floor, collider boxes as walls and pillars,
 * and small markers at dressing, loot and light sockets. Enemy sockets stay empty; the world
 * places automatons there. Geometry is shared across rooms; materials come from the caller.
 */
export function buildGreyboxRoom(t: RoomTemplate, materials: GreyboxMaterials): THREE.Group {
  const room = new THREE.Group();
  room.name = `room-${t.id}`;
  const { min, max } = t.footprint;
  const floor = new THREE.Mesh(unitBox, materials.floor);
  floor.name = 'floor';
  floor.scale.set(max[0] - min[0], 0.1, max[1] - min[1]);
  floor.position.set((min[0] + max[0]) / 2, -0.05, (min[1] + max[1]) / 2);
  room.add(floor);
  t.colliders.forEach((c, i) => {
    const wall = new THREE.Mesh(unitBox, materials.wall);
    wall.name = `collider-${i}`;
    wall.scale.set(c.max[0] - c.min[0], c.max[1] - c.min[1], c.max[2] - c.min[2]);
    wall.position.set(
      (c.min[0] + c.max[0]) / 2,
      (c.min[1] + c.max[1]) / 2,
      (c.min[2] + c.max[2]) / 2,
    );
    room.add(wall);
  });
  for (const s of [...t.dressingSockets, ...t.lootSockets]) {
    const marker = new THREE.Mesh(markerGeometry, materials.marker);
    marker.name = `socket-${s.id}`;
    marker.position.set(s.position[0], s.position[1] + 0.25, s.position[2]);
    room.add(marker);
  }
  for (const s of t.lightSockets) {
    const bulb = new THREE.Mesh(lightGeometry, materials.light);
    bulb.name = `light-${s.id}`;
    bulb.position.set(...s.position);
    room.add(bulb);
  }
  room.userData.templateId = t.id;
  return room;
}
