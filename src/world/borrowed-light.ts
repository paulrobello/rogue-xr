import * as THREE from 'three';
import {
  BORROWED_MIRRORS,
  BORROWED_RECEIVER,
  BORROWED_SCREEN,
  type BorrowedLightControl,
  type BorrowedLightState,
  type BorrowedLightTrace,
  readBorrowedLight,
  traceBorrowedLight,
  traceBorrowedLightNormals,
} from '../rules/borrowed-light.ts';
import { ClockInscription } from './clock-inscription.ts';
import { DOOR_HEIGHT, type FloorWorld } from './floor-world.ts';
import type { PbrSet } from './materials.ts';

type Layout = NonNullable<FloorWorld['plan']['borrowedLight']>;
type Pick = { readonly action: BorrowedLightControl; readonly distance: number };
type Resource = { dispose(): void };
type Mirror = {
  readonly glass: THREE.Group;
  readonly from: THREE.Quaternion;
  readonly to: THREE.Quaternion;
  readonly index: THREE.Mesh;
};

const FORWARD = new THREE.Vector3(0, 0, 1);
const UP = new THREE.Vector3(0, 1, 0);
const FACING = { N: 0, E: -Math.PI / 2, S: Math.PI, W: Math.PI / 2 } as const;
const TURN_SECONDS = 0.23;
const SLIDE_SECONDS = 1.05;

