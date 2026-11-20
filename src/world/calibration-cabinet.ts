import * as THREE from 'three';
import { CanvasLabel } from '../combat-view/canvas-label.ts';
import { CARD_FLIGHT_SECONDS, flightGoal, flightPose, flightScale } from '../flow/card-flight.ts';
import {
  BEARINGS,
  calibrationPlan,
  GEAR_TEETH,
  type StoredCalibrationState,
} from '../rules/calibration.ts';
import type { FloorWorld } from './floor-world.ts';
import type { InteriorPlacement } from './interior-furnishings.ts';
import type { CofferCardFace } from './loot.ts';
import { findPuzzleMount, kitPart, type PuzzleMount } from './puzzle-placement.ts';
export type FolioPick = { action: 'chart' | 'card' | 'part' | 'key'; distance: number };

function drawChart(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  plan: ReturnType<typeof calibrationPlan>,
) {
  ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = '#504336';
  ctx.fillStyle = '#342925';
  ctx.lineWidth = 2.5;
  ctx.strokeRect(9, 9, w - 18, h - 18);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = 'bold 44px Georgia';
  ctx.fillText(plan.kind === 'gears' ? 'ESCAPEMENT TRAIN' : 'CELESTIAL TABLE', w / 2, 46, w * 0.86);
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(w * 0.11, 81);
  ctx.lineTo(w * 0.89, 81);
  ctx.stroke();
  if (plan.kind === 'gears') {
    const r = plan.gearOrder.map((id) => GEAR_TEETH[id] * 3);
    const span = 2 * r.reduce((s, n) => s + n, 0);
    let x = (w - span) / 2;
    const y = h * 0.49;
    ctx.setLineDash([8, 6]);
    ctx.beginPath();
    ctx.moveTo(w * 0.055, y);
    ctx.lineTo(w * 0.945, y);
    ctx.stroke();
    ctx.setLineDash([]);
    for (const [i, id] of plan.gearOrder.entries()) {
      x += r[i];
      const teeth = GEAR_TEETH[id];
      ctx.beginPath();
      for (let j = 0; j <= teeth * 4; j++) {
        const a = (j * Math.PI) / (teeth * 2),
          rr = r[i] + (j % 4 === 1 || j % 4 === 2 ? 4 : -4);
        const xx = x + rr * Math.cos(a),
          yy = y + rr * Math.sin(a);
        if (j) ctx.lineTo(xx, yy);
        else ctx.moveTo(xx, yy);
      }
      ctx.closePath();
      ctx.lineWidth = 3;
      ctx.stroke();
      for (const radius of [r[i] * 0.59, r[i] * 0.18]) {
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.font = '34px Georgia';
      ctx.fillText(['I', 'II', 'III'][i], x, h * 0.76);
      ctx.font = 'bold 39px Georgia';
      ctx.fillText(teeth + ' teeth', x, h * 0.89, 2 * r[i] + 20);
      x += r[i];
    }
  } else {
    const x = w * 0.35,
      y = h * 0.54,
      R = h * 0.32;
    for (const [i, detent] of plan.detents.entries()) {
      const r = (0.39 + 0.3 * i) * R,
        a = ((detent - 1) * Math.PI) / 2;
      ctx.strokeStyle = ['#503c74', '#794825', '#235f61'][i];
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + r * Math.cos(a), y + r * Math.sin(a));
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(x + r * Math.cos(a), y + r * Math.sin(a), 7 + i, 0, Math.PI * 2);
      ctx.fillStyle = ctx.strokeStyle;
      ctx.fill();
      ctx.fillStyle = '#3b3027';
      ctx.font = '32px Georgia';
      ctx.fillText(
        ['Moon', 'Sun', 'Ringed planet'][i] + ' · ' + BEARINGS[detent],
        w * 0.74,
        h * (0.34 + i * 0.19),
        w * 0.44,
      );
    }
    ctx.font = '25px Georgia';
    ctx.fillText('N', x, y - R - 19);
    ctx.fillText('S', x, y + R + 19);
    ctx.fillText('W', x - R - 18, y);
    ctx.fillText('E', x + R + 18, y);
  }
}

