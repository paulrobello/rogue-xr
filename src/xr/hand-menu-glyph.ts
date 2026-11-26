import * as THREE from 'three';
import { PALETTE } from '../palette.ts';
import { createMenuTouch } from './menu-touch.ts';

export interface TrackedPalm {
  readonly position: THREE.Vector3;
  readonly forward: THREE.Vector3;
  readonly backNormal: THREE.Vector3;
  readonly surfaceOffset: number;
}

export function createHandMenuGlyph() {
  const root = new THREE.Group();
  root.name = 'hand-menu-glyph';
  root.visible = false;
  const disc = new THREE.CircleGeometry(0.019, 24);
  const fill = new THREE.MeshBasicMaterial({ color: PALETTE.warmBlack, toneMapped: false });
  const ink = new THREE.MeshBasicMaterial({ color: PALETTE.brass, toneMapped: false });
  const face = new THREE.Mesh(disc, fill);
  const rim = new THREE.Mesh(new THREE.RingGeometry(0.0178, 0.019, 24), ink);
  rim.position.z = 0.0004;
  root.add(face, rim);
  const stroke = new THREE.PlaneGeometry(0.018, 0.002);
  for (const y of [-0.0055, 0, 0.0055]) {
    const bar = new THREE.Mesh(stroke, ink);
    bar.position.set(0, y, 0.0008);
    root.add(bar);
  }

  const touch = createMenuTouch();
  // Testing in glyph coordinates keeps the press and release thresholds on the moving hand.
  const touchTargets = [new THREE.Mesh(disc, fill)];
  const localFront = new THREE.Vector3(0, 0, 1);
  const localTip = new THREE.Vector3();
  const view = new THREE.Vector3();
  const side = new THREE.Vector3();
  const up = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const basis = new THREE.Matrix4();
  const controlAt = () => 'menu';

  return {
    root,
    get held(): boolean {
      return touch.held;
    },
    update(palm: TrackedPalm | null, tip: THREE.Vector3 | null, eye: THREE.Vector3): boolean {
      root.visible = false;
      if (palm) {
        up.copy(palm.forward).normalize();
        side.crossVectors(up, palm.backNormal).normalize();
        normal.crossVectors(side, up).normalize();
        root.position.copy(palm.position).addScaledVector(normal, palm.surfaceOffset);
        root.quaternion.setFromRotationMatrix(basis.makeBasis(side, up, normal));
        root.visible = view.subVectors(eye, root.position).normalize().dot(normal) > 0.3;
      }
      const local = root.visible && tip ? root.worldToLocal(localTip.copy(tip)) : null;
      const { hovered, pressed } = touch.sample(local, localFront, touchTargets, controlAt);
      ink.color.set(hovered ? PALETTE.parchment : PALETTE.brass);
      return pressed !== null;
    },
  };
}
