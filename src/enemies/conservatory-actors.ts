import * as THREE from 'three';
import { EnemyAsset, type EnemyClip, type EnemyManifest } from './enemy-asset.ts';

/** The owl has rigid articulated parts and uses the same combat animation mixer as the other enemies. */
export function makeClockworkOwlAsset(art: THREE.Object3D): EnemyAsset {
  const root = new THREE.Group();
  const bird = art.clone(true);
  bird.name = 'ClockworkOwl';
  const facing = new THREE.Group();
  facing.rotation.y = Math.PI;
  facing.add(bird);
  const flight = new THREE.Group();
  flight.name = 'OwlFlight';
  const hoverHeight = 0.98;
  flight.position.y = hoverHeight;
  flight.add(facing);
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
    flight.add(marker);
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
          hoverHeight,
          hoverHeight + (name === 'attack' ? 0.09 : name === 'idle' ? 0.035 : 0),
          name === 'death' ? 0.08 : hoverHeight,
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
        { bone: name, parent: flight.name, position: [pos[0], pos[1] + hoverHeight, pos[2]] },
      ]),
    ),
    emissive: { material: 'Magical glimmer', color: '#f1bc68', intensity: 1, nodes: [] },
    materialSlots: {},
    budget: { tris, materials: mats.size, bones: 0, influences: 0 },
  };
  return new EnemyAsset(manifest, root, clips, { geometries: [], materials: [] });
}
