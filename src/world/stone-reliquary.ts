import * as THREE from 'three';
import { type ReliquarySeal, reliquaryGlyph } from '../rules/reliquary.ts';
import type { Point } from '../sigil/types.ts';
import {
  MAX_TRACE_POINTS,
  makePlatePose,
  rayToPlate,
  TraceBuilder,
} from '../sigil-plate/projection.ts';
import { ClockInscription } from './clock-inscription.ts';
import { DOOR_HEIGHT, type FloorWorld } from './floor-world.ts';
import type { InteriorPlacement } from './interior-furnishings.ts';
import { findPuzzleMount } from './puzzle-placement.ts';

type Layout = NonNullable<FloorWorld['plan']['reliquary']>;
export type ReliquaryPick = { readonly action: 'rubbing' | 'trace'; readonly distance: number };

const FACING = { N: 0, E: -Math.PI / 2, S: Math.PI, W: Math.PI / 2 } as const;
const PLATE_HALF = 0.36;
const PLATE_XY = new THREE.Vector3(0, 1.19, 0.065);
const RAY_REACH = 4;
const LATCH_SECONDS = 0.18;
const DROP_SECONDS = 1.25;

function writeSegment(
  attr: THREE.BufferAttribute,
  at: number,
  a: Point,
  b: Point,
  halfWidth: number,
): void {
  const dx = b.x - a.x,
    dy = b.y - a.y;
  const scale = halfWidth / Math.hypot(dx, dy);
  const x = -dy * scale,
    y = dx * scale;
  attr.setXYZ(at, a.x + x, a.y + y, 0);
  attr.setXYZ(at + 1, a.x - x, a.y - y, 0);
  attr.setXYZ(at + 2, b.x + x, b.y + y, 0);
  attr.setXYZ(at + 3, b.x + x, b.y + y, 0);
  attr.setXYZ(at + 4, a.x - x, a.y - y, 0);
  attr.setXYZ(at + 5, b.x - x, b.y - y, 0);
}

function ribbon(capacity: number): THREE.BufferGeometry {
  const mesh = new THREE.BufferGeometry();
  mesh.setAttribute('position', new THREE.BufferAttribute(new Float32Array(capacity * 18), 3));
  mesh.setDrawRange(0, 0);
  return mesh;
}

export class StoneReliquary {
  readonly plate = new THREE.Group();
  readonly rubbing = new THREE.Group();
  readonly gate = new THREE.Group();

  private readonly leaf = new THREE.Group();
  private readonly latch = new THREE.Group();
  private readonly capture = new TraceBuilder();
  private readonly trace = ribbon(MAX_TRACE_POINTS);
  private readonly traceMaterial = new THREE.MeshBasicMaterial({
    color: 0xffcf75,
    toneMapped: false,
  });
  private readonly stone = new THREE.MeshStandardMaterial({ color: 0x626864, roughness: 0.9 });
  private readonly dark = new THREE.MeshStandardMaterial({ color: 0x242d2b, roughness: 0.76 });
  private readonly brass = new THREE.MeshStandardMaterial({
    color: 0xb18e57,
    metalness: 0.66,
    roughness: 0.5,
  });
  private readonly paper = new THREE.MeshBasicMaterial({ color: 0xc6a781 });
  private readonly ink = new THREE.MeshBasicMaterial({ color: 0x432e22 });
  private readonly signs: ClockInscription[] = [];
  private readonly resources: { dispose(): void }[] = [
    this.trace,
    this.traceMaterial,
    this.stone,
    this.dark,
    this.brass,
    this.paper,
    this.ink,
  ];
  private readonly ray = new THREE.Raycaster();
  private readonly box = new THREE.Box3();
  private readonly point = new THREE.Vector3();
  private readonly center = new THREE.Vector3();
  private readonly normal = new THREE.Vector3();
  private readonly transform = new THREE.Quaternion();
  private readonly plateFace: THREE.Mesh;
  private readonly rubbingFace: THREE.Mesh;
  private readonly panelHint: ClockInscription;
  private readonly instructions: ClockInscription;
  private traceSegments = 0;
  private lastPoint: Point | null = null;
  private seal: ReliquarySeal = 'hidden';
  private started = false;
  private motion = 0;

