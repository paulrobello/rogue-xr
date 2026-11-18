import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { CombatHook, type CombatSession } from '../src/combat/combat-session.ts';
import { enemyKindOf } from '../src/combat/encounter-choice.ts';
import { CombatController } from '../src/combat-view/controller.ts';
import { intentChips } from '../src/combat-view/index.ts';
import { getCard } from '../src/content/cards.ts';
import { GREYBOX_TEMPLATES, templateById } from '../src/content/rooms.ts';
import { ActionBus } from '../src/core/actions.ts';
import {
  type EnemyAsset,
  parseEnemyAsset,
  parseEnemyManifest,
} from '../src/enemies/enemy-asset.ts';
import type { EnemyState } from '../src/rules/index.ts';
import { type FloorView, mountFloorView } from '../src/world/floor-view.ts';
import { heroTemplates, parseStudyManifest } from '../src/world/study-room.ts';

const DT = 1 / 60;
const SEED = 'SPIRE002';

// happy-dom serves import.meta.url over http, so asset paths resolve from the repo root.
const asset = (path: string): string => join(process.cwd(), 'public/assets', path);
const sentryManifest = parseEnemyManifest(
  JSON.parse(readFileSync(asset('enemies/cog-sentry/cog-sentry.manifest.json'), 'utf8')),
  'cog-sentry',
);
const sentryBytes = readFileSync(asset(`enemies/cog-sentry/${sentryManifest.glb}`));
/**
 * The shipped sentry GLB, optionally relabelled as another kind: only cog-sentry has a model on
 * disk, so a second kind's model is the same bytes under its own manifest id.
 */
const loadTestModel = (kind = 'cog-sentry'): Promise<EnemyAsset> =>
  parseEnemyAsset(
    sentryBytes.buffer.slice(
      sentryBytes.byteOffset,
      sentryBytes.byteOffset + sentryBytes.byteLength,
    ) as ArrayBuffer,
    { ...sentryManifest, id: kind },
    null,
  );
const loadTestSentry = (): Promise<EnemyAsset> => loadTestModel();
const only = (asset: EnemyAsset): Map<string, EnemyAsset> => new Map([[asset.id, asset]]);
const studyRaw: unknown = JSON.parse(
  readFileSync(asset('rooms/study/study.manifest.json'), 'utf8'),
);

/** The first regular room whose encounter includes a Cog Sentry. */
function sentryRoom(view: FloorView): number {
  for (const [room, bodies] of view.world.enemies) {
    const tier = view.world.plan.rooms[room]?.encounter?.tier;
    if (tier === 'regular' && bodies.some((b) => b.userData.enemyKind === 'cog-sentry'))
      return room;
  }
  throw new Error('no cog-sentry room');
}

function enemyState(intent: EnemyState['intent']): EnemyState {
  return {
    id: 'cog-sentry',
    name: 'Cog Sentry',
    hp: 38,
    maxHp: 38,
    block: 0,
    statuses: {},
    intent,
  } as EnemyState;
}

describe('enemy intent chips', () => {
  it('gives each part of a multi-part move its own icon and amount', () => {
    const brace = enemyState({
      id: 'brace',
      intent: 'defend',
      effects: [
        { type: 'block', amount: 7 },
        { type: 'damage', amount: 4, target: 'target' },
      ],
    } as unknown as EnemyState['intent']);
    expect(intentChips(brace, [4]).map((c) => [c.icon, c.text])).toEqual([
      ['block', '7'],
      ['intent-attack', '4'],
    ]);
  });

  it('shows multi-hit damage after statuses and status stacks', () => {
    const hound = enemyState({
      id: 'flurry',
      intent: 'attack',
      effects: [{ type: 'damage', amount: 3, hits: 2, target: 'target' }],
    } as unknown as EnemyState['intent']);
    expect(intentChips(hound, [4]).map((c) => c.text)).toEqual(['4x2']);
    const jam = enemyState({
      id: 'jam',
      intent: 'debuff',
      effects: [{ type: 'apply-status', status: 'weak', stacks: 2, target: 'target' }],
    } as unknown as EnemyState['intent']);
    expect(intentChips(jam, []).map((c) => [c.icon, c.text])).toEqual([['status-weak', '2']]);
  });
});

