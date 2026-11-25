import * as THREE from 'three';
import { CanvasLabel } from '../combat-view/canvas-label.ts';
import { getCard, type SliceCard } from '../content/cards.ts';
import type { CombatCard } from '../rules/types.ts';

const WIDTH = 0.216;
const SLOT_X = [-0.238, 0, 0.238] as const;
const PULSE_SECONDS = 0.42;

type Slot = {
  readonly root: THREE.Group;
  readonly lamp: THREE.MeshStandardMaterial;
  readonly label: CanvasLabel | null;
  uid: number | null;
  model: THREE.Object3D | null;
  pulse: number;
};

function caption(card: SliceCard): string {
  const phase = card.mechanism?.timing === 'end-turn' ? 'Turn end' : 'Turn start';
  const effect = card.mechanism?.effects[0];
  if (effect?.type === 'block') return `${phase} · ${effect.amount} Block`;
  if (effect?.type === 'damage') return `${phase} · ${effect.amount} damage`;
  if (effect?.type === 'apply-status')
    return `${phase} · ${effect.stacks} ${effect.status === 'charge' ? 'Charge' : 'Overheat'}`;
  return phase;
}

export class MechanismRack {
  readonly root = new THREE.Group();
  private readonly owned: { dispose(): void }[] = [];
  private readonly molds = new Map<string, THREE.Group>();
  private readonly slots: Slot[] = [];
  private readonly brass: THREE.MeshStandardMaterial;
  private readonly iron: THREE.MeshStandardMaterial;
  private readonly walnut: THREE.MeshStandardMaterial;
  private readonly jade: THREE.MeshStandardMaterial;
  private readonly ivory: THREE.MeshStandardMaterial;
  private readonly copper: THREE.MeshStandardMaterial;
  private readonly ember: THREE.MeshStandardMaterial;
  private readonly at = new THREE.Vector3();

  constructor(
    private readonly reduced: boolean,
    environment: THREE.Texture | null,
    labels: boolean,
  ) {
    this.root.name = 'mechanism-rack';
    this.root.visible = false;
    const alloy = (color: number, metalness: number, roughness: number) =>
      this.keep(
        new THREE.MeshStandardMaterial({
          color,
          metalness,
          roughness,
          envMap: environment,
          envMapIntensity: 0.55,
        }),
      );
    this.brass = alloy(0xc49555, 0.68, 0.36);
    this.iron = alloy(0x293039, 0.58, 0.47);
    this.walnut = alloy(0x392519, 0.1, 0.66);
    this.jade = alloy(0x186c65, 0.34, 0.31);
    this.copper = alloy(0xaf5033, 0.64, 0.45);
    this.ivory = alloy(0xe6d4a4, 0.1, 0.57);
    this.ember = this.keep(
      new THREE.MeshStandardMaterial({
        color: 0xe04a21,
        emissive: 0xcf3710,
        emissiveIntensity: 0.45,
      }),
    );
    this.box(this.root, [0.728, 0.026, 0.108], [0, 0.013, 0], this.walnut);
    this.box(this.root, [0.728, 0.008, 0.014], [0, 0.026, -0.048], this.brass);
    const cradle = this.keep(new THREE.CylinderGeometry(0.067, 0.076, 0.019, 16));
    for (const [index, x] of SLOT_X.entries()) {
      const root = new THREE.Group();
      root.name = `mechanism-slot-${index}`;
      root.position.x = x;
      this.root.add(root);
      const base = new THREE.Mesh(cradle, this.brass);
      base.scale.z = 0.61;
      base.position.y = 0.03;
      root.add(base);
      const lamp = this.keep(
        new THREE.MeshStandardMaterial({
          color: 0x644324,
          emissive: 0xf5b85d,
          emissiveIntensity: 0.05,
        }),
      );
      this.mesh(root, new THREE.SphereGeometry(0.011, 10, 6), [0.087, 0.034, 0.033], lamp);
      let label: CanvasLabel | null = null;
      if (labels && typeof document !== 'undefined') {
        try {
          label = this.keep(new CanvasLabel(540, 200, WIDTH, false));
          label.mesh.name = 'mechanism-nameplate';
          label.mesh.position.set(0, 0.065, 0.075);
          label.mesh.rotation.x = -0.53;
          label.mesh.visible = false;
          root.add(label.mesh);
        } catch {
          // Geometry still identifies each device without a canvas in the renderer.
        }
      }
      this.slots.push({ root, lamp, label, uid: null, model: null, pulse: 0 });
    }
  }

