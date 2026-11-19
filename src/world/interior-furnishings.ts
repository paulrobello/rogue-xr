import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { type Box, type Rect, type Socket, templateById } from '../content/rooms.ts';
import { Stream } from '../core/rng.ts';
import type { FloorWorld } from './floor-world.ts';

export const INTERIOR_FURNISHINGS_BASE = '/assets/props/interior-furnishings';
export const INTERIOR_PAINTINGS = [
  '/assets/props/paintings/clockmaker-first.webp',
  '/assets/props/paintings/clockmaker-return.webp',
] as const;
const ROOT_NAMES = [
  'DoorSingle',
  'DoorDouble',
  'DoorArched',
  'Curtain',
  'DiningChair',
  'DiningTable',
  'Bookcase',
  'Candelabrum',
  'WallClock',
  'ClockworkArmor',
  'FramedPainting',
] as const;
export type InteriorFurnishingRoot = (typeof ROOT_NAMES)[number];
export type InteriorTheme = 'library' | 'dining' | 'gallery' | 'workshop';

export interface InteriorFurnishingsAsset {
  readonly scene: THREE.Group;
  readonly roots: Readonly<Record<InteriorFurnishingRoot, THREE.Object3D>>;
}

let assetPromise: Promise<InteriorFurnishingsAsset> | undefined;

/** Loads and indexes the furnishing library once. Every placement clones these shared roots. */
export function loadInteriorFurnishings(
  base = INTERIOR_FURNISHINGS_BASE,
): Promise<InteriorFurnishingsAsset> {
  if (!assetPromise) {
    assetPromise = new GLTFLoader().loadAsync(`${base}/interior-furnishings.glb`).then((gltf) => {
      gltf.scene.updateMatrixWorld(true);
      const roots = {} as Record<InteriorFurnishingRoot, THREE.Object3D>;
      for (const name of ROOT_NAMES) {
        const root = gltf.scene.getObjectByName(name);
        if (!root) throw new Error(`interior-furnishings: root ${name} missing`);
        roots[name] = root;
      }
      return { scene: gltf.scene, roots };
    });
  }
  return assetPromise;
}

/** The freestanding case and the baked study use the same UV atlas. */
export function bindBookcaseAtlas(asset: InteriorFurnishingsAsset, atlas: THREE.Texture): void {
  asset.roots.Bookcase.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) return;
    const mat = node.material;
    if (mat instanceof THREE.MeshStandardMaterial && mat.name === 'LibraryBindingAtlas') {
      mat.map = atlas;
      mat.color.set(0xffffff);
      mat.needsUpdate = true;
    }
  });
}

export interface InteriorPlacement {
  readonly room: number;
  readonly theme: InteriorTheme;
  readonly root: InteriorFurnishingRoot;
  readonly object: THREE.Object3D;
  readonly position: THREE.Vector3;
  readonly yaw: number;
}

export interface InteriorFurnishingsOptions {
  readonly reducedMotion?: boolean;
  readonly paintings?: readonly THREE.Texture[];
}

interface Candidate {
  root: InteriorFurnishingRoot;
  x: number;
  z: number;
  y?: number;
  yaw: number;
}
type RootBounds = Readonly<Record<InteriorFurnishingRoot, THREE.Box3>>;

const SIZES: Readonly<Record<InteriorFurnishingRoot, [number, number]>> = {
  DoorSingle: [1.7, 0.29],
  DoorDouble: [1.7, 0.29],
  DoorArched: [1.6, 0.25],
  Curtain: [2.09, 0.273],
  DiningChair: [0.56, 0.5],
  DiningTable: [1.75, 0.88],
  Bookcase: [1.56, 0.5],
  Candelabrum: [0.671, 0.7],
  WallClock: [0.55, 0.161],
  ClockworkArmor: [1.007, 0.6],
  FramedPainting: [0.97, 0.107],
};

const THEME_ROOTS: Readonly<Record<InteriorTheme, readonly InteriorFurnishingRoot[]>> = {
  library: ['Bookcase', 'WallClock', 'Candelabrum'],
  dining: ['DiningTable', 'DiningChair', 'Candelabrum'],
  gallery: ['Curtain', 'FramedPainting', 'WallClock'],
  workshop: ['ClockworkArmor', 'Bookcase', 'Candelabrum'],
};

