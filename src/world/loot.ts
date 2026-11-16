import * as THREE from 'three';
import { CanvasLabel } from '../combat-view/canvas-label.ts';
import { getCard } from '../content/cards.ts';
import type { Box, Socket } from '../content/rooms.ts';
import type { LootKind } from '../floor/generate.ts';
import { PALETTE } from '../palette.ts';
import { lootKey, type TreasureLoot } from '../rules/run.ts';

/** Coffer footprint: width along its local x, depth along z (its front faces local -z, like a socket yaw 0). */
const WIDTH = 0.7;
const DEPTH = 0.44;
const BODY_HEIGHT = 0.3;
const LID_RADIUS = DEPTH / 2;
/** Lid angle when open, radians about the rear hinge. */
const OPEN_ANGLE = 1.95;
/** Radians per second the lid swings. */
const OPEN_RATE = 4;
/** A collider this low and rising from the floor is a surface the coffer stands on (a desk), not a wall. */
const SURFACE_MAX = 1.5;
const FLOOR_EPS = 0.05;

/** The two materials a coffer is dressed in; `wood` is its body and lid, `brass` the bands and latch. */
export interface LootMaterials {
  readonly wood: THREE.Material;
  readonly brass: THREE.Material;
}

type Slot = keyof LootMaterials;

/** Top of the surface under floor point (x, z): the highest low collider covering it, else the floor. */
export function surfaceHeightAt(colliders: readonly Box[], x: number, z: number): number {
  let top = 0;
  for (const c of colliders) {
    if (c.min[1] > FLOOR_EPS || c.max[1] > SURFACE_MAX) continue;
    if (x >= c.min[0] && x <= c.max[0] && z >= c.min[2] && z <= c.max[2])
      top = Math.max(top, c.max[1]);
  }
  return top;
}

export interface Coffer {
  /** Room-local group at the loot socket, named `coffer-<room>-<socketId>`. */
  readonly object: THREE.Group;
  readonly room: number;
  readonly socketId: string;
  readonly kind: LootKind;
  /** The `RunState.openedLoot` key. */
  readonly key: string;
  /** The invisible box a ray tests. */
  readonly hit: THREE.Mesh;
  readonly opened: boolean;
  /** Starts the lid swinging (or jumps it open when `animate` is false). Idempotent. */
  open(animate: boolean): void;
  update(dt: number): void;
}

/**
 * Shared geometry and the placeholder materials for every coffer on one floor: a walnut chest with a
 * barrel lid, brass bands and an amber latch gem. The kit owns what it creates; materials handed to
 * `dress` stay the caller's. No lights: the amber parts are unlit basic materials.
 */
export class CofferKit {
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly ownedMaterials: THREE.Material[] = [];
  private readonly slotted: { mesh: THREE.Mesh; slot: Slot }[] = [];
  private readonly wood = new THREE.MeshStandardMaterial({
    color: PALETTE.walnut,
    roughness: 0.75,
    metalness: 0.05,
  });
  private readonly brass = new THREE.MeshStandardMaterial({
    color: PALETTE.brass,
    roughness: 0.4,
    metalness: 0.55,
  });
  private readonly amber = new THREE.MeshBasicMaterial({
    color: PALETTE.candle,
    toneMapped: false,
  });
  private readonly invisible = new THREE.MeshBasicMaterial({ visible: false });
  private readonly body = this.geometry(new THREE.BoxGeometry(WIDTH, BODY_HEIGHT, DEPTH));
  private readonly lid = this.geometry(
    new THREE.CylinderGeometry(LID_RADIUS, LID_RADIUS, WIDTH, 14, 1, false, 0, Math.PI).rotateZ(
      Math.PI / 2,
    ),
  );
  private readonly lidPlate = this.geometry(new THREE.BoxGeometry(WIDTH, 0.02, DEPTH));
  private readonly bodyBand = this.geometry(
    new THREE.BoxGeometry(0.06, BODY_HEIGHT + 0.012, DEPTH + 0.012),
  );
  private readonly lidBand = this.geometry(
    new THREE.CylinderGeometry(
      LID_RADIUS + 0.012,
      LID_RADIUS + 0.012,
      0.06,
      14,
      1,
      false,
      0,
      Math.PI,
    ).rotateZ(Math.PI / 2),
  );
  private readonly latch = this.geometry(new THREE.BoxGeometry(0.1, 0.12, 0.035));
  private readonly gem = this.geometry(new THREE.SphereGeometry(0.032, 10, 8));
  private readonly glow = this.geometry(
    new THREE.PlaneGeometry(WIDTH - 0.12, DEPTH - 0.12).rotateX(-Math.PI / 2),
  );
  private readonly hitBox = this.geometry(new THREE.BoxGeometry(WIDTH + 0.2, 0.62, DEPTH + 0.2));
  private dressing: LootMaterials | null = null;

