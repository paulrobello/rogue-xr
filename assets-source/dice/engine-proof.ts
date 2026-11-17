// In-engine stills of the P5-T7 dice, loaded by assets-source/dice/engine_shot.py through the
// running Vite dev server (it serves and transforms this file; it is outside src/, biome and tsc).
// Uses the real runtime path: loadDice() for the GLBs and the UI atlas KTX2 colour and glow pages
// bound with bindFaceMaps() as DicePresenter.applyFaces does, lit by the room probe through
// setEnvironment() at DICE_ENV_INTENSITY as DicePresenter does (so the slots' envMapScale and
// toneMapped apply), posed with the presenter's correction (correctionRotation from identity).
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { type DiceAsset, loadDice } from '/src/dice/dice-asset.ts';
import { DICE_ENV_INTENSITY } from '/src/dice/presenter.ts';
import { correctionRotation, D8_CIRCUMRADIUS, type DieKind, dieVertices } from '/src/dice/faces.ts';
import { QUAT_IDENTITY } from '/src/dice/quat.ts';
import { sharedKtx2Loader } from '/src/ui/first-render.ts';
import { loadUiAtlas, UI_ATLAS_BASE } from '/src/ui/icon-atlas.ts';

const REST = { d6: 0.02, d8: D8_CIRCUMRADIUS / Math.sqrt(3) };

