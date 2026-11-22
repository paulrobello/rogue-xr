import * as THREE from 'three';
import { type PrismChannel, prismOrder, type StoredPrismState } from '../rules/prism-signal.ts';
import { ClockInscription } from './clock-inscription.ts';
import type { FloorWorld } from './floor-world.ts';
import type { InteriorPlacement } from './interior-furnishings.ts';
import type { PbrSet } from './materials.ts';
import { findPuzzleMount } from './puzzle-placement.ts';

type PrismAction =
  | { action: 'turn' }
  | { action: 'exhibit' }
  | { action: 'receiver'; channel: PrismChannel };
type Control = { node: THREE.Object3D; action: PrismAction };
export type PrismPick = (PrismAction & { distance: number }) | null;

const CHANNELS = [0, 1, 2] as const;
const COLORS = [0xea614d, 0x52befc, 0xffc850] as const;
const SIGILS = ['Notch', 'Star', 'Ring'] as const;
const FORWARD = new THREE.Vector3(0, 0, 1);
const PRISM_LIGHT = new THREE.Vector3(0, 1.025, 0.08);
const CLOSED_HEIGHT = 1.16;
const OPEN_HEIGHT = -1.18;

function sigilGeometry(channel: PrismChannel): THREE.BufferGeometry {
  if (channel === 2) return new THREE.RingGeometry(0.061, 0.109, 24);
  const shape = new THREE.Shape();
  if (channel === 0) {
    shape.moveTo(-0.105, 0.082);
    shape.lineTo(-0.044, 0.082);
    shape.lineTo(0, -0.007);
    shape.lineTo(0.044, 0.082);
    shape.lineTo(0.105, 0.082);
    shape.lineTo(0, -0.105);
  } else {
    for (let point = 0; point < 10; point++) {
      const angle = Math.PI / 2 + (point * Math.PI) / 5;
      const radius = point % 2 ? 0.048 : 0.116;
      const x = Math.cos(angle) * radius;
      const y = Math.sin(angle) * radius;
      if (point === 0) shape.moveTo(x, y);
      else shape.lineTo(x, y);
    }
  }
  return new THREE.ShapeGeometry(shape);
}

/** Optical controls, a wall clue and the lift-down glass gate share one persistence view. */
export class PrismAnnex {
  readonly object = new THREE.Group();
  readonly room: number;
  readonly clueRoom: number;
  readonly annexRoom: number;
  private readonly gate = new THREE.Group();
  private readonly display = new THREE.Group();
  private displayControl?: THREE.Object3D;
  private displayPrism?: THREE.Object3D;
  private displaySample = 0;
  private readonly controls: Control[] = [];
  private readonly faces: THREE.MeshBasicMaterial[] = [];
  private readonly owned: { dispose(): void }[] = [];
  private readonly releases: (() => void)[] = [];
  private readonly ray = new THREE.Raycaster();
  private readonly box = new THREE.Box3();
  private readonly point = new THREE.Vector3();
  private readonly beamDirection = new THREE.Vector3();
  private readonly order: readonly PrismChannel[];
  private readonly brass = new THREE.MeshStandardMaterial({
    color: 0xa27648,
    metalness: 0.58,
    roughness: 0.44,
  });
  private readonly walnut = new THREE.MeshStandardMaterial({ color: 0x493127, roughness: 0.63 });
  private readonly felt = new THREE.MeshStandardMaterial({
    color: 0x163f46,
    roughness: 0.82,
    metalness: 0.08,
  });
  private readonly glass = new THREE.MeshStandardMaterial({
    color: 0x8bd7df,
    emissive: 0x1d6974,
    emissiveIntensity: 0.42,
    roughness: 0.18,
    metalness: 0.2,
    transparent: true,
    opacity: 0.65,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  private readonly beamMaterial = new THREE.MeshBasicMaterial({
    color: COLORS[0],
    transparent: true,
    opacity: 0.63,
    depthWrite: false,
  });
  private readonly beam = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.028, 1), this.beamMaterial);
  private readonly prism = new THREE.Group();
  private clue?: ClockInscription;
  private orientation: PrismChannel = 0;
  private solved = false;

