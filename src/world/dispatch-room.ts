import * as THREE from 'three';
import { dispatchDestination, type StoredDispatchState } from '../rules/dispatch.ts';
import { ClockInscription } from './clock-inscription.ts';
import type { FloorWorld } from './floor-world.ts';
import type { InteriorPlacement } from './interior-furnishings.ts';
import { findPuzzleMount, type PuzzleMount } from './puzzle-placement.ts';

type DispatchAction = 'turn' | 'send' | 'open';
export interface DispatchPick {
  readonly action: DispatchAction;
  readonly distance: number;
}

const CLOSED_Y = 1.1;
const OPEN_Y = -1.15;
const ROUTE_X = [-0.34, 0, 0.34] as const;
const TRAVEL_SECONDS = 0.65;

export class DispatchRoom {
  readonly object = new THREE.Group();
  private readonly reply = new THREE.Group();
  private readonly storage = new THREE.Group();
  private readonly gate = new THREE.Group();
  private readonly selectorNeedle = new THREE.Group();
  private readonly routeMarker = new THREE.Group();
  private readonly sendButton = new THREE.Group();
  private readonly replyCapsule = new THREE.Group();
  private readonly travelCapsule = new THREE.Group();
  private readonly controls: { node: THREE.Object3D; action: DispatchAction }[] = [];
  private readonly resources: { dispose(): void }[] = [];
  private readonly releases: (() => void)[] = [];
  private readonly ray = new THREE.Raycaster();
  private readonly box = new THREE.Box3();
  private readonly point = new THREE.Vector3();
  private readonly iron = new THREE.MeshStandardMaterial({
    color: 0x414c4f,
    metalness: 0.65,
    roughness: 0.48,
  });
  private readonly copper = new THREE.MeshStandardMaterial({
    color: 0x9b6947,
    metalness: 0.58,
    roughness: 0.42,
  });
  private readonly wood = new THREE.MeshStandardMaterial({ color: 0x382722, roughness: 0.61 });
  private readonly signal = new THREE.MeshBasicMaterial({ color: 0x246f7a });
  private readonly button = new THREE.MeshStandardMaterial({
    color: 0xa74336,
    metalness: 0.32,
    roughness: 0.48,
  });
  private state: StoredDispatchState = { route: 0, sent: false, opened: false };
  private travel = 0;
  private returned = false;

  static mount(
    world: FloorWorld,
    art: THREE.Object3D,
    seed: string,
    reducedMotion: boolean,
    props: readonly InteriorPlacement[] = [],
  ): DispatchRoom | null {
    const layout = world.plan.dispatchRoom;
    if (!layout) return null;
    const door = world.rooms[layout.source.room].doors.find(
      (door) => door.id === layout.source.door,
    );
    const source = findPuzzleMount(
      world,
      [layout.source.room],
      props,
      'dispatch-send',
      0.74,
      1.4,
      1.58,
    );
    const reply = findPuzzleMount(
      world,
      [layout.replyRoom],
      props,
      'dispatch-return',
      0.57,
      1.2,
      1.58,
    );
    const selector = art.getObjectByName('pipe_selector');
    const capsule = art.getObjectByName('carrier_capsule');
    if (!door || !source || !reply || !selector || !capsule) return null;
    const dispatch = new DispatchRoom(world, layout, reducedMotion);
    dispatch.buildSender(selector, capsule);
    dispatch.buildReturn(capsule, dispatchDestination(seed) + 1);
    dispatch.place(dispatch.object, source);
    dispatch.place(dispatch.reply, reply);
    dispatch.buildGate(door);
    const storage = findPuzzleMount(
      world,
      [layout.vaultRoom],
      props,
      'dispatch-storage',
      0.58,
      0.95,
      1.55,
    );
    if (storage) {
      dispatch.buildStorage(capsule);
      dispatch.place(dispatch.storage, storage);
    }
    return dispatch;
  }

  private constructor(
    private readonly world: FloorWorld,
    private readonly layout: NonNullable<FloorWorld['plan']['dispatchRoom']>,
    private readonly reducedMotion: boolean,
  ) {
    this.resources.push(this.iron, this.copper, this.wood, this.signal, this.button);
  }

  private block(
    parent: THREE.Object3D,
    dimensions: readonly [number, number, number],
    center: readonly [number, number, number],
    material: THREE.Material,
  ): void {
    const geometry = new THREE.BoxGeometry(...dimensions);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.fromArray(center);
    parent.add(mesh);
    this.resources.push(geometry);
  }

  private plate(parent: THREE.Object3D, plate: ClockInscription, y: number, z: number): void {
    plate.object.position.set(0, y, z);
    parent.add(plate.object);
    this.resources.push(plate);
  }