  constructor() {
    this.ownedMaterials.push(this.wood, this.brass, this.amber, this.invisible);
  }

  private geometry<T extends THREE.BufferGeometry>(g: T): T {
    this.geometries.push(g);
    return g;
  }

  private part(
    geometry: THREE.BufferGeometry,
    slot: Slot,
    parent: THREE.Object3D,
    name: string,
  ): THREE.Mesh {
    const mesh = new THREE.Mesh(
      geometry,
      this.dressing?.[slot] ?? (slot === 'wood' ? this.wood : this.brass),
    );
    mesh.name = name;
    parent.add(mesh);
    this.slotted.push({ mesh, slot });
    return mesh;
  }

  /** Swaps the wood and brass of every coffer built so far (and later ones) to `materials`. */
  dress(materials: LootMaterials): void {
    this.dressing = materials;
    for (const { mesh, slot } of this.slotted) mesh.material = materials[slot];
  }

  /** Builds the coffer for `socket` of `room`, standing `surface` metres above the room floor. */
  build(room: number, socket: Socket, kind: LootKind, surface: number): Coffer {
    const object = new THREE.Group();
    object.name = `coffer-${room}-${socket.id}`;
    object.position.set(socket.position[0], socket.position[1] + surface, socket.position[2]);
    object.rotation.y = (-socket.yaw * Math.PI) / 180;
    const body = this.part(this.body, 'wood', object, 'coffer-body');
    body.position.y = BODY_HEIGHT / 2;
    for (const x of [-0.22, 0.22]) {
      const band = this.part(this.bodyBand, 'brass', object, 'coffer-band');
      band.position.set(x, BODY_HEIGHT / 2, 0);
    }
    const hinge = new THREE.Group();
    hinge.name = 'coffer-lid';
    hinge.position.set(0, BODY_HEIGHT, DEPTH / 2);
    object.add(hinge);
    const lid = this.part(this.lid, 'wood', hinge, 'coffer-lid-top');
    lid.position.z = -DEPTH / 2;
    const plate = this.part(this.lidPlate, 'wood', hinge, 'coffer-lid-plate');
    plate.position.set(0, 0.01, -DEPTH / 2);
    for (const x of [-0.22, 0.22]) {
      const band = this.part(this.lidBand, 'brass', hinge, 'coffer-lid-band');
      band.position.set(x, 0, -DEPTH / 2);
    }
    const latch = this.part(this.latch, 'brass', object, 'coffer-latch');
    latch.position.set(0, BODY_HEIGHT - 0.03, -DEPTH / 2 - 0.012);
    const gem = new THREE.Mesh(this.gem, this.amber);
    gem.name = 'coffer-gem';
    gem.position.set(0, BODY_HEIGHT - 0.03, -DEPTH / 2 - 0.04);
    object.add(gem);
    const glow = new THREE.Mesh(this.glow, this.amber);
    glow.name = 'coffer-glow';
    glow.position.y = BODY_HEIGHT + 0.004;
    glow.visible = false;
    object.add(glow);
    const hit = new THREE.Mesh(this.hitBox, this.invisible);
    hit.name = 'coffer-hit';
    hit.position.y = 0.3;
    object.add(hit);

    let angle = 0;
    let target = 0;
    let clock = 0;
    const coffer: Coffer = {
      object,
      room,
      socketId: socket.id,
      kind,
      key: lootKey(room, socket.id),
      hit,
      get opened() {
        return target > 0;
      },
      open(animate) {
        target = OPEN_ANGLE;
        if (!animate) {
          angle = OPEN_ANGLE;
          hinge.rotation.x = angle;
          glow.visible = true;
        }
      },
      update(dt) {
        clock += dt;
        if (angle < target) {
          angle = Math.min(target, angle + OPEN_RATE * dt);
          hinge.rotation.x = angle;
          glow.visible = angle > 0.35;
        }
        const pulse = target > 0 ? 0.6 : 1 + 0.22 * Math.sin(clock * 2.4);
        gem.scale.setScalar(pulse);
      },
    };
    object.userData.coffer = coffer;
    return coffer;
  }