  static mount(
    world: FloorWorld,
    seed: string,
    reducedMotion: boolean,
    props: readonly InteriorPlacement[] = [],
  ): StoneReliquary | null {
    const layout = world.plan.reliquary;
    if (!layout) return null;
    const station = findPuzzleMount(
      world,
      [layout.source.room],
      props,
      'reliquary-plate',
      0.54,
      0.58,
    );
    const rubbing = findPuzzleMount(
      world,
      [layout.clueRoom],
      props,
      'reliquary-rubbing',
      0.5,
      0.47,
    );
    const door = world.rooms[layout.source.room]?.doors.find((d) => d.id === layout.source.door);
    if (!station || !rubbing || !door) return null;
    const puzzle = new StoneReliquary(world, layout, door, seed, reducedMotion);
    puzzle.plate.position.copy(station.wallSurface).setY(0);
    puzzle.plate.rotation.y = station.yaw;
    puzzle.plate.translateZ(0.09);
    puzzle.rubbing.position.copy(rubbing.wallSurface).setY(0);
    puzzle.rubbing.rotation.y = rubbing.yaw;
    puzzle.rubbing.translateZ(0.09);
    world.roomGroups[layout.source.room].add(puzzle.plate);
    world.roomGroups[layout.clueRoom].add(puzzle.rubbing);
    world.roomGroups[layout.source.room].attach(puzzle.gate);
    return puzzle;
  }

  private constructor(
    private readonly world: FloorWorld,
    private readonly layout: Layout,
    door: FloorWorld['rooms'][number]['doors'][number],
    seed: string,
    private readonly reducedMotion: boolean,
  ) {
    this.plate.name = 'reliquary-tracing-plate';
    this.rubbing.name = 'reliquary-rubbing';
    this.gate.name = 'reliquary-stone-gate';
    this.leaf.name = 'reliquary-stone-leaf';
    this.latch.name = 'reliquary-brass-latch';
    this.block(this.plate, [0.83, 0.83, 0.075], [0, PLATE_XY.y, 0], this.stone);
    this.block(this.plate, [0.756, 0.756, 0.05], [0, PLATE_XY.y, 0.024], this.brass);
    this.plateFace = this.block(this.plate, [0.72, 0.72, 0.027], [0, PLATE_XY.y, 0.045], this.dark);
    this.plateFace.name = 'reliquary-trace-face';
    const trail = new THREE.Mesh(this.trace, this.traceMaterial);
    trail.position.copy(PLATE_XY);
    trail.frustumCulled = false;
    this.plate.add(trail);
    this.panelHint = this.sign(
      this.plate,
      0.89,
      1.76,
      'Stone Reliquary',
      'Find the keeper’s rubbing.',
      'Read it in Items once found.',
    );
    this.instructions = this.sign(
      this.plate,
      0.89,
      1.76,
      'Stone Reliquary',
      'Hold trigger or drag to trace.',
      'Use one continuous stroke.',
    );
    this.instructions.object.name = 'reliquary-trace-instructions';
    this.instructions.object.visible = false;
    this.sign(
      this.rubbing,
      0.86,
      1.76,
      'Keeper’s rubbing',
      'Select to copy this seal.',
      'Trace it in one continuous stroke.',
    );
    this.block(this.rubbing, [0.67, 0.69, 0.067], [0, PLATE_XY.y, 0], this.dark);
    this.rubbingFace = this.block(
      this.rubbing,
      [0.6, 0.62, 0.018],
      [0, PLATE_XY.y, 0.04],
      this.paper,
    );
    this.rubbingFace.name = 'reliquary-rubbing-face';
    const points = reliquaryGlyph(seed).points.map(({ x, y }) => ({ x: x * 0.47, y: y * 0.47 }));
    const ink = ribbon(points.length - 1);
    this.resources.push(ink);
    const attr = ink.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 1; i < points.length; i++)
      writeSegment(attr, (i - 1) * 6, points[i - 1], points[i], 0.012);
    ink.setDrawRange(0, (points.length - 1) * 6);
    const mark = new THREE.Mesh(ink, this.ink);
    mark.position.copy(PLATE_XY);
    this.rubbing.add(mark);

