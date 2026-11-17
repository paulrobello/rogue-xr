import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EnemyActor,
  type EnemyAsset,
  hasPhaseClip,
  parseEnemyAsset,
  parseEnemyManifest,
} from '../src/enemies/enemy-asset.ts';
import { nearSet, neighbours, shellSet, visibleSet } from '../src/floor/visibility.ts';
import { type FloorView, mountFloorView, SHELL_ACTOR_EVERY } from '../src/world/floor-view.ts';

/** Quest 3's default refresh rate. */
const DT = 1 / 72;
const FRAMES = 144;
/** Room 0 of this seed sees a fight room and a treasure room down its corridors. */
const SHELL_SEED = 'SHELL024';
/** From room 0 of this seed, 1 sentry-class body is near, 2 are down corridors and 3 are hidden. */
const TIER_SEED = 'DIST0020';

// happy-dom serves import.meta.url over http, so asset paths resolve from the repo root.
const asset = (path: string): string => join(process.cwd(), 'public/assets', path);
const sentryManifest = parseEnemyManifest(
  JSON.parse(readFileSync(asset('enemies/cog-sentry/cog-sentry.manifest.json'), 'utf8')),
  'cog-sentry',
);
const sentryBytes = readFileSync(asset(`enemies/cog-sentry/${sentryManifest.glb}`));
/** The shipped sentry GLB relabelled as `kind`: only cog-sentry has a model on disk. */
const loadTestModel = (kind: string): Promise<EnemyAsset> =>
  parseEnemyAsset(
    sentryBytes.buffer.slice(
      sentryBytes.byteOffset,
      sentryBytes.byteOffset + sentryBytes.byteLength,
    ) as ArrayBuffer,
    { ...sentryManifest, id: kind },
    null,
  );

/**
 * Mounts the seed with a model for every enemy kind on the floor, so every body is an actor. The
 * guardian needs a phase-change clip the sentry GLB lacks, so it keeps its capsule.
 */
async function dressedView(seed: string): Promise<{ view: FloorView; head: THREE.Object3D }> {
  const scene = new THREE.Scene();
  const view = mountFloorView(scene, new THREE.Group(), seed);
  view.suspendTriggers = true;
  const kinds = new Set<string>();
  for (const bodies of view.world.enemies.values()) {
    for (const b of bodies) {
      const kind = b.userData.enemyKind as string;
      if (!hasPhaseClip(kind)) kinds.add(kind);
    }
  }
  const models = new Map<string, EnemyAsset>();
  for (const kind of kinds) models.set(kind, await loadTestModel(kind));
  view.useEnemyAssets(models);
  const head = new THREE.Object3D();
  const spawn = view.world.spawnPoint();
  head.position.set(spawn.x, 1.2, spawn.z);
  scene.add(head);
  head.updateMatrixWorld(true);
  return { view, head };
}

/** True when `o` and every ancestor are visible: what the renderer draws. */
function shownInWorld(o: THREE.Object3D): boolean {
  for (let n: THREE.Object3D | null = o; n; n = n.parent) if (!n.visible) return false;
  return true;
}