  static mount(
    world: FloorWorld,
    art: THREE.Object3D,
    runSeed: string,
    reducedMotion: boolean,
    props: readonly InteriorPlacement[] = [],
  ): PrismAnnex | null {
    const plan = world.plan.prismAnnex;
    if (!plan) return null;
    const door = world.rooms[plan.source.room].doors.find((d) => d.id === plan.source.door);
    const fixture = findPuzzleMount(
      world,
      [plan.source.room],
      props,
      'prism-station',
      0.84,
      1.55,
      1.4,
    );
    const clue = findPuzzleMount(world, [plan.clueRoom], props, 'prism-clue', 0.66, 0.5);
    if (!door || !fixture || !clue) return null;

    const annex = new PrismAnnex(world, plan, runSeed, reducedMotion);
    annex.object.name = 'prism-annex-fixture';
    annex.object.position.copy(fixture.center);
    annex.object.position.y = 0;
    annex.object.rotation.y = fixture.yaw;
    // All the controls and the back of the bench need to clear the wall molding.
    annex.object.translateZ(0.45);
    annex.makeStation(art);
    world.roomGroups[annex.room].add(annex.object);
    annex.registerCollider(annex.room, annex.object);
    annex.clue = new ClockInscription(
      'prism-annex-clue',
      1.25,
      'Prism Annex',
      annex.order.map((channel) => SIGILS[channel]).join('  ·  '),
      'Turn the prism. Latch each lit mark.',
    );
    annex.clue.object.position.copy(clue.wallSurface);
    annex.clue.object.rotation.y = clue.yaw;
    annex.clue.object.translateZ(0.055);
    world.roomGroups[annex.clueRoom].add(annex.clue.object);
    annex.makeGate(door);
    annex.makeDisplay(art, props);
    annex.sync({ orientation: 0, progress: 0 }, true);
    return annex;
  }

  private constructor(
    private readonly world: FloorWorld,
    plan: NonNullable<FloorWorld['plan']['prismAnnex']>,
    seed: string,
    private readonly reducedMotion: boolean,
  ) {
    this.room = plan.source.room;
    this.clueRoom = plan.clueRoom;
    this.annexRoom = plan.annexRoom;
    this.order = prismOrder(seed);
    this.owned.push(
      this.brass,
      this.walnut,
      this.felt,
      this.glass,
      this.beamMaterial,
      this.beam.geometry,
    );
  }

  private block(
    parent: THREE.Object3D,
    size: readonly [number, number, number],
    position: readonly [number, number, number],
    material = this.brass,
  ): void {
    const geometry = new THREE.BoxGeometry(...size);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(...position);
    parent.add(mesh);
    this.owned.push(geometry);
  }

  private makeStation(art: THREE.Object3D): void {
    this.block(this.object, [1.61, 0.1, 0.73], [0, 0.8, 0], this.walnut);
    this.block(this.object, [1.5, 0.025, 0.64], [0, 0.86, 0], this.felt);
    this.block(this.object, [1.53, 0.055, 0.11], [0, 0.76, 0.26]);
    this.block(this.object, [1.54, 0.035, 0.035], [0, 0.91, 0.32]);
    for (const x of [-0.69, 0.69])
      for (const z of [-0.28, 0.28]) {
        this.block(this.object, [0.095, 0.76, 0.095], [x, 0.38, z], this.walnut);
        this.block(this.object, [0.109, 0.07, 0.109], [x, 0.037, z]);
      }
    this.block(this.object, [1.38, 0.065, 0.056], [0, 0.26, -0.28], this.walnut);
    const guide = new ClockInscription(
      'prism-station-guide',
      1.28,
      'Prism Signal',
      'The order plate is in another room.',
      'Rotate, then press each lit mark to open the annex.',
    );
    guide.object.position.set(0, 1.55, -0.3);
    this.object.add(guide.object);
    this.owned.push(guide);
    this.prism.name = 'prism-turn';
    this.prism.position.set(0, 0.87, 0.08);
    this.block(this.prism, [0.31, 0.06, 0.27], [0, 0, 0]);
    const glass = art.getObjectByName('prism')?.clone(true);
    if (glass) {
      glass.position.set(0, 0.04, 0);
      glass.scale.setScalar(0.72);
      this.prism.add(glass);
    }
    this.object.add(this.prism);
    this.controls.push({ node: this.prism, action: { action: 'turn' } });
    for (const channel of CHANNELS) {
      const root = new THREE.Group();
      root.name = `prism-receiver-${channel}`;
      root.position.set((channel - 1) * 0.48, 1.19, -0.32);
      this.block(this.object, [0.065, 0.33, 0.07], [root.position.x, 0.995, -0.37]);
      const body = new THREE.Mesh(new THREE.CylinderGeometry(0.165, 0.165, 0.055, 24), this.brass);
      body.rotation.x = Math.PI / 2;
      const face = new THREE.MeshBasicMaterial({
        color: COLORS[channel],
        transparent: true,
        opacity: 0.3,
      });
      const mark = new THREE.Mesh(sigilGeometry(channel), face);
      const halo = new THREE.Mesh(
        new THREE.TorusGeometry(0.13, 0.012, 6, 24),
        new THREE.MeshBasicMaterial({ color: COLORS[channel], transparent: true, opacity: 0.72 }),
      );
      halo.rotation.x = Math.PI / 2;
      halo.position.z = 0.035;
      mark.position.z = 0.03;
      root.add(body, halo, mark);
      this.object.add(root);
      this.faces.push(face);
      this.owned.push(body.geometry, halo.geometry, mark.geometry, face, halo.material);
      this.controls.push({ node: root, action: { action: 'receiver', channel } });
    }
    this.beam.name = 'prism-light-path';
    this.object.add(this.beam);
  }

