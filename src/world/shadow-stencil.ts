import * as THREE from 'three';
import { CanvasLabel } from '../combat-view/canvas-label.ts';
import {
  readShadowStencil,
  type ShadowStencilControl,
  type ShadowStencilDetent,
  type ShadowStencilState,
  type ShadowStencilTile,
  shadowStencilTarget,
} from '../rules/shadow-stencil.ts';
import type { FloorWorld } from './floor-world.ts';
import type { InteriorPlacement } from './interior-furnishings.ts';
import type { Coffer } from './loot.ts';
import { findPuzzleMount } from './puzzle-placement.ts';

const DETENTS: readonly ShadowStencilDetent[] = [0, 1, 2, 3, 4];
const TILES: readonly ShadowStencilTile[] = [0, 1, 2];
const NAMES = ['Triangle', 'Square', 'Circle'] as const;
const SIDES = [3, 4, 28] as const;
const LAMP = { y: 1.45, z: 0.19 };
const SHUTTER_Z = 0.55;
const FLOOR_Y = 0.015;
const FRAME_Z = 2.58;
const FRAME_WIDTH = 0.98;
const FRAME_DEPTH = 0.62;
const DETENT_STEP = 0.036;
const CREST_RADIUS = 0.174;
const PROJECT_SCALE = (FRAME_Z - LAMP.z) / (SHUTTER_Z - LAMP.z);
const SHUTTER_Y = LAMP.y - (LAMP.y - FLOOR_Y) / PROJECT_SCALE;
export const STENCIL_SLIDE_SECONDS = 0.38;
export const STENCIL_RELEASE_SECONDS = 0.78;

interface Pick {
  readonly action: ShadowStencilControl;
  readonly distance: number;
}

function crest(tile: ShadowStencilTile, radius: number): THREE.Vector2[] {
  const count = SIDES[tile];
  const phase = tile === 1 ? Math.PI / 4 : Math.PI / 2;
  return Array.from({ length: count }, (_, i) => {
    const angle = phase + (Math.PI * 2 * i) / count;
    return new THREE.Vector2(radius * Math.cos(angle), radius * Math.sin(angle));
  });
}

function plate(width: number, height: number): THREE.Shape {
  return new THREE.Shape([
    new THREE.Vector2(-width / 2, -height / 2),
    new THREE.Vector2(width / 2, -height / 2),
    new THREE.Vector2(width / 2, height / 2),
    new THREE.Vector2(-width / 2, height / 2),
  ]);
}

function castPatch(width: number, depth: number): THREE.BufferGeometry {
  const corners = [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ];
  const positions: number[] = [];
  const colors: number[] = [];
  for (const [inset, opacity] of [
    [0, 0],
    [0.035, 1],
  ]) {
    for (const [x, z] of corners) {
      positions.push(x * (width / 2 - inset), 0, z * (depth / 2 - inset));
      colors.push(1, 1, 1, opacity);
    }
  }
  const indices = [4, 6, 5, 4, 7, 6];
  for (let edge = 0; edge < 4; edge++) {
    const next = (edge + 1) % 4;
    indices.push(edge, next + 4, next, edge, edge + 4, next + 4);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 4));
  geometry.setIndex(indices);
  return geometry;
}

export class ShadowStencil {
  readonly object = new THREE.Group();
  readonly room: number;
  readonly target: ReturnType<typeof shadowStencilTarget>;
  private readonly slider = new THREE.Group();
  private readonly cast = new THREE.Group();
  private readonly crestShadow: THREE.Mesh;
  private readonly tileCaps: readonly THREE.Group[];
  private readonly targets = new Map<THREE.Mesh, ShadowStencilControl>();
  private readonly resources: { dispose(): void }[] = [];
  private readonly removeCollider: () => void;
  private readonly ray = new THREE.Raycaster();
  private readonly box = new THREE.Box3();
  private readonly at = new THREE.Vector3();
  private state: ShadowStencilState = readShadowStencil({});
  private shown = 0;
  private from = 0;
  private age = STENCIL_SLIDE_SECONDS;
  private releaseAge = 0;

