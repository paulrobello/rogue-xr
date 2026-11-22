import * as THREE from 'three';
import { kitPart } from '../world/puzzle-placement.ts';
import { EnemyAsset, type EnemyClip, type EnemyManifest } from './enemy-asset.ts';

const ARMOR = 'ClockworkArmor';
const PIVOT = 'ArmorFightPose';
const HEAD = `${ARMOR}_Head`;
const VISOR = `${ARMOR}_Visor`;
const LEFT = `${ARMOR}_LeftArm`;
const RIGHT = `${ARMOR}_RightArm`;
const PLINTH = 'Octagonal_display_plinth';
const TOE_HEIGHT = 0.086;

/** The furnished GLB merges static meshes by material, so the display hardware shares two meshes. */
function splitHardware(armor: THREE.Object3D, stand: THREE.Object3D): THREE.BufferGeometry[] {
  const owned: THREE.BufferGeometry[] = [];
  const plinth = kitPart(armor, PLINTH);
  stand.add(plinth);
  armor.updateMatrixWorld(true);
  const point = new THREE.Vector3();
  for (const [name, support] of [
    ['ClockworkArmor_AntiqueBrass', (p: THREE.Vector3) => p.y < 0.07],
    [
      'ClockworkArmor_BlackIron',
      (p: THREE.Vector3) => Math.abs(p.x) < 0.036 && Math.abs(p.z + 0.083) < 0.035,
    ],
  ] as const) {
    const mesh = kitPart(armor, name) as THREE.Mesh<THREE.BufferGeometry>;
    const original = mesh.geometry;
    const positions = original.getAttribute('position');
    const [moving, fixed] = [[], []] as [number[], number[]];
    const count = original.index?.count ?? positions.count;
    for (let i = 0; i < count; i += 3) {
      const triangle = [0, 1, 2].map((offset) => original.index?.getX(i + offset) ?? i + offset);
      const onStand = triangle.every((index) =>
        support(point.fromBufferAttribute(positions, index).applyMatrix4(mesh.matrixWorld)),
      );
      (onStand ? fixed : moving).push(...triangle);
    }
    if (fixed.length === 0 || moving.length === 0)
      throw new Error(`Missing display split in ${name}`);
    const indexed = (vertices: number[]) => {
      const geometry = original.clone().setIndex(vertices);
      const bounds = new THREE.Box3();
      for (const index of vertices)
        bounds.expandByPoint(point.fromBufferAttribute(positions, index));
      geometry.boundingBox = bounds;
      geometry.boundingSphere = bounds.getBoundingSphere(new THREE.Sphere());
      return geometry;
    };
    const actorGeometry = indexed(moving);
    const standGeometry = indexed(fixed);
    const standMesh = mesh.clone();
    mesh.geometry = actorGeometry;
    standMesh.geometry = standGeometry;
    stand.add(standMesh);
    owned.push(actorGeometry, standGeometry);
  }
  return owned;
}

function armorClip(
  name: string,
  duration: number,
  peak: number,
  pose: readonly [body: number, left: number, right: number, head: number, visor: number],
): THREE.AnimationClip {
  const [body, left, right, head, visor] = pose;
  const times = [0, duration * peak, duration];
  const bend = (node: string, axis: 'x' | 'y' | 'z', at: number, rest = 0) =>
    new THREE.NumberKeyframeTrack(`${node}.rotation[${axis}]`, times, [
      rest,
      at,
      name === 'death' ? at : rest,
    ]);
  return new THREE.AnimationClip(name, duration, [
    bend(PIVOT, 'x', body),
    bend(LEFT, 'x', left),
    bend(RIGHT, 'x', right),
    bend(HEAD, 'y', head),
    bend(VISOR, 'x', visor, -0.27),
    new THREE.NumberKeyframeTrack(`${PIVOT}.position[y]`, times, [
      0,
      name === 'death' ? 0.22 : 0,
      name === 'death' ? 0.22 : 0,
    ]),
  ]);
}