  dress(set: PbrSet, environment: THREE.Texture | null): void {
    for (const [material, slot] of [
      [this.walnut, 'walnut'],
      [this.brass, 'brass-polished'],
      [this.felt, 'stone-floor'],
      [this.glass, 'stained-glass'],
    ] as const) {
      const source = set.materials.get(slot);
      if (!source) continue;
      material.map = source.map;
      material.normalMap = source.normalMap;
      material.normalScale.setScalar(0.12);
      material.roughnessMap = source.roughnessMap;
      material.envMap = environment;
      material.envMapIntensity = material === this.brass ? 0.5 : 0.2;
      material.needsUpdate = true;
    }
  }

  private makeGate(door: FloorWorld['rooms'][number]['doors'][number]): void {
    this.gate.name = 'prism-annex-gate';
    this.gate.position.set(door.world[0], CLOSED_HEIGHT, door.world[1]);
    this.gate.rotation.y = { N: 0, E: -Math.PI / 2, S: Math.PI, W: Math.PI / 2 }[door.facing];
    this.block(this.gate, [door.width - 0.14, 2.15, 0.036], [0, 0, 0], this.glass);
    for (const side of [-1, 1]) {
      this.block(this.gate, [0.065, 2.23, 0.075], [side * (door.width / 2 - 0.05), 0, 0]);
      this.block(this.gate, [door.width - 0.1, 0.07, 0.075], [0, side * 1.08, 0]);
      this.block(this.gate, [door.width - 0.18, 0.03, 0.06], [0, side * 0.36, 0]);
    }
    this.block(this.gate, [0.035, 2.17, 0.065], [0, 0, 0]);
    this.world.roomGroups[this.room].attach(this.gate);
  }

  private makeDisplay(art: THREE.Object3D, props: readonly InteriorPlacement[]): void {
    const mount = findPuzzleMount(
      this.world,
      [this.annexRoom],
      props,
      'prism-study-display',
      0.66,
      0.9,
      1.16,
    );
    if (!mount) return;
    this.display.name = 'prism-annex-display';
    this.display.position.copy(mount.center);
    this.display.position.y = 0;
    this.display.rotation.y = mount.yaw;
    this.display.translateZ(0.33);
    this.block(this.display, [1.24, 0.69, 0.49], [0, 0.345, 0], this.walnut);
    this.block(this.display, [1.29, 0.036, 0.5], [0, 0.69, 0]);
    for (const [index, name] of ['polarizing_lens', 'prism'].entries()) {
      const instrument = art.getObjectByName(name)?.clone(true);
      if (!instrument) continue;
      instrument.position.set((index - 0.5) * 0.62, 0.71, 0);
      this.display.add(instrument);
      if (name === 'prism') this.displayPrism = instrument;
    }
    const guide = new ClockInscription(
      'prism-exhibit-control',
      0.91,
      'The Light Bench',
      'Select to turn the demonstration prism.',
      'Each angle separates a different mark.',
    );
    guide.object.position.set(0, 1.21, 0.04);
    this.display.add(guide.object);
    this.displayControl = guide.object;
    this.owned.push(guide);
    this.world.roomGroups[this.annexRoom].add(this.display);
    this.registerCollider(this.annexRoom, this.display);
  }

  private registerCollider(room: number, object: THREE.Object3D): void {
    object.updateWorldMatrix(true, true);
    const bounds = new THREE.Box3().setFromObject(object);
    this.releases.push(
      this.world.addFixtureCollider(room, { min: bounds.min.toArray(), max: bounds.max.toArray() }),
    );
  }

