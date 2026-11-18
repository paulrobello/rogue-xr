import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const SOLID_KINDS = [
  'cog',
  'hammer',
  'volley',
  'flurry',
  'storm',
  'furnace',
  'pin',
  'knuckle',
  'counterstroke',
] as const;
export type SolidAttack = (typeof SOLID_KINDS)[number];
const SOLID_ATTACKS: ReadonlySet<string> = new Set(SOLID_KINDS);

export function isSolidAttack(kind: string): kind is SolidAttack {
  return SOLID_ATTACKS.has(kind);
}

/** All the components of one projectile share a single draw. */
export function projectileGeometry(kind: SolidAttack): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const part = (geometry: THREE.BufferGeometry, color: number): void => {
    const tint = new THREE.Color(color);
    const count = geometry.getAttribute('position').count;
    const colors = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) tint.toArray(colors, i * 3);
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    parts.push(geometry);
  };
  if (kind === 'cog') {
    part(new THREE.TorusGeometry(0.061, 0.014, 6, 24), 0xdfa448);
    for (let i = 0; i < 10; i++) {
      const angle = (2 * Math.PI * i) / 10;
      part(
        new THREE.BoxGeometry(0.028, 0.023, 0.026).translate(0.073, 0, 0).rotateZ(angle),
        0xffcd72,
      );
    }
  } else if (kind === 'pin') {
    part(new THREE.CylinderGeometry(0.013, 0.015, 0.22, 8).rotateX(Math.PI / 2), 0xd9d8ce);
    part(
      new THREE.CylinderGeometry(0.033, 0.033, 0.02, 10)
        .rotateX(Math.PI / 2)
        .translate(0, 0, -0.106),
      0xb35942,
    );
  } else if (kind === 'knuckle') {
    part(new THREE.SphereGeometry(1, 10, 7).scale(0.085, 0.048, 0.077), 0x724331);
    const wrist = new THREE.CylinderGeometry(0.062, 0.055, 0.047, 10).rotateX(Math.PI / 2);
    part(wrist.translate(0, -0.006, -0.076), 0xcb9242);
    for (const x of [-0.063, -0.022, 0.022, 0.063]) {
      const finger = new THREE.SphereGeometry(1, 8, 6).scale(0.024, 0.036, 0.043);
      part(finger.translate(x, 0.016, 0.059 - Math.abs(x) * 0.18), 0xc9cbd1);
    }
    part(
      new THREE.SphereGeometry(1, 8, 6).scale(0.032, 0.032, 0.043).translate(0.075, -0.016, 0.011),
      0xb58045,
    );
    part(new THREE.ConeGeometry(0.047, 0.06, 3).translate(0, 0.06, -0.016), 0xc33f3b);
  } else if (kind === 'counterstroke') {
    const pin = new THREE.CylinderGeometry(0.033, 0.033, 0.097, 10).rotateZ(Math.PI / 2);
    part(pin.translate(0, 0, -0.042), 0xcf9545);
    for (const side of [-1, 1]) {
      part(
        new THREE.BoxGeometry(0.016, 0.028, 0.135)
          .rotateX(-0.33)
          .translate(side * 0.046, 0.023, 0.008),
        0xa62e38,
      );
      part(new THREE.SphereGeometry(0.016, 8, 5).translate(side * 0.053, 0, -0.042), 0xf6d77d);
    }
    part(
      new THREE.CylinderGeometry(0.02, 0.028, 0.113, 10)
        .rotateX(Math.PI / 2)
        .translate(0, 0.039, 0.071),
      0xf0c36a,
    );
    part(
      new THREE.CylinderGeometry(0.041, 0.026, 0.036, 8)
        .rotateX(Math.PI / 2)
        .translate(0, 0.039, 0.135),
      0xbfc3c8,
    );
  } else if (kind === 'flurry') {
    const slash = new THREE.Shape();
    slash.moveTo(-0.085, -0.064);
    slash.quadraticCurveTo(-0.012, 0.05, 0.09, 0.085);
    slash.quadraticCurveTo(0.016, 0.028, -0.085, -0.064);
    for (const lane of [-1, 0, 1]) {
      part(
        new THREE.ExtrudeGeometry(slash, {
          depth: 0.005,
          bevelEnabled: false,
          curveSegments: 6,
        }).translate(lane * 0.047, -lane * 0.028, 0),
        lane === 0 ? 0xffcd77 : 0xe3633e,
      );
    }
  } else if (kind === 'storm') {
    const gear = new THREE.Shape();
    for (let i = 0; i < 32; i++) {
      const angle = (i * Math.PI) / 16;
      const radius = i % 4 < 2 ? 0.047 : 0.035;
      const x = Math.cos(angle) * radius,
        y = Math.sin(angle) * radius;
      if (i === 0) gear.moveTo(x, y);
      else gear.lineTo(x, y);
    }
    gear.closePath();
    const bore = new THREE.Path();
    bore.absarc(0, 0, 0.014, 0, Math.PI * 2, true);
    gear.holes.push(bore);
    for (let i = 0; i < 3; i++) {
      const phase = (i * Math.PI * 2) / 3;
      part(
        new THREE.ExtrudeGeometry(gear, { depth: 0.012, bevelEnabled: false, curveSegments: 4 })
          .translate(0.078, 0, 0)
          .rotateZ(phase),
        i === 0 ? 0xe9bb6c : 0xae90cc,
      );
    }
  } else if (kind === 'furnace') {
    for (const lane of [-1, 0, 1]) {
      const tall = lane === 0 ? 1 : 0.7;
      const flame = new THREE.LatheGeometry(
        [
          new THREE.Vector2(0, 0),
          new THREE.Vector2(0.027, 0.015),
          new THREE.Vector2(0.031, 0.049),
          new THREE.Vector2(0.018, 0.085),
          new THREE.Vector2(0.008, 0.118),
          new THREE.Vector2(0, 0.146),
        ],
        8,
      );
      const pos = flame.getAttribute('position');
      for (let i = 0; i < pos.count; i++) {
        const y = pos.getY(i);
        pos.setX(i, pos.getX(i) + 0.014 * Math.sin(y * 43));
      }
      flame
        .scale(1, tall, 1)
        .rotateZ(-lane * 0.35)
        .translate(lane * 0.022, -0.04, 0);
      part(flame, lane === 0 ? 0xffdb67 : 0xff6135);
    }
  } else if (kind === 'volley') {
    for (const lane of [-1, 0, 1]) {
      const x = lane * 0.047;
      const z = Math.abs(lane) * -0.048;
      part(
        new THREE.CylinderGeometry(0.011, 0.009, 0.13, 8).rotateX(Math.PI / 2).translate(x, 0, z),
        0x9bb9c2,
      );
      part(
        new THREE.CylinderGeometry(0.021, 0.021, 0.015, 8)
          .rotateX(Math.PI / 2)
          .translate(x, 0, z - 0.058),
        0xdeaf64,
      );
    }
  } else {
    part(new THREE.CylinderGeometry(0.012, 0.016, 0.19, 8).translate(0, -0.036, 0), 0xb96a34);
    part(new THREE.BoxGeometry(0.145, 0.058, 0.059).translate(0, 0.071, 0), 0xb2b6bb);
    part(new THREE.BoxGeometry(0.042, 0.066, 0.065).translate(0, 0.071, 0), 0xe7af54);
  }
  const merged = mergeGeometries(parts);
  for (const geometry of parts) geometry.dispose();
  if (!merged) throw new Error('Incompatible projectile geometry');
  return merged;
}
