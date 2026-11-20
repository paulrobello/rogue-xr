import * as THREE from 'three';
import type { FloorWorld } from './floor-world.ts';
import type { InteriorPlacement } from './interior-furnishings.ts';
import { findPuzzleMount, kitPart } from './puzzle-placement.ts';

type Weight = 0 | 1;
export type CounterweightPick = ({ action: 'weigh'; weight: Weight } | { action: 'hang' }) & {
  distance: number;
};
export class CounterweightStation {
  readonly object = new THREE.Group();
  readonly hook: THREE.Object3D;
  readonly beam: THREE.Object3D;
  private readonly weights: THREE.Group[] = [];
  private readonly targets: THREE.Mesh[] = [];
  private readonly geometry: THREE.BufferGeometry[] = [];
  private readonly hitMaterial = new THREE.MeshBasicMaterial({ visible: false });
  private readonly cast = new THREE.Raycaster();
  private readonly point = new THREE.Vector3();
  private readonly box = new THREE.Box3();
  private goal = 0;
  private solved = false;
  private shake = 0;
  private release?: () => void;
  static mount(
    world: FloorWorld,
    art: THREE.Object3D,
    place: { rooms: readonly number[]; props: readonly InteriorPlacement[] },
  ): CounterweightStation | null {
    const mount = findPuzzleMount(world, place.rooms, place.props, 'counterweight', 0.71, 1.5);
    if (!mount) return null;
    const station = new CounterweightStation(world, mount.room, art);
    station.object.position.copy(mount.center);
    station.object.rotation.y = mount.yaw;
    world.roomGroups[mount.room].add(station.object);
    station.object.updateWorldMatrix(true, true);
    const b = new THREE.Box3().setFromObject(station.object);
    station.release = world.addFixtureCollider(mount.room, {
      min: b.min.toArray(),
      max: b.max.toArray(),
    });
    return station;
  }
  constructor(
    private readonly world: FloorWorld,
    readonly room: number,
    art: THREE.Object3D,
  ) {
    this.object.name = 'counterweight-balance-station';
    const scale = kitPart(art, 'balance_scale').clone(true);
    this.beam = kitPart(scale, 'balance_beam_pivot');
    scale.scale.setScalar(1.52);
    scale.position.set(-0.12, -0.39, 0.28);
    this.object.add(scale);
    const source = kitPart(art, 'scale_weights');
    const body = source.children.find(
      (n) => n.name.startsWith('weight') && Math.abs(n.position.x) < 0.005,
    ) as THREE.Mesh;
    const knob = source.children.find(
      (n) => n.name.startsWith('knob') && Math.abs(n.position.x) < 0.005,
    ) as THREE.Mesh;
    const brass = knob.material as THREE.Material,
      iron = body.material as THREE.Material;
    const hardware = (
      geom: THREE.BufferGeometry,
      mat: THREE.Material,
      x: number,
      y: number,
      z: number,
      parent: THREE.Object3D = this.object,
    ) => {
      this.geometry.push(geom);
      const mesh = new THREE.Mesh(geom, mat);
      mesh.position.set(x, y, z);
      parent.add(mesh);
      return mesh;
    };
    hardware(new THREE.BoxGeometry(1.32, 0.075, 0.55), iron, 0, -0.43, 0.25);
    hardware(new THREE.BoxGeometry(1.34, 0.018, 0.57), brass, 0, -0.39, 0.25);
    for (const x of [-0.5, 0.5])
      hardware(new THREE.BoxGeometry(0.05, 0.25, 0.22), brass, x, -0.56, 0.16);
    const weight = () => {
      const g = new THREE.Group();
      g.add(body.clone(), knob.clone());
      return g;
    };
    const reference = weight();
    reference.name = 'counterweight-reference';
    reference.position.set(0.22, -0.18, 0);
    this.beam.add(reference);
    for (const i of [0, 1] as const) {
      const w = weight();
      this.object.add(w);
      w.scale.setScalar(1.35);
      this.weights.push(w);
      const target = hardware(
        new THREE.SphereGeometry(0.079, 12, 8),
        this.hitMaterial,
        0,
        0.071,
        0,
        w,
      );
      target.name = i ? 'counterweight-b-target' : 'counterweight-a-target';
      this.targets.push(target);
    }
    const ring = hardware(new THREE.TorusGeometry(0.097, 0.02, 8, 24), brass, 0.52, 0.035, 0.23);
    for (let i = 0; i < 13; i++) {
      const link = hardware(
        new THREE.TorusGeometry(0.035, 0.009, 6, 12),
        iron,
        0.52,
        0.15 + i * 0.048,
        0.23,
      );
      link.rotation.y = ((i % 2) * Math.PI) / 2;
    }
    this.hook = hardware(new THREE.SphereGeometry(0.12, 12, 8), this.hitMaterial, 0, 0, 0, ring);
    this.hook.name = 'counterweight-hook';
    this.targets.push(this.hook as THREE.Mesh);
    this.sync(null, 0, false);
  }
  sync(selected: Weight | null, correct: Weight, solved: boolean): void {
    this.solved = solved;
    this.goal =
      solved || selected === null || selected === correct ? 0 : selected === 0 ? 0.21 : -0.21;
    for (const i of [0, 1] as const) {
      const part = this.weights[i];
      if (i === selected && !solved) {
        this.beam.add(part);
        part.scale.setScalar(0.89);
        part.position.set(-0.22, -0.18, 0);
      } else {
        this.object.add(part);
        part.scale.setScalar(1.35);
        if (i === selected) part.position.set(0.52, -0.18, 0.23);
        else part.position.set(i ? 0.27 : -0.41, -0.38, 0.48);
      }
    }
  }
  miss() {
    this.shake = 0.32;
  }
  update(dt: number) {
    this.shake = Math.max(0, this.shake - dt);
    this.beam.rotation.z = THREE.MathUtils.damp(
      this.beam.rotation.z,
      this.goal + this.shake * 0.22 * Math.sin(this.shake * 45),
      12,
      dt,
    );
  }
  private hit(index: number, distance: number): CounterweightPick {
    return index === 2
      ? { action: 'hang', distance }
      : { action: 'weigh', weight: index as Weight, distance };
  }
  pick(origin: THREE.Vector3, direction: THREE.Vector3): CounterweightPick | null {
    if (this.solved || this.world.current !== this.room) return null;
    this.object.updateWorldMatrix(true, true);
    this.cast.set(origin, direction);
    this.cast.far = 4;
    const h = this.cast.intersectObjects(this.targets, false)[0];
    if (!h) return null;
    const local = this.object.worldToLocal(this.point.copy(origin));
    if (local.z < 0.05) return null;
    for (const b of this.world.colliders[this.room]) {
      this.box.min.fromArray(b.min);
      this.box.max.fromArray(b.max);
      if (this.box.containsPoint(h.point)) continue;
      if (
        this.cast.ray.intersectBox(this.box, this.point) &&
        this.point.distanceTo(origin) < h.distance - 0.025
      )
        return null;
    }
    return this.hit(this.targets.indexOf(h.object as THREE.Mesh), h.distance);
  }
  near(point: THREE.Vector3, reach: number): CounterweightPick | null {
    if (this.solved || this.world.current !== this.room) return null;
    let best: CounterweightPick | null = null;
    this.targets.forEach((t, i) => {
      const d = t.getWorldPosition(this.point).distanceTo(point);
      if (d <= reach && (!best || d < best.distance)) best = this.hit(i, d);
    });
    return best;
  }
  dispose() {
    this.release?.();
    for (const g of this.geometry) g.dispose();
    this.hitMaterial.dispose();
    this.object.removeFromParent();
  }
}
