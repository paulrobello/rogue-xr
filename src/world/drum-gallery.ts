import * as THREE from 'three';
import { CanvasLabel } from '../combat-view/canvas-label.ts';
import { type Facing, templateById } from '../content/rooms.ts';
import type { FloorPlan } from '../floor/generate.ts';
import {
  type DrumBeat,
  type DrumControl,
  type DrumGalleryState,
  type DrumPin,
  drumPattern,
  drumPlayback,
  EMPTY_DRUM_GALLERY,
} from '../rules/drum-gallery.ts';
import type { BellNote } from '../rules/types.ts';
import { ClockInscription } from './clock-inscription.ts';
import { DOOR_HEIGHT, type FloorWorld } from './floor-world.ts';
import type { InteriorPlacement } from './interior-furnishings.ts';
import { findPuzzleMount } from './puzzle-placement.ts';

const FACING_IN: Record<Facing, number> = { N: 0, E: -Math.PI / 2, S: Math.PI, W: Math.PI / 2 };
const BEATS: readonly DrumBeat[] = [0, 1, 2, 3];
const NOTES: readonly BellNote[] = [0, 1, 2];
const NOTE_LABELS = ['LOW', 'MID', 'HIGH'];
const BEAT_X = [-0.445, -0.158, 0.129, 0.416];
const NOTE_Y = [-0.025, -0.17, -0.315];
const BOARD_WIDTH = 1.69;
const BOARD_HEIGHT = 1.24;
export const DRUM_BEAT_SECONDS = 0.4;
export const DRUM_GATE_SECONDS = 0.95;

type Layout = NonNullable<FloorPlan['drumGallery']>;
type Pick = { action: DrumControl; distance: number };
type Feedback = {
  onBeat: (notes: readonly BellNote[], at: THREE.Vector3) => void;
  onRelease: (at: THREE.Vector3) => void;
};

export class DrumGallery {
  readonly object = new THREE.Group();
  readonly gate = new THREE.Group();
  readonly leaf = new THREE.Group();
  readonly clueObject: THREE.Object3D;
  readonly clueRoom: number;
  private readonly board = new THREE.Group();
  private readonly drum = new THREE.Group();
  private readonly markers: THREE.MeshBasicMaterial[] = [];
  private readonly hits = new Map<THREE.Mesh, DrumControl>();
  private readonly sockets = new Map<string, THREE.Mesh>();
  private readonly seatedCaps = new Map<string, THREE.Mesh>();
  private readonly geometries = new Set<THREE.BufferGeometry>();
  private readonly materials = new Set<THREE.Material>();
  private readonly ray = new THREE.Raycaster();
  private readonly box = new THREE.Box3();
  private readonly point = new THREE.Vector3();
  private readonly pattern: ReturnType<typeof drumPattern>;
  private readonly reservePins: THREE.Mesh[] = [];
  private readonly drumPins: THREE.Mesh[];
  private readonly key = new THREE.Group();
  private readonly label: CanvasLabel | null;
  private readonly scoreClue: ClockInscription;
  private readonly removeCollider: () => void;
  private state: DrumGalleryState = EMPTY_DRUM_GALLERY;
  private phrase: readonly (readonly BellNote[])[] = [];
  private beat = -1;
  private beatAge = 0;
  private gateAge = 0;
  private opening = false;