  private readonly brass = this.keep(
    new THREE.MeshStandardMaterial({
      color: 0xbe9655,
      metalness: 0.6,
      roughness: 0.36,
    }),
  );
  private readonly iron = this.keep(
    new THREE.MeshStandardMaterial({
      color: 0x332e28,
      metalness: 0.64,
      roughness: 0.49,
    }),
  );
  private readonly stone = this.keep(
    new THREE.MeshStandardMaterial({ color: 0x736956, roughness: 0.93 }),
  );
  private readonly bright = this.keep(
    new THREE.MeshBasicMaterial({ color: 0xffdf9a, toneMapped: false }),
  );
  private readonly dark = this.keep(
    new THREE.MeshBasicMaterial({ color: 0x49352b, toneMapped: false }),
  );

  static mount(
    world: FloorWorld,
    seed: string,
    reduced: boolean,
    art?: THREE.Object3D,
    environment?: THREE.Texture | null,
    furnishings: readonly InteriorPlacement[] = [],
  ): ShadowStencil | null {
    const room = world.plan.shadowStencil?.room;
    if (room === undefined) return null;
    const coffer = world.coffers.find((entry) => entry.room === room);
    return coffer
      ? new ShadowStencil(world, room, coffer, seed, reduced, art, environment, furnishings)
      : null;
  }

  private constructor(
    private readonly world: FloorWorld,
    room: number,
    private readonly coffer: Coffer,
    seed: string,
    private readonly reduced: boolean,
    art: THREE.Object3D | undefined,
    environment: THREE.Texture | null | undefined,
    furnishings: readonly InteriorPlacement[],
  ) {
    this.room = room;
    this.target = shadowStencilTarget(seed);
    this.brass.envMap = environment ?? null;
    this.brass.envMapIntensity = 0.56;
    this.object.name = 'shadow-stencil-station';
    this.slider.name = 'shadow-stencil-slider';
    const parent = world.roomGroups[room];
    const mount = findPuzzleMount(world, [room], furnishings, 'shadow-stencil', 1.52, 4.14, 2.0);
    if (mount) {
      this.object.position.copy(mount.wallSurface).setY(0);
      this.object.rotation.y = mount.yaw;
    } else this.pinFreestanding(parent);
    parent.add(this.object);
    this.buildLamp(art);
    this.crestShadow = this.buildReceiver();
    this.tileCaps = TILES.map((tile) => this.makeTile(tile));
    const bounds = new THREE.Box3(
      new THREE.Vector3(-0.58, 0, 0.025),
      new THREE.Vector3(0.58, 1.23, 0.41),
    );
    this.object.updateWorldMatrix(true, false);
    bounds.applyMatrix4(this.object.matrixWorld);
    this.removeCollider = world.addFixtureCollider(room, {
      min: bounds.min.toArray(),
      max: bounds.max.toArray(),
    });
    this.draw();
  }

  get aligned(): boolean {
    return (
      this.age >= STENCIL_SLIDE_SECONDS &&
      this.state.detent === this.target.detent &&
      (this.state.pitch ?? 0) === this.target.pitch
    );
  }

  get released(): boolean {
    return this.state.opened && this.releaseAge >= STENCIL_RELEASE_SECONDS;
  }

  private keep<T extends { dispose(): void }>(resource: T): T {
    this.resources.push(resource);
    return resource;
  }

  private pinFreestanding(parent: THREE.Group): void {
    parent.updateWorldMatrix(true, false);
    for (const x of [2.1, -2.1, 0]) {
      const span = new THREE.Box3(
        new THREE.Vector3(x - 1.45, 0.03, -2.8),
        new THREE.Vector3(x + 1.45, 1.87, 1.13),
      ).applyMatrix4(parent.matrixWorld);
      const blocked = this.world.colliders[this.room].some(({ min, max }) => {
        this.box.min.fromArray(min);
        this.box.max.fromArray(max);
        return span.intersectsBox(this.box);
      });
      if (!blocked) {
        this.object.position.set(x, 0, -2.8);
        return;
      }
    }
    this.object.position.set(0, 0, -2.6);
  }