function floorStencil(): THREE.Texture | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = 768;
  canvas.height = 512;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.save();
  ctx.translate(384, 256);
  ctx.scale(1, 0.69);
  const spill = ctx.createRadialGradient(0, 0, 61, 0, 0, 368);
  spill.addColorStop(0, 'rgba(119,208,227,0.72)');
  spill.addColorStop(0.75, 'rgba(77,176,207,0.50)');
  spill.addColorStop(1, 'rgba(51,132,172,0)');
  ctx.fillStyle = spill;
  ctx.fillRect(-384, -370, 768, 740);
  ctx.strokeStyle = '#bbf1ed';
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.ellipse(0, 0, 295, 225, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
  ctx.fillStyle = '#f6ffe7';
  ctx.strokeStyle = '#193845';
  ctx.lineWidth = 4;
  ctx.font = '700 47px Georgia, serif';
  ctx.textAlign = 'center';
  ctx.strokeText('THE WAY IS OPEN', 384, 207);
  ctx.fillText('THE WAY IS OPEN', 384, 207);
  ctx.lineWidth = 9;
  ctx.strokeStyle = '#d5fff7';
  ctx.beginPath();
  ctx.arc(345, 312, 25, 0, Math.PI * 2);
  ctx.moveTo(370, 312);
  ctx.lineTo(452, 312);
  ctx.lineTo(452, 335);
  ctx.moveTo(425, 312);
  ctx.lineTo(425, 328);
  ctx.stroke();
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

export class BorrowedLight {
  readonly object = new THREE.Group();
  readonly gate = new THREE.Group();
  private readonly leaf = new THREE.Group();
  private readonly resources: Resource[] = [];
  private readonly remove: (() => void)[] = [];
  private readonly controls: THREE.Mesh[] = [];
  private readonly controlActions: BorrowedLightControl[] = [];
  private readonly brass = new THREE.MeshStandardMaterial({
    color: 0xb68b48,
    metalness: 0.64,
    roughness: 0.39,
  });
  private readonly dark = new THREE.MeshStandardMaterial({
    color: new THREE.Color().setRGB(0.16, 0.14, 0.12),
    metalness: 0.34,
    roughness: 0.64,
  });
  private readonly stone = new THREE.MeshStandardMaterial({
    color: new THREE.Color().setRGB(0.46, 0.42, 0.35),
    roughness: 0.88,
  });
  private readonly silver = new THREE.MeshStandardMaterial({
    color: 0x8ab9bd,
    metalness: 0.85,
    roughness: 0.19,
    side: THREE.DoubleSide,
  });
  private readonly ray = new THREE.Raycaster();
  private readonly plane = new THREE.Box3();
  private readonly crossing = new THREE.Vector3();
  private readonly at = new THREE.Vector3();
  private readonly low = new THREE.Vector3();
  private readonly high = new THREE.Vector3();
  private readonly delta = new THREE.Vector3();
  private readonly normals = [new THREE.Vector3(), new THREE.Vector3()] as const;
  private readonly mirrors: readonly [Mirror, Mirror];
  private readonly beams: THREE.Mesh[];
  private readonly tipLight: THREE.Mesh;
  private readonly projected: THREE.Mesh;
  private state: BorrowedLightState;
  private slide = 0;
  private aimAge = TURN_SECONDS;

  constructor(
    private readonly world: FloorWorld,
    readonly layout: Layout,
    private readonly seed: string,
    private readonly reducedMotion: boolean,
    art?: THREE.Object3D,
    environment?: THREE.Texture | null,
  ) {
    this.state = readBorrowedLight({ seed });
    this.object.name = 'borrowed-light-station';
    this.gate.name = 'borrowed-light-gate';
    this.leaf.name = 'borrowed-light-stone-leaf';
    this.resources.push(this.brass, this.dark, this.stone, this.silver);
    this.silver.envMap = environment ?? null;
    this.silver.envMapIntensity = 0.75;
    this.brass.envMap = environment ?? null;
    this.brass.envMapIntensity = 0.36;
    world.roomGroups[layout.opticsRoom].add(this.object);
    this.buildScreen();
    this.mirrors = [this.buildMirror(0, art), this.buildMirror(1, art)];
    this.buildReceiver();
    const reset = this.inscription(
      'borrowed-light-reset',
      0.75,
      'Borrowed Light',
      'Aim I, then II at the floor seal',
      'Select here to reset',
    );
    reset.position.set(0.68, 0.9, 2.455);
    this.box(
      'borrowed-light-instruction-stand',
      this.object,
      [0.27, 0.81, 0.22],
      [0.68, 0.405, 2.31],
      this.dark,
    );
    this.controls.push(reset);
    this.controlActions.push('reset');
    this.collider({ min: [0.52, 0, 2.2], max: [0.84, 0.81, 2.44] });

    const light = new THREE.MeshBasicMaterial({
      color: 0x9ee9f8,
      transparent: true,
      opacity: 0.54,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
      side: THREE.DoubleSide,
    });
    const beam = new THREE.CylinderGeometry(1, 1, 1, 6, 1, true);
    const tip = new THREE.SphereGeometry(0.035, 8, 5);
    this.resources.push(light, beam, tip);
    this.beams = [0, 1, 2].map((index) => {
      const mesh = new THREE.Mesh(beam, light);
      mesh.name = `borrowed-light-beam-${index}`;
      this.object.add(mesh);
      return mesh;
    });
    this.tipLight = new THREE.Mesh(tip, light);
    this.tipLight.name = 'borrowed-light-ray-end';
    this.object.add(this.tipLight);
    const map = floorStencil();
    const projectedGeometry = new THREE.PlaneGeometry(1.47, 1.03);
    const projectedMaterial = new THREE.MeshBasicMaterial({
      map,
      color: map ? 0xffffff : 0x99e2e8,
      transparent: true,
      opacity: 0.94,
      depthWrite: false,
      toneMapped: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
    });
    this.resources.push(projectedGeometry, projectedMaterial);
    if (map) this.resources.push(map);
    this.projected = new THREE.Mesh(projectedGeometry, projectedMaterial);
    this.projected.name = 'borrowed-light-floor-message';
    this.projected.position.fromArray(BORROWED_RECEIVER).addScaledVector(UP, 0.009);
    this.projected.rotation.x = -Math.PI / 2;
    this.object.add(this.projected);
    this.buildGate();
    this.sync(this.state, true);
  }

  private box(
    name: string,
    parent: THREE.Object3D,
    size: readonly [number, number, number],
    at: readonly [number, number, number],
    material: THREE.Material,
  ): THREE.Mesh {
    const geometry = new THREE.BoxGeometry(...size);
    this.resources.push(geometry);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = name;
    mesh.position.fromArray(at);
    parent.add(mesh);
    return mesh;
  }

  private collider(box: {
    min: readonly [number, number, number];
    max: readonly [number, number, number];
  }): void {
    this.object.updateWorldMatrix(true, false);
    const bounds = new THREE.Box3(
      new THREE.Vector3(...box.min),
      new THREE.Vector3(...box.max),
    ).applyMatrix4(this.object.matrixWorld);
    this.remove.push(
      this.world.addFixtureCollider(this.layout.opticsRoom, {
        min: bounds.min.toArray(),
        max: bounds.max.toArray(),
      }),
    );
  }

  private buildScreen(): void {
    const { min, max } = BORROWED_SCREEN;
    const masonry = new THREE.Group();
    masonry.name = 'borrowed-light-stone-screen';
    this.object.add(masonry);
    const centre = [(max[0] + min[0]) / 2, (max[2] + min[2]) / 2] as const;
    const depth = max[2] - min[2],
      width = max[0] - min[0];
    this.box(
      'borrowed-light-screen-body',
      masonry,
      [width - 0.016, max[1] - 0.08, depth - 0.016],
      [centre[0], (max[1] - 0.08) / 2, centre[1]],
      this.stone,
    );
    this.box(
      'borrowed-light-screen-foot',
      masonry,
      [width, 0.14, depth],
      [centre[0], 0.07, centre[1]],
      this.dark,
    );
    this.box(
      'borrowed-light-coping',
      masonry,
      [width, 0.08, depth],
      [centre[0], max[1] - 0.04, centre[1]],
      this.dark,
    );
    for (const y of [0.41, 0.74, 1.07])
      this.box(
        'borrowed-light-mortar-joint',
        masonry,
        [width, 0.014, depth],
        [centre[0], y, centre[1]],
        this.dark,
      );
    this.collider(BORROWED_SCREEN);
  }

  dress(set: PbrSet, environment: THREE.Texture | null): void {
    for (const [material, slot] of [
      [this.brass, 'brass-polished'],
      [this.dark, 'brass-aged'],
      [this.stone, 'stone-floor'],
      [this.silver, 'stained-glass'],
    ] as const) {
      const source = set.materials.get(slot);
      if (!source) continue;
      material.map = source.map;
      material.normalMap = source.normalMap;
      material.normalScale.setScalar(0.12);
      material.roughnessMap = source.roughnessMap;
      material.envMap = environment;
      material.envMapIntensity = material === this.brass || material === this.silver ? 0.55 : 0.18;
      material.needsUpdate = true;
    }
  }

  private inscription(
    name: string,
    width: number,
    title: string,
    first: string,
    second: string,
  ): THREE.Mesh {
    const sign = new ClockInscription(name, width, title, first, second);
    this.resources.push(sign);
    this.object.add(sign.object);
    return sign.object;
  }

  private buildMirror(id: 0 | 1, art?: THREE.Object3D): Mirror {
    const [x, y, z] = BORROWED_MIRRORS[id];
    const glass = new THREE.Group();
    glass.name = `borrowed-light-mirror-${id}`;
    glass.position.set(x, y, z);
    const shape = new THREE.CircleGeometry(0.237, 32);
    const face = new THREE.Mesh(shape, this.silver);
    face.name = `borrowed-light-mirror-face-${id}`;
    face.position.z = 0.016;
    const frame = new THREE.TorusGeometry(0.248, 0.025, 8, 32);
    const rim = new THREE.Mesh(frame, this.brass);
    rim.name = `borrowed-light-mirror-rim-${id}`;
    glass.add(rim, face);
    this.resources.push(shape, frame);
    const model = art?.getObjectByName('mirror_gimbal')?.clone(true);
    if (model) {
      model.rotation.x = Math.PI / 2;
      model.position.z = -0.31;
      model.scale.setScalar(1.68);
      glass.add(model);
    }
    this.object.add(glass);
    this.box(
      `borrowed-light-mirror-base-${id}`,
      this.object,
      [0.57, 0.16, 0.57],
      [x, 0.08, z],
      this.stone,
    );
    this.box(
      `borrowed-light-mirror-stand-${id}`,
      this.object,
      [0.23, y - 0.21, 0.23],
      [x, (y - 0.21) / 2, z],
      this.dark,
    );
    this.box(
      `borrowed-light-mirror-collar-${id}`,
      this.object,
      [0.31, 0.085, 0.31],
      [x, y - 0.255, z],
      this.brass,
    );
    const pick = this.inscription(
      `borrowed-light-turn-${id}`,
      0.47,
      id === 0 ? 'Mirror I' : 'Mirror II',
      'Select to turn',
      '',
    );
    pick.position.set(x, y - 0.48, z + 0.288);
    this.controls.push(face, rim, pick);
    this.controlActions.push(id, id, id);
    this.box(
      `borrowed-light-detent-dial-${id}`,
      this.object,
      [0.17, 0.17, 0.032],
      [x, y - 0.24, z + 0.203],
      this.dark,
    );
    const pointer = this.box(
      `borrowed-light-pointer-${id}`,
      this.object,
      [0.037, 0.125, 0.026],
      [x, y - 0.24, z + 0.229],
      this.brass,
    );
    this.collider({ min: [x - 0.285, 0, z - 0.285], max: [x + 0.285, y + 0.235, z + 0.285] });
    return { glass, from: new THREE.Quaternion(), to: new THREE.Quaternion(), index: pointer };
  }

  private buildReceiver(): void {
    const receiver = new THREE.Group();
    receiver.name = 'borrowed-light-receiver';
    receiver.position.fromArray(BORROWED_RECEIVER);
    const ring = new THREE.TorusGeometry(0.556, 0.018, 6, 40);
    const collar = new THREE.Mesh(ring, this.brass);
    collar.rotation.x = -Math.PI / 2;
    receiver.add(collar);
    this.object.add(receiver);
    this.resources.push(ring);
  }

  private buildGate(): void {
    const door = this.world.rooms[this.layout.gate.room].doors.find(
      (d) => d.id === this.layout.gate.door,
    );
    if (!door) throw Error('Borrowed Light recess doorway missing');
    this.gate.position.set(door.world[0], 0, door.world[1]);
    this.gate.rotation.y = FACING[door.facing];
    const w = door.width,
      h = DOOR_HEIGHT;
    this.box(
      'borrowed-light-recess-stone',
      this.leaf,
      [w - 0.044, h - 0.035, 0.148],
      [0, h / 2 - 0.014, 0],
      this.stone,
    );
    for (const y of [0.25, h - 0.28]) {
      this.box(
        'borrowed-light-recess-band',
        this.leaf,
        [w - 0.11, 0.09, 0.167],
        [0, y, 0],
        this.brass,
      );
    }
    this.box(
      'borrowed-light-recess-keymark',
      this.leaf,
      [0.19, 0.19, 0.179],
      [0, 1.27, 0],
      this.brass,
    ).rotation.z = Math.PI / 4;
    this.gate.add(this.leaf);
    this.world.roomGroups[this.layout.gate.room].attach(this.gate);
  }

  sync(state: BorrowedLightState, immediate = false): void {
    if (
      !immediate &&
      this.state.detents[0] === state.detents[0] &&
      this.state.detents[1] === state.detents[1] &&
      this.state.open === state.open
    )
      return;
    this.state = state;
    const trace = traceBorrowedLight(this.seed, state.detents);
    this.aimAge = immediate || this.reducedMotion ? TURN_SECONDS : 0;
    for (const id of [0, 1] as const) {
      const mirror = this.mirrors[id];
      mirror.from.copy(mirror.glass.quaternion);
      mirror.to.setFromUnitVectors(FORWARD, this.at.fromArray(trace.normals[id]));
      mirror.index.rotation.z = (-Math.PI * state.detents[id]) / 2;
    }
    this.aim();
    if (state.open && (immediate || this.reducedMotion)) {
      this.slide = 1;
      this.slideGate();
    }
  }

  update(dt: number): void {
    if (this.aimAge < TURN_SECONDS) {
      this.aimAge = Math.min(TURN_SECONDS, this.aimAge + dt);
      this.aim();
    }
    if (this.state.open && this.slide < 1) {
      this.slide = Math.min(1, this.slide + dt / SLIDE_SECONDS);
      this.slideGate();
    }
  }

  private aim(): void {
    const t = THREE.MathUtils.smoothstep(this.aimAge, 0, TURN_SECONDS);
    for (const id of [0, 1] as const) {
      const { glass, from, to } = this.mirrors[id];
      glass.quaternion.slerpQuaternions(from, to, t);
      this.normals[id].copy(FORWARD).applyQuaternion(glass.quaternion);
    }
    this.drawBeam(
      traceBorrowedLightNormals([this.normals[0].toArray(), this.normals[1].toArray()]),
    );
  }

  private drawBeam(trace: BorrowedLightTrace): void {
    for (const [i, beam] of this.beams.entries()) {
      const end = trace.points[i + 1];
      beam.visible = end !== undefined;
      if (!end) continue;
      this.low.fromArray(trace.points[i]);
      this.high.fromArray(end);
      this.delta.subVectors(this.high, this.low);
      beam.scale.set(0.017, this.delta.length(), 0.017);
      beam.quaternion.setFromUnitVectors(UP, this.delta.normalize());
      beam.position.copy(this.low).lerp(this.high, 0.5);
    }
    this.tipLight.position.fromArray(trace.points[trace.points.length - 1]);
    this.projected.visible = this.state.open && trace.reachesReceiver;
  }

  private slideGate(): void {
    this.leaf.position.y = -(DOOR_HEIGHT + 0.024) * THREE.MathUtils.smoothstep(this.slide, 0, 1);
    this.leaf.visible = this.slide < 1;
    if (this.slide === 1) this.world.setPuzzleGateOpen('borrowed-light', true, true);
  }

  pick(origin: THREE.Vector3, direction: THREE.Vector3): Pick | null {
    if (this.world.current !== this.layout.opticsRoom) return null;
    this.object.updateWorldMatrix(true, true);
    this.ray.set(origin, direction);
    this.ray.far = 4.1;
    const [hit] = this.ray.intersectObjects(this.controls, false);
    if (!hit) return null;
    const blocked = this.world.colliders[this.layout.opticsRoom].some((box) => {
      this.plane.min.fromArray(box.min);
      this.plane.max.fromArray(box.max);
      return (
        !this.plane.containsPoint(hit.point) &&
        this.ray.ray.intersectBox(this.plane, this.crossing) !== null &&
        this.crossing.distanceTo(origin) < hit.distance - 0.028
      );
    });
    return blocked
      ? null
      : {
          action: this.controlActions[this.controls.indexOf(hit.object as THREE.Mesh)],
          distance: hit.distance,
        };
  }

  near(position: THREE.Vector3, reach: number): Pick | null {
    if (this.world.current !== this.layout.opticsRoom) return null;
    let closest: Pick | null = null;
    this.controls.forEach((control, i) => {
      const distance = control.getWorldPosition(this.at).distanceTo(position);
      if (distance <= reach && (!closest || distance < closest.distance))
        closest = { action: this.controlActions[i], distance };
    });
    return closest;
  }

  receiverPosition(out: THREE.Vector3): THREE.Vector3 {
    return this.object.localToWorld(out.fromArray(BORROWED_RECEIVER));
  }

  gatePosition(out: THREE.Vector3): THREE.Vector3 {
    return this.gate.localToWorld(out.set(0, 0.98, 0.04));
  }

  dispose(): void {
    this.object.removeFromParent();
    this.gate.removeFromParent();
    for (const release of this.remove) release();
    for (const resource of this.resources) resource.dispose();
  }
}