describe('run max hp and bonus dice reach combat', () => {
  it('starts the fight at the run max hp instead of the fixed 70', () => {
    const c = new CombatController({ seed: SEED, playerMaxHp: 85, playerHp: 80 });
    expect(c.state.player.maxHp).toBe(85);
    expect(c.state.player.hp).toBe(80);
    expect(c.playerMaxHp).toBe(85);
    expect(
      new CombatController({ seed: SEED, playerMaxHp: 50, playerHp: 90 }).state.player.hp,
    ).toBe(50);
  });

  it('rolls 1 + bonusDice dice per dice card and keeps the best; 0 matches the default', () => {
    const play = (bonusDice?: number) => {
      const c = new CombatController({
        seed: SEED,
        deck: Array(10).fill('cog-toss'),
        ...(bonusDice === undefined ? {} : { bonusDice }),
      });
      const card = c.state.piles.hand.find((h) => getCard(h.def.id).dice !== undefined);
      if (!card) throw new Error('no dice card');
      c.select(card.uid);
      const foe = c.state.enemies[0]?.id ?? '';
      if (c.stage === 'target') c.target(foe);
      else c.table();
      return { value: c.lastDice?.value ?? -1, rng: c.state.rng.dice };
    };
    const base = play();
    expect(play(0)).toEqual(base);
    const spare = play(1);
    expect(spare.value).toBeGreaterThanOrEqual(base.value);
    expect(spare.rng).not.toEqual(base.rng);
  });

  it('carries the run options from the hook into the session controller', async () => {
    const scene = new THREE.Scene();
    const view = mountFloorView(scene, new THREE.Group(), SEED);
    const room = sentryRoom(view);
    const hook = openHook(view, room, {
      fightOptions: () => ({ playerHp: 72, playerMaxHp: 80, bonusDice: 1 }),
    });
    hook.step(1.2);
    const session = await hook.hook.ready();
    expect(session?.controller.state.player.maxHp).toBe(80);
    expect(session?.controller.state.player.hp).toBe(72);
    expect(session?.controller.bonusDice).toBe(1);
    hook.hook.dispose();
  });
});

describe('hero study template', () => {
  const study = parseStudyManifest(studyRaw);

  it('swaps the baked study (desk and shelf colliders) into world building', () => {
    const templates = heroTemplates(study.template);
    expect(templates.find((t) => t.id === 'study')?.colliders.length).toBeGreaterThan(
      templateById('study').colliders.length,
    );
    expect(templates.filter((t) => t.id !== 'study')).toEqual(
      GREYBOX_TEMPLATES.filter((t) => t.id !== 'study'),
    );
  });

  it('keeps the greybox study when the baked layout disagrees', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const moved = { ...study.template, doors: study.template.doors.slice(1) };
    expect(heroTemplates(moved)).toBe(GREYBOX_TEMPLATES);
    warn.mockRestore();
  });

  it('dresses only study rooms, keeping their automatons and sealed caps', () => {
    const view = mountFloorView(new THREE.Scene(), new THREE.Group(), SEED, {
      templates: heroTemplates(study.template),
    });
    const studies = view.world.plan.rooms.flatMap((r, i) => (r.templateId === 'study' ? [i] : []));
    expect(studies.length).toBeGreaterThan(0);
    const dressed = view.useRoomAsset('study', () => {
      const model = new THREE.Group();
      model.name = 'study-model';
      return model;
    });
    expect(dressed).toBe(studies.length);
    for (const i of studies) {
      const group = view.world.roomGroups[i] as THREE.Group;
      expect(group.getObjectByName('study-model')).toBeDefined();
      expect(group.getObjectByName('floor')).toBeUndefined();
      expect(group.children.some((c) => c.name.startsWith('collider-'))).toBe(false);
      for (const body of view.world.enemies.get(i) ?? []) expect(body.parent).toBe(group);
    }
    // Other rooms keep their greybox.
    const other = view.world.plan.rooms.findIndex((r) => r.templateId !== 'study');
    expect(view.world.roomGroups[other]?.getObjectByName('floor')).toBeDefined();
  });
});

interface HookRig {
  hook: CombatHook;
  camera: THREE.PerspectiveCamera;
  ends: { outcome: string; at: number }[];
  time: () => number;
  step(seconds: number): void;
}