  private mesh(
    name: string,
    parent: THREE.Object3D,
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    position: readonly [number, number, number],
  ): THREE.Mesh {
    const mesh = new THREE.Mesh(this.keep(geometry), material);
    mesh.name = name;
    mesh.position.fromArray(position);
    parent.add(mesh);
    return mesh;
  }

  private block(
    name: string,
    parent: THREE.Object3D,
    size: readonly [number, number, number],
    position: readonly [number, number, number],
    material: THREE.Material,
  ): THREE.Mesh {
    return this.mesh(name, parent, new THREE.BoxGeometry(...size), material, position);
  }

  private buildLamp(art: THREE.Object3D | undefined): void {
    const station = this.object;
    this.block('stencil-plinth-foot', station, [1.16, 0.11, 0.39], [0, 0.055, 0.219], this.stone);
    this.block('stencil-plinth', station, [0.86, 1.06, 0.34], [0, 0.61, 0.207], this.stone);
    this.block('stencil-lantern-shelf', station, [1.16, 0.14, 0.47], [0, 1.15, 0.264], this.stone);
    // A stepped brass chassis makes the optical instrument read as a machine, not a stack of boxes.
    for (const x of [-0.49, 0.49]) {
      this.block(
        'stencil-chassis-upright',
        station,
        [0.075, 0.94, 0.055],
        [x, 0.61, 0.414],
        this.brass,
      );
      for (const y of [0.18, 0.61, 1.04])
        this.mesh(
          'stencil-chassis-rivet',
          station,
          new THREE.SphereGeometry(0.027, 10, 6),
          this.bright,
          [x, y, 0.449],
        );
    }
    this.block('stencil-chassis-bridge', station, [1.08, 0.07, 0.08], [0, 1.11, 0.43], this.brass);
    const lampGlow = new THREE.PointLight(0xffc86b, 1.4, 1.8, 2);
    lampGlow.position.set(0, LAMP.y, LAMP.z + 0.08);
    station.add(lampGlow);
    const lantern = art?.getObjectByName('shutter_lantern')?.clone(true);
    if (lantern) {
      lantern.getObjectByName('shutter')?.removeFromParent();
      lantern.getObjectByName('stencil_slot')?.removeFromParent();
      lantern.name = 'stencil-authored-lantern';
      lantern.scale.setScalar(1.19);
      lantern.position.set(0, 1.235, LAMP.z);
      const source = lantern.getObjectByName('glow_core');
      if (source instanceof THREE.Mesh) source.material = this.bright;
      station.add(lantern);
    } else {
      this.mesh(
        'stencil-lantern-core',
        station,
        new THREE.CylinderGeometry(0.1, 0.1, 0.31, 16),
        this.bright,
        [0, LAMP.y, LAMP.z],
      );
      for (const y of [1.255, 1.62])
        this.mesh(
          'stencil-lantern-cap',
          station,
          new THREE.CylinderGeometry(0.16, 0.16, 0.042, 16),
          this.iron,
          [0, y, LAMP.z],
        );
    }
    station.add(this.slider);
    const aperture = plate(0.53, 0.239);
    const opening = crest(this.target.tile, CREST_RADIUS).map(({ x, y }) => {
      const ratio = (SHUTTER_Z - LAMP.z) / (FRAME_Z - y - LAMP.z);
      return new THREE.Vector2(x * ratio, LAMP.y - (LAMP.y - FLOOR_Y) * ratio - SHUTTER_Y);
    });
    aperture.holes.push(new THREE.Path(opening));
    this.mesh(
      'stencil-pierced-sheet',
      this.slider,
      new THREE.ExtrudeGeometry(aperture, {
        depth: 0.017,
        bevelEnabled: false,
      }),
      this.brass,
      [0, SHUTTER_Y, SHUTTER_Z],
    );
    this.block(
      'stencil-shutter-grip',
      this.slider,
      [0.108, 0.038, 0.054],
      [0, SHUTTER_Y + 0.071, SHUTTER_Z + 0.037],
      this.iron,
    );
    for (const y of [SHUTTER_Y - 0.133, SHUTTER_Y + 0.133]) {
      this.block(
        'stencil-fixed-track',
        station,
        [0.98, 0.024, 0.038],
        [0, y, SHUTTER_Z],
        this.iron,
      );
      for (const x of [-0.46, 0.46])
        this.block(
          'stencil-track-bracket',
          station,
          [0.056, 0.09, 0.15],
          [x, y, SHUTTER_Z - 0.046],
          this.brass,
        );
    }
    for (const detent of DETENTS) {
      const x = (detent - 2) * 0.174;
      const button = this.block(
        `stencil-detent-${detent}`,
        station,
        [0.146, 0.076, 0.071],
        [x, 1.055, 0.56],
        this.brass,
      );
      this.block('stencil-detent-notch', button, [0.011, 0.04, 0.01], [0, 0, 0.039], this.iron);
      this.targets.set(button, { kind: 'slide', detent });
    }
    for (const pitch of [0, 1, 2, 3] as const) {
      const button = this.block(
        `stencil-pitch-${pitch}`,
        station,
        [0.12, 0.05, 0.06],
        [(pitch - 1.5) * 0.16, 0.93, 0.59],
        this.iron,
      );
      this.targets.set(button, { kind: 'pitch', pitch });
    }
    if (typeof document !== 'undefined') {
      const label = this.keep(new CanvasLabel(880, 300, 1.16, false));
      label.mesh.name = 'shadow-stencil-instructions';
      label.mesh.position.set(0, 1.866, 0.18);
      label.draw((ctx, width, height) => {
        ctx.fillStyle = '#222924';
        ctx.fillRect(0, 0, width, height);
        ctx.strokeStyle = '#bc9454';
        ctx.lineWidth = 7;
        ctx.strokeRect(4, 4, width - 8, height - 8);
        ctx.textAlign = 'center';
        ctx.fillStyle = '#f4d99d';
        ctx.font = 'bold 76px Georgia';
        ctx.fillText('Shadow Stencil', width / 2, 92);
        ctx.font = '49px system-ui';
        ctx.fillText('Set shutter and lamp pitch until the shadow', width / 2, 161);
        ctx.fillText('fits the frame. Select the matching tile.', width / 2, 226);
      });
      station.add(label.mesh);
    }
  }

