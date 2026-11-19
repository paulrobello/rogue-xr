import * as THREE from 'three';
import provenance from '../../assets-source/rooms/study/pump-wall-lightmap.json';
import { bakedRoomMaterial } from './study-room.ts';

const WALL_FILE = '/assets/props/pressure-works/pump-wall-lightmap.png';
let pending: Promise<THREE.Texture> | undefined;

export function loadPumpWallLightmap(): Promise<THREE.Texture> {
  pending ??= new THREE.TextureLoader()
    .loadAsync(`${WALL_FILE}?v=${provenance.sha256}`)
    .then((texture) => {
      texture.channel = 1;
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.flipY = false;
      return texture;
    })
    .catch((error: unknown) => {
      pending = undefined;
      throw error;
    });
  return pending;
}

/** Close the lancet and give the new north wall its own unobstructed lightmap. */
export function closePumpRoomWindow(
  model: THREE.Object3D,
  wallLight: THREE.Texture,
): (THREE.BufferGeometry | THREE.Material)[] {
  const owned: (THREE.BufferGeometry | THREE.Material)[] = [];
  const walls: { parent: THREE.Mesh; geometry: THREE.BufferGeometry; material: THREE.Material }[] =
    [];
  model.traverse((mesh) => {
    if (!(mesh instanceof THREE.Mesh) || !(mesh.material instanceof THREE.MeshStandardMaterial))
      return;
    const slot = mesh.material.name;
    if (slot === 'study_stained-glass') {
      mesh.visible = false;
      return;
    }
    if (slot !== 'study_wallpaper' && slot !== 'study_walnut') return;
    const original: THREE.BufferGeometry = mesh.geometry;
    const index = original.getIndex();
    if (!index) return;
    const pos = original.getAttribute('position');
    const keep: number[] = [];
    const north: number[] = [];
    const extend = new Set<number>();
    for (let t = 0; t < index.count; t += 3) {
      const vertices = [index.getX(t), index.getX(t + 1), index.getX(t + 2)];
      if (slot === 'study_wallpaper' && vertices.every((i) => Math.abs(pos.getZ(i) + 4) < 0.001)) {
        if (vertices.every((i) => pos.getX(i) >= 0.599)) {
          north.push(...vertices);
          for (const i of vertices) if (Math.abs(pos.getX(i) - 0.6) < 0.001) extend.add(i);
        }
        continue;
      }
      if (
        slot === 'study_walnut' &&
        vertices.every(
          (i) =>
            Math.abs(pos.getX(i)) <= 0.771 &&
            pos.getY(i) >= 1.299 &&
            pos.getY(i) <= 3.711 &&
            pos.getZ(i) < -3.739 &&
            pos.getZ(i) >= -4.001,
        )
      )
        continue;
      keep.push(...vertices);
    }
    if (keep.length === index.count && !extend.size) return;
    const geometry = original.clone();
    geometry.setIndex(keep);
    mesh.geometry = geometry;
    owned.push(geometry);
    if (!north.length) return;
    const wall = original.clone();
    wall.setIndex(north);
    const position = wall.getAttribute('position');
    const uv = wall.getAttribute('uv');
    const uv1 = wall.getAttribute('uv1');
    if (!uv1) throw new Error('Pump room wall has no lightmap UVs');
    for (const i of extend) {
      uv.setX(i, uv.getX(i) + (-4 - position.getX(i)) / 0.75);
      position.setX(i, -4);
    }
    for (const i of new Set(north))
      uv1.setXY(i, (position.getX(i) + 4) / 8, (4 - position.getY(i)) / 3);
    wall.computeBoundingBox();
    wall.computeBoundingSphere();
    const material = bakedRoomMaterial(mesh.material.clone());
    material.lightMap = wallLight;
    walls.push({ parent: mesh, geometry: wall, material });
    owned.push(wall, material);
  });
  for (const { parent, geometry, material } of walls)
    parent.add(new THREE.Mesh(geometry, material));
  return owned;
}
