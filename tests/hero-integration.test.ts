import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { CombatHook, type CombatSession } from '../src/combat/combat-session.ts';
import { CombatController } from '../src/combat-view/controller.ts';
import { intentChips } from '../src/combat-view/index.ts';
import { getCard } from '../src/content/cards.ts';
import { GREYBOX_TEMPLATES, templateById } from '../src/content/rooms.ts';
import { ActionBus } from '../src/core/actions.ts';
import { parseSentry, parseSentryManifest, type SentryAsset } from '../src/enemies/sentry-asset.ts';
import type { EnemyState } from '../src/rules/index.ts';
import { type FloorView, mountFloorView } from '../src/world/floor-view.ts';
import { heroTemplates, parseStudyManifest } from '../src/world/study-room.ts';

const DT = 1 / 60;
const SEED = 'SPIRE002';

// happy-dom serves import.meta.url over http, so asset paths resolve from the repo root.
const asset = (path: string): string => join(process.cwd(), 'public/assets', path);
const sentryManifest = parseSentryManifest(
  JSON.parse(readFileSync(asset('enemies/cog-sentry/cog-sentry.manifest.json'), 'utf8')),
);
const sentryBytes = readFileSync(asset(`enemies/cog-sentry/${sentryManifest.glb}`));
const loadTestSentry = (): Promise<SentryAsset> =>
  parseSentry(
    sentryBytes.buffer.slice(
      sentryBytes.byteOffset,
      sentryBytes.byteOffset + sentryBytes.byteLength,
    ) as ArrayBuffer,
    sentryManifest,
    null,
  );
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
    const view = mountFloorView(new THREE.Scene(), new THREE.Group(), SEED);
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
    view.useSentryAsset(await loadTestSentry());
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
    const view = mountFloorView(new THREE.Scene(), new THREE.Group(), SEED);
    const room = sentryRoom(view);
    view.useSentryAsset(await loadTestSentry());
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
