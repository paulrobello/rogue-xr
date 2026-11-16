import * as THREE from 'three';
import type { RoomTemplate, Socket } from '../content/rooms.ts';
import { PALETTE } from '../palette.ts';
import { lootKey } from '../rules/run.ts';
import type { ToastLines } from './loot.ts';

const BOWL_RADIUS = 0.34;
const BOWL_FOOT = 0.2;
const BOWL_HEIGHT = 0.24;
const RIM_Y = 0.86;
const LEG_BASE_RADIUS = 0.3;
const LEG_COUNT = 3;
/** Seconds the coals take to fade from glowing to ash once the hearth is used. */
const DIM_SECONDS = 1.4;

const LIT = new THREE.Color('#ff8a24');
const ASH = new THREE.Color('#2b1a10');

/**
 * Where a rest room's hearth stands: the template's first loot socket (the generator gives a rest
 * room's loot socket no pickup, so it is free), else its first dressing socket, else null.
 */
export function hearthSocket(template: RoomTemplate): Socket | null {
  return template.lootSockets[0] ?? template.dressingSockets[0] ?? null;
}

/** The brass a hearth is dressed in (the caller owns it; the placeholder brass stays on a failure). */
export interface HearthMaterials {
  readonly brass: THREE.Material;
}

/** The two lines the in-scene panel shows when a hearth is used. The first is the hp gained. */
export function hearthLines(healed: number): ToastLines {
  return { text: `+${healed} hp`, caption: 'The hearth burns low' };
}

export interface Hearth {
  /** Room-local group at the rest room's socket, named `hearth-<room>-<socketId>`. */
  readonly object: THREE.Group;
  readonly room: number;
  readonly socketId: string;
  /** The `RunState.usedHearths` key. */
  readonly key: string;
  /** The invisible box a ray tests. */
  readonly hit: THREE.Mesh;
  readonly used: boolean;
  /** Starts the coals fading (or jumps them to ash when `animate` is false). Idempotent. */
  use(animate: boolean): void;
  update(dt: number): void;
}

/**
 * Shared geometry and placeholder materials for every hearth on one floor: a brass tripod brazier
 * with a rim and a bowl of coals. The coals are an unlit emissive surface, so a hearth adds no
 * dynamic light. The kit owns what it creates; materials handed to `dress` stay the caller's.
 */
export class HearthKit {
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly ownedMaterials: THREE.Material[] = [];
  private readonly brassMeshes: THREE.Mesh[] = [];
  private readonly brass = new THREE.MeshStandardMaterial({
    color: PALETTE.brass,
    roughness: 0.4,
    metalness: 0.55,
  });
  private readonly invisible = new THREE.MeshBasicMaterial({ visible: false });
  private readonly bowl = this.geometry(
    new THREE.CylinderGeometry(BOWL_RADIUS, BOWL_FOOT, BOWL_HEIGHT, 18),
  );
  private readonly rim = this.geometry(new THREE.TorusGeometry(BOWL_RADIUS, 0.022, 8, 24));
  private readonly ring = this.geometry(
    new THREE.TorusGeometry(LEG_BASE_RADIUS * 0.6, 0.016, 6, 18),
  );
  private readonly leg = this.geometry(new THREE.CylinderGeometry(0.02, 0.028, RIM_Y, 6));
  private readonly foot = this.geometry(new THREE.SphereGeometry(0.04, 8, 6));
  private readonly coals = this.geometry(
    new THREE.SphereGeometry(BOWL_RADIUS - 0.02, 16, 6, 0, Math.PI * 2, 0, Math.PI / 2).scale(
      1,
      0.32,
      1,
    ),
  );
  private readonly hitBox = this.geometry(new THREE.BoxGeometry(0.8, 1.1, 0.8));
  private dressing: HearthMaterials | null = null;

  constructor() {
    this.ownedMaterials.push(this.brass, this.invisible);
  }

  private geometry<T extends THREE.BufferGeometry>(g: T): T {
    this.geometries.push(g);
    return g;
  }

  private part(geometry: THREE.BufferGeometry, parent: THREE.Object3D, name: string): THREE.Mesh {
    const mesh = new THREE.Mesh(geometry, this.dressing?.brass ?? this.brass);
    mesh.name = name;
    parent.add(mesh);
    this.brassMeshes.push(mesh);
    return mesh;
  }

  /** Swaps the brass of every hearth built so far (and later ones) to `materials`. */
  dress(materials: HearthMaterials): void {
    this.dressing = materials;
    for (const mesh of this.brassMeshes) mesh.material = materials.brass;
  }

