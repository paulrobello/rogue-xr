import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { kitPart } from '../world/puzzle-placement.ts';
import { EnemyAsset, type EnemyClip, type EnemyManifest } from './enemy-asset.ts';

const OWL_REST_HEIGHT = 0.98;

export class ClockworkOwlFlight {
  private readonly hover: THREE.Object3D;
  private readonly left: THREE.Object3D;
  private readonly right: THREE.Object3D;
  private readonly leftFlap: THREE.Object3D;
  private readonly rightFlap: THREE.Object3D;
  private blend = 0;
  private cycle = 0;

  constructor(object: THREE.Object3D) {
    this.hover = kitPart(object, 'OwlHover');
    this.left = kitPart(object, 'OwlWingL');
    this.right = kitPart(object, 'OwlWingR');
    this.leftFlap = kitPart(object, 'OwlWingLFlap');
    this.rightFlap = kitPart(object, 'OwlWingRFlap');
  }

  /** Own only the offsets. The mixer can leave an unchanged keyframe untouched for many frames. */
  update(dt: number, airborne: boolean): void {
    this.blend = THREE.MathUtils.clamp(this.blend + (airborne ? dt : -dt) / 0.28, 0, 1);
    if (this.blend === 0) {
      this.cycle = 0;
    } else {
      this.cycle = (this.cycle + dt * 2.8) % 1;
    }
    const phase = this.cycle * Math.PI * 2;
    const weight = THREE.MathUtils.smoothstep(this.blend, 0, 1);
    const wing = 1.1 + Math.sin(phase) * 0.58;
    this.leftFlap.rotation.z = (-wing - this.left.rotation.z) * weight;
    this.rightFlap.rotation.z = (wing - this.right.rotation.z) * weight;
    this.hover.position.y = weight * (0.21 + 0.033 * Math.cos(phase));
  }
}

/** Independent room scenery so combat movement and break-apart never carry the roost with the owl. */
export function makeOwlPerch(): { object: THREE.Group; dispose(): void } {
  const object = new THREE.Group();
  object.name = 'clockwork-owl-perch';
  const turned = (profile: readonly [number, number][], segments = 20) =>
    new THREE.LatheGeometry(
      profile.map(([r, y]) => new THREE.Vector2(r, y)),
      segments,
    );
  const bronze = new THREE.MeshStandardMaterial({
    color: 0xb28844,
    metalness: 0.62,
    roughness: 0.4,
  });
  const enamel = new THREE.MeshStandardMaterial({
    color: 0x34554e,
    metalness: 0.36,
    roughness: 0.43,
  });
  const walnut = new THREE.MeshStandardMaterial({
    color: 0x633c28,
    metalness: 0.06,
    roughness: 0.65,
  });
  const pedestal = turned([
    [0, 0],
    [0.221, 0],
    [0.236, 0.012],
    [0.236, 0.038],
    [0.223, 0.051],
    [0.195, 0.055],
    [0.177, 0.077],
    [0.122, 0.091],
    [0.093, 0.13],
    [0.076, 0.172],
    [0.066, 0.18],
    [0.06, 0.21],
    [0.044, 0.36],
    [0.035, 0.59],
    [0.043, 0.67],
    [0.06, 0.705],
    [0.057, 0.744],
    [0, 0.75],
  ]);
  object.add(new THREE.Mesh(pedestal, enamel));

  // The authored claws curve across -Z, starting 7 cm above the bird origin at the ankles.
  const barY = OWL_REST_HEIGHT - 0.025;
  const barZ = -0.058;
  const crossbar = turned([
    [0, -0.315],
    [0.048, -0.315],
    [0.058, -0.297],
    [0.058, 0.297],
    [0.048, 0.315],
    [0, 0.315],
  ])
    .rotateZ(-Math.PI / 2)
    .translate(0, barY, barZ);
  object.add(new THREE.Mesh(crossbar, walnut));
  const fittings: THREE.BufferGeometry[] = [
    turned([
      [0.231, 0.018],
      [0.239, 0.022],
      [0.239, 0.032],
      [0.231, 0.036],
    ]),
    turned([
      [0.066, 0.172],
      [0.079, 0.178],
      [0.08, 0.19],
      [0.071, 0.201],
      [0.062, 0.204],
    ]),
    turned([
      [0.056, 0.7],
      [0.066, 0.708],
      [0.066, 0.724],
      [0.058, 0.733],
    ]),
  ];
  for (const side of [-1, 1]) {
    const sweep = new THREE.CubicBezierCurve3(
      new THREE.Vector3(0, 0.733, 0),
      new THREE.Vector3(side * 0.032, 0.816, 0),
      new THREE.Vector3(side * 0.232, 0.823, barZ),
      new THREE.Vector3(side * 0.232, barY, barZ),
    );
    fittings.push(
      new THREE.TubeGeometry(sweep, 12, 0.017, 8, false),
      turned([
        [0.055, -0.016],
        [0.061, -0.014],
        [0.061, 0.014],
        [0.055, 0.016],
      ])
        .rotateZ(-Math.PI / 2)
        .translate(side * 0.232, barY, barZ),
      turned([
        [0, -0.016],
        [0.045, -0.016],
        [0.051, -0.01],
        [0.051, 0.01],
        [0.044, 0.016],
        [0, 0.016],
      ])
        .rotateZ(-Math.PI / 2)
        .translate(side * 0.311, barY, barZ),
    );
  }
  const hardware = mergeGeometries(fittings);
  for (const part of fittings) part.dispose();
  object.add(new THREE.Mesh(hardware, bronze));
  return {
    object,
    dispose() {
      object.removeFromParent();
      for (const geometry of [pedestal, crossbar, hardware]) geometry.dispose();
      for (const material of [enamel, walnut, bronze]) material.dispose();
    },
  };
}