  private buildSender(selector: THREE.Object3D, capsule: THREE.Object3D): void {
    this.object.name = 'dispatch-room';
    this.block(this.object, [1.34, 0.81, 0.46], [0, 0.405, 0], this.wood);
    this.block(this.object, [1.42, 0.085, 0.54], [0, 0.83, 0], this.iron);
    this.block(this.object, [1.32, 0.65, 0.085], [0, 1.14, -0.19], this.iron);
    this.block(this.object, [1.32, 0.042, 0.02], [0, 0.9, -0.12], this.copper);
    const manifold = selector.clone(true);
    manifold.name = 'dispatch-selector';
    manifold.position.set(-0.22, 1.1, -0.1);
    manifold.rotation.x = Math.PI / 2;
    manifold.scale.setScalar(0.79);
    const pointer = manifold.getObjectByName('pointer');
    if (pointer) {
      this.selectorNeedle.add(pointer);
      manifold.add(this.selectorNeedle);
    }
    this.object.add(manifold);
    this.controls.push({ node: manifold, action: 'turn' });
    this.routeMarker.position.set(ROUTE_X[0], 1.36, -0.11);
    this.block(this.routeMarker, [0.195, 0.028, 0.045], [0, 0, 0], this.signal);
    this.object.add(this.routeMarker);
    this.plate(
      this.object,
      new ClockInscription(
        'dispatch-route-scale',
        1.06,
        'Pneumatic dispatch',
        '1                 2                 3',
        'Set line. Press Send.',
      ),
      1.49,
      -0.12,
    );
    this.sendButton.name = 'dispatch-send';
    this.sendButton.position.set(0.43, 0.99, -0.075);
    this.block(this.sendButton, [0.19, 0.16, 0.16], [0, 0, -0.005], this.button);
    this.block(this.sendButton, [0.11, 0.035, 0.012], [0, 0, 0.082], this.copper);
    this.object.add(this.sendButton);
    this.controls.push({ node: this.sendButton, action: 'send' });
    this.block(this.object, [0.32, 0.12, 0.25], [0.02, 0.93, 0.18], this.iron);
    this.travelCapsule.add(capsule.clone(true));
    this.travelCapsule.position.set(0.02, 1.05, 0.22);
    this.travelCapsule.rotation.z = -Math.PI / 2;
    this.travelCapsule.scale.setScalar(0.72);
    this.object.add(this.travelCapsule);
  }

  private buildReturn(capsule: THREE.Object3D, route: number): void {
    this.reply.name = 'dispatch-reply-station';
    this.block(this.reply, [1.04, 0.8, 0.43], [0, 0.4, 0], this.wood);
    this.block(this.reply, [1.14, 0.08, 0.49], [0, 0.82, 0], this.iron);
    this.block(this.reply, [1.04, 0.67, 0.09], [0, 1.14, -0.18], this.iron);
    this.block(this.reply, [0.57, 0.12, 0.29], [0, 0.9, 0.08], this.copper);
    this.plate(
      this.reply,
      new ClockInscription(
        'dispatch-routing-slip',
        1.0,
        'Return Work Order',
        `Route ${route}`,
        'Take the brass reply here.',
      ),
      1.31,
      -0.12,
    );
    this.replyCapsule.name = 'dispatch-capsule';
    this.replyCapsule.add(capsule.clone(true));
    this.replyCapsule.position.set(0, 0.96, 0.14);
    this.replyCapsule.visible = false;
    this.reply.add(this.replyCapsule);
    this.controls.push({ node: this.replyCapsule, action: 'open' });
  }

  private place(object: THREE.Group, mount: PuzzleMount): void {
    object.position.copy(mount.center).setY(0);
    object.rotation.y = mount.yaw;
    object.translateZ(0.32);
    this.world.roomGroups[mount.room].add(object);
    object.updateWorldMatrix(true, true);
    const bounds = new THREE.Box3().setFromObject(object);
    this.releases.push(
      this.world.addFixtureCollider(mount.room, {
        min: bounds.min.toArray(),
        max: bounds.max.toArray(),
      }),
    );
  }

  private buildStorage(capsule: THREE.Object3D): void {
    this.storage.name = 'dispatch-vault-storage';
    this.block(this.storage, [1.13, 1.05, 0.41], [0, 0.525, 0], this.wood);
    this.block(this.storage, [1.16, 0.07, 0.46], [0, 1.05, 0], this.iron);
    this.block(this.storage, [1.09, 0.066, 0.016], [0, 0.92, 0.21], this.copper);
    this.plate(
      this.storage,
      new ClockInscription(
        'dispatch-vault-plate',
        0.97,
        'Dispatch Vault',
        'Clockwork Spire',
        'Pneumatic carriers',
      ),
      1.42,
      -0.19,
    );
    for (const position of [-0.32, 0, 0.32]) {
      const spare = capsule.clone(true);
      spare.position.set(position, 1.085, 0.07);
      spare.rotation.y = Math.PI / 4;
      this.storage.add(spare);
    }
  }

