import * as THREE from 'three';
import { CanvasLabel } from '../combat-view/canvas-label.ts';
import {
  MAX_SPRING_TENSION,
  readSpringTension,
  type SpringTensionControl,
  type SpringTensionState,
  springTensionWindow,
} from '../rules/spring-tension.ts';
import { ClockInscription } from './clock-inscription.ts';
import { DOOR_HEIGHT, type FloorWorld } from './floor-world.ts';
import type { InteriorPlacement } from './interior-furnishings.ts';
import { findPuzzleMount } from './puzzle-placement.ts';

const GATE_YAW = { N: 0, E: -Math.PI / 2, S: Math.PI, W: Math.PI / 2 };
const DIAL_RADIUS = 0.248;
const WIND_SECONDS = 0.26;
const TEST_SECONDS = 0.57;
export const SPRING_GATE_SECONDS = 1.08;
const angleFor = (tension: number): number =>
  ((208 - (236 * tension) / MAX_SPRING_TENSION) * Math.PI) / 180;

type Layout = NonNullable<FloorWorld['plan']['springTension']>;
type Pick = { readonly action: SpringTensionControl; readonly distance: number };

export class SpringTension {
  readonly object = new THREE.Group();
  readonly gate = new THREE.Group();
  readonly leaf = new THREE.Group();
  readonly range: ReturnType<typeof springTensionWindow>;
  private readonly parts: { dispose(): void }[] = [];
  private readonly targets = new Map<THREE.Mesh, SpringTensionControl>();
  private readonly cast = new THREE.Raycaster();
  private readonly bounds = new THREE.Box3();
  private readonly at = new THREE.Vector3();
  private readonly removeFixture: () => void;
  private readonly key = new THREE.Group();
  private readonly needle = new THREE.Group();
  private readonly clutch = new THREE.Group();
  private readonly controlPoints: Record<SpringTensionControl, THREE.Object3D>;
  private readonly brass = this.keep(
    new THREE.MeshStandardMaterial({
      color: 0xbd9257,
      metalness: 0.56,
      roughness: 0.39,
    }),
  );
  private readonly iron = this.keep(
    new THREE.MeshStandardMaterial({
      color: 0x474b48,
      metalness: 0.6,
      roughness: 0.5,
    }),
  );
  private readonly stone = this.keep(
    new THREE.MeshStandardMaterial({
      color: new THREE.Color().setRGB(0.33, 0.35, 0.33),
      roughness: 0.89,
    }),
  );
  private readonly contrast = this.keep(
    new THREE.MeshBasicMaterial({ color: 0x452921, toneMapped: false }),
  );
  private readonly hitMaterial = this.keep(new THREE.MeshBasicMaterial({ visible: false }));
  private state: SpringTensionState = readSpringTension({});
  private shown = 0;
  private from = 0;
  private windAge = WIND_SECONDS;
  private testAge = TEST_SECONDS;
  private shallow = false;
  private gateAge = 0;

  constructor(
    private readonly world: FloorWorld,
    readonly layout: Layout,
    seed: string,
    private readonly reduced: boolean,
    art?: THREE.Object3D,
    environment?: THREE.Texture | null,
    furnishings: readonly InteriorPlacement[] = [],
  ) {
    this.range = springTensionWindow(seed);
    this.brass.envMap = environment ?? null;
    this.brass.envMapIntensity = 0.67;
    this.object.name = 'spring-tension-station';
    this.gate.name = 'spring-tension-gate';
    this.leaf.name = 'spring-tension-portcullis';
    this.key.name = 'spring-tension-key';
    this.needle.name = 'spring-tension-needle';
    this.clutch.name = 'spring-tension-clutch-arm';
    const parent = world.roomGroups[layout.workshop];
    const mount = findPuzzleMount(
      world,
      [layout.workshop],
      furnishings,
      'spring-tension',
      0.96,
      1.18,
      2.0,
    );
    if (mount) {
      this.object.position.copy(mount.wallSurface).setY(0);
      this.object.rotation.y = mount.yaw;
    } else this.object.position.set(2.1, 0, -2.3);
    parent.add(this.object);
    this.buildCabinet();
    this.buildGauge(art);
    this.controlPoints = this.buildControls(art);
    this.buildGate();
    this.object.updateWorldMatrix(true, false);
    const footprint = new THREE.Box3(
      new THREE.Vector3(-0.69, 0, 0.035),
      new THREE.Vector3(0.69, 1.84, 0.414),
    ).applyMatrix4(this.object.matrixWorld);
    this.removeFixture = world.addFixtureCollider(layout.workshop, {
      min: footprint.min.toArray(),
      max: footprint.max.toArray(),
    });
    this.draw();
  }