    this.gate.position.set(door.world[0], 0, door.world[1]);
    this.gate.rotation.y = FACING[door.facing];
    this.gate.add(this.leaf);
    const width = door.width - 0.05;
    const course = DOOR_HEIGHT / 4;
    for (let row = 0; row < 4; row++) {
      const y = course * (row + 0.5);
      this.block(
        this.leaf,
        [width, course - 0.012, row % 2 ? 0.157 : 0.175],
        [0, y, 0],
        this.stone,
      );
    }
    for (const side of [-1, 1]) {
      this.block(
        this.leaf,
        [0.05, DOOR_HEIGHT - 0.018, 0.197],
        [side * (width / 2 - 0.04), DOOR_HEIGHT / 2, 0],
        this.dark,
      );
    }
    this.block(this.leaf, [width - 0.06, 0.13, 0.21], [0, 1.11, 0], this.dark);
    this.block(this.latch, [width * 0.62, 0.085, 0.044], [width * -0.11, 1.11, 0.116], this.brass);
    this.block(this.latch, [0.12, 0.12, 0.1], [width * -0.37, 1.11, 0.132], this.brass);
    this.block(this.leaf, [0.15, 0.16, 0.08], [width * -0.42, 1.11, 0.113], this.dark);
    this.leaf.add(this.latch);
    const gateSign = this.sign(
      this.leaf,
      0.8,
      1.78,
      'Stone Reliquary',
      'Use the seal plate',
      'to release the stone door.',
    );
    gateSign.object.position.z = 0.105;
  }

  private block(
    parent: THREE.Object3D,
    size: readonly [number, number, number],
    at: readonly [number, number, number],
    material: THREE.Material,
  ): THREE.Mesh {
    const shape = new THREE.BoxGeometry(...size);
    this.resources.push(shape);
    const mesh = new THREE.Mesh(shape, material);
    mesh.position.fromArray(at);
    parent.add(mesh);
    return mesh;
  }

  private sign(
    root: THREE.Group,
    width: number,
    y: number,
    title: string,
    first: string,
    second: string,
  ): ClockInscription {
    const sign = new ClockInscription(`${root.name}-sign`, width, title, first, second);
    sign.object.position.set(0, y, 0.04);
    root.add(sign.object);
    this.signs.push(sign);
    return sign;
  }

  private hit(
    origin: THREE.Vector3,
    direction: THREE.Vector3,
    face: THREE.Mesh,
    front: THREE.Group,
  ) {
    front.getWorldPosition(this.center);
    front.getWorldQuaternion(this.transform);
    this.normal.set(0, 0, 1).applyQuaternion(this.transform);
    if (this.point.subVectors(origin, this.center).dot(this.normal) <= 0) return null;
    face.updateWorldMatrix(true, false);
    this.ray.set(origin, direction);
    this.ray.far = RAY_REACH;
    const hit = this.ray.intersectObject(face)[0];
    if (!hit) return null;
    for (const collider of this.world.colliders[this.world.current]) {
      this.box.min.fromArray(collider.min);
      this.box.max.fromArray(collider.max);
      if (
        this.ray.ray.intersectBox(this.box, this.point) &&
        this.point.distanceTo(origin) < hit.distance - 0.035
      )
        return null;
    }
    return hit;
  }

  pick(origin: THREE.Vector3, direction: THREE.Vector3): ReliquaryPick | null {
    if (this.world.current === this.layout.clueRoom) {
      const hit = this.hit(origin, direction, this.rubbingFace, this.rubbing);
      return hit ? { action: 'rubbing', distance: hit.distance } : null;
    }
    if (this.world.current !== this.layout.source.room || this.seal === 'open') return null;
    const hit = this.hit(origin, direction, this.plateFace, this.plate);
    return hit ? { action: 'trace', distance: hit.distance } : null;
  }

  begin(origin: THREE.Vector3, direction: THREE.Vector3): boolean {
    if (this.seal !== 'known' || this.pick(origin, direction)?.action !== 'trace') return false;
    this.cancel();
    this.traceMaterial.color.setHex(0xffcf75);
    this.capture.beginStroke();
    this.sample(origin, direction);
    return true;
  }

  sample(origin: THREE.Vector3, direction: THREE.Vector3): void {
    if (!this.capture.isDrawing || this.world.current !== this.layout.source.room) return;
    const hit = this.hit(origin, direction, this.plateFace, this.plate);
    const pose = makePlatePose(
      this.plate.localToWorld(this.center.copy(PLATE_XY)),
      this.normal,
      PLATE_HALF,
    );
    const p = hit ? rayToPlate(pose, origin, direction, 0) : null;
    if (!this.capture.add(p)) {
      if (!p) this.lastPoint = null;
      return;
    }
    if (p && this.lastPoint) {
      const attr = this.trace.getAttribute('position') as THREE.BufferAttribute;
      writeSegment(attr, this.traceSegments * 6, this.lastPoint, p, 0.007);
      this.traceSegments++;
      attr.needsUpdate = true;
      this.trace.setDrawRange(0, this.traceSegments * 6);
    }
    this.lastPoint = p;
  }

  finish(): readonly Point[] {
    this.capture.endStroke();
    return this.capture.strokes.length === 1 ? this.capture.strokes[0] : [];
  }

  cancel(): void {
    this.capture.clear();
    this.lastPoint = null;
    this.traceSegments = 0;
    this.trace.setDrawRange(0, 0);
  }

  reject(): void {
    this.traceMaterial.color.setHex(0xf17860);
  }

  sync(seal: ReliquarySeal, immediate = false): void {
    if (seal !== this.seal) {
      this.seal = seal;
      this.panelHint.object.visible = seal === 'hidden';
      this.instructions.object.visible = seal === 'known';
    }
    if (seal !== 'open') return;
    if (immediate || this.reducedMotion) this.setMotion(DROP_SECONDS);
    else this.started ||= this.motion < DROP_SECONDS;
    this.traceMaterial.color.setHex(0xb1eea6);
  }

  openingPosition(target: THREE.Vector3): THREE.Vector3 {
    return this.gate.localToWorld(target.set(0, 1.11, 0));
  }

  private setMotion(time: number): void {
    this.motion = time;
    const latch = Math.min(1, time / LATCH_SECONDS);
    const fall = Math.max(0, (time - LATCH_SECONDS) / (DROP_SECONDS - LATCH_SECONDS));
    this.latch.position.x = 0.31 * latch;
    this.leaf.position.y = -(DOOR_HEIGHT + 0.025) * fall ** 2;
    this.leaf.visible = time < DROP_SECONDS;
    if (time >= DROP_SECONDS) this.world.setPuzzleGateOpen('reliquary', true);
  }

  update(dt: number): void {
    if (!this.started) return;
    this.setMotion(Math.min(DROP_SECONDS, this.motion + dt));
    this.started = this.motion < DROP_SECONDS;
  }

  dispose(): void {
    for (const sign of this.signs) sign.dispose();
    for (const resource of this.resources) resource.dispose();
    for (const object of [this.plate, this.rubbing, this.gate]) object.removeFromParent();
  }
}