function openHook(
  view: FloorView,
  room: number,
  extra: Partial<ConstructorParameters<typeof CombatHook>[0]> = {},
): HookRig {
  const placed = view.world.plan.rooms[room];
  if (placed) view.world.update(placed.position[0], placed.position[1]);
  const bodies = view.world.enemies.get(room) ?? [];
  const target = bodies[0]?.getWorldPosition(new THREE.Vector3()) as THREE.Vector3;
  const camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.05, 100);
  camera.position.set(target.x, 1.2, target.z + 1);
  view.world.group.parent?.add(camera);
  view.world.update(camera.position.x, camera.position.z);
  const ends: { outcome: string; at: number }[] = [];
  let clock = 0;
  const hook = new CombatHook({
    floor: view,
    camera,
    actions: new ActionBus(),
    syncLabels: false,
    models: null,
    onEnd: ({ outcome }) => ends.push({ outcome, at: clock }),
    ...extra,
  });
  return {
    hook,
    camera,
    ends,
    time: () => clock,
    step(seconds) {
      for (let t = 0; t < seconds - 1e-9; t += DT) {
        clock += DT;
        camera.updateMatrixWorld(true);
        view.update(camera, DT);
        hook.update(DT);
      }
    },
  };
}

/** Plays target-free and enemy-targeted plain cards until every enemy is down (1 hp each). */
function killAll(session: CombatSession, rig: HookRig): void {
  for (let guard = 0; guard < 40 && session.controller.outcome === null; guard++) {
    const state = session.controller.state;
    const card = state.piles.hand.find((c) => {
      const info = getCard(c.def.id);
      return (
        info.target === 'enemy' &&
        info.sigil === undefined &&
        info.dice === undefined &&
        info.cost <= state.player.steam
      );
    });
    const foe = state.enemies.find((e) => e.hp > 0);
    if (card && foe) {
      session.controller.select(card.uid);
      session.controller.target(foe.id);
    } else session.controller.endTurn();
    rig.step(DT);
  }
}

describe('Cog Sentry on the floor', () => {
  it('keeps the capsules when the sentry never loads', () => {
    const view = mountFloorView(new THREE.Scene(), new THREE.Group(), SEED, { contentVersion: 1 });
    const room = sentryRoom(view);
    expect(view.actors).toHaveLength(0);
    for (const body of view.world.enemies.get(room) ?? []) {
      expect((body as THREE.Mesh).isMesh).toBe(true);
      expect(view.actorOf(body)).toBeNull();
    }
  });

  it('replaces sentry capsules with idle actors on the floor, skipping cleared rooms', async () => {
    const view = mountFloorView(new THREE.Scene(), new THREE.Group(), SEED);
    const room = sentryRoom(view);
    const cleared = [...view.world.enemies].find(
      ([r, b]) => r !== room && b.some((x) => x.userData.enemyKind === 'cog-sentry'),
    )?.[0];
    if (cleared !== undefined) view.markCleared(cleared);
    const capsule = view.world.enemies
      .get(room)
      ?.find((b) => b.userData.enemyKind === 'cog-sentry') as THREE.Object3D;
    const { x, z } = capsule.position;
    const rotY = capsule.rotation.y;
    view.useEnemyAssets(only(await loadTestSentry()));
    const body = view.world.enemies
      .get(room)
      ?.find((b) => b.userData.enemyKind === 'cog-sentry') as THREE.Object3D;
    const actor = view.actorOf(body);
    expect(actor).not.toBeNull();
    expect(body).not.toBe(capsule);
    expect(capsule.parent).toBeNull();
    expect(body.position.toArray()).toEqual([x, 0, z]);
    expect(body.rotation.y).toBeCloseTo(rotY);
    expect(body.name).toBe(capsule.name);
    expect(body.userData).toMatchObject({ room, socketId: capsule.userData.socketId });
    expect(actor?.state).toBe('idle');
    if (cleared !== undefined) {
      for (const b of view.world.enemies.get(cleared) ?? []) expect(view.actorOf(b)).toBeNull();
    }
    view.dispose();
    expect(actor?.disposed).toBe(true);
  });

  it('freezes on contact, swings on its attack, and dies before the win hands over', async () => {
    const view = mountFloorView(new THREE.Scene(), new THREE.Group(), SEED, { contentVersion: 1 });
    const room = sentryRoom(view);
    view.useEnemyAssets(only(await loadTestSentry()));
    const rig = openHook(view, room, { options: { enemyHp: 1 } });
    rig.step(0.5);
    const actor = view.actors.find((a) => a.object.userData.room === room);
    expect(actor?.frozen).toBe(true);
    rig.step(0.8);
    const session = await rig.hook.ready();
    if (!session || !actor) throw new Error('no session');
    const sentryId = session.enemies.find((e) => e.body === actor.object)?.id;
    expect(sentryId?.replace(/-\d+$/, '')).toBe('cog-sentry');

    // The sentry's turn: a damaging intent plays the attack clip.
    const intent = session.controller.state.enemies.find((e) => e.id === sentryId)?.intent;
    const attacks = intent?.effects.some((e) => e.type === 'damage');
    session.controller.endTurn();
    rig.step(DT);
    if (attacks) expect(actor.state).toBe('attack');
    rig.step(1.4);
    // The enemy phase plays out before the player acts again.
    for (let i = 0; i < 600 && session.enemyPhase; i++) rig.step(DT);
    expect(session.enemyPhase).toBe(false);
    // Its swing over, the sentry settles back into the time-freeze pose.
    rig.step(0.5);
    expect(actor.frozen).toBe(true);
    expect(actor.state).toBe('frozen');

    const killedAt = rig.time();
    killAll(session, rig);
    expect(session.controller.outcome).toBe('won');
    expect(actor.dead).toBe(true);
    expect(actor.object.visible).toBe(true);
    rig.step(1.5);
    // The victory hold alone (1.2 s) has passed, but the sentry is still falling.
    expect(rig.ends).toHaveLength(0);
    expect(rig.hook.banner).toBe('VICTORY');
    rig.step(1.5);
    expect(rig.ends.map((e) => e.outcome)).toEqual(['win']);
    expect((rig.ends[0]?.at ?? 0) - killedAt).toBeGreaterThan(1.9);
    // The flow's board takes over: the banner is gone the moment the fight hands over.
    expect(rig.hook.banner).toBe('');
    rig.step(1.5);
    expect(view.encounter.phase).toBe('idle');
    expect(actor.disposed).toBe(true);
    rig.hook.dispose();
  }, 30_000);
});