  private buildReceiver(): THREE.Mesh {
    this.cast.name = 'stencil-floor-projection';
    this.object.add(this.cast);
    const glow = this.keep(
      new THREE.MeshBasicMaterial({
        color: 0xffda8c,
        vertexColors: true,
        transparent: true,
        opacity: 0.71,
        depthWrite: false,
        toneMapped: false,
      }),
    );
    this.mesh(
      'stencil-light-patch',
      this.cast,
      castPatch(FRAME_WIDTH - 0.028, FRAME_DEPTH - 0.028),
      glow,
      [0, FLOOR_Y, FRAME_Z],
    );
    const shadow = this.mesh(
      'stencil-crest-shadow',
      this.cast,
      new THREE.ShapeGeometry(new THREE.Shape(crest(this.target.tile, CREST_RADIUS))),
      this.dark,
      [0, FLOOR_Y + 0.002, FRAME_Z],
    );
    shadow.rotation.x = -Math.PI / 2;
    shadow.renderOrder = 1;
    for (const side of [-1, 1]) {
      this.block(
        'stencil-registration-frame',
        this.object,
        [FRAME_WIDTH + 0.042, 0.024, 0.033],
        [0, 0.013, FRAME_Z + (side * FRAME_DEPTH) / 2],
        this.brass,
      );
      this.block(
        'stencil-registration-frame',
        this.object,
        [0.033, 0.024, FRAME_DEPTH - 0.033],
        [(side * FRAME_WIDTH) / 2, 0.013, FRAME_Z],
        this.brass,
      );
    }
    return shadow;
  }

