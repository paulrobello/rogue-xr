import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { PALETTE } from '../palette.ts';
import { loadPbrSet } from './materials.ts';

const ORDER = [
  'brass-aged',
  'brass-polished',
  'walnut',
  'stone-floor',
  'stained-glass',
  'wallpaper',
];
const GAP = 0.15;

/**
 * `?view=material-proof`: every core material on a wall panel two tiles wide at true world scale,
 * so repeats, seams and texel density read as they will in the room.
 * `&light=neutral|grazing|warm` picks the rig, `&dist=<m>` the camera distance, `&x=<m>` its offset,
 * `&tilt=<deg>` turns the panels away from the camera for oblique and mip checks.
 */
export async function mountMaterialProof(
  scene: THREE.Scene,
  rig: THREE.Group,
  renderer: THREE.WebGLRenderer,
): Promise<void> {
  const params = new URLSearchParams(location.search);
  const light = params.get('light') ?? 'neutral';
  const tilt = THREE.MathUtils.degToRad(Number(params.get('tilt') ?? 0));
  scene.background = new THREE.Color(PALETTE.void);

  const { manifest, materials } = await loadPbrSet(
    '/assets/materials',
    renderer.capabilities.getMaxAnisotropy(),
  );
  const widths = ORDER.map((name) => 2 * (manifest[name]?.tileMeters ?? 1));
  const total = widths.reduce((a, b) => a + b, 0) + GAP * (ORDER.length - 1);
  let x = -total / 2;
  ORDER.forEach((name, i) => {
    const material = materials.get(name);
    const entry = manifest[name];
    if (!material || !entry) throw new Error(`material-proof: ${name} missing from the manifest`);
    for (const texture of [
      material.map,
      material.normalMap,
      material.aoMap,
      material.emissiveMap,
    ]) {
      texture?.repeat.set(2, 2);
    }
    if (material.emissiveMap) material.emissiveIntensity = light === 'warm' ? 1.2 : 0.6;
    const size = widths[i] ?? 1;
    const panel = new THREE.Mesh(new THREE.PlaneGeometry(size, size), material);
    panel.name = `proof-${name}`;
    // Bottom edges line up at 0.6 m so the tall stone panel rises above the rest.
    panel.position.set(x + size / 2, 0.6 + size / 2, 0);
    panel.rotation.x = -tilt;
    scene.add(panel);
    x += size + GAP;
  });

  if (light === 'grazing') {
    // Light skims down the panels from above: raised detail must catch light on its upper edge.
    const sun = new THREE.DirectionalLight('#ffffff', 3);
    sun.position.set(0, 10, 0.6);
    scene.add(sun, new THREE.AmbientLight('#ffffff', 0.08));
  } else if (light === 'warm') {
    const candle = new THREE.PointLight(PALETTE.candle, 6, 0, 1.6);
    candle.position.set(-1.2, 1.4, 1.0);
    const sky = new THREE.PointLight(PALETTE.sapphire, 3, 0, 1.6);
    sky.position.set(2.5, 2.2, 1.2);
    scene.add(candle, sky, new THREE.AmbientLight('#ffffff', 0.05));
  } else {
    const key = new THREE.DirectionalLight('#ffffff', 2.2);
    key.position.set(0.6, 1.2, 2);
    scene.add(key, new THREE.HemisphereLight('#ffffff', '#3a3028', 0.6));
  }
  // Metals show only what they reflect; a neutral studio room stands in for the baked room probe.
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = light === 'grazing' ? 0.1 : light === 'warm' ? 0.25 : 0.6;
  pmrem.dispose();

  rig.position.set(Number(params.get('x') ?? 0), 0, Number(params.get('dist') ?? 4.5));
  (window as unknown as { __materialProofReady: boolean }).__materialProofReady = true;
}
