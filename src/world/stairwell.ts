import * as THREE from 'three';
import { roots } from '../../assets-source/props/stairwell/report.json';
import { CanvasLabel } from '../combat-view/canvas-label.ts';
import {
  STAIR_DOOR_DEPTH,
  STAIR_FLIGHT_END,
  STAIR_LANDING_END,
  STAIR_TOTAL_RISE,
  type StairEntry,
  stairHeightAtDepth,
  stairLandingOccupancy,
  stairLocalPoint,
} from '../floor/stairs.ts';
import { PALETTE } from '../palette.ts';
import type { FloorWorld } from './floor-world.ts';

export class Stairwell {
  readonly root = new THREE.Group();
  private readonly label: CanvasLabel | null;
  private landingPrompted = false;
  private readonly cast = new THREE.Raycaster();
  private readonly local = new THREE.Ray();
  private readonly inverse = new THREE.Matrix4();
  private readonly hitPoint = new THREE.Vector3();
  private readonly hits: THREE.Intersection[] = [];

  constructor(
    readonly entry: StairEntry,
    readonly destination: 1 | 2,
    world: Pick<FloorWorld, 'roomGroups'>,
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

  /** Stay dismisses the prompt until the player backs off the landing and approaches again. */
  enteredLanding(x: number, z: number): boolean {
    if (stairLandingOccupancy(this.entry, x, z)) {
      if (this.landingPrompted) return false;
      this.landingPrompted = true;
      return true;
    }
    const p = stairLocalPoint(this.entry, x, z);
    if (p.depth < STAIR_FLIGHT_END - 0.25 || Math.abs(p.across) > 1.5) this.landingPrompted = false;
    return false;
  }

  pick(room: number, origin: THREE.Vector3, direction: THREE.Vector3): { distance: number } | null {
    if (room !== this.entry.room) return null;
    this.root.updateWorldMatrix(true, true);
    this.cast.set(origin, direction);
    this.local.copy(this.cast.ray).applyMatrix4(this.inverse.copy(this.root.matrixWorld).invert());
    const { origin: o, direction: d } = this.local;
    const directionSign = this.destination === 2 ? 1 : -1;
    // A controller can reach into the door slab while the player's body stops at its face.
    const aboveLanding = o.y - directionSign * STAIR_TOTAL_RISE;
    if (
      o.z >= STAIR_DOOR_DEPTH &&
      o.z <= STAIR_LANDING_END + 0.1 &&
      Math.abs(o.x) <= 0.59 &&
      aboveLanding >= 0 &&
      aboveLanding <= 2.12 &&
      d.z > 0.2
    )
      return { distance: 0 };
    if (o.z <= 0) {
      if (d.z <= 0) return null;
      const depth = -o.z / d.z;
      const x = o.x + d.x * depth,
        y = o.y + d.y * depth;
      if (Math.abs(x) > 0.8 || y < 0 || y > 2.4) return null;
    } else if (Math.abs(o.x) > 1.46 || o.z > STAIR_LANDING_END) return null;

    this.hits.length = 0;
    this.cast.intersectObject(this.root, true, this.hits);
    const hit = this.hits[0];
    if (!hit) return null;
    const p = this.hitPoint.copy(hit.point).applyMatrix4(this.inverse);
    // Only the visible flight, its rails, or the access door and its sign are travel targets.
    const floor = stairHeightAtDepth(p.z, directionSign);
    const maxHeight = p.z >= STAIR_DOOR_DEPTH - 0.12 ? 2.27 : 1.05;
    if (
      Math.abs(p.x) > 1.13 ||
      p.z < -0.001 ||
      p.z > STAIR_LANDING_END ||
      p.y < floor - 0.3 ||
      p.y > floor + maxHeight
    )
      return null;
    return { distance: hit.distance };
  }

  dispose(): void {
    this.root.removeFromParent();
    this.label?.dispose();
  }
}
