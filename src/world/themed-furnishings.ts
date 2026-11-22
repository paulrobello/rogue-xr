import * as THREE from 'three';
import type { FloorWorld } from './floor-world.ts';
import type { InteriorPlacement } from './interior-furnishings.ts';
import { findPuzzleMount, kitPart } from './puzzle-placement.ts';
import type { StoneRoomKit } from './stone-rooms.ts';
import { createFloorContactShadow } from './table-decor.ts';

type FurnishingProfile = 'walnut' | 'steel' | 'glazed';
type Surface = 'shelf' | 'planter' | 'dishes' | 'rim' | 'iron' | 'brass';
type Finish = readonly [color: number, metalness: number, roughness: number];
type ShelfProp = Readonly<{
  surface: 'dishes' | 'planter';
  height: 'middle' | 'top';
  x: number;
  scale: number;
  yaw: number;
}>;

const PROFILES: Record<
  FurnishingProfile,
  {
    scale: readonly [number, number, number];
    finishes: Record<Surface, Finish>;
    props: readonly ShelfProp[];
  }
> = {
  walnut: {
    scale: [1.14, 1, 1.12],
    finishes: {
      shelf: [0xffe9d4, 0.02, 0.56],
      planter: [0x9e5837, 0.04, 0.61],
      dishes: [0xdfceb0, 0.04, 0.38],
      rim: [0xa57951, 0.32, 0.44],
      iron: [0x694c35, 0.56, 0.44],
      brass: [0xc59a61, 0.64, 0.37],
    },
    props: [
      { surface: 'dishes', height: 'middle', x: -0.22, scale: 1.08, yaw: 0.08 },
      { surface: 'planter', height: 'top', x: 0.28, scale: 0.73, yaw: 0.28 },
    ],
  },
  steel: {
    scale: [1.26, 0.87, 1.22],
    finishes: {
      shelf: [0x626e73, 0.52, 0.47],
      planter: [0x986147, 0.36, 0.49],
      dishes: [0x997c5e, 0.68, 0.4],
      rim: [0x6b777a, 0.56, 0.42],
      iron: [0x454f55, 0.62, 0.41],
      brass: [0xb77c50, 0.62, 0.37],
    },
    props: [
      { surface: 'dishes', height: 'top', x: -0.28, scale: 1.08, yaw: 0.12 },
      { surface: 'dishes', height: 'top', x: 0.28, scale: 0.85, yaw: Math.PI - 0.38 },
      { surface: 'dishes', height: 'middle', x: 0.18, scale: 1, yaw: -0.17 },
    ],
  },
  glazed: {
    scale: [1.05, 1.16, 1.08],
    finishes: {
      shelf: [0x3c472d, 0.16, 0.54],
      planter: [0xa29d73, 0.08, 0.35],
      dishes: [0xd5cda1, 0.06, 0.35],
      rim: [0xc5ab74, 0.26, 0.38],
      iron: [0x59604a, 0.43, 0.43],
      brass: [0xc7a263, 0.56, 0.35],
    },
    props: [
      { surface: 'planter', height: 'top', x: 0.25, scale: 0.91, yaw: 0.18 },
      { surface: 'planter', height: 'top', x: -0.24, scale: 0.59, yaw: -1.3 },
      { surface: 'dishes', height: 'middle', x: -0.12, scale: 0.97, yaw: 0.3 },
    ],
  },
};

const profileFor = (room: THREE.Group, floorNumber: 1 | 2 | 3): FurnishingProfile => {
  if (floorNumber === 3) return 'glazed';
  if (room.userData.roomStyle === 'boiler') return 'steel';
  return 'walnut';
};

const MATERIAL_SURFACES: Readonly<Record<string, Surface | undefined>> = {
  'Stone walnut': 'shelf',
  'Stone iron': 'iron',
  'Stone brass': 'brass',
  'Stone worn edges': 'rim',
};

function dressMaterials(
  root: THREE.Object3D,
  profile: FurnishingProfile,
  ceramic?: 'dishes' | 'planter',
): () => void {
  const owned = new Map<THREE.Material, THREE.Material>();
  const dress = (source: THREE.Material): THREE.Material => {
    const surface = source.name === 'Stone ceramic' ? ceramic : MATERIAL_SURFACES[source.name];
    if (!surface || !(source instanceof THREE.MeshStandardMaterial)) return source;
    const cached = owned.get(source);
    if (cached) return cached;
    const material = source.clone();
    const [color, metalness, roughness] = PROFILES[profile].finishes[surface];
    // The stone kit's base maps already contain their pigment.
    if (profile !== 'walnut' || surface !== 'shelf') material.map = null;
    material.color.setHex(color);
    material.metalness = metalness;
    material.roughness = roughness;
    material.name = `themed-${profile}-${surface}`;
    owned.set(source, material);
    return material;
  };
  root.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) return;
    node.material = Array.isArray(node.material) ? node.material.map(dress) : dress(node.material);
  });
  return () => {
    for (const material of owned.values()) material.dispose();
  };
}

function eligible(
  world: FloorWorld,
  index: number,
  room: THREE.Group,
  floorNumber: 1 | 2 | 3,
): boolean {
  const placed = world.plan.rooms[index];
  if (!placed || !['hall', 'study'].includes(placed.templateId)) return false;
  if (placed.encounter || placed.role === 'guardian' || (floorNumber === 3 && index === 0))
    return false;
  if (world.stairEntry?.room === index || world.plan.armoryAlcove?.room === index) return false;
  return !String(room.userData.roomStyle).startsWith('stone-');
}

