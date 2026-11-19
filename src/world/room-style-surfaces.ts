import * as THREE from 'three';
import type { RoomStyle, RoomStyleKit } from './room-styles.ts';

const ROOM_EDGE = 4;
// The wall backing is 12 mm thick. Ceiling members seat halfway into it.
const BEARING_EDGE = ROOM_EDGE - 0.006;

type Point = readonly [number, number, number];

function edgeLength(a: Point, b: Point): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/** One material batch per room. UVs address the same six PBR swatches as its wall bays. */
class SurfaceBuilder {
  private readonly positions: number[] = [];
  private readonly normals: number[] = [];
  private readonly uvs: number[] = [];
  private readonly colors: number[] = [];
  private readonly indices: number[] = [];
  private readonly a = new THREE.Vector3();
  private readonly b = new THREE.Vector3();
  private faces = 0;

  face(
    points: readonly [Point, Point, Point] | readonly [Point, Point, Point, Point],
    cell: number,
    shade = 1,
    exposed = true,
  ): void {
    // Each authored face has a deterministic texture offset, including faces buried in a wall.
    const faceIndex = this.faces++;
    if (!exposed) return;
    const [first, second] = points;
    const last = points[points.length - 1];
    this.a.set(second[0] - first[0], second[1] - first[1], second[2] - first[2]);
    this.b.set(last[0] - first[0], last[1] - first[1], last[2] - first[2]);
    this.a.cross(this.b).normalize();
    const width = edgeLength(first, second),
      height = edgeLength(first, last);
    const rotate = height > width;
    const uSpan = Math.min(0.96, (rotate ? height : width) / 1.75);
    const vSpan = Math.min(0.96, (rotate ? width : height) / 1.25);
    const u0 = 0.02 + (0.96 - uSpan) * (((faceIndex * 37) % 97) / 97);
    const v0 = 0.02 + (0.96 - vSpan) * (((faceIndex * 59) % 101) / 101);
    const offset = this.positions.length / 3;
    for (const [i, p] of points.entries()) {
      this.positions.push(...p);
      this.normals.push(this.a.x, this.a.y, this.a.z);
      this.colors.push(shade, shade, shade);
      const across = i === 1 || i === 2 ? 1 : 0,
        along = i >= 2 ? 1 : 0;
      this.uvs.push(
        ((cell % 3) + u0 + uSpan * (rotate ? along : across)) / 3,
        1 - (Math.floor(cell / 3) + v0 + vSpan * (rotate ? across : along)) / 2,
      );
    }
    this.indices.push(offset, offset + 1, offset + 2);
    if (points.length === 4) this.indices.push(offset, offset + 2, offset + 3);
  }

  box(
    x: number,
    y: number,
    z: number,
    w: number,
    h: number,
    d: number,
    cell: number,
    shade = 1,
    limit = BEARING_EDGE,
  ): void {
    const l = Math.max(-limit, x - w / 2),
      r = Math.min(limit, x + w / 2),
      b = y - h / 2,
      t = y + h / 2,
      n = Math.max(-limit, z - d / 2),
      f = Math.min(limit, z + d / 2);
    this.face(
      [
        [l, t, f],
        [r, t, f],
        [r, t, n],
        [l, t, n],
      ],
      cell,
      shade,
    );
    this.face(
      [
        [l, b, n],
        [r, b, n],
        [r, b, f],
        [l, b, f],
      ],
      cell,
      shade * 0.87,
    );
    this.face(
      [
        [l, b, f],
        [r, b, f],
        [r, t, f],
        [l, t, f],
      ],
      cell,
      shade,
      f < limit,
    );
    this.face(
      [
        [r, b, n],
        [l, b, n],
        [l, t, n],
        [r, t, n],
      ],
      cell,
      shade,
      n > -limit,
    );
    this.face(
      [
        [l, b, n],
        [l, b, f],
        [l, t, f],
        [l, t, n],
      ],
      cell,
      shade,
      l > -limit,
    );
    this.face(
      [
        [r, b, f],
        [r, b, n],
        [r, t, n],
        [r, t, f],
      ],
      cell,
      shade,
      r < limit,
    );
  }

