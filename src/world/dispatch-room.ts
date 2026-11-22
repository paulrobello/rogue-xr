import * as THREE from 'three';
import { dispatchDestination, type StoredDispatchState } from '../rules/dispatch.ts';
import { ClockInscription } from './clock-inscription.ts';
import type { FloorWorld } from './floor-world.ts';
import { DOOR_HEIGHT } from './floor-world.ts';
import type { InteriorPlacement } from './interior-furnishings.ts';
import type { PbrSet } from './materials.ts';
import { findPuzzleMount, type PuzzleMount } from './puzzle-placement.ts';

type DispatchAction = 'turn' | 'send' | 'open';
export interface DispatchPick {
  readonly action: DispatchAction;
  readonly distance: number;
}

const CLOSED_Y = DOOR_HEIGHT / 2;
const OPEN_Y = -DOOR_HEIGHT / 2 - 0.05;
const ROUTE_X = [-0.34, 0, 0.34] as const;
const TRAVEL_SECONDS = 0.65;
const SENDER_REST = 0.34;
const SENDER_BULKHEAD = -0.48;
const RECEIVER_BULKHEAD = -0.28;
const RECEIVER_REST = 0.31;

export class DispatchRoom {
  readonly object = new THREE.Group();
  readonly reply = new THREE.Group();
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
  private readonly conduit = this.copper.clone();
  private readonly wood = new THREE.MeshStandardMaterial({ color: 0xb9957f, roughness: 0.61 });
  private readonly signal = new THREE.MeshBasicMaterial({ color: 0x246f7a });
  private readonly button = new THREE.MeshStandardMaterial({
    color: 0xa74336,
    metalness: 0.32,
    roughness: 0.48,
  });
  private state: StoredDispatchState = { route: 0, sent: false, opened: false };
  private travel = 0;
  private replyTravel = 0;
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
    this.conduit.side = THREE.DoubleSide;
    this.resources.push(this.iron, this.copper, this.conduit, this.wood, this.signal, this.button);
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
    this.block(this.object, [1.16, 0.52, 0.035], [0, 0.47, -0.255], this.iron);
    for (const x of [-0.62, 0.62]) {
      this.block(this.object, [0.075, 0.7, 0.045], [x, 0.46, -0.25], this.copper);
    }
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
        'Find the return slip. Set its route, then Send.',
      ),
      1.49,
      -0.12,
    );
    this.sendButton.name = 'dispatch-send';
    this.sendButton.position.set(0.43, 0.99, -0.075);
    const plunger = new THREE.Mesh(new THREE.CylinderGeometry(0.095, 0.11, 0.12, 16), this.button);
    plunger.name = 'dispatch-send-plunger';
    plunger.rotation.x = Math.PI / 2;
    plunger.position.z = -0.005;
    this.sendButton.add(plunger);
    this.resources.push(plunger.geometry);
    const escutcheon = new THREE.Mesh(new THREE.TorusGeometry(0.115, 0.018, 8, 16), this.copper);
    escutcheon.name = 'dispatch-send-escutcheon';
    escutcheon.rotation.x = Math.PI / 2;
    escutcheon.position.z = 0.06;
    this.sendButton.add(escutcheon);
    this.resources.push(escutcheon.geometry);
    this.block(this.sendButton, [0.11, 0.035, 0.012], [0, 0, 0.082], this.copper);
    this.object.add(this.sendButton);
    this.controls.push({ node: this.sendButton, action: 'send' });
    this.block(this.object, [0.32, 0.12, 0.25], [0.02, 0.93, 0.18], this.iron);
    this.travelCapsule.add(capsule.clone(true));
    this.travelCapsule.position.set(0.02, 1.05, SENDER_REST);
    this.travelCapsule.rotation.x = Math.PI / 2;
    this.travelCapsule.scale.setScalar(0.72);
    this.object.add(this.travelCapsule);
    this.fitCarrierTube(this.object, 'dispatch-intake', 0.02, -0.36, 0.22);
  }

  private fitCarrierTube(
    parent: THREE.Group,
    name: string,
    x: number,
    back: number,
    front: number,
  ): void {
    const y = 1.05;
    const radius = 0.12;
    const trough = new THREE.CylinderGeometry(
      radius,
      radius,
      front - back,
      24,
      1,
      true,
      -Math.PI / 2 - 0.18,
      Math.PI + 0.36,
    ).rotateX(Math.PI / 2);
    const tube = new THREE.Mesh(trough, this.conduit);
    tube.name = name;
    tube.position.set(x, y, (back + front) / 2);
    parent.add(tube);
    this.resources.push(trough);

    const cuffGeometry = new THREE.CylinderGeometry(radius, radius, 0.085, 24, 1, true).rotateX(
      Math.PI / 2,
    );
    const cuff = new THREE.Mesh(cuffGeometry, this.conduit);
    cuff.position.set(x, y, back + 0.045);
    parent.add(cuff);
    this.resources.push(cuffGeometry);
    const collarGeometry = new THREE.TorusGeometry(radius, 0.016, 8, 24);
    for (const z of [back + 0.084, front - 0.035]) {
      const ring = new THREE.Mesh(collarGeometry, this.copper);
      ring.position.set(x, y, z);
      parent.add(ring);
    }
    this.resources.push(collarGeometry);
    for (const z of [back + 0.12, front - 0.09])
      this.block(parent, [0.31, 0.034, 0.053], [x, y - radius - 0.012, z], this.iron);
  }

  private buildReturn(capsule: THREE.Object3D, route: number): void {
    this.reply.name = 'dispatch-reply-station';
    this.block(this.reply, [1.04, 0.8, 0.43], [0, 0.4, 0], this.wood);
    this.block(this.reply, [1.14, 0.08, 0.49], [0, 0.82, 0], this.iron);
    this.block(this.reply, [1.04, 0.67, 0.09], [0, 1.14, -0.18], this.iron);
    this.block(this.reply, [0.57, 0.12, 0.29], [0, 0.9, 0.08], this.copper);
    this.block(this.reply, [0.88, 0.05, 0.035], [0, 0.22, -0.24], this.copper);
    for (const x of [-0.47, 0.47]) {
      this.block(this.reply, [0.07, 0.7, 0.045], [x, 0.46, -0.235], this.copper);
    }
    this.plate(
      this.reply,
      new ClockInscription(
        'dispatch-routing-slip',
        1.0,
        'Return Work Order',
        `Route ${route}`,
        'Open the hatch when the capsule returns.',
      ),
      1.31,
      -0.12,
    );
    this.replyCapsule.name = 'dispatch-capsule';
    this.replyCapsule.add(capsule.clone(true));
    this.replyCapsule.position.set(0, 1.05, RECEIVER_REST);
    this.replyCapsule.rotation.x = Math.PI / 2;
    this.replyCapsule.scale.setScalar(0.72);
    this.replyCapsule.visible = false;
    this.reply.add(this.replyCapsule);
    this.fitCarrierTube(this.reply, 'dispatch-delivery', 0, -0.36, 0.38);
    this.controls.push({ node: this.replyCapsule, action: 'open' });
  }

  private place(object: THREE.Group, mount: PuzzleMount): void {
    object.position.copy(mount.wallSurface).setY(0);
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
    this.block(this.gate, [door.width - 0.036, DOOR_HEIGHT, 0.085], [0, 0, 0], this.iron);
    for (const side of [-1, 1]) {
      this.block(
        this.gate,
        [0.1, DOOR_HEIGHT, 0.13],
        [side * (door.width / 2 - 0.075), 0, 0],
        this.copper,
      );
    }
    this.world.roomGroups[this.layout.source.room].attach(this.gate);
  }

  dress(set: PbrSet, environment: THREE.Texture | null = null): void {
    for (const [material, slot] of [
      [this.wood, 'walnut'],
      [this.iron, 'brass-aged'],
      [this.copper, 'brass-polished'],
      [this.conduit, 'brass-polished'],
      [this.button, 'brass-aged'],
    ] as const) {
      const source = set.materials.get(slot);
      if (!source) continue;
      material.map = source.map;
      material.normalMap = source.normalMap;
      material.normalScale.setScalar(0.13);
      material.roughnessMap = source.roughnessMap;
      material.envMap = environment;
      material.envMapIntensity = 0.5;
      material.needsUpdate = true;
    }
  }

  private availableControl(action: DispatchAction): boolean {
    return action === 'open'
      ? this.world.current === this.layout.replyRoom &&
          this.state.sent &&
          !this.state.opened &&
          this.replyTravel === 0
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
    if (!returned && !this.reducedMotion) {
      this.replyCapsule.visible = false;
      this.replyCapsule.position.z = RECEIVER_BULKHEAD;
      this.replyTravel = TRAVEL_SECONDS * 2;
    }
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
        if (this.gate.position.y <= -DOOR_HEIGHT / 2) this.gate.visible = false;
      }
    }
    if (this.travel > 0) {
      this.travel = Math.max(0, this.travel - dt);
      if (!this.reducedMotion) {
        const fraction = 1 - this.travel / TRAVEL_SECONDS;
        this.sendButton.position.z = -0.075 - 0.055 * Math.sin(Math.PI * Math.min(fraction * 2, 1));
        const distance = this.returned ? Math.sin(fraction * Math.PI) : fraction;
        this.travelCapsule.position.z = THREE.MathUtils.lerp(
          SENDER_REST,
          SENDER_BULKHEAD,
          distance,
        );
        this.travelCapsule.visible = this.travel > 0 || this.returned;
      }
      if (this.travel === 0) this.signal.color.setHex(this.state.sent ? 0x55968d : 0x246f7a);
    }
    if (this.replyTravel > 0) {
      this.replyTravel = Math.max(0, this.replyTravel - dt);
      const fraction = 1 - Math.min(this.replyTravel / TRAVEL_SECONDS, 1);
      this.replyCapsule.visible = fraction > 0 && this.state.sent && !this.state.opened;
      this.replyCapsule.position.z = THREE.MathUtils.lerp(
        RECEIVER_BULKHEAD,
        RECEIVER_REST,
        fraction,
      );
    }
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
