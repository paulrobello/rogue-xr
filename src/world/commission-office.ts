import * as THREE from 'three';
import { CanvasLabel } from '../combat-view/canvas-label.ts';
import { CARD_FLIGHT_SECONDS, flightGoal, flightPose, flightScale } from '../flow/card-flight.ts';
import {
  COMMISSION_ORDERS,
  COMMISSION_PAYOUT,
  COMMISSION_TITLES,
  type CommissionKind,
} from '../rules/commissions.ts';
import type { FloorWorld } from './floor-world.ts';
import type { InteriorPlacement } from './interior-furnishings.ts';
import { findPuzzleMount, kitPart, type PuzzleMount } from './puzzle-placement.ts';

type Spring = 0 | 1 | 2;
type Input = { action: 'read' | 'accept' | 'claim' } | { action: 'spring'; spring: Spring };
export type CommissionAction = Input & { distance: number };
export type CommissionState = {
  accepted: boolean;
  claimed: boolean;
  recovered: readonly Spring[];
  progress: number;
  total: number;
};

function accessibleRooms(world: FloorWorld): number[] {
  const visited = new Set([0]),
    queue = [0];
  for (let i = 0; i < queue.length; i++)
    for (const edge of world.plan.connections) {
      if (edge.puzzleGate) continue;
      const [a, b] = edge,
        n = a.room === queue[i] ? b.room : b.room === queue[i] ? a.room : -1;
      if (n >= 0 && !visited.has(n)) {
        visited.add(n);
        queue.push(n);
      }
    }
  return queue.filter(
    (r) =>
      r !== world.plan.guardianRoom &&
      r !== world.plan.pressureWing?.pumpRoom &&
      r !== world.plan.pressureWing?.gallery,
  );
}