const WALL_FIXTURES = new Set<InteriorFurnishingRoot>([
  'Bookcase',
  'WallClock',
  'FramedPainting',
  'Curtain',
]);

function boxFor(c: Candidate, roots: RootBounds, access = false): Box {
  const box = roots[c.root].clone();
  if (access && c.root === 'Bookcase') box.max.z += 0.65;
  box.applyMatrix4(new THREE.Matrix4().makeRotationY(c.yaw));
  box.translate(new THREE.Vector3(c.x, c.y ?? 0, c.z));
  return { min: box.min.toArray(), max: box.max.toArray() };
}

function overlaps(a: Box, b: Box, gap = 0.08): boolean {
  return (
    a.min[0] < b.max[0] + gap &&
    a.max[0] > b.min[0] - gap &&
    a.min[2] < b.max[2] + gap &&
    a.max[2] > b.min[2] - gap
  );
}

function worldBox(world: FloorWorld, room: number, box: Box): Box {
  const group = world.roomGroups[room];
  const corners = [
    new THREE.Vector3(box.min[0], box.min[1], box.min[2]),
    new THREE.Vector3(box.max[0], box.max[1], box.max[2]),
  ];
  group?.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromPoints(
    corners.map((corner) => group?.localToWorld(corner) ?? corner),
  );
  return {
    min: [bounds.min.x, bounds.min.y, bounds.min.z],
    max: [bounds.max.x, bounds.max.y, bounds.max.z],
  };
}

function blocked(
  world: FloorWorld,
  room: number,
  root: InteriorFurnishingRoot,
  box: Box,
  candidates: readonly Box[],
): boolean {
  const template = templateById(world.plan.rooms[room].templateId);
  // The north lancet and its sill are part of the baked wall, without a window collider.
  const windowX = template.id === 'hall' ? 2.6 : template.id === 'study' ? 0 : undefined;
  if (
    windowX !== undefined &&
    root !== 'Curtain' &&
    box.min[2] < template.footprint.min[1] + 0.55 &&
    box.min[0] < windowX + 0.78 &&
    box.max[0] > windowX - 0.78
  )
    return true;
  const placedWorld = worldBox(world, room, box);
  const footprint = world.rooms[room].footprint;
  if (
    world.colliders[room]?.some((c) => {
      // Perimeter collision extends 10 cm inside the room; the visible wall is on its footprint edge.
      const crossesWall =
        c.min[0] < footprint.min[0] - 0.01 ||
        c.max[0] > footprint.max[0] + 0.01 ||
        c.min[2] < footprint.min[1] - 0.01 ||
        c.max[2] > footprint.max[1] + 0.01;
      if (WALL_FIXTURES.has(root) && crossesWall) return false;
      return (
        placedWorld.min[1] < c.max[1] &&
        placedWorld.max[1] > c.min[1] &&
        overlaps(placedWorld, c, 0)
      );
    })
  )
    return true;
  if (
    template.doors.some((door) => {
      const [x, , z] = door.position;
      const apron = 0.55;
      const alongDoor = door.facing === 'N' || door.facing === 'S';
      const alongMin = (alongDoor ? x : z) - door.width / 2 - 0.18;
      const alongMax = (alongDoor ? x : z) + door.width / 2 + 0.18;
      const acrossMin = (alongDoor ? z : x) - apron;
      const acrossMax = (alongDoor ? z : x) + apron;
      const alongBoxMin = alongDoor ? box.min[0] : box.min[2];
      const alongBoxMax = alongDoor ? box.max[0] : box.max[2];
      const acrossBoxMin = alongDoor ? box.min[2] : box.min[0];
      const acrossBoxMax = alongDoor ? box.max[2] : box.max[0];
      return (
        alongBoxMin <= alongMax &&
        alongBoxMax >= alongMin &&
        acrossBoxMin <= acrossMax &&
        acrossBoxMax >= acrossMin
      );
    })
  )
    return true;
  const sockets: readonly Socket[] = [
    ...template.enemySockets,
    ...template.lootSockets,
    ...template.dressingSockets,
  ];
  const socketMargin =
    root === 'Candelabrum' || root === 'DiningTable' || root === 'DiningChair' ? 0.1 : 0.28;
  if (
    sockets.some((s) => {
      const [x, , z] = s.position;
      return (
        box.min[0] <= x + socketMargin &&
        box.max[0] >= x - socketMargin &&
        box.min[2] <= z + socketMargin &&
        box.max[2] >= z - socketMargin
      );
    })
  )
    return true;
  return candidates.some((c) => overlaps(box, c));
}

