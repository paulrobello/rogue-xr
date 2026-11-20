import * as THREE from 'three';
import { CanvasLabel } from '../combat-view/canvas-label.ts';
import { type Box, templateById } from '../content/rooms.ts';
import { CARD_FLIGHT_SECONDS, flightGoal, flightPose, flightScale } from '../flow/card-flight.ts';
import { BELL_CLUE_HINT, type BellNote, type StoredBellChimesState } from '../rules/bell-chimes.ts';
import type { FloorWorld } from './floor-world.ts';
import type { InteriorPlacement } from './interior-furnishings.ts';

type Action = { action: 'listen' | 'claim' } | { action: 'strike'; note: BellNote };
export type BellPick = Action & { distance: number };
interface Mount {
  room: number;
  center: THREE.Vector3;
  yaw: number;
}
const COLORS = [0xf2b24c, 0x55c6b1, 0xa89bff] as const;
const NOTES = [0, 1, 2] as const;
const HALF_WIDTH = 0.66;

/** All wall scans use the unrotated template; fixture colliders arrive in world space. */
function mountingPoint(
  world: FloorWorld,
  room: number,
  props: readonly InteriorPlacement[],
): Mount | null {
  const template = templateById(world.plan.rooms[room].templateId);
  const { min, max } = template.footprint;
  const parent = world.roomGroups[room];
  parent.updateWorldMatrix(true, true);
  const inverse = parent.matrixWorld.clone().invert();
  const obstacles = world.colliders[room].map((b) =>
    new THREE.Box3(new THREE.Vector3(...b.min), new THREE.Vector3(...b.max)).applyMatrix4(inverse),
  );
  const furnishingBounds = props
    .filter((p) => p.room === room)
    .map((p) => new THREE.Box3().setFromObject(p.object).applyMatrix4(inverse));
  // Authored sconces and shelf trim can project through a plaque without a physics collider.
  const surfaces: THREE.Object3D[] = [];
  for (const child of parent.children)
    child.traverseVisible((node) => {
      if (node instanceof THREE.Mesh && !node.material?.transparent) surfaces.push(node);
    });
  const probe = new THREE.Raycaster();
  const rayPoint = new THREE.Vector3();
  for (const wall of ['S', 'E', 'W', 'N'] as const) {
    const ns = wall === 'N' || wall === 'S';
    const lo = ns ? min[0] : min[1],
      hi = ns ? max[0] : max[1];
    const edge = wall === 'N' ? min[1] : wall === 'S' ? max[1] : wall === 'W' ? min[0] : max[0];
    const yaw = { S: Math.PI, E: -Math.PI / 2, W: Math.PI / 2, N: 0 }[wall];
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    const inward = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
    const sockets = template.doors.filter((d) => d.facing === wall);
    const slots = Array.from(
      { length: Math.floor((hi - lo - 2) / 0.5) + 1 },
      (_, i) => lo + 1 + i * 0.5,
    );
    for (const along of slots.sort((a, b) => Math.abs(a) - Math.abs(b))) {
      if (
        sockets.some(
          (d) => Math.abs(along - d.position[ns ? 0 : 2]) < d.width / 2 + HALF_WIDTH + 0.2,
        )
      )
        continue;
      if (
        wall === 'N' &&
        ((template.id === 'hall' && Math.abs(along - 2.6) < 1.5) ||
          (template.id === 'study' && Math.abs(along) < 1.5))
      )
        continue;
      const center = new THREE.Vector3(ns ? along : edge, 1.48, ns ? edge : along).addScaledVector(
        inward,
        0.13,
      );
      const space = new THREE.Box3(
        new THREE.Vector3(-HALF_WIDTH, -0.75, 0.07),
        new THREE.Vector3(HALF_WIDTH, 0.65, 1.4),
      ).applyMatrix4(new THREE.Matrix4().compose(center, q, new THREE.Vector3(1, 1, 1)));
      if (obstacles.some((b) => space.intersectsBox(b))) continue;
      const back = new THREE.Box3(
        new THREE.Vector3(-HALF_WIDTH - 0.08, -0.49, -0.18),
        new THREE.Vector3(HALF_WIDTH + 0.08, 0.49, 1.4),
      ).applyMatrix4(new THREE.Matrix4().compose(center, q, new THREE.Vector3(1, 1, 1)));
      if (furnishingBounds.some((b) => back.intersectsBox(b))) continue;
      const direction = inward.clone().negate().transformDirection(parent.matrixWorld);
      probe.far = 0.93;
      const clear = [-0.6, -0.3, 0, 0.3, 0.6].every((x) =>
        [-0.34, 0, 0.34].every((y) => {
          rayPoint.set(x, y, 0.63).applyQuaternion(q).add(center).applyMatrix4(parent.matrixWorld);
          probe.set(rayPoint, direction);
          const hit = probe.intersectObjects(surfaces, false)[0];
          return hit !== undefined && hit.distance >= 0.625;
        }),
      );
      if (clear) return { room, center, yaw };
    }
  }
  return null;
}

