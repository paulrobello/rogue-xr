import * as THREE from 'three';
import type { FollowupRecipe } from '../rules/alchemy.ts';
import type { FloorWorld } from './floor-world.ts';
import { kitPart } from './puzzle-placement.ts';

export type ArchivePick = { action: 'pour' | 'unlatch'; distance: number };
const prefix: Readonly<Record<FollowupRecipe, string>> = {
  'lantern-ink': 'ArchiveInk',
  stillwind: 'ArchiveWind',
  'looking-glass': 'ArchiveMirror',
};
const overlay: Readonly<Record<FollowupRecipe, string>> = {
  'lantern-ink': 'ArchiveInkTrace',
  stillwind: 'ArchiveWindRotor',
  'looking-glass': 'ArchiveMirrorSilver',
};

export class ConservatoryArchive {
  readonly object = new THREE.Group();
  readonly leaves: THREE.Object3D[];
  readonly effect: THREE.Object3D;
  readonly latch: THREE.Object3D | null;
  private readonly ray = new THREE.Raycaster();
  private readonly box = new THREE.Box3();
  private readonly hitPoint = new THREE.Vector3();
  private readonly overlayMaterials: THREE.Material[] = [];
  private readonly restY: number;
  private progress = 0;
  private revealed = false;
  private opened = false;
  private speed = 3.8;

  static mount(
    world: FloorWorld,
    art: THREE.Object3D,
    kind: FollowupRecipe,
    reducedMotion = false,
  ): ConservatoryArchive {
    const edge = world.plan.connections.find((c) => c.puzzleGate === 'archive');
    if (!edge) throw Error('Missing Conservatory archive connection');
    const ref = edge[0],
      door = world.rooms[ref.room].doors.find((d) => d.id === ref.door);
    if (!door) throw Error('Missing archive doorway');
    const archive = new ConservatoryArchive(world, ref.room, art, kind, reducedMotion);
    archive.object.position.set(door.world[0], 0, door.world[1]);
    archive.object.rotation.y = { N: 0, E: -Math.PI / 2, S: Math.PI, W: Math.PI / 2 }[door.facing];
    world.roomGroups[ref.room].attach(archive.object);
    return archive;
  }

  private constructor(
    private readonly world: FloorWorld,
    readonly room: number,
    art: THREE.Object3D,
    readonly kind: FollowupRecipe,
    private readonly reducedMotion: boolean,
  ) {
    this.object.name = 'ConservatoryArchive';
    this.leaves = ['Left', 'Right'].map((side, i) => {
      const leaf = kitPart(art, prefix[kind] + side).clone(true);
      leaf.position.x = i ? 0.8 : -0.8;
      this.object.add(leaf);
      return leaf;
    });
    this.effect = kitPart(art, overlay[kind]).clone(true);
    this.object.add(this.effect);
    this.restY = this.effect.position.y;
    if (kind === 'lantern-ink') {
      this.latch = kitPart(art, 'ArchiveInkLatch').clone(true);
      this.object.add(this.latch);
    } else this.latch = null;
    if (kind !== 'stillwind') {
      const clones = new Map<THREE.Material, THREE.Material>();
      const translucent = (m: THREE.Material) => {
        let clone = clones.get(m);
        if (!clone) {
          clone = m.clone();
          clone.transparent = true;
          clone.depthWrite = false;
          clones.set(m, clone);
          this.overlayMaterials.push(clone);
        }
        return clone;
      };
      this.effect.traverse((node) => {
        if (node instanceof THREE.Mesh)
          node.material = Array.isArray(node.material)
            ? node.material.map(translucent)
            : translucent(node.material);
      });
    }
    this.sync({ revealed: false, opened: false }, true);
  }
  private inputs(): readonly THREE.Object3D[] {
    if (this.opened || this.world.current !== this.room) return [];
    if (this.revealed && this.latch) return [this.latch];
    return this.kind === 'lantern-ink' ? this.leaves : [...this.leaves, this.effect];
  }
  pick(origin: THREE.Vector3, direction: THREE.Vector3): ArchivePick | null {
    const nodes = this.inputs();
    if (!nodes.length) return null;
    this.object.updateWorldMatrix(true, true);
    this.ray.set(origin, direction);
    this.ray.far = 4;
    let nearest = Infinity;
    for (const node of nodes) {
      const hit = this.ray.intersectObject(node, true)[0];
      if (!hit || hit.distance >= nearest) continue;
      const blocked = this.world.colliders[this.room].some((b) => {
        this.box.min.fromArray(b.min);
        this.box.max.fromArray(b.max);
        return (
          !this.box.containsPoint(hit.point) &&
          this.ray.ray.intersectBox(this.box, this.hitPoint) !== null &&
          this.hitPoint.distanceTo(origin) < hit.distance - 0.15
        );
      });
      if (!blocked) nearest = hit.distance;
    }
    return Number.isFinite(nearest)
      ? { action: this.revealed ? 'unlatch' : 'pour', distance: nearest }
      : null;
  }
  near(point: THREE.Vector3, reach: number): ArchivePick | null {
    let d = Infinity;
    for (const node of this.inputs())
      d = Math.min(d, this.box.setFromObject(node).distanceToPoint(point));
    return d <= reach ? { action: this.revealed ? 'unlatch' : 'pour', distance: d } : null;
  }
  sync(state: { revealed: boolean; opened: boolean }, immediate = false): void {
    this.revealed = state.revealed;
    this.opened = state.opened;
    if (immediate || this.reducedMotion) {
      this.progress = Number(this.opened);
      this.speed = this.opened ? 0 : 3.8;
    }
    this.pose();
  }
  private pose(): void {
    const t = this.progress * this.progress * (3 - 2 * this.progress);
    this.leaves[0].rotation.y = (t * Math.PI) / 2;
    this.leaves[1].rotation.y = (-t * Math.PI) / 2;
    if (this.latch) this.latch.visible = this.revealed && t < 0.08;
    this.effect.visible = t < 1 && (this.kind !== 'lantern-ink' || this.revealed);
    if (this.kind === 'stillwind') this.effect.position.y = this.restY + 2.5 * t;
    else for (const mat of this.overlayMaterials) mat.opacity = 1 - t;
  }
  update(dt: number): void {
    if (!this.object.parent?.visible) return;
    if (this.kind === 'stillwind' && !this.reducedMotion && this.effect.visible) {
      this.speed = THREE.MathUtils.damp(this.speed, this.opened ? 0 : 3.8, 4, dt);
      this.effect.rotation.z += this.speed * dt;
    }
    if (this.opened && this.progress < 1) {
      this.progress = Math.min(1, this.progress + dt * 1.3);
      this.pose();
    }
  }
  dispose() {
    for (const m of this.overlayMaterials) m.dispose();
    this.object.removeFromParent();
  }
}