  get released(): boolean {
    return this.state.open && this.gateAge >= SPRING_GATE_SECONDS;
  }

  get winding(): boolean {
    return this.windAge < WIND_SECONDS;
  }

  private keep<T extends { dispose(): void }>(resource: T): T {
    this.parts.push(resource);
    return resource;
  }

  private mesh(
    name: string,
    parent: THREE.Object3D,
    geometry: THREE.BufferGeometry,
    position: readonly [number, number, number],
    material = this.brass as THREE.Material,
  ): THREE.Mesh {
    const mesh = new THREE.Mesh(this.keep(geometry), material);
    mesh.name = name;
    mesh.position.fromArray(position);
    parent.add(mesh);
    return mesh;
  }

  private box(
    name: string,
    parent: THREE.Object3D,
    size: readonly [number, number, number],
    position: readonly [number, number, number],
    material?: THREE.Material,
  ): THREE.Mesh {
    return this.mesh(name, parent, new THREE.BoxGeometry(...size), position, material);
  }

  private engraving(
    name: string,
    width: number,
    position: readonly [number, number, number],
    title: string,
    line1: string,
    line2: string,
  ): THREE.Mesh {
    const label = this.keep(new ClockInscription(name, width, title, line1, line2));
    label.object.position.fromArray(position);
    this.object.add(label.object);
    return label.object;
  }

  private buildCabinet(): void {
    this.box('spring-stone-foot', this.object, [1.33, 0.12, 0.4], [0, 0.06, 0.231], this.stone);
    for (const x of [-0.55, 0.55]) {
      this.box('spring-stone-post', this.object, [0.21, 0.93, 0.32], [x, 0.545, 0.207], this.stone);
      this.box(
        'spring-post-collar',
        this.object,
        [0.238, 0.055, 0.346],
        [x, 0.27, 0.207],
        this.iron,
      );
    }
    this.box('spring-worktop', this.object, [1.45, 0.13, 0.44], [0, 0.985, 0.235], this.stone);
    this.box(
      'spring-instrument-back',
      this.object,
      [1.29, 0.67, 0.092],
      [0, 1.355, 0.179],
      this.iron,
    );
    this.box('spring-instrument-sill', this.object, [1.35, 0.048, 0.17], [0, 1.073, 0.244]);
    this.engraving(
      'spring-tension-instructions',
      1.36,
      [0, 1.93, 0.282],
      'Spring Tension',
      'Wind to the engraved interval.',
      'Pull the clutch while the needle is inside.',
    );
  }