function candidatesFor(
  world: FloorWorld,
  room: number,
  theme: InteriorTheme,
  stream: Stream,
  rootBounds: RootBounds,
): Candidate[] {
  const placed = world.plan.rooms[room];
  const template = templateById(placed.templateId);
  const fp = template.footprint;
  const result: Candidate[] = [];
  const taken: Box[] = [];
  const sane = (group: Candidate[]) => {
    const bounds = group.map((candidate) => boxFor(candidate, rootBounds, true));
    if (
      bounds.some(
        (box, i) =>
          box.min[0] < fp.min[0] - 0.001 ||
          box.max[0] > fp.max[0] + 0.001 ||
          box.min[2] < fp.min[1] - 0.001 ||
          box.max[2] > fp.max[1] + 0.001 ||
          blocked(world, room, group[i].root, box, taken),
      )
    )
      return false;
    result.push(...group);
    taken.push(...bounds);
    return true;
  };
  if (theme === 'dining') {
    const angles = stream.shuffle([0, Math.PI / 2]);
    const corners = stream.shuffle([
      [-1, -1],
      [-1, 1],
      [1, -1],
      [1, 1],
    ]);
    dining: for (const [sx, sz] of corners)
      for (const yaw of angles) {
        const x = sx * (fp.max[0] - 1.85),
          z = sz * (fp.max[1] - 1.85);
        const seats = [-1, 1].map((side) => ({
          root: 'DiningChair' as const,
          x: x + Math.cos(yaw) * side * 1.25,
          z: z - Math.sin(yaw) * side * 1.25,
          yaw: yaw - (side * Math.PI) / 2,
        }));
        if (sane([{ root: 'DiningTable', x, z, yaw }, ...seats])) {
          result.push({ root: 'Candelabrum', x, z, y: 0.78, yaw });
          break dining;
        }
      }
  }
  function placeOnWall(root: InteriorFurnishingRoot, near?: Candidate): Candidate | undefined {
    const spots = spotsForWall(fp, SIZES[root][1], stream);
    if (near)
      spots.sort(
        (a, b) => Math.hypot(a.x - near.x, a.z - near.z) - Math.hypot(b.x - near.x, b.z - near.z),
      );
    for (const spot of spots) {
      const c: Candidate = {
        ...spot,
        root,
        y: root === 'WallClock' || root === 'FramedPainting' ? 1.18 : 0,
      };
      if (WALL_FIXTURES.has(root)) fitWallCandidate(c, rootBounds[root], fp);
      if (sane([c])) return c;
    }
  }

  for (const root of theme === 'dining' ? [] : THEME_ROOTS[theme]) {
    if (root === 'Curtain') continue;
    const c = placeOnWall(root);
    if (c && root === 'FramedPainting' && !placeOnWall('Bookcase', c)) {
      result.pop();
      taken.pop();
    }
  }
  const windowX = template.id === 'hall' ? 2.6 : template.id === 'study' ? 0 : undefined;
  if (windowX !== undefined && (theme === 'gallery' || theme === 'dining')) {
    const curtain: Candidate = {
      root: 'Curtain',
      x: windowX,
      z: fp.min[1],
      y: 1.3,
      yaw: 0,
    };
    fitWallCandidate(curtain, rootBounds.Curtain, fp);
    sane([curtain]);
  }
  return result;
}

function fitWallCandidate(candidate: Candidate, bounds: THREE.Box3, fp: Rect): void {
  const inset = (candidate.root === 'Curtain' ? 0.125 : 0.012) - bounds.min.z;
  switch (candidate.yaw) {
    case 0:
      candidate.z = fp.min[1] + inset;
      break;
    case Math.PI:
      candidate.z = fp.max[1] - inset;
      break;
    case Math.PI / 2:
      candidate.x = fp.min[0] + inset;
      break;
    case -Math.PI / 2:
      candidate.x = fp.max[0] - inset;
      break;
  }
}