/** Dresses styled halls and studies after gameplay fixtures have claimed their clearance. */
function nearBuiltInPractical(room: THREE.Group, wallPosition: THREE.Vector3): boolean {
  const matrix = new THREE.Matrix4();
  const center = new THREE.Vector3();
  room.updateWorldMatrix(true, true);
  return room.children.some((part) => {
    if (!(part instanceof THREE.InstancedMesh) || part.material.name !== 'PracticalAmberGlass')
      return false;
    part.geometry.computeBoundingBox();
    const bounds = part.geometry.boundingBox;
    if (!bounds) return false;
    for (let i = 0; i < part.count; i++) {
      part.getMatrixAt(i, matrix);
      bounds.getCenter(center).applyMatrix4(matrix).applyMatrix4(part.matrixWorld);
      if (Math.hypot(center.x - wallPosition.x, center.z - wallPosition.z) < 2.1) return true;
    }
    return false;
  });
}

export function furnishThemedRoom(
  world: FloorWorld,
  index: number,
  room: THREE.Group,
  kit: StoneRoomKit,
  existing: readonly InteriorPlacement[],
  floorNumber: 1 | 2 | 3,
): readonly (() => void)[] {
  if (!eligible(world, index, room, floorNumber)) return [];
  const profile = profileFor(room, floorNumber);
  const releases: (() => void)[] = [];
  const parent = world.roomGroups[index];
  const attach = (object: THREE.Object3D) => {
    parent.add(object);
    if (room !== parent) room.attach(object);
  };
  const shelfMount = findPuzzleMount(
    world,
    [index],
    existing,
    `themed-shelf-${index}`,
    0.78,
    1.35,
    1.73,
  );
  if (shelfMount) {
    const shelf = kit.StoneShelf.clone(true);
    shelf.name = `ThemedShelf-${profile}`;
    shelf.scale.fromArray(PROFILES[profile].scale);
    shelf.position.copy(shelfMount.center).setY(0);
    shelf.rotation.y = shelfMount.yaw;
    shelf.translateZ(0.28);
    const { props, scale } = PROFILES[profile];
    const middle = kitPart(shelf, 'SocketShelfDish');
    const top = kitPart(shelf, 'SocketShelfPlant');
    const disposeFinishes = [dressMaterials(shelf, profile)];
    const batches = new Map<ShelfProp['surface'], THREE.Group[]>();
    for (const { surface, height, x, scale: propScale, yaw } of props) {
      const socket = height === 'top' ? top : middle;
      const anchor = new THREE.Group();
      anchor.name = surface === 'dishes' ? 'ThemedDishes' : 'ThemedPlanter';
      anchor.position.x = x / scale[0] - socket.position.x;
      anchor.scale.set(propScale / scale[0], propScale / scale[1], propScale / scale[2]);
      const turned = new THREE.Group();
      turned.rotation.y = yaw;
      anchor.add(turned);
      socket.add(anchor);
      const placements = batches.get(surface) ?? [];
      placements.push(turned);
      batches.set(surface, placements);
    }
    shelf.updateWorldMatrix(true, true);
    const inverse = shelf.matrixWorld.clone().invert();
    for (const [surface, placements] of batches) {
      const prop = (surface === 'dishes' ? kit.StoneDishes : kit.StonePlanter).clone(true);
      disposeFinishes.push(dressMaterials(prop, profile, surface));
      prop.updateWorldMatrix(true, true);
      prop.traverse((node) => {
        if (!(node instanceof THREE.Mesh)) return;
        const mesh = new THREE.InstancedMesh(node.geometry, node.material, placements.length);
        mesh.name = node.name;
        for (const [i, position] of placements.entries()) {
          const matrix = new THREE.Matrix4().multiplyMatrices(inverse, position.matrixWorld);
          mesh.setMatrixAt(i, matrix.multiply(node.matrixWorld));
        }
        mesh.computeBoundingBox();
        shelf.add(mesh);
        disposeFinishes.push(() => mesh.dispose());
      });
    }
    attach(shelf);
    const bounds = new THREE.Box3().setFromObject(shelf);
    const removeCollider = world.addFixtureCollider(index, {
      min: bounds.min.toArray(),
      max: bounds.max.toArray(),
    });
    const shadow = room.userData.roomStyle ? null : createFloorContactShadow(0.44, 0.13);
    if (shadow) {
      shadow.name = 'ThemedShelfContact';
      shadow.scale.z = 0.39;
      shelf.add(shadow);
    }
    releases.push(() => {
      removeCollider();
      shelf.removeFromParent();
      for (const dispose of disposeFinishes) dispose();
      shadow?.geometry.dispose();
      shadow?.material.dispose();
    });
  }
  // The baked shells already have practicals and cannot receive the new lamp's light pool.
  if (!room.userData.roomStyle) return releases;
  const lightMount = findPuzzleMount(world, [index], existing, `themed-light-${index}`, 0.29, 0.45);
  if (
    lightMount &&
    !nearBuiltInPractical(room, parent.localToWorld(lightMount.wallSurface.clone()))
  ) {
    const light = kit.StoneTorch.clone(true);
    light.name = `ThemedWallLight-${profile}`;
    light.position.copy(lightMount.wallSurface).setY(1.54);
    light.rotation.y = lightMount.yaw;
    light.translateZ(0.042);
    const disposeLight = dressMaterials(light, profile);
    attach(light);
    const sockets = room.userData.themedTorchSockets ?? [];
    room.userData.themedTorchSockets = sockets;
    const socket = kitPart(light, 'SocketTorchLight');
    sockets.push(socket);
    releases.push(() => {
      light.removeFromParent();
      const i = sockets.indexOf(socket);
      if (i >= 0) sockets.splice(i, 1);
      disposeLight();
    });
  }
  return releases;
}