const roomOf = (actor: EnemyActor): number => actor.object.userData.room as number;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('distant room actors', () => {
  it('spawns an actor for every body, shows the corridor-seen ones, and keeps them on entry', async () => {
    const { view, head } = await dressedView(SHELL_SEED);
    const plan = view.world.plan;
    const shell = shellSet(plan, 0);
    const bodies = [...view.world.enemies.values()]
      .flat()
      .filter((b) => !hasPhaseClip(b.userData.enemyKind as string));
    expect(bodies.length).toBeGreaterThan(0);
    for (const b of bodies) expect(view.actorOf(b)).not.toBeNull();
    const shellActors = view.actors.filter((a) => shell.has(roomOf(a)));
    expect(shellActors.length).toBeGreaterThan(0);
    for (const a of shellActors) {
      expect(shownInWorld(a.object)).toBe(true);
      expect(a.state).toBe('idle');
    }
    for (const a of view.actors) {
      expect(shownInWorld(a.object)).toBe(visibleSet(plan, 0).has(roomOf(a)));
    }
    view.update(head, DT);

    // Walk into the corridor that leads to the shell fight room: the same actors stay, shown.
    const fightRoom = roomOf(shellActors[0] as EnemyActor);
    const corridor = neighbours(plan, 0).find((n) =>
      neighbours(plan, n).includes(fightRoom),
    ) as number;
    const before = [...view.actors];
    const fp = view.world.rooms[corridor]?.footprint;
    if (!fp) throw new Error('no corridor');
    head.position.set((fp.min[0] + fp.max[0]) / 2, 1.2, (fp.min[1] + fp.max[1]) / 2);
    head.updateMatrixWorld(true);
    view.update(head, DT);
    expect(view.world.current).toBe(corridor);
    expect(nearSet(plan, corridor).has(fightRoom)).toBe(true);
    expect(view.actors).toEqual(before);
    for (const a of shellActors) {
      expect(view.actorOf(a.object)).toBe(a);
      expect(shownInWorld(a.object)).toBe(true);
    }
    view.dispose();
  }, 30_000);

  it('steps shell actors in turn without look-at and holds hidden ones', async () => {
    const { view, head } = await dressedView(TIER_SEED);
    const plan = view.world.plan;
    const near = nearSet(plan, 0);
    const shell = shellSet(plan, 0);
    const update = vi.spyOn(EnemyActor.prototype, 'update');
    const tierOf = (a: EnemyActor) =>
      near.has(roomOf(a)) ? 'near' : shell.has(roomOf(a)) ? 'shell' : 'hidden';
    // Shell steps per frame: they take turns, so no frame pays for all of them at once.
    const shellPerFrame: number[] = [];
    for (let f = 0; f < FRAMES; f++) {
      const from = update.mock.calls.length;
      view.update(head, DT);
      shellPerFrame.push(
        update.mock.contexts.slice(from).filter((a) => tierOf(a as EnemyActor) === 'shell').length,
      );
    }
    expect(view.world.current).toBe(0);

    const count = { near: 0, shell: 0, hidden: 0 };
    const calls = { near: 0, shell: 0, hidden: 0 };
    for (const a of view.actors) count[tierOf(a)]++;
    const seconds = new Map<EnemyActor, number>();
    update.mock.calls.forEach((args, i) => {
      const actor = update.mock.contexts[i] as EnemyActor;
      const tier = tierOf(actor);
      calls[tier]++;
      if (tier === 'shell') expect(args[1]).toBeNull();
      if (tier === 'near') expect(args[1]).toBeInstanceOf(THREE.Vector3);
      seconds.set(actor, (seconds.get(actor) ?? 0) + args[0]);
    });
    expect(count).toEqual({ near: 1, shell: 2, hidden: 3 });
    expect(calls.near).toBe(count.near * FRAMES);
    expect(calls.shell).toBe((count.shell * FRAMES) / SHELL_ACTOR_EVERY);
    expect(calls.hidden).toBe(0);
    // Shell clips still run on real seconds: the skipped frames are folded into each step, so
    // only the frames since an actor's last turn are still owed.
    for (const [actor, s] of seconds) {
      if (tierOf(actor) !== 'shell') continue;
      expect(s).toBeLessThanOrEqual(FRAMES * DT + 1e-9);
      expect(s).toBeGreaterThan((FRAMES - SHELL_ACTOR_EVERY) * DT);
    }
    expect(Math.max(...shellPerFrame)).toBe(Math.ceil(count.shell / SHELL_ACTOR_EVERY));
    const baseline = view.actors.length * FRAMES;
    const tiered = calls.near + calls.shell + calls.hidden;
    // Wall time of the same frames under both rules, for the report (this host is shared).
    const at = head.getWorldPosition(new THREE.Vector3());
    const t0 = performance.now();
    for (let f = 0; f < FRAMES; f++) for (const a of view.actors) a.update(DT, at);
    const allMs = performance.now() - t0;
    update.mockClear();
    const t1 = performance.now();
    for (let f = 0; f < FRAMES; f++) view.update(head, DT);
    const viewMs = performance.now() - t1;
    console.info(
      `actors near=${count.near} shell=${count.shell} hidden=${count.hidden}; ` +
        `updates over ${FRAMES} frames: every-actor-every-frame=${baseline} tiered=${tiered} ` +
        `(near=${calls.near} shell=${calls.shell} hidden=${calls.hidden}); ` +
        `wall ms: every-actor-every-frame=${allMs.toFixed(1)} view.update tiered=${viewMs.toFixed(1)}`,
    );
    expect(tiered).toBeLessThan(baseline);
    view.dispose();
  }, 30_000);
});
