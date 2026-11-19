import * as THREE from 'three';
import type { PbrSet } from './materials.ts';
import type { PressureArt } from './pressure-works.ts';

type Finish = 'iron' | 'brass' | 'copper' | 'wood';
const FINISHES: Readonly<Record<string, Finish>> = {
  'cast iron': 'iron',
  'dark inset': 'iron',
  'compartment cast iron': 'iron',
  'compartment dark lining': 'iron',
  palette_iron: 'iron',
  'aged brass': 'brass',
  'compartment aged brass': 'brass',
  'compartment bright gold': 'brass',
  palette_brass: 'brass',
  copper: 'copper',
  'oxidized copper': 'copper',
  'compartment walnut': 'wood',
};

/** Paint in metres in the assembled machine's rest frame so trim, wheels and large vessels
 * have the same grain size, and moving pieces carry their own surface finish. */
function projectMachineUvs(mesh: THREE.Mesh, tileMeters: number): void {
  const geometry = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone();
  const position = geometry.getAttribute('position');
  const uv = new Float32Array(position.count * 2);
  const vertices = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  const edge = new THREE.Vector3(),
    normal = new THREE.Vector3();
  for (let start = 0; start < position.count; start += 3) {
    for (let j = 0; j < 3; j++)
      vertices[j].fromBufferAttribute(position, start + j).applyMatrix4(mesh.matrixWorld);
    normal.subVectors(vertices[1], vertices[0]).cross(edge.subVectors(vertices[2], vertices[0]));
    const x = Math.abs(normal.x),
      y = Math.abs(normal.y),
      z = Math.abs(normal.z);
    for (let j = 0; j < 3; j++) {
      const p = vertices[j];
      uv[(start + j) * 2] = (x > y && x > z ? -Math.sign(normal.x) * p.z : p.x) / tileMeters;
      uv[(start + j) * 2 + 1] = (y > x && y > z ? -Math.sign(normal.y) * p.z : p.y) / tileMeters;
    }
  }
  geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geometry.deleteAttribute('tangent');
  mesh.geometry = geometry;
}

export function dressPumpMaterials(art: PressureArt, set: PbrSet): void {
  for (const [name, assembly] of Object.entries(art)) {
    if (name === 'gallery-pipes' || !assembly) continue;
    assembly.updateMatrixWorld(true);
    const dressed = new Set<THREE.Material>();
    assembly.traverse((mesh) => {
      if (!(mesh instanceof THREE.Mesh) || !(mesh.material instanceof THREE.MeshStandardMaterial))
        return;
      const material = mesh.material;
      const finish = FINISHES[material.name];
      if (!finish) return;
      const slot =
        finish === 'wood' ? 'walnut' : finish === 'brass' ? 'brass-polished' : 'brass-aged';
      const source = set.materials.get(slot);
      if (!source) return;
      projectMachineUvs(mesh, set.manifest[slot].tileMeters);
      if (dressed.has(material)) return;
      dressed.add(material);
      material.map = source.map;
      material.normalMap = source.normalMap;
      material.normalScale.setScalar(finish === 'iron' ? 0.09 : finish === 'wood' ? 0.55 : 0.13);
      material.roughnessMap = source.roughnessMap;
      material.roughness = finish === 'wood' ? 0.95 : finish === 'iron' ? 0.83 : 0.69;
      material.envMapIntensity = finish === 'wood' ? 0.24 : finish === 'iron' ? 0.32 : 0.76;
      if (finish === 'wood') {
        material.color.setRGB(0.94, 0.84, 0.72);
      } else if (finish === 'brass') {
        material.color.setRGB(0.94, 0.87, 0.71);
      } else {
        // The wear and tool marks share the room metals' scale; iron and copper retain
        // their own patina instead of taking the brass texture's yellow pigment.
        material.onBeforeCompile = (shader) => {
          shader.fragmentShader = shader.fragmentShader.replace(
            '#include <map_fragment>',
            `
            #ifdef USE_MAP
              vec3 wear = texture2D(map,vMapUv).rgb;
              diffuseColor.rgb *= mix(0.57,1.2,smoothstep(0.015,0.55,dot(wear,vec3(0.2126,0.7152,0.0722))));
            #endif`,
          );
        };
        if (finish === 'iron') {
          const grain = material.onBeforeCompile;
          material.onBeforeCompile = function (shader, renderer) {
            grain.call(this, shader, renderer);
            shader.fragmentShader = shader.fragmentShader.replace(
              '#include <roughnessmap_fragment>',
              '#include <roughnessmap_fragment>\n roughnessFactor = max(0.52, roughnessFactor);',
            );
          };
        }
        material.customProgramCacheKey = () => `pump-metal-grain-${finish}`;
      }
      material.needsUpdate = true;
    });
  }
}