  private keep<T extends { dispose(): void }>(resource: T): T {
    this.owned.push(resource);
    return resource;
  }

  private mesh(
    parent: THREE.Group,
    geometry: THREE.BufferGeometry,
    position: readonly [number, number, number],
    material: THREE.Material,
  ): THREE.Mesh {
    const part = new THREE.Mesh(this.keep(geometry), material);
    part.position.fromArray(position);
    parent.add(part);
    return part;
  }

  private box(
    parent: THREE.Group,
    dimensions: readonly [number, number, number],
    position: readonly [number, number, number],
    material: THREE.Material,
  ): THREE.Mesh {
    return this.mesh(parent, new THREE.BoxGeometry(...dimensions), position, material);
  }

  private build(id: string): THREE.Group {
    const root = new THREE.Group();
    root.name = `installed-${id}`;
    const ring = (
      radius: number,
      width: number,
      point: readonly [number, number, number],
      material: THREE.Material,
    ) => this.mesh(root, new THREE.TorusGeometry(radius, width, 8, 20), point, material);
    const drum = (
      radius: number,
      height: number,
      point: readonly [number, number, number],
      material: THREE.Material,
    ) => this.mesh(root, new THREE.CylinderGeometry(radius, radius, height, 18), point, material);
    switch (id) {
      case 'gyro-stabilizer': {
        drum(0.034, 0.033, [0, 0.011, 0], this.iron);
        ring(0.071, 0.006, [0, 0.087, 0], this.brass);
        ring(0.053, 0.005, [0, 0.087, 0], this.copper).rotation.set(0.69, -0.55, 0);
        this.mesh(root, new THREE.SphereGeometry(0.038, 16, 10), [0, 0.087, 0], this.jade);
        break;
      }
      case 'pressure-gauge': {
        this.box(root, [0.101, 0.058, 0.075], [0, 0.022, 0], this.iron);
        drum(0.063, 0.04, [0, 0.077, 0], this.brass).rotation.x = Math.PI / 2;
        drum(0.05, 0.007, [0, 0.077, 0.024], this.ivory).rotation.x = Math.PI / 2;
        ring(0.051, 0.004, [0, 0.077, 0.028], this.brass);
        this.box(root, [0.009, 0.066, 0.006], [0.007, 0.086, 0.031], this.copper).rotation.z =
          -0.83;
        drum(0.017, 0.028, [0.048, 0.139, -0.004], this.copper);
        break;
      }
      case 'clockwork-turret': {
        for (const [x, z] of [
          [-0.042, 0.033],
          [0.042, 0.033],
          [0, -0.049],
        ])
          this.box(root, [0.023, 0.053, 0.035], [x, 0.022, z], this.brass).rotation.z = -x * 7;
        // Keep the turret open around its moving shoulder and barrel. The old solid chassis read
        // as a rectangular backing in the headset and obscured the mechanism's silhouette.
        const shoulder = this.box(root, [0.086, 0.044, 0.062], [0, 0.128, -0.005], this.brass);
        shoulder.name = 'turret-brass-shoulder';
        const barrel = drum(0.022, 0.125, [0, 0.14, -0.054], this.brass);
        barrel.name = 'turret-cannon-barrel';
        barrel.rotation.x = Math.PI / 2;
        const bore = drum(0.012, 0.008, [0, 0.14, -0.119], this.iron);
        bore.name = 'turret-cannon-bore';
        bore.rotation.x = Math.PI / 2;
        const muzzle = ring(0.029, 0.006, [0, 0.14, -0.121], this.brass);
        muzzle.name = 'turret-muzzle-ring';
        const rearBand = ring(0.026, 0.004, [0, 0.14, 0.008], this.copper);
        rearBand.name = 'turret-rear-band';
        for (const side of [-1, 1] as const) {
          const pivot = ring(0.027, 0.006, [side * 0.051, 0.128, -0.006], this.brass);
          pivot.name = `turret-pivot-${side < 0 ? 'left' : 'right'}`;
          pivot.rotation.y = Math.PI / 2;
          this.mesh(
            root,
            new THREE.CylinderGeometry(0.009, 0.009, 0.014, 10),
            [side * 0.055, 0.128, -0.006],
            this.iron,
          ).rotation.z = Math.PI / 2;
        }
        const winding = this.box(root, [0.009, 0.036, 0.009], [0, 0.135, 0.032], this.copper);
        winding.name = 'turret-winding-key';
        winding.rotation.z = Math.PI / 2;
        ring(0.018, 0.004, [0, 0.135, 0.032], this.brass).rotation.x = Math.PI / 2;
        break;
      }
      case 'furnace-heart': {
        for (const side of [-1, 1]) {
          const vessel = this.mesh(
            root,
            new THREE.SphereGeometry(0.052, 16, 10),
            [side * 0.027, 0.068, 0],
            this.copper,
          );
          vessel.scale.set(0.9, 1.2, 0.65);
          ring(0.039, 0.011, [side * 0.044, 0.122, -0.013], this.iron).rotation.y = side * 0.55;
        }
        drum(0.047, 0.029, [0, 0.009, 0], this.iron);
        for (const x of [-0.033, 0, 0.033])
          this.box(root, [0.013, 0.055, 0.009], [x, 0.069, 0.035], this.ember);
        break;
      }
    }
    return root;
  }