/** The owl has rigid articulated parts and uses the same combat animation mixer as the other enemies. */
export function makeClockworkOwlAsset(art: THREE.Object3D): EnemyAsset {
  const root = new THREE.Group();
  const bird = art.clone(true);
  bird.name = 'ClockworkOwl';
  for (const name of ['OwlWingL', 'OwlWingR']) {
    const wing = kitPart(bird, name);
    const pivot = new THREE.Group();
    pivot.name = `${name}Flap`;
    pivot.position.copy(wing.position);
    wing.parent?.add(pivot);
    wing.position.set(0, 0, 0);
    pivot.add(wing);
  }
  const facing = new THREE.Group();
  facing.rotation.y = Math.PI;
  facing.add(bird);
  const flight = new THREE.Group();
  flight.name = 'OwlFlight';
  flight.position.y = OWL_REST_HEIGHT;
  const hover = new THREE.Group();
  hover.name = 'OwlHover';
  hover.add(facing);
  flight.add(hover);
  root.add(flight);
  const socketPositions = {
    'socket-hit': [0, 0.54, -0.04],
    'socket-eye': [0, 0.72, -0.14],
    'socket-weapon': [0, 0.62, -0.2],
  } as const;
  for (const [name, position] of Object.entries(socketPositions)) {
    const marker = new THREE.Object3D();
    marker.name = name;
    marker.position.set(position[0], position[1], position[2]);
    hover.add(marker);
  }
  const clips = new Map<EnemyClip, THREE.AnimationClip>();
  const spec = {} as EnemyManifest['clips'];
  for (const [name, duration, head, wing, roll] of [
    ['idle', 2.4, 0.15, 0.045, 0],
    ['attack', 0.58, -0.27, 0.83, -0.12],
    ['hit', 0.36, 0.23, -0.24, 0.19],
    ['death', 0.92, -0.65, -0.57, -1.38],
    ['frozen', 1, 0, 0, 0],
  ] as const) {
    const times = [0, duration * 0.4, duration];
    const pose = (path: string, value: number) =>
      new THREE.NumberKeyframeTrack(path, times, [0, value, name === 'death' ? value : 0]);
    clips.set(
      name,
      new THREE.AnimationClip(name, duration, [
        new THREE.NumberKeyframeTrack('OwlFlight.position[y]', times, [
          OWL_REST_HEIGHT,
          OWL_REST_HEIGHT + (name === 'attack' ? 0.09 : 0),
          name === 'death' ? 0.08 : OWL_REST_HEIGHT,
        ]),
        pose('OwlHead.rotation[y]', head),
        pose('OwlWingL.rotation[z]', wing),
        pose('OwlWingR.rotation[z]', -wing),
        pose('ClockworkOwl.rotation[z]', roll),
      ]),
    );
    spec[name] = {
      duration,
      loop: name === 'idle' || name === 'frozen' ? 'repeat' : 'once',
      events: name === 'attack' ? { impact: 0.23 } : {},
    };
  }
  const box = new THREE.Box3().setFromObject(root),
    mats = new Set<THREE.Material>();
  let tris = 0;
  root.traverse((n) => {
    if (n instanceof THREE.Mesh) {
      for (const m of Array.isArray(n.material) ? n.material : [n.material]) mats.add(m);
      tris += (n.geometry.index?.count ?? n.geometry.attributes.position.count) / 3;
    }
  });
  const manifest: EnemyManifest = {
    id: 'clockwork-owl',
    version: 1,
    glb: 'alchemy-kit.glb',
    root: bird.name,
    mesh: bird.name,
    frame: { units: 'meters', up: '+Y', forward: '-Z', origin: 'feet' },
    bounds: { min: box.min.toArray(), max: box.max.toArray() },
    skeleton: { root: bird.name, bones: 0, joints: [], maxInfluences: 0 },
    rootMotion: 'none',
    clips: spec,
    sockets: Object.fromEntries(
      Object.entries(socketPositions).map(([name, pos]) => [
        name,
        { bone: name, parent: hover.name, position: [pos[0], pos[1] + OWL_REST_HEIGHT, pos[2]] },
      ]),
    ),
    emissive: { material: 'Magical glimmer', color: '#f1bc68', intensity: 1, nodes: [] },
    materialSlots: {},
    budget: { tris, materials: mats.size, bones: 0, influences: 0 },
  };
  return new EnemyAsset(manifest, root, clips, { geometries: [], materials: [] });
}
