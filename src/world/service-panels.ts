import * as THREE from 'three';
import type { DoorRef } from '../floor/generate.ts';
import type { StoredHiddenPanelState } from '../rules/types.ts';
import type { FloorWorld } from './floor-world.ts';
import { kitPart } from './puzzle-placement.ts';

export interface PanelHit {
  action: 'knock' | 'unlatch';
  index: number;
  hollow: boolean;
  distance: number;
}
interface Panel {
  root: THREE.Group;
  leaf: THREE.Object3D;
  catch: THREE.Object3D;
  restZ: number;
  room: number;
  hollow: boolean;
  knock: number;
}

export class ServicePanels {
  readonly panels: Panel[] = [];
  private readonly ray = new THREE.Raycaster();
  private readonly box = new THREE.Box3();
  private readonly contact = new THREE.Vector3();
  private state: StoredHiddenPanelState = { discovered: false, opened: false };
  constructor(
    private readonly world: FloorWorld,
    art: THREE.Object3D,
    private readonly reduced: boolean,
  ) {
    const plan = world.plan.hiddenPassage;
    if (!plan) throw Error('No service-panel passage on this floor');
    [plan.source, ...plan.decoys].forEach((ref, i) => {
      this.mount(art, ref, i === 0);
    });
  }
  private mount(art: THREE.Object3D, ref: DoorRef, hollow: boolean) {
    const door = this.world.rooms[ref.room].doors.find((d) => d.id === ref.door);
    if (!door) throw Error('Missing service doorway');
    const root = new THREE.Group();
    root.name = hollow ? 'hollow-service-panel' : 'solid-service-panel-' + ref.room;
    const frame = kitPart(art, 'PanelFrame').clone(true),
      leaf = kitPart(art, 'PanelLeaf').clone(true);
    const latch = kitPart(leaf, 'PanelCatch');
    leaf.name = 'service-leaf-' + ref.room;
    latch.name = 'service-catch-' + ref.room;
    leaf.position.x = -0.8;
    root.add(frame, leaf);
    root.position.set(door.world[0], 0, door.world[1]);
    root.rotation.y = { N: 0, S: Math.PI, W: Math.PI / 2, E: -Math.PI / 2 }[door.facing];
    root.translateZ(0.13);
    this.world.roomGroups[ref.room].attach(root);
    this.panels.push({
      root,
      leaf,
      catch: latch,
      restZ: latch.position.z,
      room: ref.room,
      hollow,
      knock: 0,
    });
  }
  private input(p: Panel, node: THREE.Object3D): 'knock' | 'unlatch' {
    if (p.hollow && this.state.discovered) {
      for (let n: THREE.Object3D | null = node; n && n !== p.root; n = n.parent)
        if (n === p.catch) return 'unlatch';
    }
    return 'knock';
  }
  pick(origin: THREE.Vector3, direction: THREE.Vector3): PanelHit | null {
    this.ray.set(origin, direction);
    this.ray.far = 3.6;
    let result: PanelHit | null = null;
    for (const [index, p] of this.panels.entries()) {
      if (p.room !== this.world.current || (p.hollow && this.state.opened)) continue;
      p.root.updateWorldMatrix(true, true);
      if (p.root.worldToLocal(this.contact.copy(origin)).z < 0) continue;
      const hit = this.ray.intersectObject(p.leaf, true)[0];
      if (!hit || (result && hit.distance >= result.distance)) continue;
      const blocked = this.world.colliders[p.room].some((b) => {
        this.box.min.fromArray(b.min);
        this.box.max.fromArray(b.max);
        return (
          !this.box.containsPoint(hit.point) &&
          this.ray.ray.intersectBox(this.box, this.contact) !== null &&
          this.contact.distanceTo(origin) < hit.distance - 0.04
        );
      });
      if (!blocked)
        result = {
          action: this.input(p, hit.object),
          index,
          hollow: p.hollow,
          distance: hit.distance,
        };
    }
    return result;
  }
  near(point: THREE.Vector3, reach: number): PanelHit | null {
    for (const [index, p] of this.panels.entries()) {
      if (p.room !== this.world.current || (p.hollow && this.state.opened)) continue;
      p.root.updateWorldMatrix(true, true);
      if (p.root.worldToLocal(this.contact.copy(point)).z < -0.035) continue;
      if (p.hollow && this.state.discovered) {
        const d = this.box.setFromObject(p.catch).distanceToPoint(point);
        if (d <= reach) return { action: 'unlatch', index, hollow: true, distance: d };
      }
      const d = this.box.setFromObject(p.leaf).distanceToPoint(point);
      if (d <= reach) return { action: 'knock', index, hollow: p.hollow, distance: d };
    }
    return null;
  }
  strike(index: number): THREE.Vector3 {
    const p = this.panels[index];
    p.knock = p.hollow ? 0.42 : 0.17;
    return p.catch.getWorldPosition(new THREE.Vector3());
  }
  sync(state: StoredHiddenPanelState, immediate = false) {
    this.state = state;
    if (immediate || this.reduced) this.pose(1);
  }
  private pose(blend: number) {
    for (const p of this.panels) {
      const open = p.hollow && this.state.opened,
        up = p.hollow && this.state.discovered;
      p.catch.position.z = THREE.MathUtils.lerp(
        p.catch.position.z,
        p.restZ + (up ? 0.055 : 0),
        blend,
      );
      p.leaf.rotation.y = THREE.MathUtils.lerp(
        p.leaf.rotation.y,
        open ? THREE.MathUtils.degToRad(100) : 0,
        blend,
      );
      // At full swing the leaf is stowed beyond the jamb, clearing its hinge-side thickness.
      p.leaf.position.x =
        -0.8 - 0.075 * THREE.MathUtils.clamp(p.leaf.rotation.y / (Math.PI / 2), 0, 1);
    }
  }
  update(dt: number) {
    this.pose(this.reduced ? 1 : 1 - Math.exp(-8 * dt));
    for (const p of this.panels) {
      p.knock = Math.max(0, p.knock - dt);
      p.leaf.position.z = this.reduced
        ? 0
        : p.hollow
          ? -0.045 * p.knock * Math.abs(Math.sin(p.knock * 39))
          : -0.009 * p.knock * Math.abs(Math.sin(p.knock * 67));
    }
  }
  dispose() {
    for (const p of this.panels) p.root.removeFromParent();
  }
}