  private buildGauge(art: THREE.Object3D | undefined): void {
    const gauge = new THREE.Group();
    gauge.name = 'spring-tension-gauge';
    gauge.position.set(-0.15, 1.45, 0.3);
    this.object.add(gauge);
    const original = art?.getObjectByName('tension_gauge')?.clone(true);
    if (original) {
      original.getObjectByName('needle')?.removeFromParent();
      original.name = 'spring-authored-gauge';
      original.rotation.x = Math.PI / 2;
      original.scale.setScalar(2.12);
      gauge.add(original);
    } else {
      const housing = this.mesh(
        'spring-gauge-housing',
        gauge,
        new THREE.CylinderGeometry(0.285, 0.285, 0.14, 32),
        [0, 0, 0.08],
        this.iron,
      );
      housing.rotation.x = Math.PI / 2;
    }
    this.mesh(
      'spring-gauge-rim',
      gauge,
      new THREE.TorusGeometry(0.26, 0.012, 8, 36),
      [0, 0, 0.178],
    );
    if (typeof document !== 'undefined' && document.createElement('canvas').getContext('2d')) {
      const dial = this.keep(new CanvasLabel(620, 620, DIAL_RADIUS * 2));
      dial.mesh.name = 'spring-tension-dial-print';
      dial.mesh.position.z = 0.183;
      dial.draw((ctx, width) => {
        const c = width / 2;
        ctx.fillStyle = '#eadcba';
        ctx.beginPath();
        ctx.arc(c, c, c - 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#926033';
        ctx.lineWidth = 13;
        ctx.beginPath();
        ctx.arc(c, c, c - 54, -angleFor(this.range.min - 0.13), -angleFor(this.range.max + 0.13));
        ctx.stroke();
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#37271b';
        ctx.strokeStyle = '#37271b';
        ctx.font = 'bold 29px Georgia';
        for (let tick = 0; tick <= MAX_SPRING_TENSION; tick++) {
          const angle = angleFor(tick);
          const radial = (radius: number): [number, number] => [
            c + radius * Math.cos(angle),
            c - radius * Math.sin(angle),
          ];
          const end = tick === this.range.min || tick === this.range.max;
          ctx.lineWidth = end ? 10 : 5;
          ctx.beginPath();
          ctx.moveTo(...radial(c - (end ? 81 : 69)));
          ctx.lineTo(...radial(c - 39));
          ctx.stroke();
          ctx.fillText(String(tick), ...radial(c - 111));
        }
        ctx.font = 'bold 31px Georgia';
        ctx.fillText('TENSION', c, c + 117);
      });
      gauge.add(dial.mesh);
    } else
      this.mesh(
        'spring-gauge-face',
        gauge,
        new THREE.CircleGeometry(DIAL_RADIUS, 32),
        [0, 0, 0.183],
        this.stone,
      );
    this.needle.position.z = 0.191;
    gauge.add(this.needle);
    const needle = new THREE.Shape();
    needle.moveTo(-0.013, -0.054);
    needle.lineTo(0.013, -0.054);
    needle.lineTo(0.009, 0.145);
    needle.lineTo(0, 0.192);
    needle.lineTo(-0.009, 0.145);
    needle.closePath();
    this.mesh(
      'spring-gauge-pointer',
      this.needle,
      new THREE.ShapeGeometry(needle),
      [0, 0, 0],
      this.contrast,
    );
    this.mesh('spring-gauge-pin', gauge, new THREE.SphereGeometry(0.019, 10, 8), [0, 0, 0.204]);
  }

  private buildControls(
    art: THREE.Object3D | undefined,
  ): Record<SpringTensionControl, THREE.Object3D> {
    this.key.position.set(-0.49, 1.09, 0.436);
    this.object.add(this.key);
    const authored = art?.getObjectByName('winding_key')?.clone(true);
    if (authored) {
      authored.name = 'spring-authored-winding-key';
      authored.rotation.x = Math.PI / 2;
      authored.scale.setScalar(0.51);
      this.key.add(authored);
    } else {
      const shaft = this.mesh(
        'spring-key-shaft',
        this.key,
        new THREE.CylinderGeometry(0.025, 0.025, 0.135, 10),
        [0, 0, 0.084],
      );
      shaft.rotation.x = Math.PI / 2;
      for (const x of [-0.05, 0.05])
        this.mesh('spring-key-bow', this.key, new THREE.TorusGeometry(0.051, 0.013, 8, 14), [
          x,
          0,
          0.15,
        ]);
    }
    this.clutch.position.set(0.49, 1.11, 0.382);
    this.object.add(this.clutch);
    const arm = this.box(
      'spring-clutch-link',
      this.clutch,
      [0.039, 0.27, 0.044],
      [0, 0.108, 0.072],
      this.iron,
    );
    arm.rotation.x = 0.52;
    this.mesh(
      'spring-clutch-grip',
      this.clutch,
      new THREE.SphereGeometry(0.052, 14, 8),
      [0, 0.226, 0.142],
      this.brass,
    );
    const reset = this.box(
      'spring-reset-plunger',
      this.object,
      [0.15, 0.056, 0.085],
      [0.05, 0.984, 0.495],
    );
    const controls = [
      ['wind', [-0.49, 1.09, 0.555], [0.24, 0.19, 0.23], 'Wind', 'One mark', -0.49],
      ['release', [0.49, 1.28, 0.535], [0.19, 0.32, 0.22], 'Clutch', 'Test the catch', 0.49],
      ['reset', [0.05, 0.984, 0.537], [0.19, 0.092, 0.078], 'Reset', 'Back to zero', 0.05],
    ] as const;
    for (const [action, position, size, title, hint, x] of controls) {
      const hit = this.box(
        `spring-tension-${action}`,
        this.object,
        size,
        position,
        this.hitMaterial,
      );
      this.targets.set(hit, action);
      const plate = this.engraving(
        `spring-${action}-label`,
        action === 'reset' ? 0.26 : 0.29,
        [x, 0.824, 0.442],
        title,
        hint,
        '',
      );
      this.targets.set(plate, action);
    }
    return { wind: this.key, release: this.clutch, reset };
  }

  private buildGate(): void {
    const found = this.world.rooms[this.layout.gate.room].doors.find(
      (door) => door.id === this.layout.gate.door,
    );
    if (!found) throw Error('Missing spring workshop portcullis');
    this.gate.position.set(found.world[0], 0, found.world[1]);
    this.gate.rotation.y = GATE_YAW[found.facing];
    this.gate.add(this.leaf);
    const width = found.width - 0.068;
    for (let i = 0; i < 7; i++) {
      const x = ((i - 3) * width) / 6.75;
      this.box(
        'spring-gate-iron-bar',
        this.leaf,
        [0.062, DOOR_HEIGHT - 0.047, 0.087],
        [x, (DOOR_HEIGHT - 0.018) / 2, 0],
        this.iron,
      );
    }
    for (const y of [0.16, 0.88, DOOR_HEIGHT - 0.22]) {
      this.box('spring-gate-crossrail', this.leaf, [width, 0.12, 0.118], [0, y, 0], this.iron);
      for (const x of [-width * 0.41, 0, width * 0.41])
        this.mesh('spring-gate-rivet', this.leaf, new THREE.SphereGeometry(0.022, 8, 6), [
          x,
          y,
          0.067,
        ]);
    }
    this.box('spring-gate-latch', this.leaf, [0.26, 0.18, 0.158], [0, 1.24, 0]);
    this.world.roomGroups[this.layout.workshop].attach(this.gate);
  }

  sync(state: SpringTensionState, immediate = false): void {
    if (immediate || this.reduced) {
      this.windAge = WIND_SECONDS;
      this.gateAge = state.open ? SPRING_GATE_SECONDS : 0;
      this.shallow = false;
      this.testAge = TEST_SECONDS;
    } else {
      if (state.tension !== this.state.tension) {
        this.windAge = 0;
        this.from = this.shown;
      }
      if (!state.open || !this.state.open) this.gateAge = 0;
    }
    this.state = state;
    this.draw();
  }

  testCatch(shallow: boolean): void {
    this.shallow = shallow;
    this.testAge = 0;
    this.draw();
  }

  update(dt: number): void {
    if (
      this.windAge >= WIND_SECONDS &&
      this.testAge >= TEST_SECONDS &&
      (!this.state.open || this.released)
    )
      return;
    this.windAge = Math.min(WIND_SECONDS, this.windAge + dt);
    this.testAge = Math.min(TEST_SECONDS, this.testAge + dt);
    if (this.state.open) this.gateAge = Math.min(SPRING_GATE_SECONDS, this.gateAge + dt);
    this.draw();
  }

  private draw(): void {
    this.shown = THREE.MathUtils.lerp(
      this.from,
      this.state.tension,
      THREE.MathUtils.smoothstep(this.windAge, 0, WIND_SECONDS),
    );
    this.needle.rotation.z = angleFor(this.shown) - Math.PI / 2;
    this.key.rotation.z = -this.shown * Math.PI * 0.54;
    const testFraction = this.testAge / TEST_SECONDS;
    const attempt = this.reduced ? Number(testFraction < 1) : Math.sin(testFraction * Math.PI);
    const lift = this.state.open
      ? (DOOR_HEIGHT + 0.04) * THREE.MathUtils.smoothstep(this.gateAge, 0, SPRING_GATE_SECONDS)
      : this.shallow
        ? attempt * 0.33
        : 0;
    this.leaf.position.y = lift;
    this.leaf.visible = !this.released;
    this.clutch.rotation.x = -0.62 * (this.state.open ? 1 : attempt);
    if (this.released) this.world.setPuzzleGateOpen('spring-tension', true, true);
  }

  pick(origin: THREE.Vector3, direction: THREE.Vector3): Pick | null {
    if (this.state.open || this.world.current !== this.layout.workshop) return null;
    this.object.updateWorldMatrix(true, true);
    this.cast.set(origin, direction);
    this.cast.far = 3.85;
    const [hit] = this.cast.intersectObjects([...this.targets.keys()], false);
    if (!hit) return null;
    const action = this.targets.get(hit.object as THREE.Mesh);
    if (!action) return null;
    const blocked = this.world.colliders[this.layout.workshop].some(({ min, max }) => {
      this.bounds.min.fromArray(min);
      this.bounds.max.fromArray(max);
      return (
        this.cast.ray.intersectBox(this.bounds, this.at) !== null &&
        this.at.distanceTo(origin) < hit.distance - 0.025
      );
    });
    return blocked ? null : { action, distance: hit.distance };
  }

  near(position: THREE.Vector3, reach: number): Pick | null {
    if (this.state.open || this.world.current !== this.layout.workshop) return null;
    let picked: Pick | null = null;
    for (const [object, action] of this.targets) {
      const distance = object.getWorldPosition(this.at).distanceTo(position);
      if (distance <= reach && (!picked || distance < picked.distance))
        picked = { action, distance };
    }
    return picked;
  }

  soundPosition(action: SpringTensionControl, atGate: boolean, out: THREE.Vector3): THREE.Vector3 {
    return atGate
      ? this.gate.localToWorld(out.set(0, 1.24, 0))
      : this.controlPoints[action].getWorldPosition(out);
  }

  dispose(): void {
    this.object.removeFromParent();
    this.gate.removeFromParent();
    this.removeFixture();
    for (const part of this.parts) part.dispose();
  }
}
