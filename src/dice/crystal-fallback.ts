import * as THREE from 'three';
import { configureTextTexture } from '../combat-view/canvas-label.ts';
import { D12_FACE_VERTICES, dieVertices, faceNormals } from './faces.ts';

const CELL = 128;
const PAGE = CELL * 4;

function faceNumbers(): THREE.CanvasTexture | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = PAGE;
  canvas.height = PAGE;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.fillStyle = '#135963';
  ctx.fillRect(0, 0, PAGE, PAGE);
  ctx.fillStyle = '#ffe4a1';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = 'bold 55px system-ui';
  for (let i = 0; i < 12; i++) {
    const x = ((i % 4) + 0.5) * CELL;
    const y = (Math.floor(i / 4) + 0.5) * CELL;
    ctx.fillText(String(i + 1), x, y);
    if (i + 1 === 6 || i + 1 === 9) ctx.fillRect(x - 11, y + 29, 22, 4);
  }
  const texture = new THREE.CanvasTexture(canvas);
  configureTextTexture(texture);
  return texture;
}

/** The GLB and this numbered fallback share the Rapier hull's face order. */
export function buildCrystalFallback(environment?: THREE.Texture | null) {
  const vertices = dieVertices('d12').map(({ x, y, z }) => new THREE.Vector3(x, y, z));
  const normals = faceNormals('d12');
  const positions: number[] = [];
  const uv: number[] = [];
  for (const [face, indices] of D12_FACE_VERTICES.entries()) {
    const points = indices.map((index) => vertices[index]);
    const center = new THREE.Vector3();
    for (const point of points) center.add(point);
    center.multiplyScalar(1 / points.length);
    const normal = new THREE.Vector3(normals[face].x, normals[face].y, normals[face].z);
    const vertical = points[0].clone().sub(center);
    const scale = 0.44 / vertical.length();
    vertical.normalize();
    const horizontal = vertical.clone().cross(normal);
    const col = face % 4;
    const row = Math.floor(face / 4);
    for (let i = 1; i < points.length - 1; i++) {
      for (const point of [points[0], points[i], points[i + 1]]) {
        positions.push(point.x, point.y, point.z);
        const offset = point.clone().sub(center);
        uv.push(
          (col + 0.5 + offset.dot(horizontal) * scale) / 4,
          1 - (row + 0.5 - offset.dot(vertical) * scale) / 4,
        );
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geometry.computeVertexNormals();
  const texture = faceNumbers();
  const material = new THREE.MeshStandardMaterial({
    color: texture ? '#ffffff' : '#135963',
    map: texture,
    metalness: 0.28,
    roughness: 0.31,
    emissive: texture ? '#ffffff' : '#000000',
    emissiveMap: texture,
    emissiveIntensity: 0.45,
    envMap: environment ?? null,
    envMapIntensity: 0.35,
  });
  return { geometry, material, texture };
}
