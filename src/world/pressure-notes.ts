import * as THREE from 'three';
import { templateById } from '../content/rooms.ts';
import { Stream } from '../core/rng.ts';
import {
  DECOR_RADIUS,
  DECOR_TABLES,
  type DecorPlacement,
  placeTableDecor,
} from '../floor/table-decor.ts';
import type { PressureNoteId } from '../rules/pressure.ts';
import { pressureTarget } from '../rules/pressure.ts';
import type { FloorWorld } from './floor-world.ts';

export type { PressureNoteId } from '../rules/pressure.ts';
export type PressureNoteSource = 'loose' | 'chest' | 'drop' | 'desk' | 'bench' | 'floor';

export interface PressureNoteRecord {
  readonly id: PressureNoteId;
  readonly title: string;
  readonly body: string;
  readonly source: PressureNoteSource;
  readonly origin?: string;
}

export interface PressureNotePlacement extends PressureNoteRecord {
  readonly room: number;
  readonly location: THREE.Vector3;
  readonly object: THREE.Group;
  readonly socketId?: string;
}

interface Candidate {
  room: number;
  source: PressureNoteSource;
  local: THREE.Vector3;
  parent?: THREE.Object3D;
  socketId?: string;
}

const PAPER = 0.28;
const MAX_PICK = 4;

function paper(): {
  group: THREE.Group;
  geometry: THREE.BufferGeometry[];
  materials: THREE.Material[];
} {
  const group = new THREE.Group();
  const geometry: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];
  const parchment = new THREE.MeshBasicMaterial({ color: 0xe8c98d, side: THREE.DoubleSide });
  const ink = new THREE.MeshBasicMaterial({ color: 0x422b22, side: THREE.DoubleSide });
  materials.push(parchment, ink);
  const sheet = new THREE.Mesh(new THREE.PlaneGeometry(PAPER, PAPER * 0.7), parchment);
  geometry.push(sheet.geometry);
  sheet.rotation.x = -Math.PI / 2;
  sheet.userData.noteSurface = true;
  group.add(sheet);
  const foldShape = new THREE.Shape();
  foldShape.moveTo(-PAPER / 2, -PAPER * 0.35);
  foldShape.lineTo(-PAPER / 2 + 0.07, -PAPER * 0.35);
  foldShape.lineTo(-PAPER / 2, -PAPER * 0.35 + 0.07);
  foldShape.closePath();
  const fold = new THREE.Mesh(new THREE.ShapeGeometry(foldShape), ink);
  geometry.push(fold.geometry);
  // A small raised seal and folded-corner marker make the slip distinct in the room.
  const wax = new THREE.MeshBasicMaterial({ color: 0x813638 });
  materials.push(wax);
  const seal = new THREE.Mesh(new THREE.CircleGeometry(0.027, 12), wax);
  geometry.push(seal.geometry);
  seal.rotation.x = -Math.PI / 2;
  seal.position.set(0, 0.006, 0.08);
  group.add(seal);
  fold.rotation.x = -Math.PI / 2;
  fold.position.y = 0.001;
  const lines = new THREE.BufferGeometry().setFromPoints(
    [-0.065, -0.04, -0.015, 0.01].flatMap((z, i) => [
      new THREE.Vector3(-0.103, 0.002, z),
      new THREE.Vector3(0.09 - i * 0.018, 0.002, z),
    ]),
  );
  const lineMaterial = new THREE.LineBasicMaterial({ color: 0x68513b });
  geometry.push(lines);
  materials.push(lineMaterial);
  group.add(new THREE.LineSegments(lines, lineMaterial));
  fold.name = 'folded-corner';
  fold.userData.noteSurface = true;
  group.add(fold);
  return { group, geometry, materials };
}

function furniture(world: FloorWorld, room: number, decor: readonly DecorPlacement[]): Candidate[] {
  const placed = world.plan.rooms[room];
  if (placed.templateId === 'study' && !world.coffers.some((c) => c.room === room))
    return [{ room, source: 'desk', local: new THREE.Vector3(2.34, 0.784, 2.33) }];
  if (placed.templateId !== 'hall') return [];
  const candidates: Candidate[] = [];
  for (const t of DECOR_TABLES.hall) {
    for (const offset of [-0.28, 0, 0.28]) {
      const z = t.z + offset;
      if (
        decor.some(
          (p) =>
            p.room === room &&
            p.table === t.id &&
            Math.hypot(t.x - p.x, z - p.z) < 0.17 + DECOR_RADIUS[p.kind],
        )
      )
        continue;
      candidates.push({ room, source: 'bench', local: new THREE.Vector3(t.x, t.top + 0.006, z) });
      break;
    }
  }
  return candidates;
}