export class BellChimes {
  readonly object = new THREE.Group();
  readonly room: number;
  private readonly ownedGeometry = new Set<THREE.BufferGeometry>();
  private readonly materials: THREE.Material[] = [];
  private readonly labels: CanvasLabel[] = [];
  private readonly targets: { mesh: THREE.Mesh; input: Action }[] = [];
  private readonly lamps: THREE.MeshBasicMaterial[] = [];
  private readonly pendants: THREE.Group[] = [];
  private readonly pins: THREE.MeshBasicMaterial[] = [];
  private readonly cast = new THREE.Raycaster();
  private readonly box = new THREE.Box3();
  private readonly point = new THREE.Vector3();
  private readonly normal = new THREE.Vector3();
  private readonly position = new THREE.Vector3();
  private readonly rotation = new THREE.Quaternion();
  private status: CanvasLabel | null = null;
  private statusLine = '';
  private drum?: THREE.Object3D;
  private key?: THREE.Object3D;
  private prize?: THREE.Mesh;
  private flight: {
    cog: THREE.Object3D;
    target: THREE.Object3D;
    from: THREE.Vector3;
    scale: THREE.Vector3;
    t: number;
  } | null = null;
  private heard = false;
  private solved = false;
  private claimed = false;
  private flash = 0;
  private sounding: BellNote | null = null;
  private errorTime = 0;
  private progress = 0;
  private readonly dislodge: () => void;

  static mount(
    world: FloorWorld,
    floor: 1 | 2,
    art: THREE.Object3D,
    props: readonly InteriorPlacement[] = [],
    showInstructions = false,
  ): BellChimes | null {
    if (!world.stairEntry) return null;
    const preferred = floor === 1 ? 0 : world.stairEntry.room;
    const rooms = [
      preferred,
      ...world.plan.rooms
        .filter(
          (r) =>
            r.index !== preferred &&
            r.role !== 'guardian' &&
            !r.encounter &&
            r.index !== world.plan.pressureWing?.pumpRoom &&
            r.index !== world.plan.pressureWing?.gallery,
        )
        .map((r) => r.index),
    ];
    for (const room of rooms) {
      const mount = mountingPoint(world, room, props);
      if (mount) return new BellChimes(world, floor, mount, art, showInstructions);
    }
    return null;
  }

  private constructor(
    private readonly world: FloorWorld,
    readonly floorNumber: 1 | 2,
    mount: Mount,
    art: THREE.Object3D,
    private readonly showInstructions: boolean,
  ) {
    this.room = mount.room;
    this.object.name = `bell-chimes-floor-${floorNumber}`;
    this.object.position.copy(mount.center);
    this.object.rotation.y = mount.yaw;
    world.roomGroups[mount.room].add(this.object);
    this.object.updateWorldMatrix(true, false);
    const bounds = new THREE.Box3(
      new THREE.Vector3(-0.62, -0.41, -0.055),
      new THREE.Vector3(0.62, 0.43, 0.28),
    ).applyMatrix4(this.object.matrixWorld);
    this.hardware(art);
    this.fixture = { min: bounds.min.toArray(), max: bounds.max.toArray() };
    this.dislodge = world.addFixtureCollider(mount.room, this.fixture);
    this.sync();
  }