/** A seed and room whose regular encounter mixes a Cog Sentry with a Spring Hound. */
function mixedRoom(): { seed: string; room: number } {
  for (let i = 0; i < 400; i++) {
    const seed = `MXD${i.toString().padStart(5, '0')}`;
    const view = mountFloorView(new THREE.Scene(), new THREE.Group(), seed);
    for (const [room, bodies] of view.world.enemies) {
      const kinds = bodies.map((b) => b.userData.enemyKind);
      if (kinds.includes('cog-sentry') && kinds.includes('spring-hound')) {
        view.dispose();
        return { seed, room };
      }
    }
    view.dispose();
  }
  throw new Error('no mixed sentry-hound room in 400 seeds');
}

describe('per-enemy models on the floor', () => {
  const mixed = mixedRoom();

  it('dresses each body with its own kind and keeps capsules for kinds without a model', async () => {
    const sentry = await loadTestModel('cog-sentry');
    const hound = await loadTestModel('spring-hound');
    const view = mountFloorView(new THREE.Scene(), new THREE.Group(), mixed.seed);
    view.useEnemyAssets(only(sentry));
    const room = view.world.enemies.get(mixed.room) ?? [];
    const houndBody = room.find((b) => b.userData.enemyKind === 'spring-hound');
    expect((houndBody as THREE.Mesh | undefined)?.isMesh).toBe(true);
    expect(houndBody && view.actorOf(houndBody)).toBeNull();
    // The hound's model lands later: only its capsules change, the sentries keep their actors.
    const sentryActors = [...view.actors];
    view.useEnemyAssets(only(hound));
    expect(view.actors.filter((a) => sentryActors.includes(a))).toHaveLength(sentryActors.length);
    for (const bodies of view.world.enemies.values()) {
      for (const body of bodies) {
        const kind = body.userData.enemyKind;
        const actor = view.actorOf(body);
        if (kind === 'cog-sentry' || kind === 'spring-hound') expect(actor?.kind).toBe(kind);
        else {
          expect(actor).toBeNull();
          expect((body as THREE.Mesh).isMesh).toBe(true);
        }
      }
    }
    expect(view.world.enemies.get(mixed.room)?.map((b) => view.actorOf(b)?.kind)).toEqual(
      view.world.enemies.get(mixed.room)?.map((b) => b.userData.enemyKind),
    );
    view.dispose();
    expect(sentry.liveActors + hound.liveActors).toBe(0);
  });

  it('starts a mixed fight where each enemy plays its own model or its capsule', async () => {
    const sentry = await loadTestModel('cog-sentry');
    const view = mountFloorView(new THREE.Scene(), new THREE.Group(), mixed.seed);
    view.useEnemyAssets(only(sentry));
    const rig = openHook(view, mixed.room);
    rig.step(1.3);
    const session = await rig.hook.ready();
    if (!session) throw new Error('no session');
    const kinds = session.enemies.map((e) => enemyKindOf(e.id)).sort();
    expect(kinds).toEqual(['cog-sentry', 'spring-hound']);
    for (const { id, body } of session.enemies) {
      expect(body.userData.enemyKind).toBe(enemyKindOf(id));
      const actor = view.actorOf(body);
      if (enemyKindOf(id) === 'cog-sentry') expect(actor?.kind).toBe('cog-sentry');
      else {
        expect(actor).toBeNull();
        expect((body as THREE.Mesh).isMesh).toBe(true);
      }
    }
    rig.hook.dispose();
    view.dispose();

    // With both models, both enemies play actors of their own kind.
    const hound = await loadTestModel('spring-hound');
    const both = mountFloorView(new THREE.Scene(), new THREE.Group(), mixed.seed);
    both.useEnemyAssets(new Map([...only(sentry), ...only(hound)]));
    const rig2 = openHook(both, mixed.room);
    rig2.step(1.3);
    const session2 = await rig2.hook.ready();
    for (const { id, body } of session2?.enemies ?? []) {
      expect(both.actorOf(body)?.kind).toBe(enemyKindOf(id));
    }
    expect(session2?.enemies).toHaveLength(2);
    rig2.hook.dispose();
    both.dispose();
  }, 30_000);

  it('leaves no scene children, mixers or shared-resource disposals across three rebuilds', async () => {
    const sentry = await loadTestModel('cog-sentry');
    const hound = await loadTestModel('spring-hound');
    const models = new Map([...only(sentry), ...only(hound)]);
    const disposed = new Set<THREE.BufferGeometry>();
    for (const model of models.values()) {
      model.template.traverse((o) => {
        if (o instanceof THREE.Mesh)
          o.geometry.addEventListener('dispose', () => disposed.add(o.geometry));
      });
    }
    const scene = new THREE.Scene();
    const baseline = scene.children.length;
    const seen: { mixer: THREE.AnimationMixer; actor: { disposed: boolean } }[] = [];
    // Each actor's own material clones, and whether they have been disposed.
    const cloned = new Map<THREE.Material, boolean>();
    let previous: FloorView | null = null;
    for (const seed of [mixed.seed, SEED, mixed.seed]) {
      const view = mountFloorView(scene, new THREE.Group(), seed);
      view.useEnemyAssets(models);
      expect(view.actors.length).toBeGreaterThan(0);
      for (const actor of view.actors) {
        seen.push({ mixer: actor.mixer, actor });
        actor.object.traverse((o) => {
          if (!(o instanceof THREE.Mesh)) return;
          const material = o.material as THREE.Material;
          if (cloned.has(material)) return;
          cloned.set(material, false);
          material.addEventListener('dispose', () => cloned.set(material, true));
        });
      }
      const head = new THREE.Object3D();
      for (let i = 0; i < 10; i++) view.update(head, DT);
      // The previous floor is gone and nothing it owned is left on the scene or the assets.
      previous?.dispose();
      expect(sentry.liveActors + hound.liveActors).toBe(view.actors.length);
      expect(disposed.size).toBe(0);
      previous = view;
    }
    previous?.dispose();
    expect(scene.children).toHaveLength(baseline);
    expect(sentry.liveActors + hound.liveActors).toBe(0);
    for (const { mixer, actor } of seen) {
      expect(actor.disposed).toBe(true);
      expect(mixer.stats.actions.total).toBe(0);
      expect(mixer.stats.bindings.total).toBe(0);
    }
    expect(cloned.size).toBeGreaterThan(0);
    expect([...cloned.values()].every(Boolean)).toBe(true);
    // The shared geometry outlives every floor; it goes only with the assets themselves.
    expect(disposed.size).toBe(0);
    for (const model of models.values()) model.dispose();
    expect(disposed.size).toBeGreaterThan(0);
  });
});
