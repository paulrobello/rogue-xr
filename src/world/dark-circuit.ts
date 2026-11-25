import * as THREE from 'three';
import { CanvasLabel } from '../combat-view/canvas-label.ts';
import { templateById } from '../content/rooms.ts';
import type { DoorRef } from '../floor/generate.ts';
import {
  CIRCUIT_SOCKET_MASKS,
  type CircuitSocket,
  circuitLampMask,
  type DarkCircuitState,
  darkCircuitTargets,
  readDarkCircuit,
} from '../rules/dark-circuit.ts';
import { DOOR_HEIGHT, type FloorWorld } from './floor-world.ts';
import type { InteriorPlacement } from './interior-furnishings.ts';
import { findPuzzleMount } from './puzzle-placement.ts';

const FACING_IN: Record<'N' | 'E' | 'S' | 'W', number> = {
  N: 0,
  E: -Math.PI / 2,
  S: Math.PI,
  W: Math.PI / 2,
};
const SOCKETS: readonly CircuitSocket[] = [0, 1, 2, 3];
const SOCKET_X = [-0.45, -0.15, 0.15, 0.45];
const LAMP_X = [-0.3, 0, 0.3];
const LAMP_SYMBOLS = ['○', '△', '◇'];
export const DARK_CIRCUIT_GATE_SECONDS = 0.95;

/** Independent switchboard and rack-driven grille. */
export class DarkCircuit {
  readonly object = new THREE.Group();
  readonly gate = new THREE.Group();
  private readonly board = new THREE.Group();
  private readonly sockets: THREE.Mesh[] = [];
  private readonly lamps: THREE.Mesh[] = [];
  private readonly bridges: THREE.Mesh[] = [];
  private readonly bridgeGoals: THREE.Vector3[] = [];
  readonly leaf = new THREE.Group();
  private readonly bridgeSlots: (CircuitSocket | null)[] = [null, null];
  private readonly labels: CanvasLabel[] = [];
  private progressLabel?: CanvasLabel;
  private readonly ray = new THREE.Raycaster();
  private readonly hitPoint = new THREE.Vector3();
  private readonly box = new THREE.Box3();
  private readonly obstacle = new THREE.Box3();
  private removeCollider?: () => void;
  private gateAge = 0;
  private state = readDarkCircuit({});
  private readonly reducedMotion: boolean;
  private readonly roomIndex: number;
  private readonly targetMasks: readonly number[];

  constructor(
    private readonly world: FloorWorld,
    readonly layout: NonNullable<FloorWorld['plan']['darkCircuit']>,
    seed: string,
    reducedMotion: boolean,
    private readonly environment: THREE.Texture | null,
    furnishings: readonly InteriorPlacement[],
  ) {
    this.reducedMotion = reducedMotion;
    this.roomIndex = layout.switchboard;
    this.targetMasks = darkCircuitTargets(seed);
    this.object.name = 'dark-circuit-switchboard';
    this.board.name = 'dark-circuit-board';
    this.gate.name = 'dark-circuit-toothed-grille';
    this.leaf.name = 'dark-circuit-grille-leaf';
    this.mountBoard(furnishings);
    this.mountGate(layout.gate);
    this.sync(this.state, true);
  }

  get room(): number {
    return this.roomIndex;
  }

  get released(): boolean {
    return this.state.open && this.gateAge >= DARK_CIRCUIT_GATE_SECONDS;
  }

