import * as THREE from 'three';
import { PALETTE } from '../palette.ts';
import { MAX_TABLE_HEIGHT, TABLE_HALF_DEPTH, TABLE_HALF_WIDTH } from './placement.ts';

/**
 * Greybox combat table. Origin is on the floor under the table centre, -Z is the enemy side and
 * +Z is the player's seat. P4-T5's real asset replaces this builder and keeps the node names the
 * director and `setTableUnfold` look up: `leaf-left` and `leaf-right` hinge about their own origin
 * (rotation.z), and an optional `top-assembly` / `legs` pair lets `setTableHeight` fit the waist.
 */
export const TABLE_NODES = {
  leafLeft: 'leaf-left',
  leafRight: 'leaf-right',
  topAssembly: 'top-assembly',
  legs: 'legs',
  diceTray: 'dice-tray',
} as const;

const CENTRE_HALF_WIDTH = 0.4;
const LEAF_WIDTH = TABLE_HALF_WIDTH - CENTRE_HALF_WIDTH;
const TOP_THICKNESS = 0.06;
const LEG_SIZE = 0.07;
const FOLD_ANGLE = Math.PI / 2;
/** Fraction of the unfold spent growing the table before the leaves swing out. */
const LEAF_DELAY = 0.25;
const MIN_SCALE = 0.5;

function easeOutCubic(t: number): number {
  const c = Math.min(1, Math.max(0, t));
  return 1 - (1 - c) ** 3;
}

function named<T extends THREE.Object3D>(o: T, name: string): T {
  o.name = name;
  return o;
}

/** Builds the folded-open greybox table at `height` metres; the director animates it with `setTableUnfold`. */
export function buildTableGreybox(height = 0.85): THREE.Group {
  const brass = new THREE.MeshStandardMaterial({
    color: PALETTE.brass,
    metalness: 0.8,
    roughness: 0.4,
  });
  const walnut = new THREE.MeshStandardMaterial({ color: PALETTE.walnut, roughness: 0.7 });
  const depth = TABLE_HALF_DEPTH * 2;
  const root = named(new THREE.Group(), 'combat-table');

  const legs = named(new THREE.Group(), TABLE_NODES.legs);
  const legGeometry = new THREE.BoxGeometry(LEG_SIZE, 1, LEG_SIZE);
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const leg = new THREE.Mesh(legGeometry, walnut);
      leg.position.set(
        sx * (CENTRE_HALF_WIDTH - LEG_SIZE),
        0.5,
        sz * (TABLE_HALF_DEPTH - LEG_SIZE),
      );
      legs.add(leg);
    }
  }
  root.add(legs);

  const top = named(new THREE.Group(), TABLE_NODES.topAssembly);
  const slab = named(
    new THREE.Mesh(new THREE.BoxGeometry(CENTRE_HALF_WIDTH * 2, TOP_THICKNESS, depth), brass),
    'top',
  );
  slab.position.y = -TOP_THICKNESS / 2;
  top.add(slab);

  const leafGeometry = new THREE.BoxGeometry(LEAF_WIDTH, TOP_THICKNESS, depth);
  for (const side of [-1, 1]) {
    const hinge = named(new THREE.Group(), side < 0 ? TABLE_NODES.leafLeft : TABLE_NODES.leafRight);
    hinge.position.set(side * CENTRE_HALF_WIDTH, 0, 0);
    const panel = new THREE.Mesh(leafGeometry, brass);
    panel.position.set((side * LEAF_WIDTH) / 2, -TOP_THICKNESS / 2, 0);
    hinge.add(panel);
    top.add(hinge);
  }

  // Dice tray: a shallow walnut tray on the far half of the centre slab.
  const tray = named(new THREE.Group(), TABLE_NODES.diceTray);
  const trayW = 0.5;
  const trayD = 0.28;
  const rim = 0.025;
  const rimHeight = 0.04;
  const trayFloor = new THREE.Mesh(new THREE.BoxGeometry(trayW, 0.01, trayD), walnut);
  trayFloor.position.y = 0.005;
  tray.add(trayFloor);
  for (const [w, d, x, z] of [
    [trayW, rim, 0, -(trayD - rim) / 2],
    [trayW, rim, 0, (trayD - rim) / 2],
    [rim, trayD, -(trayW - rim) / 2, 0],
    [rim, trayD, (trayW - rim) / 2, 0],
  ] as const) {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(w, rimHeight, d), walnut);
    wall.position.set(x, rimHeight / 2, z);
    tray.add(wall);
  }
  tray.position.set(0, 0, -0.18);
  top.add(tray);
  root.add(top);

  setTableHeight(root, height);
  setTableUnfold(root, 1);
  return root;
}

/** Fits the greybox legs and top to a table-top height. A no-op for assets without those nodes. */
export function setTableHeight(root: THREE.Object3D, height: number): void {
  const h = Math.min(Math.max(height, 0.05), MAX_TABLE_HEIGHT);
  root.getObjectByName(TABLE_NODES.legs)?.scale.set(1, h - TOP_THICKNESS, 1);
  root.getObjectByName(TABLE_NODES.topAssembly)?.position.setY(h);
}

/**
 * Poses the table for an unfold progress in [0, 1]: 0 is a small folded table with hanging leaves,
 * 1 is fully open. Invisible at 0. Works on any asset exposing the `leaf-left` and `leaf-right` nodes.
 */
export function setTableUnfold(root: THREE.Object3D, progress: number): void {
  const t = Math.min(1, Math.max(0, progress));
  root.visible = t > 0;
  root.scale.setScalar(MIN_SCALE + (1 - MIN_SCALE) * easeOutCubic(t / (1 - LEAF_DELAY)));
  const swing = 1 - easeOutCubic((t - LEAF_DELAY) / (1 - LEAF_DELAY));
  // A left leaf extends toward -X and hangs down at +90 degrees; the right leaf mirrors it.
  const left = root.getObjectByName(TABLE_NODES.leafLeft);
  const right = root.getObjectByName(TABLE_NODES.leafRight);
  if (left) left.rotation.z = FOLD_ANGLE * swing;
  if (right) right.rotation.z = -FOLD_ANGLE * swing;
}

/** Releases every geometry and material under a table built by `buildTableGreybox`. */
export function disposeTable(root: THREE.Object3D): void {
  const materials = new Set<THREE.Material>();
  const geometries = new Set<THREE.BufferGeometry>();
  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    geometries.add(o.geometry);
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) materials.add(m);
  });
  for (const g of geometries) g.dispose();
  for (const m of materials) m.dispose();
}
