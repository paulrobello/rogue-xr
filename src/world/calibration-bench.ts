import * as THREE from 'three';
import { CanvasLabel } from '../combat-view/canvas-label.ts';
import {
  calibrationPlan,
  GEAR_TEETH,
  type GearId,
  meshedSpindles,
  PLANET_NAMES,
  type StoredCalibrationState,
} from '../rules/calibration.ts';
import type { FloorWorld } from './floor-world.ts';
import type { InteriorPlacement } from './interior-furnishings.ts';
import { findPuzzleMount, kitPart } from './puzzle-placement.ts';

type Control = { action: 'gear' | 'seat' | 'ring'; id: GearId } | { action: 'wind' };
export type CalibrationAction = Control & { distance: number };
const IDS = [0, 1, 2] as const;
const WHEELS = ['gear_small', 'gear_medium', 'gear_large'] as const;
const ARMS = ['OrreryInner', 'OrreryMiddle', 'OrreryOuter'] as const;
const SCALE = 0.55;
// The authored gears use a common 27 mm module.
export const pitchRadius = (id: GearId): number => (GEAR_TEETH[id] * 0.027 * SCALE) / 2;
export function spindleCenters(order: readonly GearId[]): number[] {
  const radii = [pitchRadius(0), ...order.map(pitchRadius), pitchRadius(0)];
  const points = [0];
  for (let i = 1; i < radii.length; i++) points.push(points[i - 1] + radii[i - 1] + radii[i]);
  const midpoint = points[points.length - 1] / 2;
  return points.map((x) => x - midpoint);
}