  sync(cards: readonly CombatCard[], available: boolean): void {
    this.root.visible = available || cards.length > 0;
    this.slots.forEach((slot, index) => {
      const entry = cards[index];
      if (slot.uid === (entry?.uid ?? null)) return;
      slot.model?.removeFromParent();
      slot.model = null;
      slot.uid = entry?.uid ?? null;
      slot.root.userData.cardId = entry?.def.id;
      slot.pulse = 0;
      slot.lamp.emissiveIntensity = entry ? 0.34 : 0.05;
      if (slot.label) slot.label.mesh.visible = Boolean(entry);
      if (!entry) return;
      const id = entry.def.id.replace(/\+$/, '');
      let mold = this.molds.get(id);
      if (!mold) {
        mold = this.build(id);
        this.molds.set(id, mold);
      }
      slot.model = mold.clone(true);
      slot.model.position.y = 0.04;
      slot.root.add(slot.model);
      const card = getCard(entry.def.id);
      slot.label?.draw((ctx, width, height) => {
        ctx.fillStyle = '#182425';
        ctx.fillRect(0, 0, width, height);
        ctx.strokeStyle = '#ab8649';
        ctx.lineWidth = 8;
        ctx.strokeRect(4, 4, width - 8, height - 8);
        ctx.textAlign = 'center';
        ctx.fillStyle = '#ffead0';
        ctx.font = 'bold 52px Georgia';
        ctx.fillText(card.name, width / 2, 83, width - 26);
        ctx.fillStyle = '#e8d2aa';
        ctx.font = '42px system-ui';
        ctx.fillText(caption(card), width / 2, 151, width - 24);
      });
    });
  }

  fire(uid: number): THREE.Vector3 | null {
    const slot = this.slots.find((entry) => entry.uid === uid);
    if (!slot) return null;
    slot.pulse = PULSE_SECONDS;
    slot.lamp.emissiveIntensity = 2.6;
    return slot.root.localToWorld(this.at.set(0, 0.13, 0));
  }

  update(dt: number): void {
    for (const slot of this.slots) {
      if (slot.pulse <= 0) continue;
      slot.pulse = Math.max(0, slot.pulse - dt);
      const power = slot.pulse / PULSE_SECONDS;
      slot.lamp.emissiveIntensity = 0.34 + 2.26 * power;
      if (!this.reduced && slot.model) slot.model.rotation.z = 0.065 * Math.sin(power * 15) * power;
    }
  }

  dispose(): void {
    this.root.removeFromParent();
    for (const item of this.owned) item.dispose();
  }
}
