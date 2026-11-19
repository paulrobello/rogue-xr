import * as THREE from 'three';
import { roots } from '../../assets-source/props/stairwell/report.json';
import { CanvasLabel } from '../combat-view/canvas-label.ts';
import type { StairEntry } from '../floor/stairs.ts';
import { PALETTE } from '../palette.ts';
import type { FloorWorld } from './floor-world.ts';

export class Stairwell {
  readonly root = new THREE.Group();
  private readonly label: CanvasLabel | null;
  private readonly cast = new THREE.Raycaster();
  private readonly local = new THREE.Ray();
  private readonly inverse = new THREE.Matrix4();
  private readonly hits: THREE.Intersection[] = [];

  constructor(
    readonly entry: StairEntry,
    readonly destination: 1 | 2,
    world: FloorWorld,
    model: THREE.Object3D,
  ) {
    const up = destination === 2;
    this.root.name = up ? 'staircase-up' : 'staircase-down';
    this.root.add(model.clone(true));
    this.root.position.set(entry.world[0], 0, entry.world[1]);
    this.root.rotation.y = Math.atan2(...entry.facing);
    this.label = typeof document === 'undefined' ? null : new CanvasLabel(640, 256, 0.85, false);
    if (this.label) {
      this.label.draw((ctx, w, h) => {
        ctx.fillStyle = '#25312e';
        ctx.fillRect(0, 0, w, h);
        ctx.strokeStyle = PALETTE.brass;
        ctx.lineWidth = 5;
        ctx.strokeRect(7, 7, w - 14, h - 14);
        ctx.fillStyle = PALETTE.candle;
        ctx.save();
        ctx.translate(w * 0.15, h * 0.5);
        ctx.scale(1, up ? 1 : -1);
        ctx.beginPath();
        ctx.moveTo(0, -63);
        ctx.lineTo(49, -5);
        ctx.lineTo(19, -5);
        ctx.lineTo(19, 57);
        ctx.lineTo(-19, 57);
        ctx.lineTo(-19, -5);
        ctx.lineTo(-49, -5);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
        ctx.fillStyle = PALETTE.parchment;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.font = 'bold 132px Georgia, serif';
        ctx.fillText(`Floor ${destination}`, w * 0.61, h * 0.53, w * 0.69);
      });
      this.label.mesh.name = 'stair-destination-sign';
      this.label.mesh.rotation.y = Math.PI;
      const [x, y, z] = roots[up ? 'StairUp' : 'StairDown'].sign_center;
      this.label.mesh.position.set(x, y, z - 0.007);
      this.root.add(this.label.mesh);
    }
    world.roomGroups[entry.room].attach(this.root);
  }

  pick(room: number, origin: THREE.Vector3, direction: THREE.Vector3): { distance: number } | null {
    if (room !== this.entry.room) return null;
    this.root.updateWorldMatrix(true, true);
    this.cast.set(origin, direction);
    this.local.copy(this.cast.ray).applyMatrix4(this.inverse.copy(this.root.matrixWorld).invert());
    const { origin: o, direction: d } = this.local;
    if (d.z <= 0 || o.z > 0.36) return null;
    const travel = Math.max(0, -o.z / d.z);
    if (
      travel > 4.5 ||
      Math.abs(o.x + d.x * travel) > 0.8 ||
      o.y + d.y * travel < 0 ||
      o.y + d.y * travel > 2.4
    )
      return null;
    this.hits.length = 0;
    this.cast.intersectObject(this.root, true, this.hits);
    return this.hits.length ? { distance: this.hits[0].distance } : null;
  }

  dispose(): void {
    this.root.removeFromParent();
    this.label?.dispose();
  }
}