export class CalibrationCabinet {
  readonly object: THREE.Object3D;
  readonly key: THREE.Object3D | null;
  readonly drawer: THREE.Object3D;
  readonly card: THREE.Object3D;
  readonly spare: THREE.Object3D | null;
  private spareHit?: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
  private readonly chart: CanvasLabel | null;
  private readonly cardHit: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private readonly cast = new THREE.Raycaster();
  private readonly box = new THREE.Box3();
  private readonly point = new THREE.Vector3();
  private readonly slides: THREE.Object3D;
  private readonly restZ: number;
  private solved = false;
  private paid = false;
  private t = 0;
  private flight: { start: THREE.Vector3; target: THREE.Object3D; t: number } | null = null;
  private release?: () => void;
  static mount(
    world: FloorWorld,
    art: THREE.Object3D,
    instruments: THREE.Object3D,
    seed: string,
    props: readonly InteriorPlacement[],
    face: (id: string) => CofferCardFace,
    reduced: boolean,
  ): CalibrationCabinet {
    const gate = world.plan.connections.find((e) => e.puzzleGate === 'pressure');
    if (!gate) throw Error('Missing pressure supply room');
    const room = gate[1].room,
      site = findPuzzleMount(world, [room], props, 'calibration-chart', 0.54, 0.78);
    if (!site) throw Error('No calibration cabinet bay in the supply room');
    const plan = calibrationPlan(seed),
      cabinet = new CalibrationCabinet(
        world,
        room,
        art,
        instruments,
        plan,
        face(plan.rewardCard),
        reduced,
      );
    cabinet.object.position.copy(site.center);
    cabinet.object.rotation.y = site.yaw;
    world.roomGroups[room].add(cabinet.object);
    cabinet.object.updateWorldMatrix(true, true);
    const b = new THREE.Box3().setFromObject(cabinet.object);
    cabinet.release = world.addFixtureCollider(room, {
      min: b.min.toArray(),
      max: b.max.toArray(),
    });
    return cabinet;
  }
  private constructor(
    private readonly world: FloorWorld,
    readonly room: number,
    art: THREE.Object3D,
    instruments: THREE.Object3D,
    plan: ReturnType<typeof calibrationPlan>,
    private readonly face: CofferCardFace,
    private readonly reduced: boolean,
  ) {
    this.object = kitPart(art, 'ChartCabinet').clone(true);
    this.object.name = 'calibration-chart-cabinet';
    this.drawer = kitPart(this.object, 'ChartDrawer');
    this.slides = kitPart(this.object, 'ChartDrawerSlides');
    this.restZ = this.drawer.position.z;
    this.key = plan.kind === 'gears' ? kitPart(instruments, 'winding_key').clone(true) : null;
    if (this.key) {
      this.key.name = 'folio-winding-key';
      this.key.position.set(0.275, -0.125, 0.139);
      this.key.rotation.z = -0.74;
      this.key.scale.setScalar(0.45);
      this.object.add(this.key);
    }
    this.spare = plan.kind === 'orrery' ? kitPart(art, 'OrreryCoupling').clone(true) : null;
    if (this.spare) {
      const cradle = kitPart(art, 'OrreryCouplingCradle').clone(true);
      cradle.position.set(-0.428, -0.07, 0.07);
      this.spare.name = 'orrery-drive-spare';
      this.spare.position.set(-0.428, -0.065, 0.123);
      this.spareHit = new THREE.Mesh(
        new THREE.SphereGeometry(0.051, 12, 8),
        new THREE.MeshBasicMaterial({ visible: false }),
      );
      this.spare.add(this.spareHit);
      this.object.add(cradle, this.spare);
    }
    this.card = face.object;
    this.card.name = 'calibration-card';
    this.cardHit = new THREE.Mesh(
      new THREE.PlaneGeometry(face.width, face.height),
      new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide }),
    );
    this.card.add(this.cardHit);
    kitPart(this.drawer, 'CardRest').add(this.card);
    this.card.visible = false;
    this.chart =
      typeof document !== 'undefined' && document.createElement('canvas').getContext('2d')
        ? new CanvasLabel(900, 550, 0.56, true)
        : null;
    if (this.chart) {
      this.chart.mesh.name = 'instrument-chart';
      this.chart.draw((c, w, h) => drawChart(c, w, h, plan));
      this.chart.mesh.position.set(0, 0.055, 0.084);
      this.object.add(this.chart.mesh);
    }
  }
  sync(state: StoredCalibrationState, immediate = false, collector?: THREE.Object3D) {
    if (this.key) this.key.visible = !state.chart;
    if (this.spare) this.spare.visible = !state.spare && !state.repaired;
    if (collector && state.claimed && !this.paid && this.card.visible && !this.reduced) {
      this.world.group.attach(this.card);
      this.flight = { start: this.card.position.clone(), target: collector, t: 0 };
    }
    this.solved = state.solved;
    this.paid = state.claimed;
    if (immediate || this.reduced) this.t = Number(this.solved);
    this.pose();
  }
  private pose() {
    const travel = 0.18 * this.t;
    this.drawer.position.z = this.restZ + travel;
    this.slides.position.z = travel / 2;
    if (this.flight) return;
    const rise = Math.max(0, (this.t - 0.48) / 0.52);
    this.card.visible = this.solved && !this.paid && this.t > 0.06;
    this.card.position.set(0, 0.023 + rise * 0.12, rise * 0.02);
    this.card.rotation.x = -Math.PI / 2 + rise * 1.15;
    this.card.scale.setScalar(0.4 + rise * 0.55);
  }
  pick(origin: THREE.Vector3, direction: THREE.Vector3): FolioPick | null {
    if (this.room !== this.world.current) return null;
    this.object.updateWorldMatrix(true, true);
    this.cast.set(origin, direction);
    this.cast.far = 4;
    const hit = this.cast.intersectObject(this.object, true).find((h) => {
      let n: THREE.Object3D | null = h.object;
      while (n && n !== this.object) {
        if (!n.visible) return false;
        n = n.parent;
      }
      return true;
    });
    if (!hit) return null;
    for (const b of this.world.colliders[this.room]) {
      this.box.min.fromArray(b.min);
      this.box.max.fromArray(b.max);
      if (
        !this.box.containsPoint(hit.point) &&
        this.cast.ray.intersectBox(this.box, this.point) &&
        this.point.distanceTo(origin) < hit.distance - 0.03
      )
        return null;
    }
    for (let n: THREE.Object3D | null = hit.object; n; n = n.parent) {
      if (n === this.card) return { action: 'card', distance: hit.distance };
      if (n === this.spare) return { action: 'part', distance: hit.distance };
    }
    return { action: 'chart', distance: hit.distance };
  }
  near(point: THREE.Vector3, reach: number): FolioPick | null {
    if (this.room !== this.world.current) return null;
    if (this.spare?.visible) {
      const d = this.box.setFromObject(this.spare).distanceToPoint(point);
      if (d <= reach) return { action: 'part', distance: d };
    }
    if (this.card.visible && !this.paid) {
      const d = this.box.setFromObject(this.card).distanceToPoint(point);
      if (d <= reach) return { action: 'card', distance: d };
    }
    const d = this.box.setFromObject(this.object).distanceToPoint(point);
    return d <= reach ? { action: 'chart', distance: d } : null;
  }
  update(dt: number) {
    if (this.solved && this.t < 1) {
      this.t = Math.min(1, this.t + dt * 1.8);
      this.pose();
    }
    const f = this.flight;
    if (!f) return;
    f.t += dt / CARD_FLIGHT_SECONDS;
    this.world.group.worldToLocal(f.target.getWorldPosition(this.point));
    flightGoal(f.start, this.point, 0.23, this.point);
    const k = flightPose(f.start, this.point, f.t, this.card.position);
    this.card.scale.setScalar(0.95 * flightScale(k));
    if (f.t >= 1) {
      this.flight = null;
      this.card.visible = false;
    }
  }
  dispose() {
    this.card.removeFromParent();
    this.cardHit.geometry.dispose();
    this.cardHit.material.dispose();
    this.face.dispose();
    this.spareHit?.geometry.dispose();
    this.spareHit?.material.dispose();
    this.chart?.dispose();
    this.release?.();
    this.object.removeFromParent();
  }
}