  dispose(): void {
    for (const g of this.geometries) g.dispose();
    for (const m of this.ownedMaterials) m.dispose();
    this.slotted.length = 0;
  }
}

/** What a ray found: the coffer's identity for `RunFlow.openLoot`, and how far away it is. */
export interface LootPick {
  readonly room: number;
  readonly socketId: string;
  readonly kind: LootKind;
  readonly distance: number;
}

/** First unopened coffer in `coffers` that the ray reaches within `maxDistance`, or null. */
export function pickCoffer(
  coffers: readonly Coffer[],
  origin: THREE.Vector3,
  direction: THREE.Vector3,
  maxDistance: number,
): LootPick | null {
  const raycaster = new THREE.Raycaster(origin, direction.clone().normalize(), 0, maxDistance);
  let best: LootPick | null = null;
  for (const coffer of coffers) {
    if (coffer.opened) continue;
    coffer.hit.updateWorldMatrix(true, false);
    const hit = raycaster.intersectObject(coffer.hit, false)[0];
    if (hit && (best === null || hit.distance < best.distance)) {
      best = {
        room: coffer.room,
        socketId: coffer.socketId,
        kind: coffer.kind,
        distance: hit.distance,
      };
    }
  }
  return best;
}

/** The two lines the toast shows for a pickup. The first is what was found. */
export function lootLines(loot: TreasureLoot): { text: string; caption: string } {
  return loot.kind === 'cogs'
    ? { text: `+${loot.cogs} cogs`, caption: 'Added to your purse' }
    : { text: `New card: ${getCard(loot.card).name}`, caption: 'Added to your deck' };
}

const TOAST_PX = { w: 768, h: 256 };
const TOAST_WIDTH = 1.2;
const TOAST_LIFE = 4.2;
const TOAST_FADE = 0.7;
const TOAST_RISE = 0.12;

/** An in-scene panel over the opened coffer that shows what was found, faces the head and fades out. */
export class LootToast {
  readonly root = new THREE.Group();
  readonly text: string;
  private readonly label: CanvasLabel;
  private readonly base = new THREE.Vector3();
  private age = 0;

  constructor(loot: TreasureLoot, at: THREE.Vector3) {
    const { text, caption } = lootLines(loot);
    this.text = text;
    this.label = new CanvasLabel(TOAST_PX.w, TOAST_PX.h, TOAST_WIDTH);
    this.label.draw((ctx, w, h) => {
      ctx.fillStyle = PALETTE.warmBlack;
      ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = PALETTE.brass;
      ctx.lineWidth = 8;
      ctx.strokeRect(4, 4, w - 8, h - 8);
      ctx.strokeStyle = PALETTE.brassDark;
      ctx.lineWidth = 3;
      ctx.strokeRect(18, 18, w - 36, h - 36);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = PALETTE.candle;
      let size = 92;
      do {
        ctx.font = `700 ${size}px system-ui, sans-serif`;
        size -= 4;
      } while (ctx.measureText(text).width > w - 90 && size > 28);
      ctx.fillText(text, w / 2, h * 0.42);
      ctx.font = '500 40px system-ui, sans-serif';
      ctx.fillStyle = PALETTE.parchment;
      ctx.fillText(caption, w / 2, h * 0.76);
    });
    const { mesh } = this.label;
    mesh.name = 'loot-toast';
    mesh.renderOrder = 20;
    mesh.material.depthTest = false;
    mesh.raycast = () => undefined;
    this.root.name = 'loot-toast-root';
    this.root.add(mesh);
    this.base.copy(at);
    this.root.position.copy(at);
  }

  /** The canvas the text is drawn on (the scripted checks read what it drew). */
  get canvas(): HTMLCanvasElement {
    return this.label.canvas;
  }

  /** Advances the panel: turns it to `head`, lifts and fades it. Returns false once it has expired. */
  update(dt: number, head: THREE.Vector3): boolean {
    this.age += dt;
    const k = Math.min(1, this.age / TOAST_LIFE);
    this.root.position.set(this.base.x, this.base.y + TOAST_RISE * k, this.base.z);
    this.root.rotation.y = Math.atan2(head.x - this.base.x, head.z - this.base.z);
    const left = TOAST_LIFE - this.age;
    this.label.mesh.material.opacity = Math.max(0, Math.min(1, left / TOAST_FADE));
    return this.age < TOAST_LIFE;
  }

  dispose(): void {
    this.root.removeFromParent();
    this.label.dispose();
  }
}