export class CalibrationBench {
  readonly object = new THREE.Group();
  readonly controls: { node: THREE.Object3D; input: Control }[] = [];
  readonly positions: number[];
  private readonly wheels: THREE.Group[] = [];
  private readonly arms: THREE.Object3D[] = [];
  private readonly labels: CanvasLabel[] = [];
  private readonly hitMat = new THREE.MeshBasicMaterial({ visible: false });
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly cast = new THREE.Raycaster();
  private readonly box = new THREE.Box3();
  private readonly point = new THREE.Vector3();
  private readonly selection: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  private readonly key: THREE.Object3D;
  private driver: THREE.Group | null = null;
  private output: THREE.Group | null = null;
  private release?: () => void;
  private state: StoredCalibrationState | null = null;
  private spin = 0;
  private pulse = 0;
  private connected = 0;
  static mount(
    world: FloorWorld,
    art: THREE.Object3D,
    tools: THREE.Object3D,
    seed: string,
    props: readonly InteriorPlacement[] = [],
    reducedMotion = false,
  ): CalibrationBench {
    const rooms = world.plan.rooms.filter((r) => r.role !== 'guardian').map((r) => r.index);
    const clear = rooms.filter(
      (i) => !world.plan.rooms[i].encounter && i !== world.stairEntry?.room,
    );
    const site =
      findPuzzleMount(world, clear, props, 'calibration-bench', 0.85, 1.55) ??
      findPuzzleMount(world, rooms, props, 'calibration-bench', 0.85, 1.55);
    if (!site) throw Error('Upper Works has no clear instrument bay');
    const bench = new CalibrationBench(
      world,
      site.room,
      art,
      tools,
      calibrationPlan(seed),
      reducedMotion,
    );
    bench.object.position.copy(site.center);
    bench.object.rotation.y = site.yaw;
    world.roomGroups[site.room].add(bench.object);
    bench.object.updateWorldMatrix(true, true);
    const b = new THREE.Box3().setFromObject(bench.object);
    bench.release = world.addFixtureCollider(site.room, {
      min: b.min.toArray(),
      max: b.max.toArray(),
    });
    return bench;
  }
  private constructor(
    private readonly world: FloorWorld,
    readonly room: number,
    art: THREE.Object3D,
    tools: THREE.Object3D,
    readonly plan: ReturnType<typeof calibrationPlan>,
    private readonly reduced: boolean,
  ) {
    this.object.name = 'calibration-bench';
    this.object.add(kitPart(art, 'CalibrationFrame').clone(true));
    this.positions = spindleCenters(plan.gearOrder);
    const indicator = new THREE.MeshBasicMaterial({ color: 0xffd173, side: THREE.DoubleSide });
    const ring = new THREE.RingGeometry(0.093, 0.101, 48);
    this.geometries.push(ring);
    this.selection = new THREE.Mesh(ring, indicator);
    this.selection.visible = false;
    this.object.add(this.selection);
    const makeWheel = (id: GearId) => {
      const pivot = new THREE.Group(),
        wheel = kitPart(tools, WHEELS[id]).clone(true);
      wheel.rotation.x = Math.PI / 2;
      wheel.scale.setScalar(SCALE);
      pivot.add(wheel);
      this.object.add(pivot);
      return pivot;
    };
    this.key = kitPart(tools, 'winding_key').clone(true);
    this.key.rotation.x = Math.PI / 2;
    this.key.scale.setScalar(0.53);
    const crank = new THREE.Group();
    crank.name = 'calibration-drive';
    crank.position.set(
      plan.kind === 'gears' ? this.positions[0] : -0.51,
      plan.kind === 'gears' ? 0.1 : 0,
      0.17,
    );
    this.object.add(crank);
    crank.add(this.key);
    const windHit = this.target(crank, { action: 'wind' }, 0.073, 0, 0, 0.065);
    windHit.name = 'calibration-wind-target';
    const arbor = kitPart(tools, 'winding_arbor').clone(true);
    arbor.rotateX(Math.PI / 2);
    arbor.scale.setScalar(0.55);
    crank.add(arbor);
    if (plan.kind === 'gears') {
      this.driver = makeWheel(0);
      this.driver.position.set(this.positions[0], 0.1, 0.112);
      this.output = makeWheel(0);
      this.output.position.set(this.positions[4], 0.1, 0.112);
      for (const slot of IDS) {
        const peg = kitPart(tools, 'pegboard_spindle').clone(true);
        peg.rotation.x = Math.PI / 2;
        peg.scale.setScalar(0.57);
        peg.position.set(this.positions[slot + 1], 0.1, 0.07);
        this.object.add(peg);
        const hit = this.target(
          this.object,
          { action: 'seat', id: slot },
          0.061,
          this.positions[slot + 1],
          0.1,
          0.164,
        );
        hit.name = 'calibration-socket-' + slot;
        this.label(['I', 'II', 'III'][slot], this.positions[slot + 1], 0.345, 0.075, 0.105);
        const wheel = makeWheel(slot);
        wheel.name = 'calibration-wheel-' + slot;
        this.wheels.push(wheel);
        this.controls.push({ node: wheel, input: { action: 'gear', id: slot } });
        this.target(wheel, { action: 'gear', id: slot }, 0.058, 0, 0, 0.032).name =
          'calibration-wheel-hit-' + slot;
        this.label(String(GEAR_TEETH[slot]), (slot - 1) * 0.43, -0.385, 0.24, 0.11);
      }
    } else {
      for (const id of IDS) {
        const arm = kitPart(art, ARMS[id]).clone(true);
        arm.position.z += 0.065;
        this.object.add(arm);
        this.arms.push(arm);
        this.target(arm, { action: 'ring', id }, 0.044, 0, [0.12, 0.21, 0.3][id], 0.1).name =
          'orrery-planet-' + id;
        const knob = kitPart(tools, 'winding_arbor').clone(true);
        knob.rotation.x = Math.PI / 2;
        knob.scale.setScalar(0.38);
        knob.position.set((id - 1) * 0.31, -0.31, 0.16);
        this.object.add(knob);
        this.target(
          this.object,
          { action: 'ring', id },
          0.06,
          knob.position.x,
          knob.position.y,
          0.194,
        ).name = 'orrery-control-' + id;
        this.label(PLANET_NAMES[id], knob.position.x, -0.386, 0.215, id === 2 ? 0.24 : 0.14);
      }
      for (const [text, x, y] of [
        ['N', 0, 0.365],
        ['E', 0.36, 0],
        ['S', 0, -0.34],
        ['W', -0.36, 0],
      ] as const)
        this.label(text, x, y, 0.14, 0.055);
    }
  }
  private label(text: string, x: number, y: number, z: number, width: number) {
    if (typeof document === 'undefined' || !document.createElement('canvas').getContext('2d'))
      return;
    const l = new CanvasLabel(320, 96, width, true);
    l.draw((ctx, w, h) => {
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = '#e9d6a0';
      ctx.font = 'bold 70px Georgia';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, w / 2, h / 2, w - 8);
    });
    l.mesh.position.set(x, y, z);
    this.object.add(l.mesh);
    this.labels.push(l);
  }
  private target(
    parent: THREE.Object3D,
    input: Control,
    r: number,
    x: number,
    y: number,
    z: number,
  ) {
    const geo = new THREE.SphereGeometry(r, 12, 8);
    this.geometries.push(geo);
    const mesh = new THREE.Mesh(geo, this.hitMat);
    mesh.position.set(x, y, z);
    parent.add(mesh);
    this.controls.push({ node: mesh, input });
    return mesh;
  }
  sync(state: StoredCalibrationState, immediate = false) {
    this.state = state;
    this.key.visible = state.chart;
    if (this.plan.kind === 'gears') {
      for (const id of IDS) {
        const slot = state.slots.indexOf(id),
          wheel = this.wheels[id];
        if (slot < 0) {
          wheel.position.set((id - 1) * 0.43, -0.17, 0.22);
          wheel.rotation.z = 0;
        } else {
          const tooLarge = pitchRadius(id) > pitchRadius(this.plan.gearOrder[slot]);
          wheel.position.set(
            this.positions[slot + 1],
            0.1,
            tooLarge ? 0.215 + slot * 0.048 : 0.112,
          );
          wheel.rotation.z = slot % 2 === 0 ? Math.PI / GEAR_TEETH[id] : 0;
        }
        if (state.selected === id) {
          this.selection.position.copy(wheel.position);
          this.selection.position.z += 0.045;
          this.selection.scale.setScalar(pitchRadius(id) / 0.096);
        }
      }
      this.selection.visible = state.selected !== null && !state.solved;
    } else if (immediate || this.reduced) {
      for (const id of IDS) this.arms[id].rotation.z = (-state.detents[id] * Math.PI) / 2;
    }
    this.connected = meshedSpindles(state.slots, this.plan.gearOrder);
  }
  drive(result: 'solved' | 'stalled') {
    this.pulse = result === 'solved' ? 1.3 : 0.7;
  }
  private action(input: Control): Control | null {
    const state = this.state;
    if (!state || state.solved) return null;
    if (input.action === 'gear' && state.selected !== null && state.selected !== input.id) {
      const slot = state.slots.indexOf(input.id);
      if (slot >= 0) return { action: 'seat', id: slot as GearId };
    }
    if (input.action === 'seat' && state.selected === null) {
      const id = state.slots[input.id];
      return id === null ? null : { action: 'gear', id };
    }
    return input;
  }
  pick(origin: THREE.Vector3, direction: THREE.Vector3): CalibrationAction | null {
    if (this.world.current !== this.room || this.state?.solved) return null;
    this.cast.set(origin, direction);
    this.cast.far = 4;
    let nearest: CalibrationAction | null = null;
    for (const { node, input } of this.controls) {
      const action = this.action(input);
      if (!action) continue;
      node.updateWorldMatrix(true, true);
      const hit = this.cast.intersectObject(node, true)[0];
      if (!hit || (nearest && hit.distance >= nearest.distance)) continue;
      const blocked = this.world.colliders[this.room].some((b) => {
        this.box.min.fromArray(b.min);
        this.box.max.fromArray(b.max);
        return (
          !this.box.containsPoint(hit.point) &&
          this.cast.ray.intersectBox(this.box, this.point) !== null &&
          this.point.distanceTo(origin) < hit.distance - 0.03
        );
      });
      if (!blocked) nearest = { ...action, distance: hit.distance };
    }
    return nearest;
  }
  near(point: THREE.Vector3, reach: number): CalibrationAction | null {
    if (this.world.current !== this.room || this.state?.solved) return null;
    let best: CalibrationAction | null = null;
    for (const { node, input } of this.controls) {
      const action = this.action(input);
      if (!action) continue;
      const d = this.box.setFromObject(node).distanceToPoint(point);
      if (d <= reach && (!best || d < best.distance)) best = { ...action, distance: d };
    }
    return best;
  }
  update(dt: number) {
    const state = this.state;
    if (!state || !this.object.parent?.visible) return;
    if (this.plan.kind === 'orrery') {
      for (const id of IDS) {
        const goal = (-state.detents[id] * Math.PI) / 2,
          arm = this.arms[id];
        arm.rotation.z +=
          Math.atan2(Math.sin(goal - arm.rotation.z), Math.cos(goal - arm.rotation.z)) *
          (this.reduced ? 1 : 1 - Math.exp(-10 * dt));
      }
    }
    this.pulse = Math.max(0, this.pulse - dt);
    if (this.reduced || (!state.solved && !this.pulse)) return;
    this.spin += dt * (state.solved ? 1 : 2.2);
    this.key.rotation.y = this.spin;
    if (!this.driver || !this.output) return;
    this.driver.rotation.z = this.spin;
    this.output.rotation.z = state.solved ? this.spin : 0;
    for (let slot = 0; slot < this.connected; slot++) {
      const id = state.slots[slot];
      if (id !== null)
        this.wheels[id].rotation.z =
          ((slot % 2 === 0 ? -1 : 1) * this.spin * GEAR_TEETH[0]) / GEAR_TEETH[id] +
          (slot % 2 === 0 ? Math.PI / GEAR_TEETH[id] : 0);
    }
  }
  dispose() {
    this.object.removeFromParent();
    this.release?.();
    for (const l of this.labels) l.dispose();
    for (const g of this.geometries) g.dispose();
    this.hitMat.dispose();
    this.selection.material.dispose();
  }
}
