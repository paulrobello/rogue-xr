import * as THREE from 'three';

/** Visual-only doorway dressing. Gameplay owns whether the doorway is open. */
export class PuzzleGateVisual {
  readonly object = new THREE.Group();
  readonly bars = new THREE.Group();
  readonly chain = new THREE.Group();
  readonly valve = new THREE.Group();
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly materials: THREE.Material[] = [];
  private goal = 0;
  private rattling = 0;
  readonly handle: THREE.Object3D;

  constructor(kind: 'counterweight' | 'pressure') {
    this.object.name = `puzzle-gate-${kind}`;
    const iron = new THREE.MeshStandardMaterial({
      color: 0x343a3b,
      roughness: 0.65,
      metalness: 0.82,
    });
    const brass = new THREE.MeshStandardMaterial({
      color: 0xb88743,
      roughness: 0.42,
      metalness: 0.76,
    });
    const steam = new THREE.MeshStandardMaterial({
      color: 0xa7c2c2,
      emissive: 0x4b6e70,
      emissiveIntensity: 0.5,
    });
    this.materials.push(iron, brass, steam);
    const barGeo = new THREE.BoxGeometry(0.055, 2.18, 0.07);
    this.geometries.push(barGeo);
    for (let i = -5; i <= 5; i++) {
      const bar = new THREE.Mesh(barGeo, iron);
      bar.position.set(i * 0.13, 1.08, 0);
      this.bars.add(bar);
    }
    const chainGeo = new THREE.TorusGeometry(0.07, 0.018, 6, 12);
    this.geometries.push(chainGeo);
    for (let i = 0; i < 8; i++) {
      const link = new THREE.Mesh(chainGeo, iron);
      link.position.set(0, 1.9 - i * 0.18, 0.1);
      link.rotation.x = i % 2 ? Math.PI / 2 : 0;
      this.chain.add(link);
    }
    const valveGeo = new THREE.TorusGeometry(0.18, 0.035, 8, 16);
    const hubGeo = new THREE.CylinderGeometry(0.055, 0.055, 0.08, 12);
    this.geometries.push(valveGeo, hubGeo);
    const wheel = new THREE.Mesh(valveGeo, brass);
    wheel.rotation.x = Math.PI / 2;
    this.valve.add(wheel);
    const hub = new THREE.Mesh(hubGeo, brass);
    hub.rotation.x = Math.PI / 2;
    this.valve.add(hub);
    this.valve.position.set(0.78, 1.55, 0.12);
    // The handle is just proud of the door, on local +Z, so controller rays from the room hit it.
    const handle = new THREE.Mesh(new THREE.SphereGeometry(0.1, 10, 8), brass);
    handle.name = 'puzzle-gate-handle';
    handle.position.set(0, 1.05, 0.14);
    handle.userData.gatePart = 'handle';
    this.handle = handle;
    this.geometries.push(handle.geometry);
    const indicator = new THREE.Mesh(new THREE.SphereGeometry(0.07, 10, 8), steam);
    indicator.name = 'pressure-indicator';
    indicator.position.set(0.78, 1.93, 0.12);
    this.bars.add(handle);
    this.object.add(this.bars, this.chain, this.valve, indicator);
    this.object.userData.parts = {
      bars: this.bars,
      chain: this.chain,
      valve: this.valve,
      indicator,
    };
    this.valve.visible = kind === 'pressure';
    indicator.visible = kind === 'pressure';
    if (kind === 'pressure') {
      this.bars.visible = false;
      this.chain.visible = false;
      const panel = new THREE.Mesh(new THREE.BoxGeometry(1.58, 2.34, 0.12), iron);
      panel.name = 'pressure-door-panel';
      panel.position.set(0, 1.17, -0.02);
      const piston = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.52, 12), brass);
      piston.name = 'pressure-door-piston';
      piston.rotation.z = Math.PI / 2;
      piston.position.set(0.46, 1.18, 0.1);
      panel.add(handle);
      handle.position.y = -0.12;
      handle.position.z = 0.14;
      this.object.add(panel, piston);
      this.geometries.push(panel.geometry, piston.geometry);
    }
  }

  setOpen(open: boolean, immediate = false): void {
    this.goal = open ? 1 : 0;
    if (immediate) {
      this.bars.position.y = this.goal * 2.3;
      this.chain.position.y = this.goal * 2.3;
      this.valve.rotation.z = this.goal * -Math.PI * 0.9;
      const panel = this.object.getObjectByName('pressure-door-panel');
      if (panel) panel.position.y = this.goal * 2.4 + 1.17;
      const piston = this.object.getObjectByName('pressure-door-piston');
      if (piston) piston.position.y = this.goal * 2.4 + 1.18;
    }
  }

  /** Briefly shakes the bars and chain when a locked gate is checked. */
  rattle(): void {
    if (this.goal > 0.5) return;
    this.rattling = 0.22;
  }

  update(dt: number): void {
    const amount = THREE.MathUtils.damp(this.bars.position.y, this.goal * 2.3, 7, dt);
    this.bars.position.y = amount;
    this.chain.position.y = amount;
    this.valve.rotation.z = THREE.MathUtils.damp(
      this.valve.rotation.z,
      this.goal * -Math.PI * 0.9,
      5,
      dt,
    );
    const panel = this.object.getObjectByName('pressure-door-panel');
    if (panel)
      panel.position.y = THREE.MathUtils.damp(panel.position.y, this.goal * 2.4 + 1.17, 7, dt);
    const piston = this.object.getObjectByName('pressure-door-piston');
    if (piston)
      piston.position.y = THREE.MathUtils.damp(piston.position.y, this.goal * 2.4 + 1.18, 7, dt);
    if (this.rattling > 0) {
      this.rattling = Math.max(0, this.rattling - dt);
      const shake = Math.sin(this.rattling * 72) * this.rattling * 0.06;
      this.bars.rotation.z = shake;
      this.chain.rotation.z = -shake * 0.8;
    } else {
      this.bars.rotation.z = THREE.MathUtils.damp(this.bars.rotation.z, 0, 10, dt);
      this.chain.rotation.z = THREE.MathUtils.damp(this.chain.rotation.z, 0, 10, dt);
    }
  }

  dispose(): void {
    this.object.removeFromParent();
    for (const geometry of this.geometries) geometry.dispose();
    for (const material of this.materials) material.dispose();
  }
}