  cycleDisplay(): string {
    const sample = this.displaySample % SIGILS.length;
    if (this.displayPrism) this.displayPrism.rotation.y = (this.displaySample * Math.PI) / 3;
    this.displaySample++;
    return SIGILS[sample];
  }

  pick(origin: THREE.Vector3, direction: THREE.Vector3): PrismPick {
    if (this.world.current === this.annexRoom && this.displayControl) {
      this.display.updateWorldMatrix(true, true);
      this.ray.set(origin, direction);
      this.ray.far = 4;
      const hit = this.ray.intersectObject(this.displayControl, false)[0];
      return hit ? { action: 'exhibit', distance: hit.distance } : null;
    }
    if (this.solved || this.world.current !== this.room) return null;
    this.object.updateWorldMatrix(true, true);
    if (this.object.worldToLocal(this.point.copy(origin)).z < -0.35) return null;
    this.ray.set(origin, direction);
    this.ray.far = 4;
    const hit = this.ray.intersectObjects(
      this.controls.map((control) => control.node),
      true,
    )[0];
    if (!hit) return null;
    for (const box of this.world.colliders[this.room]) {
      this.box.min.fromArray(box.min);
      this.box.max.fromArray(box.max);
      if (
        !this.box.containsPoint(hit.point) &&
        this.ray.ray.intersectBox(this.box, this.point) &&
        this.point.distanceTo(origin) < hit.distance - 0.035
      )
        return null;
    }
    const control = this.controls.find(({ node }) => node.getObjectById(hit.object.id));
    return control ? { ...control.action, distance: hit.distance } : null;
  }

  near(point: THREE.Vector3, reach: number): PrismPick {
    if (this.world.current === this.annexRoom && this.displayControl) {
      const distance = this.box.setFromObject(this.displayControl).distanceToPoint(point);
      return distance <= reach ? { action: 'exhibit', distance } : null;
    }
    if (this.solved || this.world.current !== this.room) return null;
    this.object.updateWorldMatrix(true, true);
    if (this.object.worldToLocal(this.point.copy(point)).z < -0.39) return null;
    let best: PrismPick = null;
    for (const { node, action } of this.controls) {
      const distance = this.box.setFromObject(node).distanceToPoint(point);
      if (distance <= reach && (!best || distance < best.distance)) best = { ...action, distance };
    }
    return best;
  }

  sync(state: StoredPrismState, immediate = false): void {
    this.solved = state.progress === 3;
    this.orientation = state.orientation;
    const target = this.controls[this.orientation + 1].node.position;
    this.beamDirection.subVectors(target, PRISM_LIGHT);
    this.beam.position.copy(PRISM_LIGHT).addScaledVector(this.beamDirection, 0.5);
    this.beam.scale.z = this.beamDirection.length();
    this.beam.quaternion.setFromUnitVectors(FORWARD, this.beamDirection.normalize());
    this.beamMaterial.color.setHex(COLORS[this.orientation]);
    this.beam.visible = !this.solved;
    const captured = this.order.slice(0, state.progress);
    for (const channel of CHANNELS) {
      this.faces[channel].opacity = captured.includes(channel)
        ? 1
        : channel === this.orientation
          ? 0.79
          : 0.29;
    }
    if (immediate || this.reducedMotion) {
      this.gate.position.y = this.solved ? OPEN_HEIGHT : CLOSED_HEIGHT;
      this.gate.visible = !this.solved;
      this.prism.rotation.y = this.orientation * (Math.PI / 3);
    } else this.gate.visible = true;
  }

  update(dt: number): void {
    if (this.reducedMotion || !(dt > 0)) return;
    this.prism.rotation.y = THREE.MathUtils.damp(
      this.prism.rotation.y,
      this.orientation * (Math.PI / 3),
      10,
      dt,
    );
    if (this.solved && this.gate.visible) {
      this.gate.position.y = THREE.MathUtils.damp(this.gate.position.y, OPEN_HEIGHT, 8, dt);
      if (this.gate.position.y <= -1.11) this.gate.visible = false;
    }
  }

  openingPosition(target: THREE.Vector3): THREE.Vector3 {
    return this.gate.getWorldPosition(target).setY(CLOSED_HEIGHT);
  }

  dispose(): void {
    for (const release of this.releases) release();
    this.object.removeFromParent();
    this.gate.removeFromParent();
    this.display.removeFromParent();
    this.clue?.object.removeFromParent();
    this.clue?.dispose();
    for (const item of this.owned) item.dispose();
  }
}
