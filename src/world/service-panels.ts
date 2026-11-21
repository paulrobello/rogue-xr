import * as THREE from 'three';
import { CanvasLabel } from '../combat-view/canvas-label.ts';
import type { DoorRef } from '../floor/generate.ts';
import type { StoredHiddenPanelState } from '../rules/types.ts';
import type { FloorWorld } from './floor-world.ts';
import { kitPart } from './puzzle-placement.ts';

export const SERVICE_KNOCKS = 3;
const KNOCK_RADIUS = 0.15;

export interface PanelHit {
  action: 'knock' | 'unlatch';
  distance: number;
}
interface Panel {
  root: THREE.Group;
  leaf: THREE.Object3D;
  room: number;
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
  readonly panel: Panel;
  private readonly ray = new THREE.Raycaster();
  private readonly box = new THREE.Box3();
  private readonly contact = new THREE.Vector3();
  private readonly paddle = servicePaddle();
  private readonly disc = new THREE.CylinderGeometry(KNOCK_RADIUS, KNOCK_RADIUS, 0.024, 32);
  private readonly rim = new THREE.TorusGeometry(0.134, 0.009, 8, 32);
  private readonly brass = new THREE.MeshStandardMaterial({
    color: 0xb38b57,
    emissive: 0x835525,
    emissiveIntensity: 0.26,
    metalness: 0.55,
    roughness: 0.43,
  });
  private readonly strikeFace = new THREE.MeshStandardMaterial({
    color: 0x6c542f,
    emissive: 0x6c542f,
    emissiveIntensity: 0.44,
    metalness: 0.36,
    roughness: 0.58,
  });
  private readonly knockTarget = new THREE.Mesh(this.disc, this.strikeFace);
  private readonly latch = new THREE.Mesh(this.paddle, this.brass);
  private readonly rest: THREE.Vector3;
  private readonly prompt: CanvasLabel | null;
  private state: StoredHiddenPanelState = { discovered: false, opened: false };
  private count = 0;
  private vibration = 0;

  constructor(
    private readonly world: FloorWorld,
    art: THREE.Object3D,
    private readonly reduced: boolean,
  ) {
    const plan = world.plan.hiddenPassage;
    if (!plan) throw Error('No service-panel passage on this floor');
    const source = this.mount(art, plan.source);
    this.panel = source;
    const socket = kitPart(source.leaf, 'PanelCatch');
    this.latch.position.copy(socket.position);
    this.latch.position.z += 0.044;
    this.latch.name = 'service-catch-' + source.room;
    this.rest = this.latch.position.clone();
    socket.removeFromParent();
    this.knockTarget.name = 'service-knock-target';
    this.knockTarget.position.set(0.8, 1.24, 0.08);
    this.knockTarget.rotation.x = Math.PI / 2;
    const ring = new THREE.Mesh(this.rim, this.brass);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.014;
    this.knockTarget.add(ring);
    source.leaf.add(this.knockTarget, this.latch);

    this.prompt = this.stencil('service-knock-instructions', 1.03);
    if (this.prompt) source.leaf.add(this.prompt.mesh);
    this.drawPrompt();
  }

  private stencil(name: string, y: number): CanvasLabel | null {
    if (typeof document === 'undefined' || !document.createElement('canvas').getContext('2d'))
      return null;
    const label = new CanvasLabel(640, 96, 0.58);
    label.mesh.name = name;
    label.mesh.position.set(0.8, y, 0.063);
    return label;
  }

  private draw(label: CanvasLabel | null, text: string, color: string) {
    label?.draw((ctx, w, h) => {
      ctx.fillStyle = color;
      ctx.font = 'bold 69px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, w / 2, h / 2, w - 14);
    });
  }

  private drawPrompt() {
    const text = this.state.discovered
      ? 'PULL HANDLE'
      : this.count === 0
        ? `KNOCK ${SERVICE_KNOCKS} TIMES`
        : `${this.count} OF ${SERVICE_KNOCKS}`;
    this.draw(this.prompt, text, '#dfceaa');
  }

  private mount(art: THREE.Object3D, ref: DoorRef): Panel {
    const door = this.world.rooms[ref.room].doors.find((d) => d.id === ref.door);
    if (!door) throw Error('Missing service doorway');
    const root = new THREE.Group();
    root.name = 'hollow-service-panel';
    const frame = kitPart(art, 'PanelFrame').clone(true),
      leaf = kitPart(art, 'PanelLeaf').clone(true);
    // A 10 mm stop overlaps the leaf edges and steps the service reveal inside the boiler jamb.
    frame.scale.set(0.79 / 0.8, 2.39 / 2.4, 0.55);
    frame.position.z = 0.028;
    leaf.name = 'service-leaf-' + ref.room;
    leaf.position.x = -0.8;
    root.add(frame, leaf);
    root.position.set(door.world[0], 0, door.world[1]);
    root.rotation.y = { N: 0, S: Math.PI, W: Math.PI / 2, E: -Math.PI / 2 }[door.facing];
    root.translateZ(0.13);
    this.world.roomGroups[ref.room].attach(root);
    return { root, leaf, room: ref.room };
  }

