import * as THREE from 'three';
import { type PipeChannel, pipeTarget, type SpeakingPipesState } from '../rules/speaking-pipes.ts';
import { ClockInscription } from './clock-inscription.ts';
import { DOOR_HEIGHT, type FloorWorld } from './floor-world.ts';
import type { InteriorPlacement } from './interior-furnishings.ts';
import type { PbrSet } from './materials.ts';
import { findPuzzleMount, type PuzzleMount } from './puzzle-placement.ts';

export type { PipeChannel, SpeakingPipesState } from '../rules/speaking-pipes.ts';

type PipeAction =
  | { readonly action: 'send' | 'replay' }
  | { readonly action: 'select'; readonly channel: PipeChannel };
export type SpeakingPipesPick = PipeAction & { readonly distance: number };

type Layout = NonNullable<FloorWorld['plan']['speakingPipes']>;
const CHANNELS = [0, 1, 2] as const;
const X = [-0.36, 0, 0.36] as const;
const CLOSED_Y = DOOR_HEIGHT / 2;
const OPEN_Y = -CLOSED_Y - 0.055;
const GAUGE_Y = 1.25;
const FACING = { N: 0, E: -Math.PI / 2, S: Math.PI, W: Math.PI / 2 } as const;

export class SpeakingPipes {
  readonly object = new THREE.Group();
  readonly receiver = new THREE.Group();
  private readonly cistern = new THREE.Group();
  private readonly gate = new THREE.Group();
  private readonly controls: { node: THREE.Object3D; pick: PipeAction; room: number }[] = [];
  private readonly resources: { dispose(): void }[] = [];
  private readonly releases: (() => void)[] = [];
  private readonly ray = new THREE.Raycaster();
  private readonly box = new THREE.Box3();
  private readonly point = new THREE.Vector3();
  private readonly copper = new THREE.MeshStandardMaterial({
    color: 0xa06e4d,
    metalness: 0.58,
    roughness: 0.36,
  });
  private readonly iron = new THREE.MeshStandardMaterial({
    color: 0x494547,
    metalness: 0.62,
    roughness: 0.5,
  });
  private readonly stone = new THREE.MeshStandardMaterial({ color: 0x635b4e, roughness: 0.84 });
  private readonly water = new THREE.ShaderMaterial({
    uniforms: { elapsed: { value: 0 } },
    vertexShader: `
      varying vec2 waterUv;
      void main() {
        waterUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      uniform float elapsed;
      varying vec2 waterUv;
      void main() {
        vec2 center = waterUv - vec2(0.5, 0.5);
        float swirl = sin(center.x * 10.0 + center.y * 20.0 - elapsed * 0.8);
        float wave = sin(center.y * 82.0 + center.x * 13.0 + swirl * 1.8 + elapsed * 1.2);
        float glint = smoothstep(0.63, 0.98, wave) * max(0.0, 1.0 - length(center * vec2(1.3, 2.4)));
        vec3 color = mix(vec3(0.032, 0.058, 0.069), vec3(0.09, 0.13, 0.15), waterUv.y);
        gl_FragColor = vec4(color + glint * vec3(0.069, 0.078, 0.08), 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  private readonly gauge = new THREE.MeshStandardMaterial({
    color: 0xedb954,
    emissive: 0x744319,
    emissiveIntensity: 0.45,
  });
  private readonly button = new THREE.MeshStandardMaterial({
    color: 0x903228,
    metalness: 0.3,
    roughness: 0.47,
  });
  private readonly rejectMaterial = new THREE.MeshBasicMaterial({ color: 0xd46e46 });
  private readonly gaugeNeedle = new THREE.Group();
  private receiverLabel?: ClockInscription;
  private releasedLabel?: ClockInscription;
  private readonly rejectMarks: THREE.Mesh[] = [];
  private pulseTime = 0;
  private rejectTime = 0;
  private state: SpeakingPipesState = 'idle';
  private readonly target: PipeChannel;

  static mount(
    world: FloorWorld,
    art: THREE.Object3D | undefined,
    seed: string,
    reducedMotion: boolean,
    props: readonly InteriorPlacement[] = [],
  ): SpeakingPipes | null {
    const layout = world.plan.speakingPipes;
    if (!layout) return null;
    const source = findPuzzleMount(
      world,
      [layout.source.room],
      props,
      'speaking-pipes-sender',
      0.57,
      0.92,
      1.48,
    );
    const receiver = findPuzzleMount(
      world,
      [layout.receiverRoom],
      props,
      'speaking-pipes-receiver',
      0.64,
      1.12,
      1.62,
    );
    const door = world.rooms[layout.source.room]?.doors.find(
      (candidate) => candidate.id === layout.source.door,
    );
    if (!source || !receiver || !door) return null;
    const pipes = new SpeakingPipes(world, layout, seed, reducedMotion);
    pipes.buildSender(source, art);
    pipes.buildReceiver(receiver, art);
    const basin = findPuzzleMount(
      world,
      [layout.cisternRoom],
      props,
      'speaking-pipes-cistern',
      0.92,
      1.05,
      1.5,
    );
    if (basin) pipes.buildCistern(basin);
    pipes.buildGate(door);
    pipes.sync('idle', true);
    return pipes;
  }

  private constructor(
    private readonly world: FloorWorld,
    private readonly layout: Layout,
    seed: string,
    private readonly reducedMotion: boolean,
  ) {
    this.target = pipeTarget(seed);
    this.resources.push(
      this.copper,
      this.iron,
      this.stone,
      this.water,
      this.gauge,
      this.button,
      this.rejectMaterial,
    );
    this.object.name = 'speaking-pipes-sender';
    this.receiver.name = 'speaking-pipes-receiver';
    this.cistern.name = 'speaking-pipes-cistern';
  }

  private mesh(
    parent: THREE.Object3D,
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    name: string,
  ): THREE.Mesh {
    this.resources.push(geometry);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = name;
    parent.add(mesh);
    return mesh;
  }

  private block(
    parent: THREE.Object3D,
    size: readonly [number, number, number],
    at: readonly [number, number, number],
    material: THREE.Material,
    name: string,
  ): THREE.Mesh {
    const mesh = this.mesh(parent, new THREE.BoxGeometry(...size), material, name);
    mesh.position.fromArray(at);
    return mesh;
  }

  private place(root: THREE.Group, mount: PuzzleMount, depth: number): void {
    root.position.copy(mount.wallSurface).setY(0);
    root.rotation.y = mount.yaw;
    root.translateZ(depth);
    this.world.roomGroups[mount.room].add(root);
    root.updateWorldMatrix(true, true);
    const bounds = this.box.setFromObject(root);
    this.releases.push(
      this.world.addFixtureCollider(mount.room, {
        min: bounds.min.toArray(),
        max: bounds.max.toArray(),
      }),
    );
  }

  private label(parent: THREE.Object3D, label: ClockInscription, y: number): void {
    label.object.position.set(0, y, -0.055);
    parent.add(label.object);
    this.resources.push(label);
  }

  private buildSender(mount: PuzzleMount, art: THREE.Object3D | undefined): void {
    this.block(
      this.object,
      [1.06, 0.82, 0.43],
      [0, 0.41, 0],
      this.stone,
      'speaking-pipes-sender-stand',
    );
    this.block(
      this.object,
      [1.12, 0.065, 0.48],
      [0, 0.85, 0],
      this.iron,
      'speaking-pipes-sender-deck',
    );
    for (const x of [-0.49, 0.49]) {
      this.block(
        this.object,
        [0.07, 0.7, 0.04],
        [x, 0.46, -0.235],
        this.copper,
        'speaking-pipes-sender-frame',
      );
    }
    this.buildWallLine(this.object, 'speaking-pipes-transmitter-line');
    const authored = art?.getObjectByName('pipe_selector')?.clone(true);
    if (authored) {
      authored.name = 'speaking-pipes-selector';
      authored.position.set(-0.23, 0.93, 0.01);
      authored.scale.setScalar(0.72);
      this.object.add(authored);
    }
    this.label(
      this.object,
      new ClockInscription(
        'speaking-pipes-transmitter-label',
        1.03,
        'Speaking Pipes',
        'Press Send to sound the line',
        'Follow the tone to the receiver.',
      ),
      1.44,
    );
    const send = this.block(
      this.object,
      [0.25, 0.17, 0.15],
      [0.28, 1.01, -0.03],
      this.button,
      'speaking-pipes-send',
    );
    this.addPushButton(this.object, send, 'SEND');
    this.controls.push({ node: send, pick: { action: 'send' }, room: mount.room });
    this.place(this.object, mount, 0.34);
  }

  private buildReceiver(mount: PuzzleMount, art: THREE.Object3D | undefined): void {
    this.block(
      this.receiver,
      [1.18, 0.79, 0.43],
      [0, 0.395, 0],
      this.stone,
      'speaking-pipes-receiver-stand',
    );
    this.block(
      this.receiver,
      [1.24, 0.065, 0.48],
      [0, 0.82, 0],
      this.iron,
      'speaking-pipes-receiver-deck',
    );
    for (const x of [-0.55, 0.55]) {
      this.block(
        this.receiver,
        [0.07, 0.7, 0.04],
        [x, 0.46, -0.235],
        this.copper,
        'speaking-pipes-receiver-frame',
      );
    }
    this.buildWallLine(this.receiver, 'speaking-pipes-receiver-line');
    this.block(
      this.receiver,
      [1.15, 0.78, 0.085],
      [0, 1.21, -0.12],
      this.iron,
      'speaking-pipes-gauge-board',
    );
    const chime = art?.getObjectByName('whistle_chime')?.clone(true);
    if (chime) {
      chime.name = 'speaking-pipes-whistle';
      chime.position.set(-0.45, 0.87, 0.09);
      chime.scale.setScalar(0.44);
      this.receiver.add(chime);
    }
    this.receiverLabel = new ClockInscription(
      'speaking-pipes-receiver-label',
      1.2,
      'Pipe Receiver',
      'LOW              MID              HIGH',
      'Replay the tone. Choose its raised mark.',
    );
    this.releasedLabel = new ClockInscription(
      'speaking-pipes-released-label',
      1.2,
      'Grille Released',
      'Return to the transmitter for the open grille.',
      '',
    );
    this.label(this.receiver, this.receiverLabel, 1.5);
    this.label(this.receiver, this.releasedLabel, 1.5);
    this.block(
      this.receiver,
      [0.87, 0.025, 0.065],
      [0, 1.215, -0.04],
      this.copper,
      'speaking-pipes-gauge-rail',
    );
    this.gaugeNeedle.name = 'speaking-pipes-gauge-needle';
    this.gaugeNeedle.position.set(X[this.target], GAUGE_Y, 0.004);
    this.block(
      this.gaugeNeedle,
      [0.06, 0.08, 0.045],
      [0, 0, 0],
      this.gauge,
      'speaking-pipes-raised-marker',
    );
    this.receiver.add(this.gaugeNeedle);
    const sides = [3, 4, 16] as const;
    for (const channel of CHANNELS) {
      const knob = this.mesh(
        this.receiver,
        new THREE.CylinderGeometry(0.072, 0.083, 0.075, sides[channel]),
        this.copper,
        `speaking-pipes-select-${channel}`,
      );
      knob.rotation.x = Math.PI / 2;
      knob.position.set(X[channel], 1.09, -0.027);
      const reject = this.block(
        this.receiver,
        [0.1, 0.019, 0.021],
        [X[channel], 0.978, -0.045],
        this.rejectMaterial,
        `speaking-pipes-reject-${channel}`,
      );
      reject.visible = false;
      this.rejectMarks.push(reject);
      this.controls.push({ node: knob, pick: { action: 'select', channel }, room: mount.room });
    }
    const replay = this.block(
      this.receiver,
      [0.21, 0.105, 0.1],
      [0, 0.913, 0.107],
      this.button,
      'speaking-pipes-replay',
    );
    this.addPushButton(this.receiver, replay, 'REPLAY');
    this.controls.push({ node: replay, pick: { action: 'replay' }, room: mount.room });
    this.place(this.receiver, mount, 0.34);
  }

  private addPushButton(parent: THREE.Object3D, housing: THREE.Mesh, label: string): void {
    housing.material = this.iron;
    housing.scale.set(0.67, 0.7, 0.78);
    const collar = this.mesh(
      housing,
      new THREE.TorusGeometry(0.068, 0.011, 8, 20),
      this.copper,
      `speaking-pipes-${label.toLowerCase()}-rim`,
    );
    collar.position.z = 0.077;
    const plunger = this.mesh(
      housing,
      new THREE.CylinderGeometry(0.055, 0.062, 0.045, 12),
      this.button,
      `speaking-pipes-${label.toLowerCase()}-plunger`,
    );
    plunger.rotation.x = Math.PI / 2;
    plunger.position.z = 0.087;
    const caption = new ClockInscription(
      `speaking-pipes-button-label-${label.toLowerCase()}`,
      0.28,
      label,
      '',
      '',
    );
    caption.object.position.set(
      housing.position.x,
      housing.position.y + 0.16,
      housing.position.z + 0.057,
    );
    parent.add(caption.object);
    this.resources.push(caption);
  }

  private buildWallLine(parent: THREE.Object3D, name: string): void {
    const line = new THREE.Group();
    line.name = name;
    const pipe = this.mesh(
      line,
      new THREE.CylinderGeometry(0.026, 0.026, 0.64, 12),
      this.copper,
      `${name}-pipe`,
    );
    pipe.position.set(0, 0.62, -0.255);
    pipe.rotation.z = Math.PI / 2;
    for (const x of [-0.31, 0.31]) {
      this.block(line, [0.075, 0.12, 0.075], [x, 0.62, -0.255], this.iron, `${name}-bracket`);
      const collar = this.mesh(
        line,
        new THREE.CylinderGeometry(0.046, 0.046, 0.045, 12),
        this.iron,
        `${name}-collar`,
      );
      collar.position.set(x, 0.62, -0.255);
      collar.rotation.z = Math.PI / 2;
    }
    parent.add(line);
  }

  private buildCistern(mount: PuzzleMount): void {
    const basin = new THREE.Group();
    basin.name = 'cistern-service-basin';
    this.block(basin, [1.64, 0.22, 0.66], [0, 0.11, 0], this.stone, 'cistern-basin-floor');
    this.block(basin, [1.42, 0.045, 0.045], [0, 0.23, -0.31], this.iron, 'cistern-basin-drain');
    for (const side of [-1, 1]) {
      this.block(
        basin,
        [0.09, 0.16, 0.74],
        [side * 0.81, 0.27, 0],
        this.copper,
        'cistern-basin-side',
      );
      this.block(
        basin,
        [1.53, 0.16, 0.09],
        [0, 0.27, side * 0.322],
        this.copper,
        'cistern-basin-lip',
      );
    }
    const water = this.mesh(
      basin,
      new THREE.PlaneGeometry(1.529, 0.553),
      this.water,
      'cistern-water-sheen',
    );
    water.rotation.x = -Math.PI / 2;
    water.position.y = 0.308;
    this.cistern.add(basin);
    this.label(
      this.cistern,
      new ClockInscription(
        'cistern-service-label',
        1.1,
        'Service Cistern',
        'Water collects below the pressure lines.',
        'The coffer is the reward for matching the tone.',
      ),
      1.48,
    );
    const pipes = new THREE.Group();
    pipes.name = 'cistern-plumbing';
    for (const x of [-0.57, 0.57]) {
      const feeder = this.mesh(
        pipes,
        new THREE.CylinderGeometry(0.047, 0.047, 0.84, 10),
        this.copper,
        'cistern-feed-pipe',
      );
      feeder.position.set(x, 0.86, -0.22);
      const collar = this.mesh(
        pipes,
        new THREE.CylinderGeometry(0.073, 0.073, 0.059, 10),
        this.iron,
        'cistern-fitting',
      );
      collar.position.set(x, 0.54, -0.22);
      this.block(pipes, [0.16, 0.085, 0.25], [x, 1.04, -0.308], this.iron, 'cistern-wall-bracket');
      this.block(pipes, [0.17, 0.17, 0.045], [x, 1.04, -0.422], this.iron, 'cistern-wall-plate');
      const outlet = this.mesh(
        pipes,
        new THREE.CylinderGeometry(0.033, 0.047, 0.12, 12),
        this.copper,
        'cistern-outlet',
      );
      outlet.position.set(x, 0.394, -0.22);
      const cap = this.mesh(
        pipes,
        new THREE.CylinderGeometry(0.06, 0.06, 0.035, 12),
        this.iron,
        'cistern-capped-outlet',
      );
      cap.position.set(x, 0.318, -0.22);
    }
    this.block(pipes, [1.34, 0.06, 0.06], [0, 0.62, -0.22], this.iron, 'cistern-pipe-support');
    this.block(pipes, [1.32, 0.075, 0.08], [0, 1.25, -0.22], this.copper, 'cistern-manifold');
    this.cistern.add(pipes);
    this.place(this.cistern, mount, 0.41);
  }

  private buildGate(door: FloorWorld['rooms'][number]['doors'][number]): void {
    this.gate.name = 'speaking-pipes-door-gate';
    this.gate.position.set(door.world[0], CLOSED_Y, door.world[1]);
    this.gate.rotation.y = FACING[door.facing];
    const width = door.width - 0.042;
    const railHeight = 0.075;
    for (const side of [-1, 1]) {
      this.block(
        this.gate,
        [0.068, DOOR_HEIGHT, 0.09],
        [side * (width / 2 - 0.034), 0, 0],
        this.copper,
        'cistern-gate-jamb',
      );
      this.block(
        this.gate,
        [width, railHeight, 0.09],
        [0, side * (CLOSED_Y - railHeight / 2), 0],
        this.copper,
        'cistern-gate-rail',
      );
    }
    for (let i = -3; i <= 3; i++) {
      this.block(
        this.gate,
        [0.054, DOOR_HEIGHT - 0.12, 0.075],
        [(i * width) / 8, 0, 0],
        this.iron,
        'cistern-gate-bar',
      );
    }
    this.block(this.gate, [width, 0.065, 0.09], [0, 0, 0], this.copper, 'cistern-gate-crossbar');
    this.world.roomGroups[this.layout.source.room].attach(this.gate);
  }

  dress(set: PbrSet, environment: THREE.Texture | null = null): void {
    for (const [material, slot] of [
      [this.copper, 'brass-aged'],
      [this.iron, 'brass-aged'],
      [this.stone, 'stone-floor'],
      [this.gauge, 'brass-polished'],
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

  private active({ pick, room }: { pick: PipeAction; room: number }): boolean {
    return (
      this.world.current === room &&
      (pick.action === 'send' ? this.state !== 'open' : this.state === 'primed')
    );
  }

  private inFront(node: THREE.Object3D, point: THREE.Vector3): boolean {
    return !!node.parent && node.parent.worldToLocal(this.point.copy(point)).z >= -0.045;
  }

  pick(origin: THREE.Vector3, direction: THREE.Vector3): SpeakingPipesPick | null {
    const ready = this.controls.filter(
      (control) => this.active(control) && this.inFront(control.node, origin),
    );
    this.ray.set(origin, direction);
    this.ray.far = 4;
    const [hit] = this.ray.intersectObjects(
      ready.map(({ node }) => node),
      true,
    );
    if (!hit) return null;
    for (const wall of this.world.colliders[this.world.current] ?? []) {
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
    return control ? { ...control.pick, distance: hit.distance } : null;
  }

  near(hand: THREE.Vector3, reach: number): SpeakingPipesPick | null {
    let nearest: SpeakingPipesPick | null = null;
    for (const control of this.controls) {
      if (!this.active(control) || !this.inFront(control.node, hand)) continue;
      const distance = this.box.setFromObject(control.node).distanceToPoint(hand);
      if (distance <= reach && (!nearest || distance < nearest.distance))
        nearest = { ...control.pick, distance };
    }
    return nearest;
  }

  sync(state: SpeakingPipesState, immediate = false): void {
    this.state = state;
    this.gaugeNeedle.visible = state !== 'idle';
    if (this.receiverLabel) this.receiverLabel.object.visible = state !== 'open';
    if (this.releasedLabel) this.releasedLabel.object.visible = state === 'open';
    if (state === 'open') {
      this.rejectTime = 0;
      for (const mark of this.rejectMarks) mark.visible = false;
    }
    if (immediate || this.reducedMotion)
      this.gate.position.y = state === 'open' ? OPEN_Y : CLOSED_Y;
    this.gate.visible = this.gate.position.y > -CLOSED_Y;
  }

  pulse(): void {
    this.pulseTime = 0.38;
  }

  reject(channel: PipeChannel): void {
    for (const mark of this.rejectMarks) mark.visible = false;
    this.rejectMarks[channel].visible = true;
    this.rejectTime = 0.42;
  }

  update(dt: number): void {
    if (!(dt > 0)) return;
    if (!this.reducedMotion) {
      this.gate.position.y = THREE.MathUtils.damp(
        this.gate.position.y,
        this.state === 'open' ? OPEN_Y : CLOSED_Y,
        9,
        dt,
      );
      this.gate.visible = this.gate.position.y > -CLOSED_Y;
      const raised =
        this.pulseTime > 0 ? Math.abs(Math.sin((0.38 - this.pulseTime) * 26)) * 0.028 : 0;
      this.gaugeNeedle.position.y = GAUGE_Y + raised;
      if (this.world.current === this.layout.cisternRoom) this.water.uniforms.elapsed.value += dt;
    }
    this.pulseTime = Math.max(0, this.pulseTime - dt);
    if (this.rejectTime > 0) {
      this.rejectTime -= dt;
      if (this.rejectTime <= 0) for (const mark of this.rejectMarks) mark.visible = false;
    }
  }

  signalPosition(out: THREE.Vector3): THREE.Vector3 {
    return this.receiver.getWorldPosition(out).add(new THREE.Vector3(0, 1.1, 0));
  }

  senderPosition(out: THREE.Vector3): THREE.Vector3 {
    return this.object.getWorldPosition(out).add(new THREE.Vector3(0, 1.01, 0));
  }

  openingPosition(out: THREE.Vector3): THREE.Vector3 {
    return this.gate.getWorldPosition(out).setY(CLOSED_Y);
  }

  dispose(): void {
    for (const release of this.releases) release();
    this.object.removeFromParent();
    this.receiver.removeFromParent();
    this.cistern.removeFromParent();
    this.gate.removeFromParent();
    for (const resource of this.resources) resource.dispose();
  }
}