  private buildGate(door: FloorWorld['rooms'][number]['doors'][number]): void {
    this.gate.name = 'dispatch-vault-shutter';
    this.gate.position.set(door.world[0], CLOSED_Y, door.world[1]);
    this.gate.rotation.y = { N: 0, E: -Math.PI / 2, S: Math.PI, W: Math.PI / 2 }[door.facing];
    this.block(this.gate, [door.width - 0.036, 2.2, 0.085], [0, 0, 0], this.iron);
    for (const side of [-1, 1]) {
      this.block(this.gate, [0.1, 2.2, 0.13], [side * (door.width / 2 - 0.075), 0, 0], this.copper);
      this.block(this.gate, [door.width - 0.08, 0.08, 0.11], [0, side * 1.04, 0], this.copper);
    }
    for (let rib = -3; rib <= 3; rib++) {
      this.block(this.gate, [door.width - 0.17, 0.054, 0.13], [0, rib * 0.27, 0], this.iron);
    }
    this.world.roomGroups[this.layout.source.room].attach(this.gate);
  }

  private availableControl(action: DispatchAction): boolean {
    return action === 'open'
      ? this.world.current === this.layout.replyRoom && this.state.sent && !this.state.opened
      : this.world.current === this.layout.source.room && !this.state.sent;
  }

  pick(origin: THREE.Vector3, direction: THREE.Vector3): DispatchPick | null {
    const ready = this.controls.filter(
      ({ node, action }) =>
        this.availableControl(action) &&
        !!node.parent &&
        node.parent.worldToLocal(this.point.copy(origin)).z >= -0.28,
    );
    if (!ready.length) return null;
    this.ray.set(origin, direction);
    this.ray.far = 4;
    const [hit] = this.ray.intersectObjects(
      ready.map(({ node }) => node),
      true,
    );
    if (!hit) return null;
    for (const wall of this.world.colliders[this.world.current]) {
      this.box.min.fromArray(wall.min);
      this.box.max.fromArray(wall.max);
      if (
        !this.box.containsPoint(hit.point) &&
        this.ray.ray.intersectBox(this.box, this.point) &&
        this.point.distanceTo(origin) < hit.distance - 0.035
      )
        return null;
    }
    const control = ready.find(({ node }) => node.getObjectById(hit.object.id));
    return control ? { action: control.action, distance: hit.distance } : null;
  }

  near(hand: THREE.Vector3, reach: number): DispatchPick | null {
    let nearest: DispatchPick | null = null;
    for (const { node, action } of this.controls) {
      if (!this.availableControl(action)) continue;
      const distance = this.box.setFromObject(node).distanceToPoint(hand);
      if (distance <= reach && (!nearest || distance < nearest.distance))
        nearest = { action, distance };
    }
    return nearest;
  }

  sendFeedback(returned: boolean): void {
    this.returned = returned;
    this.travel = TRAVEL_SECONDS;
    this.signal.color.setHex(returned ? 0xc14636 : 0x8adbe5);
  }

  sync(state: StoredDispatchState, immediate = false): void {
    this.state = state;
    this.replyCapsule.visible = state.sent && !state.opened;
    if (immediate || this.reducedMotion) {
      this.routeMarker.position.x = ROUTE_X[state.route];
      this.selectorNeedle.rotation.y = -state.route * (Math.PI / 2);
      this.gate.position.y = state.opened ? OPEN_Y : CLOSED_Y;
      this.gate.visible = !state.opened;
      this.travelCapsule.visible = !state.sent;
    }
  }

  openingPosition(target: THREE.Vector3): THREE.Vector3 {
    return this.gate.getWorldPosition(target).setY(CLOSED_Y);
  }

  update(dt: number): void {
    if (!(dt > 0)) return;
    if (!this.reducedMotion) {
      this.routeMarker.position.x = THREE.MathUtils.damp(
        this.routeMarker.position.x,
        ROUTE_X[this.state.route],
        14,
        dt,
      );
      this.selectorNeedle.rotation.y = THREE.MathUtils.damp(
        this.selectorNeedle.rotation.y,
        -this.state.route * (Math.PI / 2),
        14,
        dt,
      );
      if (this.state.opened && this.gate.visible) {
        this.gate.position.y = THREE.MathUtils.damp(this.gate.position.y, OPEN_Y, 9, dt);
        if (this.gate.position.y < -1.09) this.gate.visible = false;
      }
    }
    if (this.travel <= 0) return;
    this.travel = Math.max(0, this.travel - dt);
    if (!this.reducedMotion) {
      const fraction = 1 - this.travel / TRAVEL_SECONDS;
      this.sendButton.position.z = -0.075 - 0.055 * Math.sin(Math.PI * Math.min(fraction * 2, 1));
      this.travelCapsule.visible = this.returned || this.travel > 0;
      const distance = this.returned ? Math.sin(fraction * Math.PI) : fraction;
      this.travelCapsule.position.set(0.02, 1.05 + distance * 0.1, 0.22 - distance * 0.4);
    }
    if (this.travel === 0) this.signal.color.setHex(this.state.sent ? 0x55968d : 0x246f7a);
  }

  dispose(): void {
    for (const release of this.releases) release();
    this.object.removeFromParent();
    this.reply.removeFromParent();
    this.storage.removeFromParent();
    this.gate.removeFromParent();
    for (const resource of this.resources) resource.dispose();
  }
}
