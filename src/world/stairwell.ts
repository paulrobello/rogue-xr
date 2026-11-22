import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { roots } from '../../assets-source/props/stairwell/report.json';
import { CanvasLabel } from '../combat-view/canvas-label.ts';
import {
  STAIR_FLIGHT_END,
  STAIR_HALF_WIDTH,
  STAIR_LANDING_END,
  STAIR_THRESHOLD_DEPTH,
  STAIR_TREAD_COUNT,
  STAIR_TREAD_PITCH,
  type StairEntry,
  stairTreadHeightAtDepth,
} from '../floor/stairs.ts';
import { PALETTE } from '../palette.ts';
import type { FloorWorld } from './floor-world.ts';

function stairShoulders(up: boolean, material: THREE.Material): THREE.Mesh {
  const outerEdge = 1.347;
  const innerEdge = STAIR_HALF_WIDTH - 0.008;
  const bottom = -1.86;
  const segments = Array.from({ length: STAIR_TREAD_COUNT + 1 }, (_, i) => {
    const landing = i === STAIR_TREAD_COUNT;
    const start = landing ? STAIR_FLIGHT_END : STAIR_THRESHOLD_DEPTH + i * STAIR_TREAD_PITCH;
    const end = landing ? STAIR_LANDING_END : start + STAIR_TREAD_PITCH;
    const top = stairTreadHeightAtDepth((start + end) / 2, up ? 1 : -1) ?? 0;
    return { start, end, y: top - 0.032 };
  });
  const boxes = [-1, 1].flatMap((side) =>
    segments.map(({ start, end, y }) =>
      new THREE.BoxGeometry(outerEdge - innerEdge, y - bottom, end - start).translate(
        (side * (outerEdge + innerEdge)) / 2,
        (y + bottom) / 2,
        (start + end) / 2,
      ),
    ),
  );
  const geometry = mergeGeometries(boxes);
  for (const box of boxes) box.dispose();
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'stair-masonry-shoulders';
  return mesh;
}

export class Stairwell {
  readonly root = new THREE.Group();
  private readonly label: CanvasLabel | null;
  private readonly shoulders: THREE.Mesh | null;
  readonly handle: THREE.Object3D;
  readonly hinge: THREE.Object3D;
  private readonly handleBounds = new THREE.Box3(
    new THREE.Vector3(-0.065, -0.14, -0.055),
    new THREE.Vector3(0.065, 0.14, 0.025),
  );
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
    const copy = model.clone(true);
    const prefix = up ? 'StairUp' : 'StairDown';
    const hinge = copy.getObjectByName(`${prefix}_DoorPivot`);
    const handle = hinge?.getObjectByName(`${prefix}_HandleSocket`);
    if (!hinge || !handle) throw Error(`Missing hinged door or pull in ${prefix}`);
    this.hinge = hinge;
    this.handle = handle;
    hinge.name = 'stair-door-hinge';
    handle.name = 'stair-door-handle-target';
    this.root.add(copy);
    let stone: THREE.Material | undefined;
    copy.traverse((object) => {
      if (object instanceof THREE.Mesh && object.material.name === 'Stairwell stone')
        stone = object.material;
    });
    this.shoulders = stone ? stairShoulders(up, stone) : null;
    if (this.shoulders) this.root.add(this.shoulders);
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
      hinge.attach(this.label.mesh);
    }
    world.roomGroups[entry.room].attach(this.root);
  }

  open(fraction: number): void {
    this.hinge.rotation.y = -THREE.MathUtils.degToRad(75) * fraction;
  }

  pick(room: number, origin: THREE.Vector3, direction: THREE.Vector3): { distance: number } | null {
    if (room !== this.entry.room) return null;
    this.handle.updateWorldMatrix(true, false);
    this.cast.set(origin, direction);
    this.local.copy(this.cast.ray).applyMatrix4(this.inverse.copy(this.root.matrixWorld).invert());
    const { origin: o, direction: d } = this.local;
    if (o.z <= 0) {
      if (d.z <= 0) return null;
      const depth = -o.z / d.z;
      const y = o.y + d.y * depth;
      if (Math.abs(o.x + d.x * depth) > 0.8 || y < 0 || y > 2.4) return null;
    } else if (Math.abs(o.x) > 1.46) return null;

    this.local
      .copy(this.cast.ray)
      .applyMatrix4(this.inverse.copy(this.handle.matrixWorld).invert());
    if (this.local.origin.z > this.handleBounds.max.z) return null;
    if (this.handleBounds.containsPoint(this.local.origin)) return { distance: 0 };
    if (!this.local.intersectBox(this.handleBounds, this.hitPoint)) return null;
    const distance = this.hitPoint.applyMatrix4(this.handle.matrixWorld).distanceTo(origin);
    this.root.updateWorldMatrix(false, true);
    this.hits.length = 0;
    this.cast.far = distance;
    this.cast.intersectObject(this.root, true, this.hits);
    return this.hits.length ? null : { distance };
  }

  dispose(): void {
    this.root.removeFromParent();
    this.shoulders?.geometry.dispose();
    this.label?.dispose();
  }
}
