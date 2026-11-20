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
  hook: THREE.Object3D;
  beam: THREE.Object3D;
  private readonly weights: THREE.Group[] = [];
  private readonly targets: THREE.Mesh[] = [];
  private readonly geometry: THREE.BufferGeometry[] = [];
  private readonly hitMaterial = new THREE.MeshBasicMaterial({ visible: false });
  private readonly cast = new THREE.Raycaster();
  private readonly point = new THREE.Vector3();
  private readonly box = new THREE.Box3();
  private goal = 0;
  private unloadedAngle = 0;
  private solved = false;
  private selected: Weight | null = null;
  private correct: Weight = 0;
  private initialized = false;
  private reduced = false;
  private pans: THREE.Object3D[] = [];
  private hanger?: THREE.Object3D;
  private readonly flights = new Map<
    Weight,
    {
      from: THREE.Vector3;
      to: THREE.Vector3;
      startScale: number;
      scale: number;
      startYaw: number;
      yaw: number;
      lift: number;
      duration: number;
      elapsed: number;
    }
  >();
  private velocity = 0;
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
    station.object.position.copy(mount.wallSurface);
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
    this.sync(null, 0, false, true);
  }
  dress(art: THREE.Object3D, reduced = false): void {
    if (this.hanger || !art.getObjectByName('AssayCase')) return;
    this.object.clear();
    for (const g of this.geometry) g.dispose();
    this.geometry.length = this.targets.length = this.weights.length = 0;
    this.flights.clear();
    this.reduced = reduced;
    const part = (name: string) => kitPart(art, name).clone(true);
    this.object.add(part('AssayCase'));
    this.hanger = part('AssayHanger');
    this.beam = part('AssayBeam');
    this.beam.position.set(-0.105, 0.012, 0.289);
    this.object.add(this.hanger, this.beam);
    this.pans = [-0.265, 0.265].map((x) => {
      const pan = part('AssayPan');
      pan.position.x = x;
      this.beam.add(pan);
      return pan;
    });
    const reference = part('AssayReference');
    reference.name = 'counterweight-reference';
    reference.position.y = -0.192;
    this.pans[1].add(reference);
    const target = (owner: THREE.Object3D, name: string, radius: number) => {
      const shape = new THREE.SphereGeometry(radius, 12, 8);
      this.geometry.push(shape);
      const hit = new THREE.Mesh(shape, this.hitMaterial);
      hit.name = name;
      owner.add(hit);
      this.targets.push(hit);
      return hit;
    };
    for (const i of [0, 1] as const) {
      const w = new THREE.Group();
      w.add(part(i ? 'AssayWeightB' : 'AssayWeightA'));
      this.object.add(w);
      this.weights.push(w);
      target(w, i ? 'counterweight-b-target' : 'counterweight-a-target', 0.07).position.y = 0.065;
    }
    this.hook = target(this.hanger, 'counterweight-hook', 0.073);
    this.hook.position.set(0.485, 0.006, 0.206);
    this.sync(this.selected, this.correct, this.solved, true);
  }
  sync(selected: Weight | null, correct: Weight, solved: boolean, immediate = false): void {
    if (
      this.initialized &&
      !immediate &&
      selected === this.selected &&
      correct === this.correct &&
      solved === this.solved
    )
      return;
    this.initialized = true;
    this.selected = selected;
    this.correct = correct;
    this.solved = solved;
    this.unloadedAngle = this.beam.rotation.z;
    this.goal =
      solved || selected === null
        ? -0.12
        : selected === correct
          ? 0
          : selected === 0
            ? 0.21
            : -0.21;
    for (const i of [0, 1] as const) {
      const part = this.weights[i];
      const weighing = i === selected && !solved,
        hanging = i === selected && solved;
      const dest = weighing
        ? (this.pans[0] ?? this.beam)
        : hanging
          ? (this.hanger ?? this.object)
          : this.object;
      const fitted = this.hanger !== undefined;
      const to = new THREE.Vector3();
      if (weighing) to.set(fitted ? 0 : -0.22, fitted ? -0.192 : -0.18, 0);
      else if (hanging)
        to.set(fitted ? 0.485 : 0.52, fitted ? -0.169 : -0.18, fitted ? 0.207 : 0.23);
      else if (fitted) to.set(i ? 0.36 : -0.55, -0.343, 0.352);
      else to.set(i ? 0.27 : -0.41, -0.38, 0.48);
      const scale = fitted ? 1 : weighing ? 0.89 : 1.35;
      const yaw = hanging && fitted ? Math.PI / 2 : 0;
      dest.attach(part);
      const distance = part.position.distanceTo(to);
      if (immediate || this.reduced || distance < 1e-5) {
        part.position.copy(to);
        part.scale.setScalar(scale);
        part.rotation.set(0, yaw, 0);
        this.flights.delete(i);
        continue;
      }
      this.flights.set(i, {
        from: part.position.clone(),
        to,
        startScale: part.scale.x,
        scale,
        startYaw: part.rotation.y,
        yaw,
        lift: Math.min(0.19, 0.07 + distance * 0.2),
        duration: Math.min(0.88, 0.42 + distance * 0.6),
        elapsed: 0,
      });
    }
    if (immediate || this.reduced) {
      this.beam.rotation.z = this.goal;
      for (const pan of this.pans) pan.rotation.z = -this.goal;
      this.velocity = 0;
    }
  }
  miss() {
    this.shake = 0.32;
  }
  update(dt: number) {
    for (const [i, f] of this.flights) {
      f.elapsed += dt;
      const t = Math.min(1, f.elapsed / f.duration);
      const travel = t * t * t * (10 + t * (-15 + 6 * t));
      const arc = Math.sin(Math.PI * t) ** 2;
      const weight = this.weights[i];
      weight.position.lerpVectors(f.from, f.to, travel);
      weight.position.y += arc * f.lift;
      weight.scale.setScalar(THREE.MathUtils.lerp(f.startScale, f.scale, travel));
      weight.rotation.set(
        0,
        THREE.MathUtils.lerp(f.startYaw, f.yaw, travel),
        0.042 * arc * Math.cos(Math.PI * t),
      );
      if (t === 1) this.flights.delete(i);
    }
    const load = this.selected === null ? undefined : this.flights.get(this.selected);
    const amount = load ? THREE.MathUtils.smoothstep(load.elapsed / load.duration, 0.39, 0.96) : 1;
    const desired = THREE.MathUtils.lerp(this.unloadedAngle, this.goal, amount);
    const x = this.beam.rotation.z - desired;
    const w = 11,
      drag = 7.2,
      decay = Math.exp(-drag * dt),
      c = Math.cos(w * dt),
      s = Math.sin(w * dt);
    const v = this.velocity + this.shake * 1.2;
    this.shake = 0;
    this.beam.rotation.z = this.reduced
      ? desired
      : desired + decay * (x * c + ((v + drag * x) * s) / w);
    this.velocity = decay * (v * c - ((drag * v + (w * w + drag * drag) * x) * s) / w);
    for (const pan of this.pans) pan.rotation.z = -this.beam.rotation.z;
    if (this.hanger)
      this.hanger.position.y = THREE.MathUtils.damp(
        this.hanger.position.y,
        this.solved ? -0.014 * amount : 0,
        9,
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
