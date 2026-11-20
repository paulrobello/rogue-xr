import * as THREE from 'three';
import { CanvasLabel } from '../combat-view/canvas-label.ts';
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
  restY: number;
  restZ: number;
  room: number;
  hollow: boolean;
  knock: number;
}

function servicePaddle(): THREE.ExtrudeGeometry {
  // Side profile of a folded palm latch, with a rolled lower edge for the fingers.
  const profile = new THREE.Shape();
  profile.moveTo(0, 0.053);
  profile.lineTo(0.009, 0.053);
  profile.lineTo(0.009, -0.027);
  profile.quadraticCurveTo(0.009, -0.041, 0.024, -0.041);
  profile.lineTo(0.028, -0.041);
  profile.lineTo(0.028, -0.05);
  profile.lineTo(0.015, -0.05);
  profile.quadraticCurveTo(0, -0.05, 0, -0.03);
  profile.closePath();
  const geometry = new THREE.ExtrudeGeometry(profile, {
    depth: 0.18,
    bevelThickness: 0.002,
    bevelSize: 0.002,
    bevelSegments: 2,
    curveSegments: 4,
  });
  return geometry.translate(0, 0, -0.09).rotateY(-Math.PI / 2);
}

export class ServicePanels {
  readonly panels: Panel[] = [];
  private readonly ray = new THREE.Raycaster();
  private readonly box = new THREE.Box3();
  private readonly contact = new THREE.Vector3();
  private readonly paddle = servicePaddle();
  private readonly brass = new THREE.MeshStandardMaterial({
    color: 0xb38b57,
    metalness: 0.55,
    roughness: 0.43,
  });
  private readonly stencil?: CanvasLabel;
  private state: StoredHiddenPanelState = { discovered: false, opened: false };
  constructor(
    private readonly world: FloorWorld,
    art: THREE.Object3D,
    private readonly reduced: boolean,
  ) {
    const plan = world.plan.hiddenPassage;
    if (!plan) throw Error('No service-panel passage on this floor');
    if (typeof document !== 'undefined' && document.createElement('canvas').getContext('2d')) {
      this.stencil = new CanvasLabel(640, 96, 0.58);
      this.stencil.mesh.name = 'service-inspection-stencil';
      this.stencil.mesh.position.set(0.8, 1.23, 0.063);
      this.stencil.draw((ctx, w, h) => {
        ctx.fillStyle = '#dfceaa';
        ctx.font = 'bold 69px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('KNOCK TO TEST', w / 2, h / 2, w - 14);
      });
    }
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
    // A 10 mm stop overlaps the leaf edges and steps the service reveal inside the boiler jamb.
    frame.scale.set(0.79 / 0.8, 2.39 / 2.4, 0.55);
    frame.position.z = 0.028;
    const socket = kitPart(leaf, 'PanelCatch');
    const latch = new THREE.Mesh(this.paddle, this.brass);
    latch.position.copy(socket.position);
    latch.position.z += 0.044;
    socket.removeFromParent();
    leaf.add(latch);
    if (this.stencil) leaf.add(this.stencil.mesh.clone());
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
      restY: latch.position.y,
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
      p.catch.rotation.x = THREE.MathUtils.lerp(p.catch.rotation.x, up ? -0.95 : 0, blend);
      // The top of the paddle stays on its hinge while the lower lip springs forward.
      p.catch.position.y = p.restY + 0.053 * (1 - Math.cos(p.catch.rotation.x));
      p.catch.position.z = p.restZ - 0.053 * Math.sin(p.catch.rotation.x);
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
    this.paddle.dispose();
    this.brass.dispose();
    this.stencil?.dispose();
  }
}
