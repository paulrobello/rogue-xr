import * as THREE from 'three';
import { CanvasLabel } from '../combat-view/canvas-label.ts';
import { cogGeometry } from './cog-geometry.ts';
import type { FloorWorld } from './floor-world.ts';
import type { InteriorFurnishings } from './interior-furnishings.ts';

export interface BookPick {
  readonly room: number;
  readonly distance: number;
  readonly object: THREE.Object3D;
}

interface BookEntry {
  readonly room: number;
  readonly object: THREE.Object3D;
  readonly caseObject: THREE.Object3D;
  readonly slider: THREE.Object3D | null;
  readonly sliderStart: THREE.Vector3;
  opened: boolean;
  cache: THREE.Object3D | null;
  label: CanvasLabel | null;
  slide: number;
}

const PANEL_HINGE_HEIGHT = 0.48;

/** Marked book interactions, including the recessed cache revealed behind each bookcase panel. */
export class BookSecret {
  private readonly books = new Map<number, BookEntry>();
  private readonly ray = new THREE.Raycaster();
  private readonly at = new THREE.Vector3();
  private readonly openedRooms = new Set<number>();

  constructor(
    private readonly world: FloorWorld,
    furnishings: InteriorFurnishings | null,
  ) {
    for (const placement of furnishings?.placements ?? []) {
      if (placement.root !== 'Bookcase') continue;
      const marked = placement.object.getObjectByName('Bookcase_PullBook');
      if (!marked) continue;
      marked.userData.bookSecret = true;
      const slider = placement.object.getObjectByName('Bookcase_Slider') ?? null;
      const entry: BookEntry = {
        room: placement.room,
        object: marked,
        caseObject: placement.object,
        slider,
        sliderStart: slider?.position.clone() ?? new THREE.Vector3(),
        opened: false,
        cache: null,
        label: null,
        slide: 0,
      };
      this.books.set(entry.room, entry);
    }
  }

  pick(origin: THREE.Vector3, direction: THREE.Vector3, maxDistance = 4): BookPick | null {
    const book = this.books.get(this.world.current);
    if (!book || book.opened) return null;
    this.ray.set(origin, direction);
    this.ray.far = maxDistance;
    const hit = this.ray.intersectObject(book.object)[0];
    if (!hit) return null;
    // Once the marked spine is in the ray, reject hits through the back or the side of its case.
    const first = this.ray.intersectObject(book.caseObject)[0];
    return first && first.distance < hit.distance - 0.0001
      ? null
      : { room: book.room, distance: hit.distance, object: book.object };
  }

  near(position: THREE.Vector3, radius = 0.25): BookPick | null {
    const book = this.books.get(this.world.current);
    if (!book || book.opened) return null;
    const distance = book.object.getWorldPosition(this.at).distanceTo(position);
    return distance <= radius ? { room: book.room, distance, object: book.object } : null;
  }

  open(room: number): boolean {
    const book = this.books.get(room);
    if (!book || book.opened) return false;
    this.openedRooms.add(room);
    book.opened = true;
    book.object.userData.bookSecretOpened = true;
    book.object.position.z += 0.065;
    book.object.rotation.x += 0.29;
    this.reveal(book);
    return true;
  }

  markOpened(rooms: readonly number[]): void {
    for (const room of rooms) {
      this.openedRooms.add(room);
      const book = this.books.get(room);
      if (book && this.open(room)) this.setPanel(book, 1);
    }
  }

  private setPanel(book: BookEntry, progress: number): void {
    book.slide = progress;
    if (!book.slider) return;
    // The authored pivot is at floor height. Fold the door about its upper edge into the cubby.
    const angle = (Math.PI / 2) * progress * progress * (3 - 2 * progress);
    book.slider.rotation.x = angle;
    book.slider.position.y = book.sliderStart.y + PANEL_HINGE_HEIGHT * (1 - Math.cos(angle));
    book.slider.position.z = book.sliderStart.z - PANEL_HINGE_HEIGHT * Math.sin(angle);
  }

  update(dt: number): void {
    for (const book of this.books.values()) {
      if (book.opened && book.slide < 1)
        this.setPanel(book, Math.min(1, book.slide + Math.max(0, dt) / 0.4));
    }
  }

  isOpened(room: number): boolean {
    return this.openedRooms.has(room);
  }

  openedRoomIds(): readonly number[] {
    return [...this.openedRooms];
  }

  objectAt(room: number): THREE.Object3D | null {
    return this.books.get(room)?.object ?? null;
  }

  dispose(): void {
    for (const book of this.books.values()) {
      book.cache?.removeFromParent();
      if (book.cache instanceof THREE.Group) {
        book.cache.traverse((child) => {
          if (child instanceof THREE.Mesh && child !== book.label?.mesh) {
            child.geometry.dispose();
            (child.material as THREE.Material).dispose();
          }
        });
      }
      book.label?.dispose();
    }
  }

  private reveal(book: BookEntry): void {
    if (book.cache) return;
    book.cache = new THREE.Group();
    book.cache.name = `book-secret-cache-${book.room}`;
    for (const [i, x] of [-0.075, 0, 0.08].entries()) {
      const coin = new THREE.Mesh(
        cogGeometry(0.044 - i * 0.003),
        new THREE.MeshStandardMaterial({ color: 0xc38a35, metalness: 0.62, roughness: 0.36 }),
      );
      coin.name = 'book-secret-cog';
      coin.rotation.set(-0.4, -0.12 + i * 0.12, i * 0.24);
      coin.position.set(x, 0.155, 0.11 - i * 0.012);
      book.cache.add(coin);
    }
    const label = new CanvasLabel(768, 160, 0.48);
    label.draw((ctx, width, height) => {
      ctx.fillStyle = '#f5df9a';
      ctx.font = '700 54px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('CLOCKMAKER CACHE', width / 2, height / 2);
    });
    label.mesh.position.set(0, 0.32, -0.108);
    book.cache.add(label.mesh);
    book.label = label;
    book.caseObject.add(book.cache);
  }
}
