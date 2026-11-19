import * as THREE from 'three';
import { Stream } from '../core/rng.ts';
import { type CompressedTextureLoader, configurePbrTexture } from './materials.ts';

export async function loadBookBindings(loader: CompressedTextureLoader): Promise<THREE.Texture> {
  const texture = await loader.loadAsync('/assets/props/study-books/book-bindings.ktx2');
  configurePbrTexture(texture, 'basecolor');
  texture.flipY = false;
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
  return texture;
}

interface Chart {
  lightUV(u: number, v: number): [number, number];
  uMin: number;
  uMax: number;
  vMin: number;
  vMax: number;
}

interface Row {
  alongX: boolean;
  front?: Chart;
  top?: Chart;
}

function shelfRows(proxy: THREE.BufferGeometry): Row[] {
  const pos = proxy.getAttribute('position');
  const normal = proxy.getAttribute('normal');
  const baked = proxy.getAttribute('uv1');
  const indices = proxy.getIndex();
  const rows = new Map<string, Row>();
  for (let i = 0; i < (indices?.count ?? pos.count); i += 3) {
    const ids = [0, 1, 2].map((k) => indices?.getX(i + k) ?? i + k);
    const points = ids.map((id) => new THREE.Vector3().fromBufferAttribute(pos, id));
    const bounds = new THREE.Box3().setFromPoints(points);
    const alongX = bounds.max.x - bounds.min.x > bounds.max.z - bounds.min.z;
    const top = normal.getY(ids[0]) > 0.9;
    const u = points.map((p) => (alongX ? p.x : -p.z));
    const v = points.map((p) => (top ? (alongX ? p.z : p.x) : p.y));
    const key = [alongX, Math.min(...u), bounds.max.y].join('/');
    const row = rows.get(key) ?? { alongX };
    const surface = top ? 'top' : 'front';
    if (row[surface]) continue;
    const corner = (k: number) => new THREE.Vector3(u[k], v[k], 0);
    const chart = new THREE.Triangle(corner(0), corner(1), corner(2));
    const uv = ids.map((id) => new THREE.Vector2(baked.getX(id), baked.getY(id)));
    const p = new THREE.Vector3();
    const interpolated = new THREE.Vector2();
    row[surface] = {
      lightUV(along, heightOrDepth) {
        // Each atlas island is an affine-mapped rectangle. Its first triangle defines both halves.
        chart.getInterpolation(p.set(along, heightOrDepth, 0), uv[0], uv[1], uv[2], interpolated);
        return [interpolated.x, interpolated.y];
      },
      uMin: Math.min(...u),
      uMax: Math.max(...u),
      vMin: Math.min(...v),
      vMax: Math.max(...v),
    };
    rows.set(key, row);
  }
  return [...rows.values()];
}

type Corner = [along: number, height: number, outward: number];

/** Dress each baked shelf row once. Instances share the resulting mesh and the room's lightmap. */
export function studyBookGeometry(proxy: THREE.BufferGeometry): THREE.BufferGeometry {
  const position: number[] = [],
    uv: number[] = [],
    uv1: number[] = [],
    index: number[] = [];
  const random = Stream.fromKey('study:leather-bindings');
  for (const { alongX, front, top } of shelfRows(proxy)) {
    if (!front || !top) throw new Error('Study shelf is missing its baked front or top surface');
    const base = front.vMin;
    for (let left = front.uMin + 0.006; left < front.uMax - 0.055; ) {
      const width = Math.min(0.034 + random.next() * 0.052, front.uMax - left - 0.003);
      const right = left + width;
      const center = (left + right) / 2;
      const height = base + (front.vMax - base) * (0.67 + 0.33 * random.next());
      const fore = top.vMax - 0.004 - 0.031 * random.next();
      const crest = fore + Math.min(0.004, width * 0.075);
      const back = fore - (top.vMax - top.vMin) * (0.59 + 0.31 * random.next());
      const binding = random.int(0, 15);
      const column = binding % 8;
      const face = (
        a: Corner,
        b: Corner,
        c: Corner,
        d: Corner,
        tile: number,
        isTop = false,
        u0 = 0,
        u1 = 1,
      ) => {
        const first = position.length / 3;
        for (const [j, [along, y, depth]] of [a, b, c, d].entries()) {
          if (alongX) position.push(along, y, depth);
          else position.push(depth, y, -along);
          const s = j === 0 || j === 3 ? u0 : u1;
          const t = j < 2 ? 1 : 0;
          uv.push(
            ((tile % 8) * 128 + 3 + s * 122) / 1024,
            (Math.floor(tile / 8) * 256 + 3 + t * 250) / 1024,
          );
          uv1.push(...(isTop ? top.lightUV(along, depth) : front.lightUV(along, y)));
        }
        index.push(first, first + 1, first + 2, first, first + 2, first + 3);
      };
      const lb: Corner = [left, base, fore],
        lt: Corner = [left, height, fore];
      const cb: Corner = [center, base, crest],
        ct: Corner = [center, height, crest];
      const rb: Corner = [right, base, fore],
        rt: Corner = [right, height, fore];
      const ltb: Corner = [left, height, back],
        rtb: Corner = [right, height, back];
      const midBack: Corner = [center, height, back];
      face(lb, cb, ct, lt, binding, false, 0, 0.5);
      face(cb, rb, rt, ct, binding, false, 0.5, 1);
      face(lt, ct, midBack, ltb, 24 + column, true, 0, 0.5);
      face(ct, rt, rtb, midBack, 24 + column, true, 0.5, 1);
      face([left, base, back], lb, lt, ltb, 16 + column);
      face(rb, [right, base, back], rtb, rt, 16 + column);
      left = right + 0.0015 + (random.next() < 0.08 ? 0.022 : 0);
    }
  }
  const books = new THREE.BufferGeometry();
  books.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
  books.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  books.setAttribute('uv1', new THREE.Float32BufferAttribute(uv1, 2));
  books.setIndex(index);
  books.computeVertexNormals();
  return books;
}