export async function mountDiceProof(w: number, h: number) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setSize(w, h);
  renderer.setPixelRatio(1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.AgXToneMapping;
  renderer.shadowMap.enabled = true;
  document.body.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#1c140e');
  const pmrem = new THREE.PMREMGenerator(renderer);
  const probe = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  // The floor reflects the scene environment; the dice materials carry their own envMap.
  scene.environment = probe;
  scene.environmentIntensity = 0.35;
  const key = new THREE.DirectionalLight('#ffd9a0', 2.2);
  key.position.set(-0.4, 0.9, 0.6);
  key.castShadow = true;
  key.shadow.camera.left = key.shadow.camera.bottom = -0.4;
  key.shadow.camera.right = key.shadow.camera.top = 0.4;
  key.shadow.mapSize.set(1024, 1024);
  scene.add(key, new THREE.HemisphereLight('#f3be65', '#231d1a', 0.35));
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(2, 2),
    new THREE.MeshStandardMaterial({ color: '#583c26', roughness: 0.7 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);
  const camera = new THREE.PerspectiveCamera(30, w / h, 0.005, 10);

  const asset: DiceAsset = await loadDice();
  const atlas = await loadUiAtlas();
  const ktx2 = sharedKtx2Loader(renderer);
  const page = async (name: string) => {
    const t = await ktx2.loadAsync(`${UI_ATLAS_BASE}/${atlas.pages[name]?.ktx2}`);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    return t;
  };
  const glowPage = (id: 'brass-d6' | 'glass-d8') => {
    const name = atlas.dice[id]?.glowPage;
    return name ? page(name) : Promise.resolve(null);
  };
  asset.bindFaceMaps(
    { d6: await page('dice-d6'), d8: await page('dice-d8') },
    { d6: await glowPage('brass-d6'), d8: await glowPage('glass-d8') },
  );
  asset.setEnvironment(probe, DICE_ENV_INTENSITY);
  /** Manifest look of every shared dice material, for `tune` to override and restore. */
  const looks = new Map<THREE.MeshStandardMaterial, { env: number; roughness: number; toneMapped: boolean }>();
  for (const kind of ['d6', 'd8'] as const) {
    for (const m of asset.spawn(kind).material as THREE.MeshStandardMaterial[]) {
      looks.set(m, { env: m.envMapIntensity, roughness: m.roughness, toneMapped: m.toneMapped });
    }
  }
  /** Sweep override of the face slot's emissiveIntensity (null keeps the manifest value). */
  let glowOverride: number | null = null;
  const faceMaterial = (mesh: THREE.Mesh) =>
    (mesh.material as THREE.MeshStandardMaterial[]).find((m) => m.name.endsWith('-face')) as THREE.MeshStandardMaterial;
  const manifestGlow = { d6: 0, d8: 0 };
  for (const kind of ['d6', 'd8'] as const) manifestGlow[kind] = faceMaterial(asset.spawn(kind)).emissiveIntensity;

  const group = new THREE.Group();
  scene.add(group);
  const place = (kind: DieKind, face: number, x: number, z: number) => {
    const mesh = asset.spawn(kind);
    faceMaterial(mesh).emissiveIntensity = glowOverride ?? manifestGlow[kind];
    const c = correctionRotation(QUAT_IDENTITY, asset.diceAssetFaces(kind), face);
    mesh.quaternion.set(c.x, c.y, c.z, c.w);
    mesh.position.set(x, REST[kind], z);
    group.add(mesh);
    return mesh;
  };
  const clear = () => {
    for (const child of [...group.children]) child.removeFromParent();
  };

  const toPx = (mesh: THREE.Mesh, v: THREE.Vector3) => {
    const p = mesh.localToWorld(v.clone()).project(camera);
    return [((p.x + 1) / 2) * w, ((1 - p.y) / 2) * h];
  };
  /** Screen polygons of every placed die's faces (panel, rail band, outer facet) for measurement. */
  const geometry = (kind: DieKind) =>
    group.children.map((obj) => {
      const mesh = obj as THREE.Mesh;
      mesh.updateMatrixWorld(true);
      const verts = dieVertices(kind).map((v) => toPx(mesh, new THREE.Vector3(v.x, v.y, v.z)));
      const normals = asset.diceAssetFaces(kind);
      const faces = normals.map((n, index) => {
        const nv = new THREE.Vector3(n.x, n.y, n.z);
        const wn = nv.clone().applyQuaternion(mesh.quaternion);
        const centreW = mesh.localToWorld(nv.clone().multiplyScalar(0.02));
        const visible = wn.dot(camera.position.clone().sub(centreW)) > 0;
        let outer: THREE.Vector3[];
        let panel: THREE.Vector3[];
        let band: THREE.Vector3[];
        if (kind === 'd6') {
          const u = Math.abs(n.y) > 0.5 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
          const v = nv.clone().cross(u);
          const sq = (half: number, depth: number) =>
            [[1, 1], [-1, 1], [-1, -1], [1, -1]].map(([a, b]) =>
              nv.clone().multiplyScalar(0.02 - depth).addScaledVector(u, a * half).addScaledVector(v, b * half),
            );
          outer = sq(0.02, 0);
          band = sq(0.0138, 0);
          panel = sq(0.0128, 0.0014);
        } else {
          const s3 = Math.sqrt(3);
          const sx = Math.sign(n.x * s3), sy = Math.sign(n.y * s3), sz = Math.sign(n.z * s3);
          outer = [new THREE.Vector3(sx * D8_CIRCUMRADIUS, 0, 0), new THREE.Vector3(0, sy * D8_CIRCUMRADIUS, 0), new THREE.Vector3(0, 0, sz * D8_CIRCUMRADIUS)];
          const g = outer[0].clone().add(outer[1]).add(outer[2]).multiplyScalar(1 / 3);
          const scaled = (k: number, depth: number) =>
            outer.map((p) => g.clone().add(p.clone().sub(g).multiplyScalar(k)).addScaledVector(nv, -depth));
          band = scaled(0.78, 0);
          panel = scaled(0.7, 0.0008);
        }
        return {
          index,
          up: wn.y,
          visible,
          outer: outer.map((p) => toPx(mesh, p)),
          band: band.map((p) => toPx(mesh, p)),
          panel: panel.map((p) => toPx(mesh, p)),
        };
      });
      return { verts, faces };
    });

  return {
    /** Sets the face glow for later `show` calls (null restores the manifest value). */
    setGlow(value: number | null) {
      glowOverride = value;
      return { override: value, manifest: manifestGlow };
    },
    /**
     * Sweep overrides without a Blender rebuild (null or absent restores the manifest look): env
     * multipliers on DICE_ENV_INTENSITY for the brass body and the face slots, brass roughness, and
     * face tone mapping. Applies to every die, shown or not.
     */
    tune(o: {
      bodyEnvScale?: number | null;
      faceEnvScale?: number | null;
      d6FaceEnvScale?: number | null;
      d8FaceEnvScale?: number | null;
      brassRoughness?: number | null;
      faceToneMapped?: boolean | null;
    }) {
      for (const [m, look] of looks) {
        const face = m.name.endsWith('-face');
        const perDie = m.name.includes('-d6-') ? o.d6FaceEnvScale : o.d8FaceEnvScale;
        const scale = face ? (perDie ?? o.faceEnvScale) : o.bodyEnvScale;
        m.envMapIntensity = scale == null ? look.env : DICE_ENV_INTENSITY * scale;
        if (!face) m.roughness = o.brassRoughness ?? look.roughness;
        if (face) m.toneMapped = o.faceToneMapped ?? look.toneMapped;
        m.needsUpdate = true;
      }
      return [...looks].map(([m]) => ({ name: m.name, env: m.envMapIntensity, roughness: m.roughness, toneMapped: m.toneMapped }));
    },
    geometry,
    /** `hero`: face 0 up beside a second die, seated three-quarter view. `lineup`: every face up. */
    show(kind: DieKind, mode: 'hero' | 'lineup') {
      clear();
      const count = kind === 'd6' ? 6 : 8;
      if (mode === 'hero') {
        place(kind, 0, -0.028, 0);
        place(kind, count - 2, 0.03, 0.012);
        camera.fov = 30;
        camera.position.set(0.07, 0.19, 0.16);
        camera.lookAt(0, 0.012, 0);
      } else {
        for (let i = 0; i < count; i++) place(kind, i, (i - (count - 1) / 2) * 0.06, 0);
        camera.fov = 40;
        camera.position.set(0, kind === 'd6' ? 0.27 : 0.37, kind === 'd6' ? 0.23 : 0.31);
        camera.lookAt(0, 0, 0.0);
      }
      camera.updateProjectionMatrix();
      renderer.info.reset();
      renderer.render(scene, camera);
      return {
        calls: renderer.info.render.calls,
        triangles: renderer.info.render.triangles,
        programs: renderer.info.programs?.length ?? 0,
        dice: group.children.length,
      };
    },
    /** Mean ms per frame for `n` dice of `kind` over `frames` frames, glFinish-bounded (desktop ranking only). */
    bench(kind: DieKind, n: number, frames: number, opaqueFace: boolean) {
      clear();
      const side = Math.ceil(Math.sqrt(n));
      for (let i = 0; i < n; i++) {
        place(kind, i % (kind === 'd6' ? 6 : 8), ((i % side) - side / 2) * 0.05, (Math.floor(i / side) - side / 2) * 0.05);
      }
      camera.fov = 40;
      camera.position.set(0, 0.5, 0.5);
      camera.lookAt(0, 0, 0);
      camera.updateProjectionMatrix();
      const mats = (group.children[0] as THREE.Mesh).material as THREE.MeshStandardMaterial[];
      const face = mats.find((m) => m.name.endsWith('-face')) as THREE.MeshStandardMaterial;
      const was = { transparent: face.transparent, opacity: face.opacity };
      if (opaqueFace) {
        face.transparent = false;
        face.opacity = 1;
        face.needsUpdate = true;
      }
      const gl = renderer.getContext();
      for (let i = 0; i < 20; i++) renderer.render(scene, camera);
      gl.finish();
      const t0 = performance.now();
      for (let i = 0; i < frames; i++) {
        group.rotation.y += 0.001;
        renderer.render(scene, camera);
      }
      gl.finish();
      const ms = (performance.now() - t0) / frames;
      face.transparent = was.transparent;
      face.opacity = was.opacity;
      face.needsUpdate = true;
      return { kind, n, opaqueFace, msPerFrame: Math.round(ms * 1000) / 1000, calls: renderer.info.render.calls };
    },
  };
}