  private mesh(
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    x: number,
    y: number,
    z: number,
    parent: THREE.Object3D = this.object,
  ) {
    this.ownedGeometry.add(geometry);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x, y, z);
    parent.add(mesh);
    return mesh;
  }

  private plate(y: number, w: number, pxHeight: number) {
    if (typeof document === 'undefined' || !document.createElement('canvas').getContext('2d'))
      return null;
    const l = new CanvasLabel(900, pxHeight, w, false);
    this.labels.push(l);
    l.mesh.position.set(0, y, 0.054);
    this.object.add(l.mesh);
    return l;
  }

  private hardware(art: THREE.Object3D) {
    const metal = (color: number, metalness: number) =>
      new THREE.MeshStandardMaterial({ color, metalness, roughness: 0.38 });
    const iron = metal(0x354746, 0.38),
      gold = metal(0xd5a454, 0.55),
      wood = metal(0x69432d, 0.05),
      enamel = metal(0x173a38, 0.18);
    const hitMat = new THREE.MeshBasicMaterial({ visible: false });
    this.materials.push(iron, gold, wood, enamel, hitMat);
    const box = (
      w: number,
      h: number,
      d: number,
      x: number,
      y: number,
      z: number,
      m: THREE.Material,
    ) => this.mesh(new THREE.BoxGeometry(w, h, d), m, x, y, z);
    const bottom = this.showInstructions ? -0.425 : this.floorNumber === 1 ? -0.2 : -0.3;
    const height = 0.425 - bottom;
    const center = (0.425 + bottom) / 2;
    const base = box(1.24, height, 0.1, 0, center, -0.025, wood);
    base.name = this.floorNumber === 1 ? 'music-box-body' : 'bell-bank-bracket';
    box(1.2, height - 0.04, 0.018, 0, center, 0.032, gold);
    box(1.185, height - 0.055, 0.012, 0, center, 0.046, enamel);
    const header = this.plate(0.326, 1.1, 110);
    header?.draw((ctx, w, h) => {
      ctx.fillStyle = '#163936';
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#ffdf9f';
      ctx.font = 'bold 69px Georgia';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(
        this.floorNumber === 1 ? 'Watchmaker’s Music Box' : 'Upper Works Chimes',
        w / 2,
        h / 2,
        w - 14,
      );
    });
    if (this.showInstructions) {
      this.status = this.plate(-0.32, 1.12, 105);
      if (this.status) this.status.mesh.name = 'bell-instruction-plaque';
    }
    const numbers = this.plate(0.194, 1.08, 70);
    numbers?.draw((ctx, w, h) => {
      ctx.fillStyle = '#163936';
      ctx.fillRect(0, 0, w, h);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = 'bold 49px Georgia';
      ['1   Low', '2   Mid', '3   High'].forEach((name, i) => {
        ctx.fillStyle = new THREE.Color(COLORS[i]).getStyle();
        ctx.fillText(name, (w * (i + 0.5)) / 3, h / 2);
      });
    });
    const part = (name: string, x: number, y: number, z: number, scale: number) => {
      const source = art.getObjectByName(name);
      if (!source) throw Error(`Missing chime instrument: ${name}`);
      const p = source.clone(true);
      p.position.set(x, y, z);
      p.scale.setScalar(scale);
      this.object.add(p);
      return p;
    };
    if (this.floorNumber === 1) {
      box(1.13, 0.1, 0.3, 0, -0.15, 0.16, wood);
      box(1.14, 0.018, 0.31, 0, -0.095, 0.16, gold);
      const drum = part('pinned_drum', -0.24, 0.003, 0.161, 1.08);
      drum.scale.y = 1.5;
      drum.rotation.z = -Math.PI / 2;
      this.drum = drum;
      for (const x of [-0.259, 0.146]) box(0.034, 0.2, 0.15, x, -0.006, 0.16, iron);
      box(0.44, 0.022, 0.08, -0.075, -0.071, 0.278, iron);
      for (let tooth = 0; tooth < 8; tooth++) {
        const comb = box(
          0.025,
          0.013,
          0.116 + tooth * 0.004,
          -0.233 + tooth * 0.048,
          -0.056,
          0.256,
          gold,
        );
        comb.rotation.x = -0.25;
      }
      const key = part('winding_key', 0.37, -0.01, 0.084, 0.64);
      key.rotation.x = Math.PI / 2;
      this.key = key;
      const hit = box(1.12, 0.48, 0.29, 0, -0.012, 0.2, hitMat);
      hit.name = 'music-box-target';
      this.targets.push({ mesh: hit, input: { action: 'listen' } });
    } else {
      box(1.13, 0.04, 0.1, 0, 0.136, 0.155, gold);
      for (const x of [-0.55, 0.55]) box(0.035, 0.055, 0.19, x, 0.136, 0.092, iron);
    }
    for (const i of NOTES) {
      const x = (i - 1) * 0.36;
      const lamp = new THREE.MeshBasicMaterial({
        color: COLORS[i],
        toneMapped: false,
      });
      this.materials.push(lamp);
      this.lamps.push(lamp);
      const jewel = this.mesh(new THREE.SphereGeometry(0.029, 14, 10), lamp, x, 0.138, 0.21);
      jewel.name = `music-box-note-${i + 1}`;
      if (this.floorNumber === 1) continue;
      const pivot = new THREE.Group();
      pivot.name = `bell-${i + 1}`;
      pivot.position.set(x, 0.124, 0.165);
      this.object.add(pivot);
      this.pendants.push(pivot);
      const scale = 1 - i * 0.105;
      const profile = [
        [0.038, -0.251],
        [0.114, -0.266],
        [0.14, -0.267],
        [0.144, -0.258],
        [0.139, -0.247],
        [0.12, -0.228],
        [0.104, -0.193],
        [0.092, -0.126],
        [0.088, -0.094],
        [0.076, -0.066],
        [0.047, -0.05],
        [0.02, -0.044],
        [0.014, -0.027],
      ];
      this.mesh(
        new THREE.LatheGeometry(
          profile.map(([r, h]) => new THREE.Vector2(r * scale, h * scale)),
          32,
        ),
        gold,
        0,
        0,
        0,
        pivot,
      );
      this.mesh(
        new THREE.CylinderGeometry(0.012, 0.012, 0.225 * scale, 12),
        iron,
        0,
        -0.117 * scale,
        0,
        pivot,
      );
      this.mesh(new THREE.SphereGeometry(0.027 * scale, 16, 12), wood, 0, -0.268 * scale, 0, pivot);
      const hit = this.mesh(
        new THREE.BoxGeometry(0.3, 0.32, 0.27),
        hitMat,
        0,
        -0.144 * scale,
        0,
        pivot,
      );
      hit.name = `bell-${i + 1}-target`;
      this.targets.push({ mesh: hit, input: { action: 'strike', note: i } });
    }
    if (this.floorNumber === 2) {
      for (let i = 0; i < 4; i++) {
        const lamp = new THREE.MeshBasicMaterial({
          color: 0x555447,
          toneMapped: false,
        });
        this.materials.push(lamp);
        this.pins.push(lamp);
        box(0.092, 0.024, 0.025, (i - 1.5) * 0.119, -0.208, 0.068, lamp).name =
          `bell-progress-${i + 1}`;
      }
      const cog = part('gear_medium', 0.449, -0.205, 0.102, 0.34);
      cog.rotation.x = Math.PI / 2;
      const hit = box(0.21, 0.2, 0.13, 0.449, -0.205, 0.125, hitMat);
      hit.name = 'bell-payout-cog';
      hit.add(cog);
      cog.position.set(0, 0, 0);
      this.prize = hit;
      this.targets.push({ mesh: hit, input: { action: 'claim' } });
    }
  }

  sync(state?: StoredBellChimesState, collector?: THREE.Object3D) {
    if (collector && this.prize && this.solved && !this.claimed && state?.rewardClaimed) {
      const cog = this.prize.children[0].clone(true);
      this.prize.add(cog);
      this.world.group.attach(cog);
      cog.name = 'bell-reward-flight';
      this.flight = {
        cog,
        target: collector,
        from: cog.position.clone(),
        scale: cog.scale.clone(),
        t: 0,
      };
    }
    this.heard = state?.clueHeard ?? false;
    this.progress = state?.progress.length ?? 0;
    this.solved = state?.solved ?? false;
    this.claimed = state?.rewardClaimed ?? false;
    if (this.prize) this.prize.visible = this.solved && !this.claimed;
    this.refresh();
  }

  private refresh() {
    for (const i of NOTES)
      this.lamps[i].color.setHex(COLORS[i]).multiplyScalar(this.sounding === i ? 1 : 0.18);
    for (const [i, pin] of this.pins.entries())
      pin.color.setHex(this.errorTime > 0 ? 0xef6752 : i < this.progress ? 0xf5ce78 : 0x555447);
    if (!this.status) return;
    let text: string;
    if (this.floorNumber === 1) {
      text =
        this.sounding !== null
          ? `♪   ${this.sounding + 1}   ·   ${['Low', 'Mid', 'High'][this.sounding]}`
          : this.heard
            ? 'Wind to replay   ·   Score in Items'
            : 'Wind the box. Repeat its tune on Floor 2.';
    } else {
      text = this.claimed
        ? '12 cogs collected'
        : this.solved
          ? 'Unlocked · take 12 cogs'
          : this.errorTime > 0
            ? 'Wrong note. Start the phrase again.'
            : this.heard
              ? 'Ring the four notes in order.'
              : BELL_CLUE_HINT;
    }
    if (text === this.statusLine) return;
    this.statusLine = text;
    this.status?.draw((ctx, w, h) => {
      ctx.fillStyle = '#163936';
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#fff1cf';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = 'bold 51px sans-serif';
      ctx.fillText(text, w / 2, h / 2, w - 10);
    });
  }

  cue(note: BellNote) {
    for (const p of this.pendants) p.rotation.x = 0;
    this.sounding = note;
    this.errorTime = 0;
    this.flash = 0.41;
    this.refresh();
  }
  miss() {
    this.errorTime = 1;
    this.refresh();
  }
  update(dt: number) {
    const f = this.flight;
    if (f && dt > 0) {
      f.t = Math.min(1, f.t + dt / CARD_FLIGHT_SECONDS);
      this.world.group.worldToLocal(f.target.getWorldPosition(this.point));
      flightGoal(f.from, this.point, 0.23, this.point);
      const k = flightPose(f.from, this.point, f.t, f.cog.position);
      const lift = Math.min(0.18, f.from.distanceTo(this.point) * 0.15);
      f.cog.position.y += Math.sin(k * Math.PI) * lift;
      f.cog.scale.copy(f.scale).multiplyScalar(flightScale(k * k));
      f.cog.rotateY(dt * 6);
      if (f.t === 1) {
        f.cog.removeFromParent();
        this.flight = null;
      }
    }
    if (dt <= 0 || (!this.flash && !this.errorTime)) return;
    if (this.sounding !== null) {
      const t = Math.min(dt, this.flash);
      this.flash = Math.max(0, this.flash - dt);
      const angle = (0.18 * Math.sin((0.41 - this.flash) * 24) * this.flash) / 0.41;
      if (this.drum) this.drum.rotateY(t * 4);
      if (this.key) this.key.rotateY(t * 3);
      if (this.pendants[this.sounding]) this.pendants[this.sounding].rotation.x = angle;
      if (this.flash === 0) this.sounding = null;
    }
    this.errorTime = Math.max(0, this.errorTime - dt);
    this.refresh();
  }

  private available(target: { input: Action }): boolean {
    return target.input.action === 'claim'
      ? this.solved && !this.claimed
      : target.input.action === 'strike'
        ? !this.solved
        : true;
  }
  private inFront(origin: THREE.Vector3) {
    this.object.getWorldPosition(this.position);
    this.object.getWorldQuaternion(this.rotation);
    return (
      this.point
        .subVectors(origin, this.position)
        .dot(this.normal.set(0, 0, 1).applyQuaternion(this.rotation)) > 0
    );
  }

  pick(origin: THREE.Vector3, direction: THREE.Vector3): BellPick | null {
    if (this.world.current !== this.room || !this.inFront(origin)) return null;
    this.cast.set(origin, direction);
    this.cast.far = 4;
    let found: BellPick | null = null;
    for (const target of this.targets) {
      if (!this.available(target)) continue;
      const hit = this.cast.intersectObject(target.mesh, false)[0];
      if (hit && (!found || hit.distance < found.distance))
        found = { ...target.input, distance: hit.distance };
    }
    if (!found) return null;
    for (const b of this.world.colliders[this.room]) {
      if (b === this.fixture) continue;
      this.box.min.fromArray(b.min);
      this.box.max.fromArray(b.max);
      if (
        this.cast.ray.intersectBox(this.box, this.point) &&
        origin.distanceTo(this.point) < found.distance - 0.015
      )
        return null;
    }
    return found;
  }

  near(point: THREE.Vector3, reach: number): BellPick | null {
    if (this.world.current !== this.room || !this.inFront(point)) return null;
    let nearest: BellPick | null = null;
    for (const t of this.targets) {
      if (!this.available(t)) continue;
      t.mesh.getWorldPosition(this.position);
      const distance = point.distanceTo(this.position);
      if (distance <= reach && (!nearest || distance < nearest.distance))
        nearest = { ...t.input, distance };
    }
    return nearest;
  }
  private readonly fixture: Box;
  dispose() {
    this.flight?.cog.removeFromParent();
    this.flight = null;
    this.dislodge();
    this.object.removeFromParent();
    for (const label of this.labels) label.dispose();
    for (const g of this.ownedGeometry) g.dispose();
    for (const m of this.materials) m.dispose();
  }
}