  board(x: number, z: number, w: number, d: number, cell: number, shade: number): void {
    const l = x - w / 2,
      r = x + w / 2,
      n = z - d / 2,
      f = z + d / 2,
      bevel = 0.003;
    const rim: [Point, Point, Point, Point] = [
      [l, -0.004, f],
      [r, -0.004, f],
      [r, -0.004, n],
      [l, -0.004, n],
    ];
    const face: [Point, Point, Point, Point] = [
      [l + bevel, 0, f - bevel],
      [r - bevel, 0, f - bevel],
      [r - bevel, 0, n + bevel],
      [l + bevel, 0, n + bevel],
    ];
    this.face(face, cell, shade);
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      this.face([rim[i], rim[j], face[j], face[i]], cell, shade * 0.88);
    }
  }

  tread(x: number, z: number, angle: number): void {
    const a = Math.cos(angle) * 0.048,
      b = Math.sin(angle) * 0.048,
      c = -Math.sin(angle) * 0.012,
      d = Math.cos(angle) * 0.012;
    const shape: [Point, Point, Point, Point] = [
      [x - a, -0.0008, z - b],
      [x + c, -0.0008, z + d],
      [x + a, -0.0008, z + b],
      [x - c, -0.0008, z - d],
    ];
    const crown: Point = [x, 0.004, z];
    for (let i = 0; i < 4; i++) this.face([shape[i], shape[(i + 1) % 4], crown], 1, 0.97);
  }

  pipe(x: number, y: number, from: number, to: number, r: number, cell: number): void {
    for (let i = 0; i < 16; i++) {
      const ax = x + r * Math.cos((i * Math.PI) / 8),
        ay = y + r * Math.sin((i * Math.PI) / 8);
      const bx = x + r * Math.cos(((i + 1) * Math.PI) / 8),
        by = y + r * Math.sin(((i + 1) * Math.PI) / 8);
      this.face(
        [
          [ax, ay, from],
          [bx, by, from],
          [bx, by, to],
          [ax, ay, to],
        ],
        cell,
        0.9,
      );
    }
  }

  geometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.positions, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.normals, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uvs, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.colors, 3));
    g.setIndex(this.indices);
    g.computeBoundingSphere();
    g.userData.roomStyleOwned = true;
    return g;
  }
}

function boiler(b: SurfaceBuilder): void {
  b.box(0, -0.041, 0, 8, 0.058, 8, 4, 0.54, ROOM_EDGE);
  b.box(0, 4.018, 0, 8, 0.024, 8, 1, 0.65);
  for (let row = 0; row < 8; row++)
    for (let col = 0; col < 8; col++) {
      const x = col - 3.5,
        z = row - 3.5;
      if (row === 2 && (col === 1 || col === 6)) {
        // Two recessed service grates interrupt the checker plates below the pump banks.
        b.box(x, -0.005, z - 0.45, 0.994, 0.01, 0.09, 1);
        b.box(x, -0.005, z + 0.45, 0.994, 0.01, 0.09, 1);
        b.box(x - 0.45, -0.005, z, 0.09, 0.01, 0.81, 1);
        b.box(x + 0.45, -0.005, z, 0.09, 0.01, 0.81, 1);
        for (let j = 0; j < 12; j++)
          b.box(x - 0.39 + j * 0.071, -0.009, z, 0.033, 0.018, 0.81, 0, 0.85);
        continue;
      }
      b.board(x, z, 0.995, 0.995, 0, 0.85 + 0.025 * ((row * 3 + col) % 5));
      for (let i = 0; i < 6; i++)
        for (let j = 0; j < 6; j++)
          b.tread(
            x + (i - 2.5) * 0.159,
            z + (j - 2.5) * 0.159,
            (i + j) % 2 === 0 ? Math.PI / 4 : -Math.PI / 4,
          );
    }
  for (let z = -3; z <= 3; z += 2) {
    for (let x = -3; x <= 3; x += 2) b.box(x, 3.991, z, 1.996, 0.022, 1.996, 1, 0.76);
    b.box(0, 3.883, z, 8, 0.16, 0.056, 1, 0.88);
    b.box(0, 3.79, z, 8, 0.028, 0.155, 0, 0.95);
  }
  for (const [x, r, cell] of [
    [-2.28, 0.055, 3],
    [-2.06, 0.043, 0],
  ]) {
    for (let j = 0; j < 4; j++) {
      const z0 = -4 + j * 2;
      b.pipe(x, 3.66, Math.max(-BEARING_EDGE, z0), Math.min(BEARING_EDGE, z0 + 2), r, cell);
      b.pipe(x, 3.66, z0 + 0.96, z0 + 1.04, r + 0.014, 2);
      b.box(x, 3.75, z0 + 1, 0.035, 0.12, 0.04, 1);
    }
  }
}