  constructor(
    private readonly world: FloorWorld,
    readonly layout: Layout,
    runSeed: string,
    private readonly reducedMotion: boolean,
    art: THREE.Object3D | undefined,
    private readonly environment: THREE.Texture | null,
    furnishings: readonly InteriorPlacement[],
    private readonly callbacks: Feedback,
  ) {
    this.pattern = drumPattern(runSeed);
    this.object.name = 'drum-gallery';
    this.board.name = 'drum-gallery-board';
    this.drum.name = 'drum-gallery-cylinder';
    this.gate.name = 'drum-gallery-grille';
    this.leaf.name = 'drum-gallery-grille-leaf';
    this.locate(furnishings);

    const casework = this.standard(0x39494d, 0.34);
    const brass = this.standard(0xb38241, 0.58);
    const walnut = this.standard(0x4b3224, 0.05);
    this.boxPart(this.board, casework, [BOARD_WIDTH, BOARD_HEIGHT, 0.103], [0, 0, 0]);
    const panel = this.standard(0x193c39, 0.14);
    panel.emissive.setHex(0x1c302b);
    panel.emissiveIntensity = 0.4;
    this.boxPart(this.board, panel, [1.59, 1.15, 0.027], [0, 0, 0.058]);
    for (const y of [-0.595, 0.595])
      this.boxPart(this.board, brass, [1.64, 0.029, 0.044], [0, y, 0.062]);
    for (const x of [-0.81, 0.81])
      this.boxPart(this.board, brass, [0.027, 1.165, 0.044], [x, 0, 0.062]);
    for (const x of [-0.72, 0.72]) {
      this.boxPart(this.board, brass, [0.036, 0.98, 0.032], [x, -0.02, 0.084]);
      for (const y of [-0.48, 0.46])
        this.mesh(this.board, new THREE.SphereGeometry(0.022, 8, 5), brass, [x, y, 0.108]);
    }
    this.boxPart(this.board, walnut, [1.45, 0.042, 0.31], [-0.05, 0.19, 0.19]);

    this.label = this.markings();
    [this.scoreClue, this.clueRoom] = this.mountScoreClue(furnishings);
    this.clueObject = this.scoreClue.object;
    const socket = new THREE.CylinderGeometry(0.045, 0.045, 0.027, 14).rotateX(Math.PI / 2);
    const cap = new THREE.CylinderGeometry(0.026, 0.031, 0.05, 12).rotateX(Math.PI / 2);
    const recessed = this.standard(0x171b1b, 0.16);
    const jewelled = this.standard(0xe6bb67, 0.36);
    const target = new THREE.BoxGeometry(0.17, 0.122, 0.07);
    const invisible = new THREE.MeshBasicMaterial({ visible: false });
    for (const beat of BEATS) {
      const marker = new THREE.MeshBasicMaterial({ color: 0x654e34, toneMapped: false });
      this.markers.push(marker);
      this.boxPart(this.board, marker, [0.183, 0.016, 0.015], [BEAT_X[beat], 0.07, 0.102]).name =
        `drum-gallery-beat-${beat}`;
      for (const note of NOTES) {
        const x = BEAT_X[beat],
          y = NOTE_Y[note];
        this.mesh(this.board, socket, recessed, [x, y, 0.092]);
        const hit = this.mesh(this.board, target, invisible, [x, y, 0.118]);
        hit.name = `drum-gallery-pin-${beat}-${note}`;
        this.sockets.set(`${beat}:${note}`, hit);
        this.hits.set(hit, { kind: 'pin', pin: { beat, note } });
        const seated = this.mesh(this.board, cap, brass, [x, y, 0.117]);
        this.seatedCaps.set(`${beat}:${note}`, seated);
      }
    }
    this.boxPart(this.board, recessed, [0.101, 0.374, 0.032], [0.619, -0.204, 0.098]);
    for (const beat of BEATS) {
      const pin = this.mesh(this.board, cap, jewelled, [0.62, -0.079 - 0.083 * beat, 0.123]);
      pin.name = `drum-gallery-reserve-${beat}`;
      this.reservePins.push(pin);
    }
    this.drumPins = this.mountDrum(art, walnut, brass);
    this.mountKey(art, brass, invisible);
    this.mountGate(casework, brass);

    this.board.updateWorldMatrix(true, false);
    const bounds = new THREE.Box3(
      new THREE.Vector3(-BOARD_WIDTH / 2, -BOARD_HEIGHT / 2, -0.057),
      new THREE.Vector3(BOARD_WIDTH / 2, BOARD_HEIGHT / 2, 0.077),
    ).applyMatrix4(this.board.matrixWorld);
    this.removeCollider = world.addFixtureCollider(layout.gallery, {
      min: bounds.min.toArray(),
      max: bounds.max.toArray(),
    });
    this.sync(this.state, true);
  }

  get released(): boolean {
    return this.state.open && this.gateAge >= DRUM_GATE_SECONDS;
  }

  get playing(): boolean {
    return this.beat >= 0;
  }

  private locate(furnishings: readonly InteriorPlacement[]): void {
    const room = this.layout.gallery;
    const site = findPuzzleMount(this.world, [room], furnishings, 'drum-gallery', 0.86, 1.1, 2.15);
    if (site) {
      this.board.position.copy(site.wallSurface);
      this.board.rotation.y = site.yaw;
    } else {
      const template = templateById(this.world.plan.rooms[room].templateId);
      const south = !template.doors.some(
        (door) => door.facing === 'S' && Math.abs(door.position[0]) < 2.0,
      );
      this.board.position.set(
        0,
        1.48,
        south ? template.footprint.max[1] - 0.15 : template.footprint.min[1] + 0.15,
      );
      this.board.rotation.y = south ? Math.PI : 0;
    }
    this.board.translateZ(0.14);
    this.object.add(this.board);
    this.world.roomGroups[room].add(this.object);
  }

