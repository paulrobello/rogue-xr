import * as THREE from 'three';
import { PALETTE } from '../palette.ts';
import type { TeleportResult } from './locomotion.ts';

/** Most arc samples drawn: `DEFAULT_TELEPORT` runs 2.5 s at 0.04 s steps, 63 points. */
const MAX_POINTS = 64;
const DOT_RADIUS = 0.02;
const RING_INNER = 0.2;
const RING_OUTER = 0.3;
/** The ring floats this high over the floor so it never z-fights it. */
const RING_LIFT = 0.012;

export const VALID_COLOR = PALETTE.brass;
export const INVALID_COLOR = '#7c2a24';

/**
 * The teleport aim: a dotted arc from the controller and a flat ring where it lands. Brass when
 * the landing is valid, a dim red when it is not (the arc that hits a wall draws dim red with no
 * ring). Two draw calls, hidden unless aiming. Lives in the world scene so walls hide the arc.
 */
export class TeleportView {
  readonly root = new THREE.Group();
  readonly arc: THREE.InstancedMesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
  readonly ring: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  private readonly matrix = new THREE.Matrix4();

  constructor() {
    this.root.name = 'teleport-view';
    this.arc = new THREE.InstancedMesh(
      new THREE.SphereGeometry(DOT_RADIUS, 6, 4),
      new THREE.MeshBasicMaterial({ color: VALID_COLOR, toneMapped: false }),
      MAX_POINTS,
    );
    this.arc.name = 'teleport-arc';
    this.arc.count = 0;
    this.arc.frustumCulled = false;
    this.ring = new THREE.Mesh(
      new THREE.RingGeometry(RING_INNER, RING_OUTER, 40).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({
        color: VALID_COLOR,
        toneMapped: false,
        transparent: true,
        opacity: 0.9,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    this.ring.name = 'teleport-ring';
    this.ring.frustumCulled = false;
    this.ring.visible = false;
    this.root.add(this.arc, this.ring);
    this.root.visible = false;
  }

  /** True while an arc is drawn. */
  get visible(): boolean {
    return this.root.visible;
  }

  /** Shows `preview` (the locomotion's current aim), or hides everything for null. */
  update(preview: TeleportResult | null): void {
    this.root.visible = preview !== null && preview.points.length > 1;
    if (!preview || !this.root.visible) {
      this.arc.count = 0;
      this.ring.visible = false;
      return;
    }
    const color = preview.valid ? VALID_COLOR : INVALID_COLOR;
    this.arc.material.color.set(color);
    this.ring.material.color.set(color);
    // Every other sample keeps the dots apart and the instance count low.
    const dots = preview.points.filter((_, i) => i % 2 === 0).slice(0, MAX_POINTS);
    dots.forEach((p, i) => {
      this.matrix.makeTranslation(p[0], p[1], p[2]);
      this.arc.setMatrixAt(i, this.matrix);
    });
    this.arc.count = dots.length;
    this.arc.instanceMatrix.needsUpdate = true;
    const landing = preview.landing;
    this.ring.visible = landing !== null;
    if (landing) this.ring.position.set(landing[0], landing[1] + RING_LIFT, landing[2]);
  }

  dispose(): void {
    this.arc.geometry.dispose();
    this.arc.material.dispose();
    this.arc.dispose();
    this.ring.geometry.dispose();
    this.ring.material.dispose();
    this.root.removeFromParent();
  }
}
