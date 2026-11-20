import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { glb_sha256 } from '../../assets-source/props/interior-furnishings/provenance.json';
import { type Box, type Rect, type Socket, templateById } from '../content/rooms.ts';
import { Stream } from '../core/rng.ts';
import { candleMaterial } from './candle-flame.ts';
import type { FloorWorld } from './floor-world.ts';
import { roomStyleFor } from './room-styles.ts';

export const INTERIOR_FURNISHINGS_BASE = '/assets/props/interior-furnishings';
export const INTERIOR_PAINTINGS = [
  '/assets/props/paintings/clockmaker-first.webp',
  '/assets/props/paintings/clockmaker-return.webp',
  '/assets/props/paintings/river-valley.webp',
  '/assets/props/paintings/pears-and-pitcher.webp',
  '/assets/props/paintings/coastal-cliffs.webp',
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
    assetPromise = new GLTFLoader()
      .loadAsync(`${base}/interior-furnishings.glb?v=${glb_sha256}`)
      .then((gltf) => {
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
  readonly preservedBookRooms?: readonly number[];
  readonly floorNumber?: 1 | 2;
}

interface Candidate {
  root: InteriorFurnishingRoot;
  x: number;
  z: number;
  y?: number;
  yaw: number;
  clueEligible?: boolean;
}
type RootBounds = Readonly<Record<InteriorFurnishingRoot, THREE.Box3>>;

const SIZES: Readonly<Record<InteriorFurnishingRoot, [number, number]>> = {
  DoorSingle: [1.7, 0.29],
  DoorDouble: [1.7, 0.29],
  DoorArched: [1.6, 0.25],
  Curtain: [2.31, 0.331],
  DiningChair: [0.56, 0.5],
  DiningTable: [1.75, 0.88],
  Bookcase: [1.56, 0.5],
  Candelabrum: [0.671, 0.7],
  WallClock: [0.55, 0.161],
  ClockworkArmor: [1.007, 0.6],
  FramedPainting: [1.02, 0.158],
};

// The hall's lower bay molding tops out at 1.49 m above the floor.
const PAINTING_BOTTOM_Y = 1.65;
const WALL_ART_CENTRE_Y = 2.345;

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
  occupied: readonly Candidate[] = [],
  requested: readonly InteriorFurnishingRoot[] = THEME_ROOTS[theme],
): Candidate[] {
  const placed = world.plan.rooms[room];
  const template = templateById(placed.templateId);
  const fp = template.footprint;
  const result: Candidate[] = [];
  const taken = occupied.map((c) => boxFor(c, rootBounds, true));
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
    const centers = corners.map(([sx, sz]) => [sx * (fp.max[0] - 1.85), sz * (fp.max[1] - 1.85)]);
    if (world.plan.seed === 'MAPTEST2') {
      for (const x of [-0.55, 0, 0.55])
        for (const z of [-0.54, -0.28, 0.28, 0.54]) centers.push([x * fp.max[0], z * fp.max[1]]);
    }
    dining: for (const [x, z] of centers)
      for (const yaw of angles) {
        const seats = [-1, 1].map((side) => ({
          root: 'DiningChair' as const,
          x: x + Math.cos(yaw) * side * 1.25,
          z: z - Math.sin(yaw) * side * 1.25,
          yaw: yaw - (side * Math.PI) / 2,
        }));
        if (sane([{ root: 'DiningTable', x, z, yaw }, ...seats])) {
          result.push({
            root: 'Candelabrum',
            x,
            z,
            y: rootBounds.DiningTable.max.y - rootBounds.Candelabrum.min.y,
            yaw,
          });
          break dining;
        }
      }
  }
  function placeOnWall(root: InteriorFurnishingRoot, near?: Candidate): Candidate | undefined {
    const spots = spotsForWall(fp, root, stream, template.id);
    if (near)
      spots.sort(
        (a, b) => Math.hypot(a.x - near.x, a.z - near.z) - Math.hypot(b.x - near.x, b.z - near.z),
      );
    for (const spot of spots) {
      const c: Candidate = {
        ...spot,
        root,
        y: 0,
      };
      if (root === 'FramedPainting' || root === 'WallClock') {
        const bounds = rootBounds[root];
        c.y = Math.max(
          PAINTING_BOTTOM_Y - bounds.min.y,
          WALL_ART_CENTRE_Y - (bounds.max.y + bounds.min.y) / 2,
        );
      }
      if (WALL_FIXTURES.has(root)) fitWallCandidate(c, rootBounds[root], fp);
      if (sane([c])) return c;
    }
  }

  for (const root of theme === 'dining' ? [] : requested) {
    if (root === 'Curtain') continue;
    const c = placeOnWall(root);
    if (c && root === 'FramedPainting') {
      c.clueEligible = Boolean(placeOnWall('Bookcase', c));
    }
  }
  const windowX = template.id === 'hall' ? 2.6 : template.id === 'study' ? 0 : undefined;
  if (
    windowX !== undefined &&
    roomStyleFor(world.plan, room) !== 'timber' &&
    (theme === 'gallery' || theme === 'dining')
  ) {
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
  const inset = (candidate.root === 'Curtain' ? 0.003 : 0.012) - bounds.min.z;
  if (candidate.yaw === 0) candidate.z = fp.min[1] + inset;
  else if (candidate.yaw === Math.PI) candidate.z = fp.max[1] - inset;
  else if (candidate.yaw === Math.PI / 2) candidate.x = fp.min[0] + inset;
  else candidate.x = fp.max[0] - inset;
}

type Wall = 'N' | 'S' | 'E' | 'W';
// Free wallpaper spans in the room kit’s wall frame, increasing to the viewer’s right.
// The hall uses its molded apertures. The study and shaft spans stop at baked furniture,
// doorway surrounds, lanterns and sconces that do not all have gameplay colliders.
const WALL_BAYS: Record<string, Partial<Record<Wall, readonly [number, number][]>>> = {
  hall: {
    E: [
      [-2.3, -0.1],
      [2.7, 4.8],
    ],
    W: [
      [-2.3, -0.1],
      [2.7, 4.8],
    ],
    S: [
      [0, 2.3],
      [2.7, 4.8],
    ],
  },
  study: { S: [[-3.85, -0.15]], E: [[0.15, 3.85]], W: [[-3.85, -1.55]] },
  'gear-shaft': {
    N: [[-3.8, -0.15]],
    S: [[-3.8, -0.15]],
    E: [
      [-5.1, -3.28],
      [-2.75, 2.75],
      [3.28, 5.85],
    ],
    W: [
      [-5.85, -4.1],
      [-3.48, -2.1],
      [0.12, 3.28],
      [3.9, 5.05],
    ],
  },
};

function spotsForWall(
  fp: Rect,
  root: InteriorFurnishingRoot,
  stream: Stream,
  templateId: string,
): { x: number; z: number; yaw: number }[] {
  const spots: { x: number; z: number; yaw: number }[] = [];
  const bays = WALL_FIXTURES.has(root) ? WALL_BAYS[templateId] : undefined;
  const [width, depth] = SIZES[root];
  const inset = 0.11 + depth / 2;
  for (const wall of ['W', 'E', 'N', 'S'] as const) {
    const half = wall === 'N' || wall === 'S' ? fp.max[0] : fp.max[1];
    const centres = bays
      ? (bays[wall] ?? []).filter(([a, b]) => b - a >= width + 0.1).map(([a, b]) => (a + b) / 2)
      : [-half * 0.53, 0, half * 0.53];
    for (const along of centres) {
      switch (wall) {
        case 'W':
          spots.push({ x: fp.min[0] + inset, z: -along, yaw: Math.PI / 2 });
          break;
        case 'E':
          spots.push({ x: fp.max[0] - inset, z: along, yaw: -Math.PI / 2 });
          break;
        case 'N':
          spots.push({ x: along, z: fp.min[1] + inset, yaw: 0 });
          break;
        case 'S':
          spots.push({ x: -along, z: fp.max[1] - inset, yaw: Math.PI });
          break;
      }
    }
  }
  return stream.shuffle(spots);
}

const FLAME_HEIGHT = 0.135;
export class InteriorFurnishings {
  readonly placements: readonly InteriorPlacement[];
  readonly themes: ReadonlyMap<number, InteriorTheme>;
  private readonly flameMaterials: THREE.ShaderMaterial[] = [];
  private readonly flameGeometry = new THREE.PlaneGeometry(0.096, FLAME_HEIGHT);
  private readonly removeColliders: (() => void)[] = [];
  private readonly root: THREE.Group;
  private readonly paintings: readonly THREE.Texture[];
  private readonly paintingMaterials: THREE.MeshBasicMaterial[];
  private readonly paintingGeometry = new THREE.PlaneGeometry(0.78, 0.8);
  private readonly cluePaintingRoom: number | undefined;
  private elapsed = 0;
  private lastRoom: number;
  private readonly cluePainting?: THREE.Object3D;
  private readonly knobGeometry = new THREE.SphereGeometry(0.033, 16, 10);
  private readonly knobMaterial = new THREE.MeshStandardMaterial({
    color: 0xa57b49,
    metalness: 0.52,
    roughness: 0.38,
  });
  private readonly portraitBounds = new THREE.Box3();
  private readonly eyeFrustum = new THREE.Frustum();
  private readonly projectionView = new THREE.Matrix4();
  private changePending = false;
  private clueSeen = false;

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
    this.paintingMaterials = this.paintings.map((texture, index) => {
      texture.flipY = true;
      if (index < 2) {
        const cropHeight = 540 / 720 / (0.77 / 0.79);
        texture.repeat.set(1, cropHeight);
        texture.offset.set(0, (1 - cropHeight) * 0.66);
      } else {
        texture.repeat.set(1, 1);
        texture.offset.set(0, 0);
      }
      return new THREE.MeshBasicMaterial({ map: texture, transparent: true, toneMapped: false });
    });
    const stream = Stream.fromKey(`${world.plan.seed}:interior-furnishings`);
    const decorativeIndices = Stream.fromKey(`${world.plan.seed}:interior-paintings`).shuffle(
      this.paintingMaterials.slice(2).map((_, index) => index + 2),
    );
    const paintingsToDress: { object: THREE.Object3D; room: number; eligible: boolean }[] = [];
    const planned: { room: number; theme: InteriorTheme; candidates: Candidate[] }[] = [];
    const made: InteriorPlacement[] = [];
    const themes = new Map<number, InteriorTheme>();
    const upperIndustrial = options.floorNumber === 2;
    for (let room = 0; room < world.plan.rooms.length; room++) {
      if (
        world.plan.pressureWing &&
        [world.plan.pressureWing.gallery, world.plan.pressureWing.pumpRoom].includes(room)
      )
        continue;
      if (room === world.plan.guardianRoom) continue;
      if (world.plan.rooms[room]?.templateId === 'corridor') continue;
      const style = roomStyleFor(world.plan, room, options.floorNumber ?? 1);
      const upperIndustrialRoom = upperIndustrial && (style === 'boiler' || room === 0);
      const theme = upperIndustrialRoom
        ? 'workshop'
        : (['library', 'dining', 'gallery', 'workshop'] as const)[stream.int(0, 3)];
      const candidates = upperIndustrialRoom
        ? candidatesFor(
            world,
            room,
            'workshop',
            stream,
            rootBounds,
            [],
            ['ClockworkArmor', 'Bookcase'],
          )
        : world.plan.rooms[room]?.role === 'combat'
          ? candidatesFor(world, room, 'gallery', stream, rootBounds)
          : candidatesFor(world, room, theme, stream, rootBounds);
      planned.push({ room, theme, candidates });
    }
    // Try an entrance gallery if the natural themes produced no reachable book-and-portrait pair.
    if (!planned.some((entry) => entry.candidates.some((c) => c.clueEligible))) {
      const entrance = planned.find((entry) => entry.room === 0);
      if (entrance) {
        const fallback = Stream.fromKey(`${world.plan.seed}:entrance-gallery`);
        for (let i = 0; i < 12; i++) {
          const candidates = candidatesFor(world, 0, 'gallery', fallback, rootBounds);
          if (candidates.some((c) => c.clueEligible)) {
            entrance.theme = 'gallery';
            entrance.candidates = candidates;
            break;
          }
        }
      }
    }
    const showcase = world.plan.seed === 'MAPTEST2';
    const secrets = Stream.fromKey(`${world.plan.seed}:bookcase-secrets`);
    const preserved = new Set(options.preservedBookRooms ?? []);
    for (const entry of planned) {
      if (!preserved.has(entry.room) || entry.candidates.some((c) => c.root === 'Bookcase'))
        continue;
      // Older saves can hold a key in a room that has since changed theme. Reserve its cabinet first.
      const [restored] = candidatesFor(
        world,
        entry.room,
        'library',
        secrets,
        rootBounds,
        [],
        ['Bookcase'],
      );
      if (restored) {
        const clearance = boxFor(restored, rootBounds, true);
        entry.candidates = entry.candidates.filter(
          (c) => !overlaps(clearance, boxFor(c, rootBounds, true)),
        );
        entry.candidates.push(restored);
      }
    }
    const paired = planned.filter((entry) =>
      entry.candidates.some((c) => c.root === 'FramedPainting' && c.clueEligible),
    );
    const secretRoom = preserved.size
      ? paired.find((p) => preserved.has(p.room))?.room
      : showcase || secrets.int(0, 2) === 0
        ? paired[0]?.room
        : undefined;
    const activeBooks = new Set(preserved);
    if (secretRoom !== undefined) activeBooks.add(secretRoom);
    const plainRooms = planned.filter(
      (p) => !activeBooks.has(p.room) && p.candidates.some((c) => c.root === 'Bookcase'),
    );
    const ordinaryRoom =
      plainRooms.length && (showcase || secrets.next() < 0.65)
        ? secrets.pick(plainRooms).room
        : undefined;
    for (const entry of planned) {
      if (!activeBooks.has(entry.room) && entry.room !== ordinaryRoom)
        entry.candidates = entry.candidates.filter((c) => c.root !== 'Bookcase');
    }
    if (showcase) {
      const entrance = planned.find((p) => p.room === 0);
      if (entrance && !entrance.candidates.some((c) => c.root === 'ClockworkArmor')) {
        entrance.candidates.push(
          ...candidatesFor(
            world,
            0,
            'workshop',
            Stream.fromKey('MAPTEST2:armor'),
            rootBounds,
            entrance.candidates,
            ['ClockworkArmor'],
          ),
        );
      }
    }
    if (showcase && !planned.some((p) => p.candidates.some((c) => c.root === 'DiningTable'))) {
      const venues = planned.filter((p) => p.room !== 0 && !activeBooks.has(p.room));
      for (const venue of venues) {
        const group = candidatesFor(
          world,
          venue.room,
          'dining',
          Stream.fromKey('MAPTEST2:dining'),
          rootBounds,
          venue.candidates,
        );
        if (!group.some((c) => c.root === 'DiningTable')) continue;
        venue.candidates.push(...group.filter((c) => c.root !== 'Curtain'));
        break;
      }
    }
    for (const { room, theme, candidates } of planned) {
      for (const c of candidates) {
        if (c.root === 'Curtain' && upperIndustrial && roomStyleFor(world.plan, room, 2)) continue;
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
          paintingsToDress.push({ object, room, eligible: c.clueEligible ?? false });
      }
      if (candidates.length) {
        themes.set(room, theme);
      }
    }
    const clue = paintingsToDress.find((p) => p.room === secretRoom);
    for (const p of made) {
      if (p.root !== 'Bookcase') continue;
      const marked = activeBooks.has(p.room);
      const book = p.object.getObjectByName('Bookcase_PullBook');
      if (book) book.userData.bookSecret = marked;
      if (!marked) {
        const ribbon = book?.getObjectByName('Red_ribbon');
        if (ribbon) ribbon.visible = false;
        const lock = p.object.getObjectByName('Lock_escutcheon');
        if (lock) lock.visible = false;
        const panel = p.object.getObjectByName('Bookcase_Slider');
        if (panel) {
          const knob = new THREE.Mesh(this.knobGeometry, this.knobMaterial);
          knob.name = 'bookcase-drawer-knob';
          knob.scale.set(1, 1, 0.65);
          knob.position.set(0, 0.31, 0.044);
          panel.add(knob);
        }
      }
    }
    if (this.paintingMaterials.length) {
      if (clue) this.setPainting(clue.object, 0);
      for (const painting of paintingsToDress) {
        if (painting === clue) continue;
        const index = decorativeIndices.shift();
        if (index !== undefined) this.setPainting(painting.object, index);
        else painting.object.removeFromParent();
      }
    }
    this.cluePaintingRoom = clue?.room;
    this.cluePainting = clue?.object;
    this.placements = made.filter((placement) => placement.object.parent !== null);
    this.themes = themes;
    this.lastRoom = world.current;

    world.group.updateMatrixWorld(true);
  }

  private addFlames(candelabrum: THREE.Object3D, reducedMotion: boolean): void {
    for (let i = 0; i < 6; i++) {
      const socket = candelabrum.getObjectByName(
        `Candelabrum_FlameSocket_${String(i).padStart(2, '0')}`,
      );
      if (!socket) continue;
      const phase = i * 2.39996 + candelabrum.position.x * 0.63 + candelabrum.position.z * 0.83;
      const material = candleMaterial(phase, reducedMotion);
      const flame = new THREE.Mesh(this.flameGeometry, material);
      flame.name = `flame-${i}`;
      flame.position.y = FLAME_HEIGHT / 2 - 0.006;
      flame.raycast = () => undefined;
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
      const canvasBounds = geometry.boundingBox;
      const front = canvasBounds?.max.z ?? 0.088;
      if (canvasBounds) {
        plane.scale.set(
          (canvasBounds.max.x - canvasBounds.min.x + 0.02) / 0.78,
          (canvasBounds.max.y - canvasBounds.min.y + 0.02) / 0.8,
          1,
        );
      }
      plane.position.set(0, 0, front + 0.003);
      canvas.add(plane);
    } else plane.material = this.paintingMaterials[index];
    object.userData.paintingIndex = index;
  }
  update(dt: number, reducedMotion = false, cameras: readonly THREE.Camera[] = []): void {
    this.elapsed += Math.max(0, dt);
    for (const material of this.flameMaterials) {
      material.uniforms.uTime.value = this.elapsed;
      material.uniforms.uMotion.value = reducedMotion ? 0 : 1;
    }
    const room = this.world.current;
    const painting = this.cluePainting;
    if (painting && painting.userData.paintingIndex === 0 && this.paintingMaterials.length > 1) {
      if (this.clueSeen && this.lastRoom === this.cluePaintingRoom && room !== this.lastRoom)
        this.changePending = true;
      if (
        cameras.length &&
        (this.changePending || (!this.clueSeen && room === this.cluePaintingRoom))
      ) {
        this.portraitBounds.setFromObject(painting);
        const visible = cameras.some((eye) => {
          // XRManager has already composed each eye with the locomotion rig.
          this.projectionView.multiplyMatrices(eye.projectionMatrix, eye.matrixWorldInverse);
          this.eyeFrustum.setFromProjectionMatrix(
            this.projectionView,
            eye.coordinateSystem,
            eye.reversedDepth,
          );
          return this.eyeFrustum.intersectsBox(this.portraitBounds);
        });
        if (visible) this.clueSeen = true;
        else if (this.changePending) {
          this.setPainting(painting, 1);
          this.changePending = false;
        }
      }
    }
    this.lastRoom = room;
  }
  dispose(): void {
    for (const remove of this.removeColliders) remove();
    for (const p of this.placements) p.object.removeFromParent();
    for (const material of this.flameMaterials) material.dispose();
    for (const material of this.paintingMaterials) material.dispose();
    this.knobGeometry.dispose();
    this.knobMaterial.dispose();
    this.flameGeometry.dispose();
    this.paintingGeometry.dispose();
    this.root.removeFromParent();
  }
}