function floorCandidate(world: FloorWorld, room: number): Candidate | null {
  const group = world.roomGroups[room];
  const template = templateById(world.plan.rooms[room].templateId);
  // Off the central shaft and the door thresholds; rotate only through the room group.
  for (const [x, z] of [
    [0.45, 0.9],
    [-0.45, -1.15],
    [0.35, 1.6],
    [0, -2.1],
    [0, 0.3],
  ]) {
    const point = group.localToWorld(new THREE.Vector3(x, 0.009, z));
    if (
      !template.walkable.some(
        (r) =>
          x > r.min[0] + 0.17 && x < r.max[0] - 0.17 && z > r.min[1] + 0.17 && z < r.max[1] - 0.17,
      )
    )
      continue;
    if (
      world.colliders[room].some(
        (b) =>
          point.x >= b.min[0] - 0.2 &&
          point.x <= b.max[0] + 0.2 &&
          point.z >= b.min[2] - 0.2 &&
          point.z <= b.max[2] + 0.2,
      )
    )
      continue;
    return { room, source: 'floor', local: new THREE.Vector3(x, 0.009, z) };
  }
  return null;
}

const ROOM_NAMES: Readonly<Record<string, string>> = {
  hall: 'grand hall',
  study: 'study',
  corridor: 'passage',
  'gear-shaft': 'gear chamber',
};
const TITLES = {
  A: 'Intake inspection',
  B: 'Return-line test',
  C: 'Relief valve register',
} as const;
const LINES = {
  A: 'I tested the intake twice. Set circuit A to',
  B: 'The return line ran steadily with circuit B set to',
  C: 'The relief gauge held at the red mark. Set circuit C to',
} as const;

export class PressureNotes {
  readonly placements: readonly PressureNotePlacement[];
  private readonly byId = new Map<PressureNoteId, PressureNotePlacement>();
  private readonly parts: { geometry: THREE.BufferGeometry[]; materials: THREE.Material[] }[] = [];
  private readonly wall = new THREE.Box3();
  private readonly crossing = new THREE.Vector3();
  private readonly raycaster = new THREE.Raycaster();

  constructor(private readonly world: FloorWorld) {
    const seed = world.plan.seed;
    const stream = Stream.fromKey(`${seed}:pressure-notes`);
    const used = new Set<number>();
    const decor = placeTableDecor(
      seed,
      world.plan.rooms.map((r) => r.templateId),
    );
    const candidates: Candidate[] = [];
    for (const coffer of world.coffers) {
      if (coffer.room === world.plan.guardianRoom) continue;
      const local = new THREE.Vector3(0.1, 0.316, 0.045);
      candidates.push({
        room: coffer.room,
        source: 'chest',
        local,
        parent: coffer.object,
        socketId: coffer.socketId,
      });
    }
    for (const [room, enemies] of world.enemies) {
      if (room === world.plan.guardianRoom || enemies.length === 0) continue;
      const body = enemies[0];
      candidates.push({
        room,
        source: 'drop',
        local: new THREE.Vector3(body.position.x, 0.08, body.position.z),
      });
    }
    for (let room = 1; room < world.plan.rooms.length; room++) {
      if (room === world.plan.guardianRoom || room === world.plan.pressureWing?.pumpRoom) continue;
      candidates.push(...furniture(world, room, decor));
      const floor = floorCandidate(world, room);
      if (floor) candidates.push(floor);
    }
    const ordered = stream.shuffle(candidates);
    const chosen: Candidate[] = [];
    // Prefer the physical reveal paths, then fill with ordinary surfaces, always in distinct rooms.
    for (const source of ['chest', 'drop'] as const) {
      const candidate = ordered.find((c) => c.source === source && !used.has(c.room));
      if (candidate) {
        chosen.push(candidate);
        used.add(candidate.room);
      }
    }
    const loose = ordered.find(
      (c) => !used.has(c.room) && ['bench', 'desk', 'floor'].includes(c.source),
    );
    if (loose) {
      chosen.push(loose);
      used.add(loose.room);
    }
    for (const candidate of ordered) {
      if (chosen.length >= 3) break;
      if (!used.has(candidate.room)) {
        chosen.push(candidate);
        used.add(candidate.room);
      }
    }
    if (chosen.length < 3) throw new Error('pressure notes need three reachable rooms');
    const result: PressureNotePlacement[] = [];
    const circuitIds = stream.shuffle(['A', 'B', 'C'] as const);
    const readings = pressureTarget(seed);
    circuitIds.forEach((id, i) => {
      const candidate = chosen[i] as Candidate;
      const value = readings['ABC'.indexOf(id)];
      const record = { id, title: TITLES[id], body: `${LINES[id]} ${value}.` };
      const built = paper();
      const object = built.group;
      object.name = `pressure-note-${id}`;
      object.userData.noteId = id;
      (candidate.parent ?? world.roomGroups[candidate.room]).add(object);
      object.position.copy(candidate.local);
      if (candidate.source === 'chest' || candidate.source === 'drop') object.visible = false;
      const location = object.getWorldPosition(new THREE.Vector3());
      const placement = {
        ...record,
        source: candidate.source,
        room: candidate.room,
        location,
        object,
        socketId: candidate.socketId,
      };
      result.push(placement);
      this.byId.set(id, placement);
      this.parts.push(built);
    });
    {
      const target =
        chosen.find((candidate) => candidate.source === 'chest' || candidate.source === 'drop') ??
        (chosen[0] as Candidate);
      const targetIndex = chosen.indexOf(target);
      const targetCircuit = circuitIds[targetIndex];
      const place = ROOM_NAMES[world.plan.rooms[target.room].templateId] ?? 'workroom';
      const instruction =
        target.source === 'chest'
          ? `I locked the circuit ${targetCircuit} slip in a coffer in the ${place}.`
          : target.source === 'drop'
            ? `A watch automaton in the ${place} still carries the circuit ${targetCircuit} slip.`
            : `Find the circuit ${targetCircuit} slip on the ${target.source} in the ${place}.`;
      const record: PressureNoteRecord = {
        id: 'dispatch',
        title: 'A runner’s dispatch',
        body: `${instruction} File each recovered reading in Items.`,
        source: 'loose',
      };
      const built = paper();
      const object = built.group;
      object.name = 'pressure-note-dispatch';
      object.userData.noteId = 'dispatch';
      const candidate = furniture(world, 0, decor)[0] ??
        floorCandidate(world, 0) ?? {
          room: 0,
          source: 'loose' as const,
          local: new THREE.Vector3(0, 0.03, 0),
        };
      world.roomGroups[0]?.add(object);
      object.position.copy(candidate.local);
      const placement = {
        ...record,
        source: candidate.source,
        room: 0,
        location: object.getWorldPosition(new THREE.Vector3()),
        object,
      };
      result.push(placement);
      this.byId.set('dispatch', placement);
      this.parts.push(built);
    }
    world.group.updateMatrixWorld(true);
    for (const placement of result)
      placement.location.copy(placement.object.getWorldPosition(new THREE.Vector3()));
    this.placements = result;
  }