  private standard(color: number, metalness: number): THREE.MeshStandardMaterial {
    return new THREE.MeshStandardMaterial({
      color,
      metalness,
      roughness: 0.48,
      envMap: this.environment,
      envMapIntensity: 0.56,
    });
  }

  private mesh(
    parent: THREE.Object3D,
    g: THREE.BufferGeometry,
    m: THREE.Material,
    at: readonly [number, number, number],
  ): THREE.Mesh {
    const mesh = new THREE.Mesh(g, m);
    mesh.position.fromArray(at);
    parent.add(mesh);
    this.geometries.add(g);
    this.materials.add(m);
    return mesh;
  }

  private boxPart(
    parent: THREE.Object3D,
    m: THREE.Material,
    size: readonly [number, number, number],
    at: readonly [number, number, number],
  ): THREE.Mesh {
    return this.mesh(parent, new THREE.BoxGeometry(...size), m, at);
  }

  private markings(): CanvasLabel | null {
    if (typeof document === 'undefined') return null;
    const label = new CanvasLabel(1100, 820, 1.61, true);
    label.mesh.name = 'drum-gallery-score';
    label.mesh.position.z = 0.082;
    label.draw((ctx, width, height) => {
      const x = (at: number) => width * (0.5 + at / 1.61);
      const y = (at: number) => height / 2 - (at * width) / 1.61;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#f3e1ae';
      ctx.font = 'bold 54px Georgia, serif';
      ctx.fillText('DRUM GALLERY', x(0), y(0.511));
      ctx.font = 'bold 32px system-ui, sans-serif';
      ctx.fillText('WIND', x(0.65), y(0.479));
      ctx.fillText('PINS', x(0.62), y(-0.429));
      for (const beat of BEATS) ctx.fillText(String(beat + 1), x(BEAT_X[beat]), y(0.128));
      ctx.font = 'bold 30px system-ui, sans-serif';
      // Keep the note legend inside the brass trim. The service order is shown on
      // a separate plaque so the puzzle face only communicates its sockets.
      for (const note of NOTES) ctx.fillText(NOTE_LABELS[note], x(-0.585), y(NOTE_Y[note]));
      ctx.fillText('Fit four pins. Wind to test.', x(0), y(-0.508));
    });
    this.board.add(label.mesh);
    return label;
  }

  private mountScoreClue(furnishings: readonly InteriorPlacement[]): [ClockInscription, number] {
    const clue = new ClockInscription(
      'drum-gallery-score-clue',
      0.82,
      'Drum Gallery Service Score',
      this.pattern.notes.map((note) => NOTE_LABELS[note]).join('  ·  '),
      'Place the four notes in this order.',
    );
    const reachable = new Set<number>([0]);
    for (const room of reachable)
      for (const edge of this.world.plan.connections) {
        if (edge.puzzleGate) continue;
        if (edge[0].room === room) reachable.add(edge[1].room);
        if (edge[1].room === room) reachable.add(edge[0].room);
      }
    const rooms = [...reachable].filter((room) => room !== this.layout.gallery);
    const mount = findPuzzleMount(this.world, rooms, furnishings, 'drum-gallery-clue', 0.46, 0.74);
    const room = mount?.room ?? 0;
    if (mount) {
      clue.object.position.copy(mount.wallSurface).setY(1.49);
      clue.object.rotation.y = mount.yaw;
      // Keep the plaque on the same wall mount, but proud of the baked trim.
      clue.object.translateZ(0.12);
    } else {
      const footprint = templateById(this.world.plan.rooms[room].templateId).footprint;
      clue.object.position.set(footprint.min[0] + 1.15, 1.53, footprint.max[1] - 0.3);
      clue.object.rotation.y = Math.PI;
    }
    this.world.roomGroups[room].add(clue.object);
    return [clue, room];
  }