/** Reuses the authored parade harness and its pivots, with the plinth left behind as furniture. */
export function makeWakingArmor(art: THREE.Object3D): {
  readonly asset: EnemyAsset;
  readonly stand: THREE.Object3D;
} {
  const armor = art.clone(true);
  const stand = new THREE.Group();
  stand.name = 'armory-display-stand';
  const owned = splitHardware(armor, stand);
  armor.rotation.y = Math.PI;
  armor.position.y = -TOE_HEIGHT;
  const root = new THREE.Group();
  const pivot = new THREE.Group();
  pivot.name = PIVOT;
  pivot.add(armor);
  root.add(pivot);
  const socketPositions = {
    'socket-hit': [0, 1.11, -0.14],
    'socket-eye': [0, 1.55, -0.13],
    'socket-weapon': [0.33, 0.9, -0.18],
  } as const;
  for (const [name, position] of Object.entries(socketPositions)) {
    const socket = new THREE.Object3D();
    socket.name = name;
    socket.position.fromArray(position);
    pivot.add(socket);
  }
  const clips = new Map<EnemyClip, THREE.AnimationClip>();
  const spec = {} as EnemyManifest['clips'];
  for (const [name, duration, peak, pose] of [
    ['idle', 2.7, 0.5, [0.012, 0.025, -0.03, 0.085, -0.31]],
    ['frozen', 1, 0.5, [0, 0, 0, 0, -0.27]],
    ['attack', 0.62, 0.45, [-0.15, 0.18, -1.11, -0.19, -0.42]],
    ['hit', 0.34, 0.34, [0.13, 0.38, -0.3, 0.23, -0.14]],
    ['death', 0.86, 0.94, [1.53, 0.33, -0.37, -0.2, -0.55]],
  ] as const) {
    const loop = name === 'idle' || name === 'frozen' ? 'repeat' : 'once';
    clips.set(name, armorClip(name, duration, peak, pose));
    spec[name] = { duration, loop, events: name === 'attack' ? { impact: duration * peak } : {} };
  }
  const moves = new Map<`intent-${string}` | `action-${string}`, THREE.AnimationClip>([
    [
      'intent-lock-plates',
      armorClip('intent-lock-plates', 1.1, 0.5, [0.04, -0.98, -0.98, 0, -0.14]),
    ],
    [
      'intent-open-gauntlets',
      armorClip('intent-open-gauntlets', 1.1, 0.5, [0.07, 0.35, 0.35, 0, -0.48]),
    ],
    [
      'action-lock-plates',
      armorClip('action-lock-plates', 0.6, 0.42, [-0.08, -1.23, -1.23, 0, -0.12]),
    ],
    [
      'action-open-gauntlets',
      armorClip('action-open-gauntlets', 0.77, 0.52, [-0.22, -1.42, -1.42, 0, -0.52]),
    ],
  ]);
  const size = new THREE.Box3().setFromObject(root);
  const mats = new Set<THREE.Material>();
  let tris = 0;
  root.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) return;
    for (const material of Array.isArray(node.material) ? node.material : [node.material])
      mats.add(material);
    tris += (node.geometry.index?.count ?? node.geometry.attributes.position.count) / 3;
  });
  const manifest: EnemyManifest = {
    id: 'waking-armor',
    version: 1,
    glb: 'interior-furnishings.glb',
    root: PIVOT,
    mesh: ARMOR,
    frame: { units: 'meters', up: '+Y', forward: '-Z', origin: 'feet' },
    bounds: { min: size.min.toArray(), max: size.max.toArray() },
    skeleton: { root: PIVOT, bones: 0, joints: [], maxInfluences: 0 },
    rootMotion: 'none',
    clips: spec,
    intentClips: { 'lock-plates': 'intent-lock-plates', 'open-gauntlets': 'intent-open-gauntlets' },
    actionClips: { 'lock-plates': 'action-lock-plates', 'open-gauntlets': 'action-open-gauntlets' },
    actionTimings: {
      'lock-plates': { duration: 0.6, impact: 0.252 },
      'open-gauntlets': { duration: 0.77, impact: 0.4 },
    },
    sockets: Object.fromEntries(
      Object.entries(socketPositions).map(([name, position]) => [
        name,
        { bone: name, parent: PIVOT, position: [...position] },
      ]),
    ),
    emissive: { material: 'Armor eye', color: '#e8bd6a', intensity: 1, nodes: [] },
    materialSlots: {},
    budget: { tris, materials: mats.size, bones: 0, influences: 0 },
  };
  return {
    asset: new EnemyAsset(manifest, root, clips, { geometries: owned, materials: [] }, null, moves),
    stand,
  };
}
