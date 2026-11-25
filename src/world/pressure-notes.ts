import * as THREE from 'three';
import { ENCOUNTER_CONTENT_VERSION, RETURN_PASSAGES_VERSION } from '../combat/encounter-choice.ts';
import { combatRoom } from '../combat/placement.ts';
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
import { validateLanding } from '../xr/locomotion.ts';
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
const DROP_HEIGHT = 0.012;
const DROP_SECONDS = 1.05;

interface NoteDrop {
  note: PressureNotePlacement;
  home: THREE.Vector3;
  from: THREE.Vector3;
  to: THREE.Vector3;
  yaw: number;
  elapsed: number;
}

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
  const writing = new THREE.LineSegments(lines, lineMaterial);
  writing.raycast = () => {};
  group.add(writing);
  fold.name = 'folded-corner';
  fold.userData.noteSurface = true;
  group.add(fold);
  return { group, geometry, materials };
}

function furniture(world: FloorWorld, room: number, decor: readonly DecorPlacement[]): Candidate[] {
  const placed = world.plan.rooms[room];
  if (placed.templateId === 'study' && !world.coffers.some((c) => c.room === room))
    return [{ room, source: 'desk', local: new THREE.Vector3(2.34, 0.784, 2.34) }];
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
  private drop: NoteDrop | null = null;
  private readonly parts: { geometry: THREE.BufferGeometry[]; materials: THREE.Material[] }[] = [];
  private readonly wall = new THREE.Box3();
  private readonly crossing = new THREE.Vector3();
  private readonly raycaster = new THREE.Raycaster();
  private readonly eye = new THREE.Vector3();
  private readonly localNormal = new THREE.Vector3();
  private readonly toLocalNormal = new THREE.Matrix3();

  constructor(
    private readonly world: FloorWorld,
    contentVersion = ENCOUNTER_CONTENT_VERSION,
  ) {
    const seed = world.plan.seed;
    world.group.updateMatrixWorld(true);
    const stream = Stream.fromKey(`${seed}:pressure-notes`);
    const used = new Set<number>();
    const decor = placeTableDecor(
      seed,
      world.plan.rooms.map((r) => r.templateId),
    );
    // Return passages can be locked until all three readings have been recovered.
    const lastRoom = world.plan.pressureWing?.pumpRoom ?? world.plan.rooms.length - 1;
    const candidates: Candidate[] = [];
    for (const coffer of world.coffers) {
      if (coffer.room > lastRoom || coffer.room === world.plan.guardianRoom) continue;
      const local = new THREE.Vector3(0.085, 0.37, 0.025);
      candidates.push({
        room: coffer.room,
        source: 'chest',
        local,
        parent: coffer.object,
        socketId: coffer.socketId,
      });
    }
    for (const [room, enemies] of world.enemies) {
      if (room > lastRoom || room === world.plan.guardianRoom || enemies.length === 0) continue;
      const body = enemies[0];
      candidates.push({
        room,
        source: 'drop',
        local: new THREE.Vector3(body.position.x, DROP_HEIGHT, body.position.z),
        socketId: body.userData.socketId as string,
      });
    }
    for (let room = 1; room <= lastRoom; room++) {
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
    const readings = pressureTarget(seed, contentVersion);
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
      if (candidate.source === 'chest') object.rotation.set(Math.PI / 3, Math.PI, 0, 'YXZ');
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
      const desks = furniture(world, 0, decor);
      const candidate = (desks.length && contentVersion >= RETURN_PASSAGES_VERSION
        ? Stream.fromKey(seed + ':dispatch').pick(desks)
        : desks[0]) ??
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

  get dropAirborne(): boolean {
    return this.drop !== null && this.drop.elapsed < DROP_SECONDS;
  }

  tossFrom(enemy: THREE.Object3D): void {
    if (this.drop) return;
    const room = enemy.userData.room as number;
    const note = this.placements.find(
      (p) => p.source === 'drop' && p.room === room && p.socketId === enemy.userData.socketId,
    );
    const parent = note?.object.parent;
    if (!note || note.object.visible || !parent) return;
    const home = note.object.position.clone();
    const from = enemy.position.clone();
    from.y += 0.32;
    const yaw = enemy.rotation.y;
    const side = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
    const base = from.clone().setY(DROP_HEIGHT);
    const forward = base.clone().add(new THREE.Vector3(side.z * 0.85, 0, -side.x * 0.85));
    if (side.dot(home.clone().sub(base)) < 0) side.negate();
    const { walkable } = combatRoom(this.world.rooms[room]);
    const env = { walkable, colliders: this.world.colliders[room] };
    const isClear = (position: THREE.Vector3): boolean => {
      const worldPoint = parent.localToWorld(position.clone());
      return validateLanding([worldPoint.x, worldPoint.z], env, PAPER / 2) === 'ok';
    };
    const to =
      [1.55, -1.55, 0.9, -0.9, 0]
        .map((distance) => forward.clone().addScaledVector(side, distance))
        .find(isClear) ?? (isClear(base) ? base : home);
    this.drop = { note, home, from, to, yaw, elapsed: 0 };
    note.object.position.copy(from);
    note.object.visible = true;
  }

  /** Advances an active drop and turns coffer letters toward the viewer. */
  update(viewer: THREE.Object3D, dt = 0): void {
    const drop = this.drop;
    if (drop && drop.elapsed < DROP_SECONDS) {
      drop.elapsed = Math.min(DROP_SECONDS, drop.elapsed + dt);
      const t = drop.elapsed / DROP_SECONDS;
      const { object, location } = drop.note;
      object.position.lerpVectors(drop.from, drop.to, t);
      object.position.y += 4 * 1.3 * t * (1 - t);
      object.rotation.set(
        1.25 * Math.sin(Math.PI * t),
        drop.yaw + 0.55 * Math.sin(2 * Math.PI * t),
        0.32 * Math.sin(2 * Math.PI * t),
        'YXZ',
      );
      if (t === 1) object.getWorldPosition(location);
    }
    viewer.getWorldPosition(this.eye);
    for (const placement of this.placements) {
      if (
        placement.source !== 'chest' ||
        placement.room !== this.world.current ||
        !placement.object.visible ||
        !placement.object.parent
      )
        continue;
      this.toLocalNormal.setFromMatrix4(placement.object.parent.matrixWorld).transpose();
      this.localNormal.copy(this.eye).sub(placement.location).applyMatrix3(this.toLocalNormal);
      const { x, y, z } = this.localNormal;
      const distance = Math.hypot(x, z);
      const yaw = distance > 0.001 ? Math.atan2(x, z) : placement.object.rotation.y;
      placement.object.rotation.set(Math.atan2(distance, y), yaw, 0, 'YXZ');
    }
  }

  sync(
    collected: readonly PressureNoteId[],
    cleared: (room: number) => boolean,
    opened: (room: number, socketId: string) => boolean,
    activeRoom?: number,
  ): void {
    const got = new Set(collected);
    for (const placement of this.placements) {
      if (got.has(placement.id)) {
        placement.object.visible = false;
        if (this.drop?.note === placement) this.drop = null;
        continue;
      }
      if (placement.source === 'drop') {
        const won = cleared(placement.room);
        if (this.drop?.note === placement && !won && placement.room !== activeRoom) {
          placement.object.position.copy(this.drop.home);
          placement.object.rotation.set(0, 0, 0);
          placement.object.getWorldPosition(placement.location);
          this.drop = null;
        }
        placement.object.visible = won || this.drop?.note === placement;
      } else if (placement.source === 'chest')
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
      if (
        !p.object.visible ||
        p.room !== this.world.current ||
        (this.drop?.note === p && this.drop.elapsed < DROP_SECONDS) ||
        (p.source !== 'chest' && origin.y < p.location.y - 0.05)
      )
        continue;
      p.object.updateWorldMatrix(true, true);
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
          !(this.drop?.note === p && this.drop.elapsed < DROP_SECONDS) &&
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