  private mountDrum(
    art: THREE.Object3D | undefined,
    wood: THREE.Material,
    brass: THREE.Material,
  ): THREE.Mesh[] {
    const axle = new THREE.Group();
    axle.position.set(-0.09, 0.335, 0.226);
    axle.rotation.z = -Math.PI / 2;
    axle.add(this.drum);
    this.board.add(axle);
    const shell = art?.getObjectByName('pinned_drum')?.clone(true);
    if (shell) {
      shell.traverse((node) => {
        if (/^pin(?:[._-]?\d+)?$/i.test(node.name)) node.visible = false;
      });
      shell.scale.set(1.16, 3.2, 1.16);
      shell.position.y = -0.384;
      this.drum.add(shell);
    } else
      this.mesh(this.drum, new THREE.CylinderGeometry(0.109, 0.109, 0.768, 28), wood, [0, 0, 0]);
    for (const side of [-1, 1])
      this.mesh(this.drum, new THREE.CylinderGeometry(0.128, 0.128, 0.023, 24), brass, [
        0,
        side * 0.385,
        0,
      ]);
    const pinShape = new THREE.BoxGeometry(0.026, 0.035, 0.028);
    return BEATS.map(() => this.mesh(this.drum, pinShape, brass, [0, 0, 0]));
  }

  private positionDrumPin(mesh: THREE.Mesh, beat: DrumBeat, note: BellNote): void {
    const angle = (beat * Math.PI) / 2;
    mesh.position.set(0.121 * Math.sin(angle), (note - 1) * 0.196, 0.121 * Math.cos(angle));
    mesh.rotation.y = angle;
  }

  private mountKey(
    art: THREE.Object3D | undefined,
    brass: THREE.Material,
    invisible: THREE.Material,
  ): void {
    this.key.position.set(0.65, 0.296, 0.192);
    this.board.add(this.key);
    const key = art?.getObjectByName('winding_key')?.clone(true);
    if (key) {
      key.rotation.x = Math.PI / 2;
      key.scale.setScalar(0.95);
      this.key.add(key);
    } else this.mesh(this.key, new THREE.TorusGeometry(0.056, 0.017, 8, 18), brass, [0, 0, 0.026]);
    const hit = this.mesh(
      this.board,
      new THREE.BoxGeometry(0.22, 0.2, 0.2),
      invisible,
      [0.65, 0.3, 0.223],
    );
    hit.name = 'drum-gallery-wind';
    this.hits.set(hit, { kind: 'wind' });
  }

  private mountGate(casework: THREE.Material, brass: THREE.Material): void {
    const ref = this.layout.gate;
    const door = this.world.rooms[ref.room]?.doors.find((candidate) => candidate.id === ref.door);
    if (!door) throw Error('Missing Drum Gallery gate doorway');
    this.gate.position.set(door.world[0], 0, door.world[1]);
    this.gate.rotation.y = FACING_IN[door.facing];
    this.gate.translateZ(0.12);
    this.world.roomGroups[ref.room].attach(this.gate);
    this.gate.add(this.leaf);
    for (const x of [-door.width / 2, door.width / 2])
      this.boxPart(this.gate, casework, [0.096, DOOR_HEIGHT, 0.16], [x, DOOR_HEIGHT / 2, 0]);
    for (let i = -4; i <= 4; i++)
      this.boxPart(
        this.leaf,
        casework,
        [0.061, DOOR_HEIGHT - 0.012, 0.075],
        [(i * (door.width - 0.15)) / 8, DOOR_HEIGHT / 2, 0],
      );
    for (const y of [0.03, 1.2, DOOR_HEIGHT - 0.03])
      this.boxPart(this.leaf, brass, [door.width - 0.071, 0.076, 0.099], [0, y, 0.013]);
  }

  sync(state: DrumGalleryState, immediate = false): void {
    this.state = state;
    const seats = drumPlayback(this.pattern, state.pin, state.pins);
    for (const [key, cap] of this.seatedCaps) {
      const [beat, note] = key.split(':').map(Number);
      cap.visible = seats[beat]?.includes(note as BellNote) ?? false;
    }
    const fitted = seats.filter((notes) => notes.length > 0).length;
    for (const beat of BEATS) {
      this.reservePins[beat].visible = beat < BEATS.length - fitted;
      const note = seats[beat]?.[0];
      this.drumPins[beat].visible = note !== undefined;
      if (note !== undefined) this.positionDrumPin(this.drumPins[beat], beat, note);
    }
    if (immediate) {
      this.beat = -1;
      this.beatAge = 0;
      this.gateAge = state.open ? DRUM_GATE_SECONDS : 0;
      this.opening = false;
      this.drawBeat();
      this.drawGate();
    }
  }