function spotsForWall(
  fp: ReturnType<typeof templateById>['footprint'],
  depth: number,
  stream: Stream,
): { x: number; z: number; yaw: number }[] {
  const margin = 0.11 + depth / 2;
  const spots: { x: number; z: number; yaw: number }[] = [];
  for (const along of [-0.53, 0, 0.53]) {
    spots.push(
      { x: fp.min[0] + margin, z: along * fp.max[1], yaw: Math.PI / 2 },
      { x: fp.max[0] - margin, z: along * fp.max[1], yaw: -Math.PI / 2 },
      { x: along * fp.max[0], z: fp.min[1] + margin, yaw: 0 },
      { x: along * fp.max[0], z: fp.max[1] - margin, yaw: Math.PI },
    );
  }
  return stream.shuffle(spots);
}

const flameVertex =
  'varying vec2 vUv; void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}';
const flameFragment =
  'uniform float uTime; uniform float uMotion; varying vec2 vUv; void main(){vec2 p=vUv-.5; float a=1.0-smoothstep(.08,.5,length(vec2(p.x*(1.0+0.12*uMotion*sin(uTime*7.0)),p.y))); gl_FragColor=vec4(1.0,.32,.04,a); if(a<.01) discard;}';

export class InteriorFurnishings {
  readonly placements: readonly InteriorPlacement[];
  readonly themes: ReadonlyMap<number, InteriorTheme>;
  private readonly flameMaterials: THREE.ShaderMaterial[] = [];
  private readonly flameGeometry = new THREE.PlaneGeometry(0.09, 0.18);
  private readonly removeColliders: (() => void)[] = [];
  private readonly root: THREE.Group;
  private readonly paintings: readonly THREE.Texture[];
  private readonly paintingMaterials: THREE.MeshBasicMaterial[];
  private readonly paintingGeometry = new THREE.PlaneGeometry(0.91, 0.91);
  private elapsed = 0;
  private lastRoom: number;
  private readonly visited = new Set<number>();
  private readonly changedPaintings = new Set<number>();

  constructor(
    private readonly world: FloorWorld,
    asset: InteriorFurnishingsAsset,
    options: InteriorFurnishingsOptions = {},
  ) {
    const rootBounds = {} as Record<InteriorFurnishingRoot, THREE.Box3>;
    for (const name of ROOT_NAMES) {
      const root = asset.roots[name];
      root.updateMatrixWorld(true);
      const inverse = root.matrixWorld.clone().invert();
      const bounds = new THREE.Box3();
      root.traverse((node) => {
        const mesh = node as THREE.Mesh;
        if (!mesh.isMesh || !mesh.geometry) return;
        mesh.geometry.computeBoundingBox();
        if (!mesh.geometry.boundingBox) return;
        bounds.union(
          mesh.geometry.boundingBox
            .clone()
            .applyMatrix4(new THREE.Matrix4().multiplyMatrices(inverse, mesh.matrixWorld)),
        );
      });
      if (bounds.isEmpty()) {
        const [width, depth] = SIZES[name];
        bounds.set(
          new THREE.Vector3(-width / 2, 0, -depth / 2),
          new THREE.Vector3(width / 2, 2.4, depth / 2),
        );
      }
      rootBounds[name] = bounds;
    }
    this.root = new THREE.Group();
    this.root.name = 'interior-furnishings';
    this.paintings = options.paintings ?? [];
    this.paintingMaterials = this.paintings.map((texture) => {
      texture.flipY = true;
      const cropHeight = 540 / 720 / (0.77 / 0.79);
      texture.repeat.set(1, cropHeight);
      texture.offset.set(0, (1 - cropHeight) * 0.66);
      return new THREE.MeshBasicMaterial({ map: texture, transparent: true, toneMapped: false });
    });
    const stream = Stream.fromKey(`${world.plan.seed}:interior-furnishings`);
    const made: InteriorPlacement[] = [];
    const themes = new Map<number, InteriorTheme>();
    for (let room = 0; room < world.plan.rooms.length; room++) {
      if (
        world.plan.pressureWing &&
        [world.plan.pressureWing.gallery, world.plan.pressureWing.pumpRoom].includes(room)
      )
        continue;
      if (room === world.plan.guardianRoom) continue;
      if (world.plan.rooms[room]?.templateId === 'corridor') continue;
      const theme = (['library', 'dining', 'gallery', 'workshop'] as const)[stream.int(0, 3)];
      const candidates =
        world.plan.rooms[room]?.role === 'combat'
          ? candidatesFor(world, room, 'gallery', stream, rootBounds)
          : candidatesFor(world, room, theme, stream, rootBounds);
      for (const c of candidates) {
        const box = boxFor(c, rootBounds);
        const object = asset.roots[c.root].clone(true);
        object.name = `interior-${c.root}-${room}`;
        object.position.set(c.x, c.y ?? 0, c.z);
        object.rotation.y = c.yaw;
        world.roomGroups[room]?.add(object);
        const placement = {
          room,
          theme,
          root: c.root,
          object,
          position: new THREE.Vector3(c.x, c.y ?? 0, c.z),
          yaw: c.yaw,
        };
        made.push(placement);
        if (!c.y && c.root !== 'FramedPainting' && c.root !== 'WallClock' && c.root !== 'Curtain')
          this.removeColliders.push(world.addFixtureCollider(room, worldBox(world, room, box)));
        if (c.root === 'Candelabrum') this.addFlames(object, options.reducedMotion ?? false);
        if (c.root === 'FramedPainting' && this.paintingMaterials.length)
          this.setPainting(object, 0);
      }
      if (candidates.length) {
        themes.set(room, theme);
      }
    }
    this.placements = made;
    this.themes = themes;
    this.lastRoom = world.current;
    this.visited.add(world.current);
    world.group.updateMatrixWorld(true);
  }

