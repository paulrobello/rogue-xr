import * as THREE from 'three';
import provenance from '../../assets-source/rooms/study/pump-floor-lightmap.json';
import { bakedRoomMaterial } from './study-room.ts';

const FLOOR_FILE = '/assets/props/pressure-works/pump-floor-lightmap.png';
const [atlasWidth, atlasHeight] = provenance.atlas_size;
const [left, top, right, bottom] = provenance.floor_crop_pixels;

export interface PumpFloorResources {
  geometries: THREE.BufferGeometry[];
  materials: THREE.Material[];
}

let pending: Promise<THREE.Texture> | undefined;

export function loadPumpFloorLightmap(): Promise<THREE.Texture> {
  pending ??= new THREE.TextureLoader()
    .loadAsync(
      `${FLOOR_FILE}?v=${provenance.source_sha256['public/assets/props/pressure-works/pump-floor-lightmap.png']}`,
    )
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

/** Replaces only this study instance's floor lightmap with its windowless floor chart. */
export function removePumpRoomSunlight(
  model: THREE.Object3D,
  texture: THREE.Texture,
): PumpFloorResources {
  const resources: PumpFloorResources = { geometries: [], materials: [] };

  model.traverse((object) => {
    if (!(object instanceof THREE.Mesh) || !(object.material instanceof THREE.MeshStandardMaterial))
      return;
    if (object.material.name !== 'study_stone-floor') return;
    const uv1 = object.geometry.getAttribute('uv1');
    if (!uv1) throw new Error('Pump room floor has no lightmap UVs');

    const geometry = object.geometry.clone();
    const floorUv = geometry.getAttribute('uv1');
    for (let i = 0; i < floorUv.count; i++) {
      floorUv.setXY(
        i,
        (floorUv.getX(i) * atlasWidth - left) / (right - left),
        (floorUv.getY(i) * atlasHeight - top) / (bottom - top),
      );
    }
    floorUv.needsUpdate = true;
    const material = bakedRoomMaterial(object.material.clone());
    material.lightMap = texture;
    object.geometry = geometry;
    object.material = material;
    resources.geometries.push(geometry);
    resources.materials.push(material);
  });
  return resources;
}