  record(id: PressureNoteId): PressureNoteRecord | undefined {
    const placement = this.byId.get(id);
    if (!placement) return undefined;
    return {
      id: placement.id,
      title: placement.title,
      body: placement.body,
      source: placement.source,
      origin: `Recovered ${placement.source === 'drop' ? 'from an automaton' : placement.source === 'chest' ? 'from a coffer' : 'from the ' + placement.source} in the ${ROOM_NAMES[this.world.plan.rooms[placement.room].templateId] ?? 'works'}.`,
    };
  }

  sync(
    collected: readonly PressureNoteId[],
    cleared: (room: number) => boolean,
    opened: (room: number, socketId: string) => boolean,
  ): void {
    const got = new Set(collected);
    for (const placement of this.placements) {
      if (got.has(placement.id)) {
        placement.object.visible = false;
        continue;
      }
      if (placement.source === 'drop') placement.object.visible = cleared(placement.room);
      else if (placement.source === 'chest')
        placement.object.visible = opened(placement.room, placement.socketId ?? '');
      else placement.object.visible = true;
    }
  }

  pick(
    origin: THREE.Vector3,
    direction: THREE.Vector3,
  ): { id: PressureNoteId; room: number; distance: number } | null {
    this.raycaster.set(origin, direction);
    this.raycaster.ray.direction.normalize();
    this.raycaster.far = MAX_PICK;
    let best: { id: PressureNoteId; room: number; distance: number } | null = null;
    for (const p of this.placements) {
      if (!p.object.visible || p.room !== this.world.current || origin.y < p.location.y - 0.05)
        continue;
      const hit = this.raycaster.intersectObject(p.object, true)[0];
      if (!hit || (best && best.distance <= hit.distance)) continue;
      let blocked = false;
      for (const c of this.world.colliders[p.room]) {
        this.wall.min.fromArray(c.min);
        this.wall.max.fromArray(c.max);
        if (this.wall.containsPoint(p.location)) continue;
        const cross = this.raycaster.ray.intersectBox(this.wall, this.crossing);
        if (cross && cross.distanceTo(origin) < hit.distance - 0.025) {
          blocked = true;
          break;
        }
      }
      if (!blocked) best = { id: p.id, room: p.room, distance: hit.distance };
    }
    return best;
  }

  near(point: THREE.Vector3, maxDistance: number): readonly PressureNotePlacement[] {
    return this.placements
      .filter(
        (p) =>
          p.room === this.world.current &&
          p.object.visible &&
          p.location.distanceTo(point) <= maxDistance,
      )
      .sort((a, b) => a.location.distanceToSquared(point) - b.location.distanceToSquared(point));
  }

  dispose(): void {
    for (const placement of this.placements) placement.object.removeFromParent();
    for (const part of this.parts) {
      for (const geometry of part.geometry) geometry.dispose();
      for (const material of part.materials) material.dispose();
    }
  }
}