  play(): void {
    if (this.playing) return;
    this.phrase = drumPlayback(this.pattern, this.state.pin, this.state.pins);
    this.beat = 0;
    this.beatAge = 0;
    this.drawBeat();
    this.soundBeat();
  }

  update(dt: number): void {
    const delta = Math.max(0, dt);
    if (this.opening) {
      this.gateAge = Math.min(DRUM_GATE_SECONDS, this.gateAge + delta);
      this.drawGate();
      this.opening = !this.released;
    }
    if (!this.playing) return;
    this.beatAge += delta;
    while (this.playing && this.beatAge >= DRUM_BEAT_SECONDS) {
      this.beatAge -= DRUM_BEAT_SECONDS;
      if (++this.beat < this.phrase.length) this.soundBeat();
      else {
        this.beat = -1;
        this.beatAge = 0;
        if (this.state.open && !this.released && !this.opening) {
          this.callbacks.onRelease(
            this.gate.getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3(0, 1.2, 0)),
          );
          this.opening = true;
          if (this.reducedMotion) {
            this.gateAge = DRUM_GATE_SECONDS;
            this.drawGate();
            this.opening = false;
          }
        }
      }
    }
    this.drawBeat();
  }

  private soundBeat(): void {
    this.callbacks.onBeat(this.phrase[this.beat], this.drum.getWorldPosition(new THREE.Vector3()));
  }

  private drawBeat(): void {
    for (const beat of BEATS)
      this.markers[beat].color.setHex(beat === this.beat ? 0xffda87 : 0x654e34);
    const progress = this.playing
      ? this.beat + (this.reducedMotion ? 0 : this.beatAge / DRUM_BEAT_SECONDS)
      : 0;
    this.drum.rotation.y = (-Math.PI * progress) / 2;
    this.key.rotation.z = this.reducedMotion ? 0 : -Math.PI * progress;
  }

  private drawGate(): void {
    const t = THREE.MathUtils.smoothstep(this.gateAge, 0, DRUM_GATE_SECONDS);
    this.leaf.position.y = t * (DOOR_HEIGHT + 0.04);
    this.leaf.visible = !this.released;
    this.world.setPuzzleGateOpen('drum-gallery', this.released, true);
  }

  private canUse(action: DrumControl): boolean {
    return action.kind === 'wind' || !this.state.open;
  }

  pick(origin: THREE.Vector3, direction: THREE.Vector3): Pick | null {
    if (this.world.current !== this.layout.gallery || this.playing) return null;
    this.board.updateWorldMatrix(true, true);
    this.ray.set(origin, direction);
    this.ray.far = 3.8;
    for (const hit of this.ray.intersectObjects([...this.hits.keys()], false)) {
      const action = this.hits.get(hit.object as THREE.Mesh);
      if (!action || !this.canUse(action)) continue;
      const blocked = this.world.colliders[this.layout.gallery].some((bounds) => {
        this.box.min.fromArray(bounds.min);
        this.box.max.fromArray(bounds.max);
        return (
          this.ray.ray.intersectBox(this.box, this.point) !== null &&
          origin.distanceTo(this.point) < hit.distance - 0.024
        );
      });
      if (!blocked) return { action, distance: hit.distance };
    }
    return null;
  }

  near(point: THREE.Vector3, reach: number): Pick | null {
    if (this.world.current !== this.layout.gallery || this.playing) return null;
    let best: Pick | null = null;
    for (const [mesh, action] of this.hits) {
      if (!this.canUse(action)) continue;
      const distance = this.box.setFromObject(mesh).distanceToPoint(point);
      if (distance <= reach && (!best || distance < best.distance)) best = { action, distance };
    }
    return best;
  }

  soundPoint(action: DrumControl): THREE.Vector3 {
    const source =
      action.kind === 'wind'
        ? this.key
        : (this.sockets.get(`${action.pin.beat}:${action.pin.note}`) ?? this.board);
    return source.getWorldPosition(new THREE.Vector3());
  }

  dispose(): void {
    this.removeCollider();
    this.object.removeFromParent();
    this.gate.removeFromParent();
    this.label?.dispose();
    this.clueObject.removeFromParent();
    this.scoreClue.dispose();
    for (const geometry of this.geometries) geometry.dispose();
    for (const material of this.materials) material.dispose();
  }
}