  /** Builds the hearth for `socket` of `room`, standing on the room floor. */
  build(room: number, socket: Socket): Hearth {
    const object = new THREE.Group();
    object.name = `hearth-${room}-${socket.id}`;
    object.position.set(socket.position[0], socket.position[1], socket.position[2]);
    object.rotation.y = (-socket.yaw * Math.PI) / 180;
    const bowl = this.part(this.bowl, object, 'hearth-bowl');
    bowl.position.y = RIM_Y - BOWL_HEIGHT / 2;
    const rim = this.part(this.rim, object, 'hearth-rim');
    rim.rotation.x = Math.PI / 2;
    rim.position.y = RIM_Y;
    const ring = this.part(this.ring, object, 'hearth-ring');
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.3;
    for (let i = 0; i < LEG_COUNT; i++) {
      const angle = (i / LEG_COUNT) * Math.PI * 2 + Math.PI / 6;
      const spread = 0.16;
      const leg = this.part(this.leg, object, 'hearth-leg');
      // Legs run from a wide foot on the floor up to the bowl's underside, leaning inward.
      leg.position.set(
        Math.cos(angle) * (LEG_BASE_RADIUS - spread / 2),
        RIM_Y / 2,
        Math.sin(angle) * (LEG_BASE_RADIUS - spread / 2),
      );
      leg.rotation.set(
        Math.sin(angle) * Math.atan2(spread, RIM_Y),
        0,
        -Math.cos(angle) * Math.atan2(spread, RIM_Y),
      );
      const foot = this.part(this.foot, object, 'hearth-foot');
      foot.position.set(Math.cos(angle) * LEG_BASE_RADIUS, 0.03, Math.sin(angle) * LEG_BASE_RADIUS);
    }
    const coalMaterial = new THREE.MeshBasicMaterial({ color: LIT.clone(), toneMapped: false });
    const coals = new THREE.Mesh(this.coals, coalMaterial);
    coals.name = 'hearth-coals';
    coals.position.y = RIM_Y - 0.01;
    object.add(coals);
    const hit = new THREE.Mesh(this.hitBox, this.invisible);
    hit.name = 'hearth-hit';
    hit.position.y = 0.55;
    object.add(hit);
    this.ownedMaterials.push(coalMaterial);

    let clock = 0;
    let target = 0;
    let dim = 0;
    const hearth: Hearth = {
      object,
      room,
      socketId: socket.id,
      key: lootKey(room, socket.id),
      hit,
      get used() {
        return target > 0;
      },
      use(animate) {
        target = 1;
        if (!animate) {
          dim = 1;
          coalMaterial.color.copy(ASH);
        }
      },
      update(dt) {
        clock += dt;
        if (dim < target) {
          dim = Math.min(target, dim + dt / DIM_SECONDS);
          coalMaterial.color.copy(LIT).lerp(ASH, dim);
        } else if (target === 0) {
          // A slow flicker of the coals: brightness only, no light.
          const flicker = 0.88 + 0.12 * Math.sin(clock * 5.1) * Math.sin(clock * 2.3 + 1);
          coalMaterial.color.copy(LIT).multiplyScalar(flicker);
        }
      },
    };
    object.userData.hearth = hearth;
    return hearth;
  }

  dispose(): void {
    for (const g of this.geometries) g.dispose();
    for (const m of this.ownedMaterials) m.dispose();
    this.brassMeshes.length = 0;
  }
}

/** What a ray found: the hearth's identity for `RunFlow.useHearth`, and how far away it is. */
export interface HearthPick {
  readonly room: number;
  readonly socketId: string;
  readonly distance: number;
}

/** First unused hearth in `hearths` that the ray reaches within `maxDistance`, or null. */
export function pickHearth(
  hearths: readonly Hearth[],
  origin: THREE.Vector3,
  direction: THREE.Vector3,
  maxDistance: number,
): HearthPick | null {
  const raycaster = new THREE.Raycaster(origin, direction.clone().normalize(), 0, maxDistance);
  let best: HearthPick | null = null;
  for (const hearth of hearths) {
    if (hearth.used) continue;
    hearth.hit.updateWorldMatrix(true, false);
    const hit = raycaster.intersectObject(hearth.hit, false)[0];
    if (hit && (best === null || hit.distance < best.distance)) {
      best = { room: hearth.room, socketId: hearth.socketId, distance: hit.distance };
    }
  }
  return best;
}