export class CommissionOffice {
  readonly object = new THREE.Group();
  readonly springs: { spring: Spring; node: THREE.Object3D; room: number }[] = [];
  readonly room: number;
  readonly ledger: THREE.Object3D | null;
  readonly stamp: THREE.Object3D | null;
  readonly purse: THREE.Object3D | null;
  private readonly hinge: THREE.Object3D | null;
  private readonly paper: CanvasLabel | null;
  private readonly caption: CanvasLabel | null;
  private readonly fixtures: THREE.Object3D[] = [];
  private readonly clear: (() => void)[] = [];
  private readonly materials: THREE.Material[] = [];
  private readonly geometry: THREE.BufferGeometry[] = [];
  private readonly cast = new THREE.Raycaster();
  private readonly box = new THREE.Box3();
  private readonly point = new THREE.Vector3();
  private readOpen = false;
  private accepted = false;
  private paid = false;
  private status = '';
  private flight: {
    node: THREE.Object3D;
    from: THREE.Vector3;
    collector: THREE.Object3D;
    t: number;
  } | null = null;
  static mount(
    world: FloorWorld,
    art: THREE.Object3D,
    floor: 1 | 2,
    kind: CommissionKind,
    props: readonly InteriorPlacement[] = [],
    reduced = false,
  ): CommissionOffice | null {
    if (floor === 2 && kind !== 'recovery') return null;
    const rooms = accessibleRooms(world);
    const quiet = rooms.filter((r) => !world.plan.rooms[r].encounter);
    const board =
      floor === 1
        ? (findPuzzleMount(world, [0], props, 'commission-ledger', 0.67, 0.85) ??
          findPuzzleMount(world, quiet, props, 'commission-ledger', 0.67, 0.85))
        : null;
    if (floor === 1 && !board) throw Error('No safe commission ledger site');
    const office = new CommissionOffice(world, art, board, kind, reduced);
    if (kind === 'recovery') {
      const used = new Set<number>();
      for (const id of (floor === 1 ? [0, 1] : [2]) as Spring[]) {
        const key = 'return-spring-' + id;
        const eligible = (ids: number[]) => ids.filter((r) => !used.has(r) && r !== board?.room);
        const site =
          findPuzzleMount(world, eligible(quiet), props, key, 0.24, 0.7) ??
          findPuzzleMount(world, eligible(rooms), props, key, 0.24, 0.7) ??
          findPuzzleMount(
            world,
            rooms.filter((r) => !used.has(r)),
            props,
            key,
            0.24,
            0.7,
          );
        if (!site) {
          office.dispose();
          throw Error('Missing reachable return spring ' + id);
        }
        used.add(site.room);
        office.mountSpring(art, id, site);
      }
    }
    return office;
  }
  private constructor(
    private readonly world: FloorWorld,
    art: THREE.Object3D,
    board: PuzzleMount | null,
    readonly kind: CommissionKind,
    private readonly reduced: boolean,
  ) {
    this.room = board?.room ?? -1;
    this.object.name = 'keeper-commission-office';
    if (!board) {
      this.ledger = this.stamp = this.purse = this.hinge = this.paper = this.caption = null;
      return;
    }
    this.ledger = kitPart(art, 'CommissionLedger').clone(true);
    this.hinge = kitPart(this.ledger, 'CommissionPaperPivot');
    this.stamp = kitPart(this.ledger, 'CommissionStamp');
    this.purse = kitPart(art, 'CommissionPurse').clone(true);
    this.purse.position.set(0.27, -0.31, 0.19);
    this.purse.visible = false;
    this.object.add(this.ledger, this.purse);
    this.attach(this.object, board);
    const canDraw =
      typeof document !== 'undefined' && document.createElement('canvas').getContext('2d');
    this.paper = canDraw ? new CanvasLabel(640, 515, 0.4, true) : null;
    this.caption = canDraw ? new CanvasLabel(608, 68, 0.49, false) : null;
    if (this.paper) {
      this.paper.mesh.name = 'commission-docket-text';
      this.paper.mesh.position.set(0, -0.015, 0.0855);
      this.ledger.add(this.paper.mesh);
      this.paper.mesh.visible = false;
    }
    if (this.caption) {
      this.caption.mesh.name = 'commission-ledger-title';
      this.caption.mesh.position.set(-0.04, 0.272, 0.092);
      this.ledger.add(this.caption.mesh);
      this.caption.draw((ctx, w, h) => {
        ctx.fillStyle = '#35291f';
        ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = '#eed5a1';
        ctx.font = 'bold 43px Georgia';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('Office of the Keeper', w / 2, h / 2, w - 18);
      });
    }
    const tray = this.shelf(0.25, 0.035, 0.24);
    tray.position.set(0.27, -0.332, 0.18);
    this.object.add(tray);
  }
  private attach(root: THREE.Object3D, site: PuzzleMount): void {
    root.position.copy(site.center);
    root.rotation.y = site.yaw;
    this.world.roomGroups[site.room].add(root);
    root.updateWorldMatrix(true, true);
    this.fixtures.push(root);
  }
  private shelf(w: number, h: number, d: number): THREE.Mesh {
    if (!this.materials.length)
      this.materials.push(
        new THREE.MeshStandardMaterial({ color: 0x735537, roughness: 0.55, metalness: 0.54 }),
      );
    const geometry = new THREE.BoxGeometry(w, h, d);
    this.geometry.push(geometry);
    return new THREE.Mesh(geometry, this.materials[0]);
  }
  private mountSpring(art: THREE.Object3D, spring: Spring, site: PuzzleMount): void {
    const mount = new THREE.Group();
    mount.name = 'spring-perch-' + spring;
    const tray = new THREE.Group();
    tray.position.set(0, -0.25, 0.2);
    tray.rotation.x = 0.42;
    mount.add(tray);
    const top = this.shelf(0.32, 0.035, 0.235);
    top.position.y = -0.018;
    tray.add(top);
    for (const x of [-0.1, 0.1]) {
      const bracket = this.shelf(0.025, 0.11, 0.17);
      bracket.position.set(x, -0.32, 0.14);
      mount.add(bracket);
    }
    const node = kitPart(art, 'ReturnSpring' + (spring + 1)).clone(true);
    tray.add(node);
    this.attach(mount, site);
    const b = new THREE.Box3().setFromObject(mount);
    this.clear.push(
      this.world.addFixtureCollider(site.room, { min: b.min.toArray(), max: b.max.toArray() }),
    );
    this.springs.push({ spring, node, room: site.room });
  }
  read(): void {
    this.readOpen = true;
  }
  sync(state: CommissionState, collector?: THREE.Object3D): void {
    for (const entry of this.springs) entry.node.visible = !state.recovered.includes(entry.spring);
    if (!this.ledger || !this.purse || !this.stamp) return;
    if (state.claimed && !this.paid && collector && this.purse.visible) {
      const node = this.purse.clone(true);
      this.object.add(node);
      this.world.group.attach(node);
      node.name = 'commission-purse-flight';
      this.flight = { node, from: node.position.clone(), collector, t: 0 };
    }
    this.accepted = state.accepted;
    this.paid = state.claimed;
    this.purse.visible = state.accepted && !state.claimed && state.progress === state.total;
    const status = state.claimed
      ? 'Paid in full'
      : state.accepted
        ? state.progress === state.total
          ? 'Payment ready'
          : `Filed · ${state.progress} / ${state.total}`
        : 'Awaiting seal';
    if (status === this.status) return;
    this.status = status;
    this.paper?.draw((ctx, w, h) => {
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = '#301d17';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = 'bold 40px Georgia';
      ctx.fillText(COMMISSION_TITLES[this.kind], w / 2, h * 0.14, w - 22);
      ctx.font = '32px Georgia';
      const words = COMMISSION_ORDERS[this.kind].split(' '),
        lines: string[] = [];
      let line = '';
      for (const word of words) {
        const next = (line + ' ' + word).trim();
        if (line && ctx.measureText(next).width > w - 60) {
          lines.push(line);
          line = word;
        } else line = next;
      }
      if (line) lines.push(line);
      for (let i = 0; i < lines.length; i++)
        ctx.fillText(lines[i], w / 2, h * 0.31 + i * 42, w - 36);
      ctx.font = 'bold 36px Georgia';
      ctx.fillText(COMMISSION_PAYOUT[this.kind] + ' cogs', w / 2, h * 0.74);
      ctx.fillStyle = '#6a352a';
      ctx.font = '29px Georgia';
      ctx.fillText(status, w / 2, h * 0.89, w - 40);
    });
  }
  private targets(): { node: THREE.Object3D; input: Input }[] {
    const out: { node: THREE.Object3D; input: Input }[] = [];
    if (this.room === this.world.current && this.ledger) {
      if (this.purse?.visible) out.push({ node: this.purse, input: { action: 'claim' } });
      if (this.readOpen && !this.accepted && this.stamp)
        out.push({ node: this.stamp, input: { action: 'accept' } });
      out.push({ node: this.ledger, input: { action: 'read' } });
    }
    for (const e of this.springs)
      if (e.room === this.world.current && e.node.visible)
        out.push({ node: e.node, input: { action: 'spring', spring: e.spring } });
    return out;
  }
  pick(origin: THREE.Vector3, direction: THREE.Vector3): CommissionAction | null {
    this.cast.set(origin, direction);
    this.cast.far = 4;
    let best: CommissionAction | null = null;
    for (const { node, input } of this.targets()) {
      node.updateWorldMatrix(true, true);
      const hit = this.cast.intersectObject(node, true)[0];
      if (!hit || (best && hit.distance >= best.distance - 0.002)) continue;
      const blocked = this.world.colliders[this.world.current].some((b) => {
        this.box.min.fromArray(b.min);
        this.box.max.fromArray(b.max);
        return (
          !this.box.containsPoint(hit.point) &&
          this.cast.ray.intersectBox(this.box, this.point) !== null &&
          this.point.distanceTo(origin) < hit.distance - 0.035
        );
      });
      if (!blocked) best = { ...input, distance: hit.distance };
    }
    return best;
  }
  near(point: THREE.Vector3, reach: number): CommissionAction | null {
    for (const { node, input } of this.targets()) {
      const d = this.box.setFromObject(node).distanceToPoint(point);
      if (d <= reach) return { ...input, distance: d };
    }
    return null;
  }
  update(dt: number): void {
    if (this.hinge) {
      const desired = this.readOpen || this.accepted ? -2.25 : 0;
      this.hinge.rotation.y = this.reduced
        ? desired
        : THREE.MathUtils.damp(this.hinge.rotation.y, desired, 7, dt);
      if (this.paper) this.paper.mesh.visible = this.hinge.rotation.y < -0.25;
    }
    if (!this.flight) return;
    const f = this.flight;
    f.t += dt / CARD_FLIGHT_SECONDS;
    this.world.group.worldToLocal(f.collector.getWorldPosition(this.point));
    flightGoal(f.from, this.point, 0.23, this.point);
    const t = Math.min(1, f.t);
    const eased = flightPose(f.from, this.point, t, f.node.position);
    f.node.scale.setScalar(flightScale(eased));
    f.node.rotation.y += dt * 4;
    if (t >= 1) {
      f.node.removeFromParent();
      this.flight = null;
    }
  }
  dispose() {
    for (const f of this.clear) f();
    this.flight?.node.removeFromParent();
    for (const f of this.fixtures) f.removeFromParent();
    this.paper?.dispose();
    this.caption?.dispose();
    for (const g of this.geometry) g.dispose();
    for (const m of this.materials) m.dispose();
  }
}
