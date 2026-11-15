import * as THREE from 'three';
import { PALETTE } from '../palette.ts';

/** Greybox brass study used until real room templates exist. */
export function createPlaceholderRoom(): THREE.Group {
  const room = new THREE.Group();
  room.name = 'placeholder-room';
  const walnut = new THREE.MeshStandardMaterial({ color: PALETTE.walnut, roughness: 0.8 });
  const brass = new THREE.MeshStandardMaterial({
    color: PALETTE.brass,
    metalness: 0.9,
    roughness: 0.35,
  });

  const floor = new THREE.Mesh(new THREE.PlaneGeometry(8, 8), walnut);
  floor.rotation.x = -Math.PI / 2;
  room.add(floor);

  const walls = new THREE.Mesh(
    new THREE.BoxGeometry(8, 4, 8),
    new THREE.MeshStandardMaterial({ color: PALETTE.brassDark, side: THREE.BackSide }),
  );
  // Sink the shell so its floor face sits below the floor plane instead of z-fighting with it.
  walls.position.y = 1.98;
  room.add(walls);

  const pillar = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.3, 4, 24), brass);
  pillar.position.set(0, 2, -2.5);
  room.add(pillar);

  const candle = new THREE.PointLight(PALETTE.candle, 6, 9, 2);
  candle.position.set(0.8, 1.8, -1.5);
  room.add(candle, new THREE.HemisphereLight(PALETTE.candle, PALETTE.void, 0.35));
  return room;
}