  private mountBoard(furnishings: readonly InteriorPlacement[]): void {
    let site = findPuzzleMount(
      this.world,
      [this.layout.switchboard],
      furnishings,
      'dark-circuit-switchboard',
      0.79,
      1.05,
      2.08,
    );
    if (!site) {
      const template = templateById(this.world.plan.rooms[this.roomIndex].templateId);
      const wall = template.doors.some(
        (door) => door.facing === 'S' && Math.abs(door.position[0]) < 2.1,
      )
        ? 'N'
        : 'S';
      const edge =
        wall === 'S' ? template.footprint.max[1] - 0.18 : template.footprint.min[1] + 0.18;
      site = {
        room: this.roomIndex,
        center: new THREE.Vector3(),
        wallSurface: new THREE.Vector3(0, 1.48, edge),
        yaw: FACING_IN[wall],
      };
    }
    this.board.position.copy(site.wallSurface);
    this.board.rotation.y = site.yaw;
    this.board.translateZ(0.075);
    this.object.add(this.board);
    this.world.roomGroups[this.layout.switchboard].add(this.object);
    const steel = new THREE.MeshStandardMaterial({
      color: 0x465555,
      emissive: 0x142020,
      emissiveIntensity: 0.34,
      envMap: this.environment,
      envMapIntensity: 0.52,
      metalness: 0.44,
      roughness: 0.46,
    });
    const brass = new THREE.MeshStandardMaterial({
      color: 0xc3954c,
      envMap: this.environment,
      envMapIntensity: 0.62,
      metalness: 0.58,
      roughness: 0.38,
    });
    this.board.add(new THREE.Mesh(new THREE.BoxGeometry(1.48, 1.12, 0.1), steel));
    const inset = new THREE.Mesh(
      new THREE.BoxGeometry(1.3, 0.94, 0.025),
      new THREE.MeshStandardMaterial({
        color: 0x223333,
        emissive: 0x152727,
        emissiveIntensity: 0.56,
        roughness: 0.85,
      }),
    );
    inset.position.z = 0.063;
    this.board.add(inset);
    for (const x of [-0.68, 0.68]) {
      const edge = new THREE.Mesh(new THREE.BoxGeometry(0.033, 1.02, 0.031), brass);
      edge.position.set(x, 0, 0.063);
      this.board.add(edge);
    }
    for (const y of [-0.515, 0.515]) {
      const edge = new THREE.Mesh(new THREE.BoxGeometry(1.39, 0.033, 0.031), brass);
      edge.position.set(0, y, 0.063);
      this.board.add(edge);
    }
    for (const i of SOCKETS) {
      const socket = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.075, 0.035, 16), brass);
      socket.rotation.x = Math.PI / 2;
      socket.position.set(SOCKET_X[i], -0.12, 0.095);
      socket.name = `dark-circuit-socket-${i}`;
      this.board.add(socket);
      this.sockets.push(socket);
      const trace = new THREE.Mesh(new THREE.BoxGeometry(0.018, 0.34, 0.012), brass);
      trace.position.set(SOCKET_X[i], 0.02, 0.082);
      this.board.add(trace);
    }
    for (const [index, x] of LAMP_X.entries()) {
      const rim = new THREE.Mesh(new THREE.TorusGeometry(0.082, 0.012, 8, 18), brass);
      rim.position.set(x, 0.23, 0.092);
      this.board.add(rim);
      const shape =
        index === 0
          ? new THREE.CircleGeometry(0.054, 20)
          : new THREE.CircleGeometry(0.061, index + 2, Math.PI / 2);
      const lamp = new THREE.Mesh(
        shape,
        new THREE.MeshStandardMaterial({
          color: 0x352a1a,
          emissive: 0xdec16a,
          emissiveIntensity: 0.05,
        }),
      );
      lamp.name = `dark-circuit-lamp-${index}`;
      lamp.position.set(x, 0.23, 0.093);
      this.board.add(lamp);
      this.lamps.push(lamp);
    }
    for (let i = 0; i < 2; i++) {
      const bridge = new THREE.Mesh(new THREE.BoxGeometry(0.21, 0.045, 0.07), brass);
      const rest = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.054, 0.066), steel);
      rest.position.set(-0.32 + i * 0.64, -0.36, 0.089);
      this.board.add(rest);
      bridge.name = `dark-circuit-bridge-${i}`;
      bridge.position.set(rest.position.x, rest.position.y, 0.134);
      this.board.add(bridge);
      this.bridges.push(bridge);
      this.bridgeGoals.push(bridge.position.clone());
    }
    const title = typeof document === 'undefined' ? null : new CanvasLabel(900, 150, 1.15, true);
    if (title) {
      title.draw((ctx, w, _h) => {
        ctx.fillStyle = '#f3dfad';
        ctx.font = 'bold 64px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('DARK CIRCUIT', w / 2, 68);
        ctx.font = '42px system-ui, sans-serif';
        ctx.fillText('PAIR TWO · SHARED MARKS CANCEL', w / 2, 124);
      });
      title.mesh.position.set(0, 0.47, 0.09);
      this.board.add(title.mesh);
      this.labels.push(title);
    }
    const symbols = typeof document === 'undefined' ? null : new CanvasLabel(900, 130, 1.15, true);
    if (symbols) {
      symbols.draw((ctx, w, _h) => {
        ctx.fillStyle = '#eee4c9';
        ctx.font = 'bold 57px system-ui, sans-serif';
        ctx.textAlign = 'center';
        for (const [index, x] of SOCKET_X.entries()) {
          const marks = LAMP_SYMBOLS.filter((_, bit) => CIRCUIT_SOCKET_MASKS[index] & (1 << bit));
          ctx.fillText(marks.join(' '), w * (0.5 + x / 1.15), 79);
        }
      });
      symbols.mesh.position.set(0, 0.014, 0.101);
      this.board.add(symbols.mesh);
      this.labels.push(symbols);
      const progress = new CanvasLabel(900, 146, 1.26, true);
      progress.mesh.position.set(0, -0.493, 0.112);
      this.board.add(progress.mesh);
      this.progressLabel = progress;
      this.labels.push(progress);
    }
    this.board.updateWorldMatrix(true, false);
    const bounds = new THREE.Box3(
      new THREE.Vector3(-0.74, -0.56, -0.05),
      new THREE.Vector3(0.74, 0.56, 0.071),
    ).applyMatrix4(this.board.matrixWorld);
    this.removeCollider = this.world.addFixtureCollider(this.layout.switchboard, {
      min: bounds.min.toArray(),
      max: bounds.max.toArray(),
    });
  }

  private mountGate(ref: DoorRef): void {
    const door = this.world.rooms[ref.room]?.doors.find((d) => d.id === ref.door);
    if (!door) throw new Error('Missing Dark Circuit gate doorway');
    this.gate.position.set(door.world[0], 0, door.world[1]);
    this.gate.rotation.y = FACING_IN[door.facing];
    this.gate.translateZ(0.14);
    this.world.roomGroups[ref.room].attach(this.gate);
    this.gate.add(this.leaf);
    const frameMat = new THREE.MeshStandardMaterial({
      color: 0x4c5a5b,
      metalness: 0.65,
      roughness: 0.55,
    });
    const brassMat = new THREE.MeshStandardMaterial({
      color: 0xc79548,
      metalness: 0.72,
      roughness: 0.38,
    });
    const halfWidth = door.width / 2;
    for (const x of [-halfWidth, halfWidth]) {
      const jamb = new THREE.Mesh(new THREE.BoxGeometry(0.08, DOOR_HEIGHT, 0.16), frameMat);
      jamb.position.set(x, DOOR_HEIGHT / 2, 0);
      this.gate.add(jamb);
    }
    const lintel = new THREE.Mesh(new THREE.BoxGeometry(door.width + 0.08, 0.09, 0.16), frameMat);
    lintel.position.y = DOOR_HEIGHT;
    this.gate.add(lintel);
    for (let i = -5; i <= 5; i++) {
      const bar = new THREE.Mesh(new THREE.BoxGeometry(0.043, DOOR_HEIGHT - 0.08, 0.057), frameMat);
      bar.position.set((i * (door.width - 0.18)) / 10, DOOR_HEIGHT / 2, 0);
      this.leaf.add(bar);
    }
    for (const y of [0.23, 1.23, DOOR_HEIGHT - 0.19]) {
      const rail = new THREE.Mesh(
        new THREE.BoxGeometry(door.width - 0.105, 0.079, 0.082),
        brassMat,
      );
      rail.position.set(0, y, 0.019);
      this.leaf.add(rail);
    }
    for (let i = 0; i < 8; i++) {
      const tooth = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.065, 0.09), brassMat);
      tooth.position.set(halfWidth - 0.15, 0.22 + i * 0.26, 0.05);
      this.leaf.add(tooth);
    }
  }

  sync(state: DarkCircuitState, immediate = false): void {
    const snap = immediate || this.reducedMotion;
    if (!state.open || !this.state.open) this.gateAge = 0;
    if (snap && state.open) this.gateAge = DARK_CIRCUIT_GATE_SECONDS;
    this.state = state;
    for (const [i, socket] of this.bridgeSlots.entries()) {
      if (socket !== null && !state.sockets.includes(socket)) this.bridgeSlots[i] = null;
    }
    for (const socket of state.sockets) {
      if (!this.bridgeSlots.includes(socket))
        this.bridgeSlots[this.bridgeSlots.indexOf(null)] = socket;
    }
    for (const [i, bridge] of this.bridges.entries()) {
      const socket = this.bridgeSlots[i];
      this.bridgeGoals[i].set(
        socket === null ? -0.32 + i * 0.64 : SOCKET_X[socket],
        socket === null ? -0.36 : -0.12,
        0.134,
      );
      if (snap) bridge.position.copy(this.bridgeGoals[i]);
    }
    const completed = state.open ? this.targetMasks.length : (state.completed?.length ?? 0);
    const mask = state.open ? (this.targetMasks.at(-1) ?? 0) : circuitLampMask(state.sockets);
    this.lamps.forEach((lamp, i) => {
      (lamp.material as THREE.MeshStandardMaterial).emissiveIntensity =
        mask & (1 << i) ? 1.75 : 0.055;
    });
    this.progressLabel?.draw((ctx, w, h) => {
      ctx.fillStyle = state.open ? '#173d2a' : '#101818';
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = state.open ? '#d8f3d5' : '#d3e6d4';
      ctx.font = 'bold 36px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(
        state.open
          ? 'CIRCUIT STABLE'
          : `LINE ${completed + 1} / 3 · ${state.sockets.length} / 2 BRIDGES`,
        w / 2,
        49,
      );
      this.targetMasks.forEach((target, index) => {
        const symbols = LAMP_SYMBOLS.filter((_, bit) => target & (1 << bit));
        ctx.fillStyle = index < completed ? '#a3e8a6' : index === completed ? '#f9d686' : '#e2cab2';
        ctx.fillText(`${index + 1}  ${symbols.join(' + ')}`, ((index + 0.5) * w) / 3, 113);
      });
    });
    this.poseGate();
  }

  update(dt: number): void {
    for (const [i, bridge] of this.bridges.entries()) {
      const goal = this.bridgeGoals[i];
      if (bridge.position.distanceToSquared(goal) < 0.000001) bridge.position.copy(goal);
      else bridge.position.lerp(goal, 1 - Math.exp(-10 * dt));
    }
    if (!this.state.open || this.released) return;
    this.gateAge = Math.min(DARK_CIRCUIT_GATE_SECONDS, this.gateAge + dt);
    this.poseGate();
  }

  private poseGate(): void {
    const progress = THREE.MathUtils.smoothstep(this.gateAge, 0, DARK_CIRCUIT_GATE_SECONDS);
    this.leaf.position.y = -(DOOR_HEIGHT + 0.05) * progress;
    this.leaf.visible = !this.released;
    this.world.setPuzzleGateOpen('dark-circuit', this.released, true);
  }

  pick(
    origin: THREE.Vector3,
    direction: THREE.Vector3,
  ): { action: CircuitSocket; distance: number } | null {
    if (this.world.current !== this.roomIndex || this.state.open) return null;
    this.ray.set(origin, direction);
    this.ray.far = 4;
    this.board.updateWorldMatrix(true, true);
    let best: { action: CircuitSocket; distance: number } | null = null;
    for (const [i, socket] of this.sockets.entries()) {
      const hit = this.ray.intersectObject(socket, false)[0];
      if (hit && (!best || hit.distance < best.distance))
        best = { action: i as CircuitSocket, distance: hit.distance };
    }
    if (!best) return null;
    for (const b of this.world.colliders[this.roomIndex] ?? []) {
      this.obstacle.min.fromArray(b.min);
      this.obstacle.max.fromArray(b.max);
      if (
        this.ray.ray.intersectBox(this.obstacle, this.hitPoint) &&
        this.hitPoint.distanceTo(origin) < best.distance - 0.02
      )
        return null;
    }
    return best;
  }

  near(point: THREE.Vector3, reach: number): { action: CircuitSocket; distance: number } | null {
    if (this.world.current !== this.roomIndex || this.state.open) return null;
    let best: { action: CircuitSocket; distance: number } | null = null;
    for (const [i, socket] of this.sockets.entries()) {
      const distance = this.box.setFromObject(socket).distanceToPoint(point);
      if (distance <= reach && (!best || distance < best.distance))
        best = { action: i as CircuitSocket, distance };
    }
    return best;
  }

  soundPoint(action: CircuitSocket | 'release'): THREE.Vector3 {
    if (action === 'release')
      return this.gate.getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3(0, 1.2, 0));
    return this.sockets[action].getWorldPosition(new THREE.Vector3());
  }

  dispose(): void {
    this.removeCollider?.();
    this.object.removeFromParent();
    this.gate.removeFromParent();
    for (const label of this.labels) {
      label.mesh.removeFromParent();
      label.dispose();
    }
    const materials = new Set<THREE.Material>();
    for (const group of [this.board, this.gate]) {
      group.traverse((node) => {
        if (!(node instanceof THREE.Mesh)) return;
        node.geometry.dispose();
        for (const material of Array.isArray(node.material) ? node.material : [node.material])
          materials.add(material);
      });
    }
    for (const material of materials) material.dispose();
  }
}
