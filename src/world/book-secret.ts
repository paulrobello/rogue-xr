import * as THREE from 'three';
import { flightGoal, flightPose, flightScale } from '../flow/card-flight.ts';
import type { RunState } from '../rules/run.ts';
import { cogGeometry } from './cog-geometry.ts';
import type { FloorWorld } from './floor-world.ts';
import type { InteriorFurnishings } from './interior-furnishings.ts';

export interface BookPick {
  readonly room: number;
  readonly kind: 'book' | 'cabinet' | 'cog';
  readonly distance: number;
  readonly object: THREE.Object3D;
}

export type BookStage = 'key' | 'unlock' | 'cogs';
interface BookEntry {
  caseObject: THREE.Object3D;
  book: THREE.Object3D;
  panel: THREE.Object3D;
  panelRest: THREE.Vector3;
  coins: THREE.Group | null;
  slide: number;
}
interface PickupFlight {
  model: THREE.Group;
  start: THREE.Vector3;
  elapsed: number;
}

const HINGE_Y = 0.525;
const FLY_SECONDS = 0.62;

function brass(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color: 0xc99b4c, metalness: 0.55, roughness: 0.3 });
}
function keyModel(): THREE.Group {
  const group = new THREE.Group();
  const metal = brass();
  const bow = new THREE.Mesh(new THREE.TorusGeometry(0.027, 0.006, 8, 24), metal);
  bow.position.y = 0.052;
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.0065, 0.0065, 0.095, 12), metal);
  shaft.position.y = -0.021;
  group.add(bow, shaft);
  for (const [y, width] of [
    [-0.045, 0.021],
    [-0.064, 0.027],
  ] as const) {
    const tooth = new THREE.Mesh(new THREE.BoxGeometry(width, 0.009, 0.011), metal);
    tooth.position.set(width / 2, y, 0);
    group.add(tooth);
  }
  group.name = 'clockmakers-key';
  return group;
}
function cogPile(): THREE.Group {
  const group = new THREE.Group();
  group.name = 'book-secret-cogs';
  const metal = brass();
  for (const [i, x] of [-0.075, 0, 0.08].entries()) {
    const coin = new THREE.Mesh(cogGeometry(0.044 - i * 0.003), metal);
    coin.name = 'book-secret-cog';
    coin.rotation.set(-0.4, -0.12 + i * 0.12, i * 0.24);
    coin.position.set(x, 0, -i * 0.012);
    group.add(coin);
  }
  const axle = new THREE.Mesh(
    new THREE.SphereGeometry(0.022, 10, 8),
    new THREE.MeshBasicMaterial({ visible: false }),
  );
  group.add(axle);
  group.position.set(0, 0.16, 0.115);
  return group;
}
function discard(group: THREE.Group): void {
  const materials = new Set<THREE.Material>();
  group.removeFromParent();
  group.traverse((node) => {
    if (node instanceof THREE.Mesh) {
      node.geometry.dispose();
      materials.add(node.material);
    }
  });
  for (const m of materials) m.dispose();
}

/** Run progress can arrive before the room models when continuing a saved game. */
export class BookSecret {
  private readonly books = new Map<number, BookEntry>();
  private readonly stages = new Map<number, BookStage>();
  private readonly keyholeHit = new THREE.BoxGeometry(0.07, 0.085, 0.008);
  private readonly hitMaterial = new THREE.MeshBasicMaterial({ visible: false });
  private readonly flights = new Set<PickupFlight>();
  private readonly ray = new THREE.Raycaster();
  private readonly point = new THREE.Vector3();