function timber(b: SurfaceBuilder): void {
  b.box(0, -0.024, 0, 8, 0.03, 8, 3, 0.62, ROOM_EDGE);
  for (let row = 0; row < 40; row++) {
    const z = -3.9 + row * 0.2;
    let left = -4;
    const first = 0.64 + ((row * 7) % 11) * 0.105;
    for (let joint = 0; left < 3.999; joint++) {
      const end = left + (joint === 0 ? first : 1.64 + ((row + joint * 3) % 8) * 0.072);
      const right = end > 3.83 ? 4 : end;
      b.board(
        (right + left) / 2,
        z,
        right - left - 0.003,
        0.197,
        0,
        0.7 + 0.032 * ((row * 5 + joint * 3) % 8),
      );
      left = right;
    }
  }
  for (let z = -3.875; z < 4; z += 0.25) {
    for (let x = -3; x < 4; x += 2) b.box(x, 3.99, z, 1.997, 0.025, 0.248, 1, 0.75);
  }
  for (const z of [-3, -1, 1, 3]) {
    b.box(0, 3.88, z, 8, 0.2, 0.16, 3, 0.9);
    b.box(0, 3.767, z, 8, 0.026, 0.183, 1, 0.93);
    for (const x of [-3.85, 3.85]) b.box(x, 3.742, z, 0.3, 0.12, 0.2, 1, 0.92);
  }
  for (const x of [-2, 0, 2]) b.box(x, 3.935, 0, 0.08, 0.087, 8, 0, 0.83);
}

export function createRoomSurfaces(style: RoomStyle, kit: RoomStyleKit): THREE.Group {
  const source = kit[style === 'boiler' ? 'BoilerBay' : 'TimberBay'];
  let surfaceMaterial: THREE.Material | undefined;
  source.traverse((node) => {
    if (!(node instanceof THREE.Mesh) || surfaceMaterial) return;
    const materials = Array.isArray(node.material) ? node.material : [node.material];
    surfaceMaterial =
      materials.find((m) => m.name === (style === 'boiler' ? 'BoilerFinish' : 'TimberFinish')) ??
      materials[0];
  });
  if (!surfaceMaterial) throw Error(`Missing ${style} finish material`);
  const builder = new SurfaceBuilder();
  if (style === 'boiler') boiler(builder);
  else timber(builder);
  const material = surfaceMaterial.clone();
  material.vertexColors = true;
  material.userData.roomStyleOwned = true;
  const mesh = new THREE.Mesh(builder.geometry(), material);
  mesh.name = `${style}-deck-and-ceiling`;
  const surfaces = new THREE.Group();
  surfaces.name = `room-style-${style}-surfaces`;
  surfaces.add(mesh);
  return surfaces;
}