  private makeTile(tile: ShadowStencilTile): THREE.Group {
    const base = new THREE.Group();
    base.name = `stencil-tile-base-${tile}`;
    base.position.set((tile - 1) * 0.72, 0, 3.34);
    this.object.add(base);
    this.block('stencil-tile-surround', base, [0.578, 0.033, 0.578], [0, 0.018, 0], this.iron);
    const cap = new THREE.Group();
    base.add(cap);
    const face = this.block(
      `stencil-tile-${tile}`,
      cap,
      [0.48, 0.035, 0.48],
      [0, 0.046, 0],
      this.stone,
    );
    face.userData.crest = NAMES[tile];
    this.targets.set(face, { kind: 'tile', tile });
    const emblem = this.mesh(
      'stencil-embossed-crest',
      cap,
      new THREE.ExtrudeGeometry(new THREE.Shape(crest(tile, 0.132)), {
        depth: 0.012,
        bevelEnabled: false,
      }),
      this.brass,
      [0, 0.063, 0],
    );
    emblem.rotation.x = -Math.PI / 2;
    return cap;
  }

  sync(state: ShadowStencilState, immediate = false): void {
    if (immediate || this.reduced) {
      this.age = STENCIL_SLIDE_SECONDS;
      this.releaseAge = state.opened ? STENCIL_RELEASE_SECONDS : 0;
    } else {
      if (state.detent !== this.state.detent) {
        this.from = this.shown;
        this.age = 0;
      }
      if (!state.opened || !this.state.opened) this.releaseAge = 0;
    }
    this.state = state;
    if (state.opened) this.coffer.unlock(immediate || this.reduced);
    this.draw();
  }

  update(dt: number): void {
    if (this.age >= STENCIL_SLIDE_SECONDS && (!this.state.opened || this.released)) return;
    this.age = Math.min(STENCIL_SLIDE_SECONDS, this.age + dt);
    if (this.state.opened)
      this.releaseAge = Math.min(STENCIL_RELEASE_SECONDS, this.releaseAge + dt);
    this.draw();
  }

  private draw(): void {
    this.shown = THREE.MathUtils.lerp(
      this.from,
      this.state.detent,
      THREE.MathUtils.smoothstep(this.age, 0, STENCIL_SLIDE_SECONDS),
    );
    const offset = (this.shown - this.target.detent) * DETENT_STEP;
    this.slider.position.x = offset;
    this.slider.rotation.z = ((this.state.pitch ?? 0) - this.target.pitch) * 0.035;
    this.cast.position.x = offset * PROJECT_SCALE;
    this.crestShadow.visible = this.aligned;
    const motion = THREE.MathUtils.smoothstep(this.releaseAge, 0, STENCIL_RELEASE_SECONDS);
    this.tileCaps[this.target.tile].position.y = -0.018 * motion;
  }

  pick(origin: THREE.Vector3, direction: THREE.Vector3): Pick | null {
    if (this.state.opened || this.world.current !== this.room) return null;
    this.object.updateWorldMatrix(true, true);
    this.ray.set(origin, direction);
    this.ray.far = 3.85;
    const hit = this.ray.intersectObjects([...this.targets.keys()], false)[0];
    if (!hit) return null;
    const action = this.targets.get(hit.object as THREE.Mesh);
    if (!action) return null;
    const blocked = this.world.colliders[this.room].some(({ min, max }) => {
      this.box.min.fromArray(min);
      this.box.max.fromArray(max);
      return (
        this.ray.ray.intersectBox(this.box, this.at) !== null &&
        this.at.distanceTo(origin) < hit.distance - 0.025
      );
    });
    return blocked ? null : { action, distance: hit.distance };
  }

  near(position: THREE.Vector3, reach: number): Pick | null {
    if (this.state.opened || this.world.current !== this.room) return null;
    let best: Pick | null = null;
    for (const [mesh, action] of this.targets) {
      const distance = mesh.getWorldPosition(this.at).distanceTo(position);
      if (distance <= reach && (!best || distance < best.distance)) best = { action, distance };
    }
    return best;
  }

  soundPosition(action: ShadowStencilControl, out: THREE.Vector3): THREE.Vector3 {
    if (action.kind === 'slide') return this.slider.getWorldPosition(out);
    return (
      this.coffer.object.getObjectByName('coffer-padlock') ?? this.coffer.object
    ).getWorldPosition(out);
  }

  dispose(): void {
    this.object.removeFromParent();
    this.removeCollider();
    for (const resource of this.resources) resource.dispose();
  }
}