  constructor(
    private readonly world: FloorWorld,
    furnishings: InteriorFurnishings | null,
  ) {
    if (furnishings) this.mount(furnishings);
  }
  mount(furnishings: InteriorFurnishings): void {
    for (const { object: caseObject, room, root } of furnishings.placements) {
      if (root !== 'Bookcase') continue;
      const book = caseObject.getObjectByName('Bookcase_PullBook');
      const panel = caseObject.getObjectByName('Bookcase_Slider');
      if (!book?.userData.bookSecret || !panel) continue;
      const lock = new THREE.Mesh(this.keyholeHit, this.hitMaterial);
      lock.name = 'book-secret-lock';
      lock.position.set(0, 0.31, 0.045);
      panel.add(lock);
      book.userData.bookSecret = true;
      const entry = {
        caseObject,
        book,
        panel,
        panelRest: panel.position.clone(),
        coins: null,
        slide: 0,
      };
      this.books.set(room, entry);
      const stage = this.stages.get(room);
      if (stage) this.apply(entry, stage, false);
    }
  }
  private targets(
    room: number,
    entry: BookEntry,
  ): { kind: BookPick['kind']; object: THREE.Object3D } | null {
    switch (this.stages.get(room)) {
      case 'key':
        return { kind: 'cabinet', object: entry.panel };
      case 'unlock':
        return entry.coins && entry.slide >= 1 ? { kind: 'cog', object: entry.coins } : null;
      case 'cogs':
        return null;
      default:
        return { kind: 'book', object: entry.book };
    }
  }
  pick(origin: THREE.Vector3, direction: THREE.Vector3, maxDistance = 4): BookPick | null {
    const room = this.world.current,
      entry = this.books.get(room);
    if (!entry) return null;
    const target = this.targets(room, entry);
    if (!target) return null;
    this.ray.set(origin, direction);
    this.ray.far = maxDistance;
    const hit = this.ray.intersectObject(entry.caseObject, true)[0];
    if (!hit) return null;
    for (let n: THREE.Object3D | null = hit.object; n && n !== entry.caseObject; n = n.parent) {
      if (n === target.object)
        return { room, kind: target.kind, object: n, distance: hit.distance };
    }
    return null;
  }
  near(position: THREE.Vector3, radius = 0.25): BookPick | null {
    const room = this.world.current,
      entry = this.books.get(room);
    if (!entry) return null;
    const target = this.targets(room, entry);
    if (!target) return null;
    this.point.set(0, target.kind === 'cabinet' ? 0.31 : 0, target.kind === 'cabinet' ? 0.044 : 0);
    target.object.localToWorld(this.point);
    const d = this.point.distanceTo(position);
    if (d > radius) return null;
    if (d < 0.018) return { room, ...target, distance: d };
    return this.pick(position, this.point.sub(position).normalize(), radius);
  }
  restore(
    run: Pick<RunState, 'bookSecretKeyRooms' | 'bookSecretCabinetRooms' | 'bookSecretOpenedRooms'>,
  ): void {
    const saved = new Map<number, BookStage>();
    for (const room of run.bookSecretKeyRooms ?? []) saved.set(room, 'key');
    for (const room of run.bookSecretCabinetRooms ?? []) saved.set(room, 'unlock');
    for (const room of run.bookSecretOpenedRooms ?? []) saved.set(room, 'cogs');
    for (const [room, stage] of saved) this.setStage(room, stage, false);
  }
  setStage(room: number, stage: BookStage, animate = true): void {
    if (this.stages.get(room) === stage) return;
    this.stages.set(room, stage);
    const entry = this.books.get(room);
    if (entry) this.apply(entry, stage, animate);
  }
  private apply(entry: BookEntry, stage: BookStage, animate: boolean): void {
    if (!entry.book.userData.bookSecretOpened) {
      entry.book.userData.bookSecretOpened = true;
      entry.book.position.z += 0.065;
      entry.book.rotation.x += 0.29;
    }
    if (stage === 'key') {
      if (animate) {
        const key = keyModel();
        key.position.copy(entry.book.position);
        key.position.z += 0.18;
        entry.caseObject.add(key);
        this.fly(key);
      }
      return;
    }
    if (!animate) this.setPanel(entry, 1);
    if (stage === 'unlock') {
      if (!entry.coins) {
        entry.coins = cogPile();
        entry.caseObject.add(entry.coins);
      }
    } else if (entry.coins) {
      if (animate) this.fly(entry.coins);
      else discard(entry.coins);
      entry.coins = null;
    }
  }
  private fly(model: THREE.Group): void {
    this.flights.add({ model, start: model.position.clone(), elapsed: 0 });
    model.traverse((n) => {
      n.raycast = () => undefined;
    });
  }
  private setPanel(entry: BookEntry, progress: number): void {
    entry.slide = progress;
    const angle = (Math.PI / 2) * progress * progress * (3 - 2 * progress);
    entry.panel.rotation.x = angle;
    entry.panel.position.y = entry.panelRest.y + HINGE_Y * (1 - Math.cos(angle));
    entry.panel.position.z = entry.panelRest.z - HINGE_Y * Math.sin(angle);
  }
  update(dt: number, head?: THREE.Object3D): void {
    for (const [room, entry] of this.books) {
      const stage = this.stages.get(room);
      if ((stage === 'unlock' || stage === 'cogs') && entry.slide < 1)
        this.setPanel(entry, Math.min(1, entry.slide + dt / 0.4));
    }
    for (const f of this.flights) {
      f.elapsed += dt;
      const t = Math.min(1, f.elapsed / FLY_SECONDS);
      if (head && f.model.parent) {
        head.getWorldPosition(this.point);
        f.model.parent.worldToLocal(this.point);
        flightGoal(f.start, this.point, 0.23, this.point);
        const k = flightPose(f.start, this.point, t, f.model.position);
        f.model.position.y += 0.1 * Math.sin(Math.PI * t);
        f.model.rotation.y += dt * 3;
        f.model.scale.setScalar(flightScale(k));
      }
      if (t >= 1) {
        discard(f.model);
        this.flights.delete(f);
      }
    }
  }
  objectAt(room: number): THREE.Object3D | null {
    return this.books.get(room)?.book ?? null;
  }
  dispose(): void {
    for (const entry of this.books.values()) if (entry.coins) discard(entry.coins);
    for (const f of this.flights) discard(f.model);
    this.keyholeHit.dispose();
    this.hitMaterial.dispose();
    for (const entry of this.books.values())
      entry.panel.getObjectByName('book-secret-lock')?.removeFromParent();
    this.flights.clear();
    this.books.clear();
  }
}