  private addFlames(candelabrum: THREE.Object3D, reducedMotion: boolean): void {
    for (let i = 0; i < 6; i++) {
      const socket = candelabrum.getObjectByName(
        `Candelabrum_FlameSocket_${String(i).padStart(2, '0')}`,
      );
      if (!socket) continue;
      const material = new THREE.ShaderMaterial({
        vertexShader: flameVertex,
        fragmentShader: flameFragment,
        uniforms: { uTime: { value: 0 }, uMotion: { value: reducedMotion ? 0.2 : 1 } },
        transparent: true,
        depthWrite: false,
        toneMapped: false,
      });
      const flame = new THREE.Mesh(this.flameGeometry, material);
      flame.name = `flame-${i}`;
      flame.position.y = 0.04;
      socket.add(flame);
      this.flameMaterials.push(material);
    }
  }
  private setPainting(object: THREE.Object3D, index: number): void {
    const canvas =
      object.getObjectByName('Canvas') ?? object.getObjectByName('FramedPainting_Canvas');
    if (!canvas || !(canvas as THREE.Mesh).isMesh || !this.paintingMaterials[index]) return;
    let plane = object.getObjectByName('FramedPainting_Image') as THREE.Mesh | undefined;
    if (!plane) {
      plane = new THREE.Mesh(this.paintingGeometry, this.paintingMaterials[index]);
      plane.name = 'FramedPainting_Image';
      const geometry = (canvas as THREE.Mesh).geometry;
      geometry.computeBoundingBox();
      const front = geometry.boundingBox?.max.z ?? 0.088;
      plane.position.set(0, 0, front + 0.003);
      canvas.add(plane);
    } else plane.material = this.paintingMaterials[index];
    object.userData.paintingIndex = index;
  }
  update(dt: number, reducedMotion = false): void {
    this.elapsed += Math.max(0, dt);
    for (const material of this.flameMaterials) {
      material.uniforms.uTime.value = this.elapsed;
      material.uniforms.uMotion.value = reducedMotion ? 0.2 : 1;
    }
    const room = this.world.current;
    if (room !== this.lastRoom) {
      if (this.visited.has(room)) {
        const painting = this.placements.find(
          (p) => p.room === room && p.root === 'FramedPainting',
        );
        if (painting && this.paintingMaterials.length > 1 && !this.changedPaintings.has(room)) {
          const current = Number(painting.object.userData.paintingIndex ?? 0);
          this.setPainting(painting.object, (current + 1) % this.paintingMaterials.length);
          this.changedPaintings.add(room);
        }
      }
      this.visited.add(room);
      this.lastRoom = room;
    }
  }
  dispose(): void {
    for (const remove of this.removeColliders) remove();
    for (const p of this.placements) p.object.removeFromParent();
    for (const material of this.flameMaterials) material.dispose();
    for (const material of this.paintingMaterials) material.dispose();
    this.flameGeometry.dispose();
    this.paintingGeometry.dispose();
    this.root.removeFromParent();
  }
}