export class CalibrationKeyStand {
  readonly object = new THREE.Group();
  readonly key = new THREE.Group();
  readonly room: number;
  private readonly label?: CanvasLabel;
  private readonly target = new THREE.Box3();
  private readonly obstacle = new THREE.Box3();
  private readonly ray = new THREE.Ray();
  private readonly hit = new THREE.Vector3();
  private readonly release: () => void;

  static mount(
    world: FloorWorld,
    tools: THREE.Object3D,
    props: readonly InteriorPlacement[],
    benchRoom: number,
  ): CalibrationKeyStand {
    const rooms = world.plan.rooms.filter((r) => r.index !== benchRoom && r.role !== 'guardian');
    const entry = world.stairEntry?.room ?? 0;
    const mount = (candidates: readonly number[]) =>
      findPuzzleMount(world, candidates, props, 'orrery-key', 0.33, 0.62);
    const site =
      mount(rooms.filter((r) => r.index === entry).map((r) => r.index)) ??
      mount(rooms.filter((r) => !r.encounter).map((r) => r.index)) ??
      mount(rooms.map((r) => r.index));
    if (!site) throw Error('No accessible Upper Works winding-key rack');
    return new CalibrationKeyStand(world, tools, site);
  }

  private constructor(
    private readonly world: FloorWorld,
    tools: THREE.Object3D,
    site: PuzzleMount,
  ) {
    this.room = site.room;
    this.object.name = 'orrery-key-stand';
    this.object.position.copy(site.wallSurface);
    this.object.rotation.y = site.yaw;
    world.roomGroups[this.room].add(this.object);
    const wood = kitPart(tools, 'stamp_press').children.find((node) =>
      node.name.startsWith('base'),
    );
    if (!wood) throw Error('Missing wooden press base for winding-key rack');
    const board = wood.clone(true);
    board.name = 'orrery-key-board';
    board.rotation.x = Math.PI / 2;
    board.scale.set(2, 1, 2.6);
    board.position.set(0, 0, 0.025);
    const peg = kitPart(tools, 'pegboard_spindle').clone(true);
    peg.rotation.x = Math.PI / 2;
    peg.scale.setScalar(0.45);
    peg.position.set(0, 0.074, 0.049);
    this.object.add(board, peg);
    if (typeof document !== 'undefined' && document.createElement('canvas').getContext('2d')) {
      this.label = new CanvasLabel(600, 85, 0.43, false);
      this.label.draw((ctx, w, h) => {
        ctx.fillStyle = '#876c45';
        ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = '#263533';
        ctx.fillRect(4, 4, w - 8, h - 8);
        ctx.font = 'bold 53px Georgia, serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#f2dfb5';
        ctx.fillText('Orrery winding key', w / 2, h / 2, w - 22);
      });
      this.label.mesh.position.set(0, 0.195, 0.052);
      this.object.add(this.label.mesh);
    }
    this.object.updateWorldMatrix(true, true);
    const rack = new THREE.Box3().setFromObject(this.object);
    this.release = world.addFixtureCollider(this.room, {
      min: rack.min.toArray(),
      max: rack.max.toArray(),
    });
    const model = kitPart(tools, 'winding_key').clone(true);
    model.position.y = -0.19;
    this.key.name = 'orrery-winding-key';
    this.key.scale.setScalar(0.82);
    this.key.rotation.set(-0.79, 0, -0.52, 'ZXY');
    this.key.position.set(0.013, -0.048, 0.231);
    this.key.add(model);
    this.object.add(this.key);
    this.key.updateWorldMatrix(true, true);
    this.target.setFromObject(this.key, true).expandByScalar(0.016);
  }

  sync(taken: boolean): void {
    this.key.visible = !taken;
  }
  pick(origin: THREE.Vector3, direction: THREE.Vector3): FolioPick | null {
    if (this.world.current !== this.room || !this.key.visible) return null;
    this.ray.set(origin, direction);
    if (!this.ray.intersectBox(this.target, this.hit)) return null;
    const distance = origin.distanceTo(this.hit);
    if (distance > 4) return null;
    for (const b of this.world.colliders[this.room]) {
      this.obstacle.min.fromArray(b.min);
      this.obstacle.max.fromArray(b.max);
      if (
        !this.obstacle.intersectsBox(this.target) &&
        this.ray.intersectBox(this.obstacle, this.hit) &&
        origin.distanceTo(this.hit) < distance - 0.02
      )
        return null;
    }
    return { action: 'key', distance };
  }
  near(point: THREE.Vector3, reach: number): FolioPick | null {
    if (this.world.current !== this.room || !this.key.visible) return null;
    const distance = this.target.distanceToPoint(point);
    return distance <= reach ? { action: 'key', distance } : null;
  }
  dispose(): void {
    this.label?.dispose();
    this.release();
    this.object.removeFromParent();
  }
}