  pick(origin: THREE.Vector3, direction: THREE.Vector3): PanelHit | null {
    const p = this.panel;
    if (this.world.current !== p.room || this.state.opened) return null;
    p.root.updateWorldMatrix(true, true);
    if (p.root.worldToLocal(this.contact.copy(origin)).z < 0) return null;
    this.ray.set(origin, direction);
    this.ray.far = 3.6;
    const hit = this.ray.intersectObject(p.leaf, true)[0];
    const target = this.state.discovered ? this.latch : this.knockTarget;
    if (!hit || (hit.object !== target && hit.object.parent !== target)) return null;
    const blocked = this.world.colliders[p.room].some((b) => {
      this.box.min.fromArray(b.min);
      this.box.max.fromArray(b.max);
      return (
        !this.box.containsPoint(hit.point) &&
        this.ray.ray.intersectBox(this.box, this.contact) !== null &&
        this.contact.distanceTo(origin) < hit.distance - 0.04
      );
    });
    return blocked
      ? null
      : {
          action: this.state.discovered ? 'unlatch' : 'knock',
          distance: hit.distance,
        };
  }

  near(point: THREE.Vector3, reach: number): PanelHit | null {
    const p = this.panel;
    if (this.world.current !== p.room || this.state.opened) return null;
    p.root.updateWorldMatrix(true, true);
    if (p.root.worldToLocal(this.contact.copy(point)).z < 0) return null;
    if (this.state.discovered) {
      const distance = this.box.setFromObject(this.latch).distanceToPoint(point);
      return distance <= reach ? { action: 'unlatch', distance } : null;
    }
    this.knockTarget.worldToLocal(this.contact.copy(point));
    const { x, y, z } = this.contact;
    return Math.hypot(x, z) <= KNOCK_RADIUS && Math.abs(y) <= reach
      ? { action: 'knock', distance: Math.abs(y) }
      : null;
  }

  knock(): { at: THREE.Vector3; count: number } | null {
    if (this.state.discovered || this.count >= SERVICE_KNOCKS) return null;
    this.count++;
    this.vibration = 0.42;
    this.drawPrompt();
    return { at: this.knockTarget.getWorldPosition(new THREE.Vector3()), count: this.count };
  }

  handlePosition(): THREE.Vector3 {
    return this.latch.getWorldPosition(new THREE.Vector3());
  }

  sync(state: StoredHiddenPanelState, immediate = false) {
    const promptChanged = state.discovered !== this.state.discovered;
    this.state = state;
    if (promptChanged) this.drawPrompt();
    if (immediate || this.reduced) this.pose(1);
  }

  private pose(blend: number) {
    const { leaf } = this.panel;
    const { opened, discovered } = this.state;
    this.latch.rotation.x = THREE.MathUtils.lerp(
      this.latch.rotation.x,
      discovered ? -0.95 : 0,
      blend,
    );
    // The top of the paddle stays on its hinge while the lower lip springs forward.
    this.latch.position.y = this.rest.y + 0.053 * (1 - Math.cos(this.latch.rotation.x));
    this.latch.position.z = this.rest.z - 0.053 * Math.sin(this.latch.rotation.x);
    leaf.rotation.y = THREE.MathUtils.lerp(
      leaf.rotation.y,
      opened ? THREE.MathUtils.degToRad(100) : 0,
      blend,
    );
    // At full swing the leaf is stowed beyond the jamb, clearing its hinge-side thickness.
    leaf.position.x = -0.8 - 0.075 * THREE.MathUtils.clamp(leaf.rotation.y / (Math.PI / 2), 0, 1);
  }

  update(dt: number) {
    this.pose(this.reduced ? 1 : 1 - Math.exp(-8 * dt));
    this.vibration = Math.max(0, this.vibration - dt);
    this.panel.leaf.position.z = this.reduced
      ? 0
      : -0.045 * this.vibration * Math.abs(Math.sin(this.vibration * 39));
  }

  dispose() {
    this.panel.root.removeFromParent();
    this.paddle.dispose();
    this.disc.dispose();
    this.rim.dispose();
    this.brass.dispose();
    this.strikeFace.dispose();
    this.prompt?.dispose();
  }
}
