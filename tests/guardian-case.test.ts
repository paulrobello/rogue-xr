// @vitest-environment node
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ENEMY_CLIPS,
  type EnemyActor,
  type EnemyAsset,
  hasPhaseClip,
  PHASE_CLIP,
  PHASE_HELD_BONES,
  parseEnemyAsset,
  parseEnemyManifest,
} from '../src/enemies/enemy-asset.ts';

const ids = ['cog-sentry', 'spring-hound', 'bellows-golem', 'orrery-warden', 'grand-escapement'];

function load(id: string, as?: string): Promise<EnemyAsset> {
  const base = new URL(`../public/assets/enemies/${id}/`, import.meta.url);
  const raw = JSON.parse(readFileSync(new URL(`${id}.manifest.json`, base), 'utf8'));
  const manifest = parseEnemyManifest(raw, id);
  const bytes = readFileSync(new URL(manifest.glb, base));
  const glb = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  return parseEnemyAsset(glb, as ? { ...manifest, id: as } : manifest);
}

const live: { asset: EnemyAsset; actor: EnemyActor }[] = [];
async function spawn(id: string, as?: string): Promise<{ asset: EnemyAsset; actor: EnemyActor }> {
  const asset = await load(id, as);
  const actor = asset.spawn();
  live.push({ asset, actor });
  return { asset, actor };
}
afterEach(() => {
  for (const { asset, actor } of live.splice(0)) {
    actor.dispose();
    asset.dispose();
  }
});

/** Advances the actor in whole 1/60 s frames. */
function advance(actor: EnemyActor, seconds: number): void {
  for (let t = 0; t < seconds - 1e-9; t += 1 / 60) actor.update(1 / 60);
}

const bone = (actor: EnemyActor, name: string): THREE.Object3D => {
  const found = actor.object.getObjectByName(THREE.PropertyBinding.sanitizeNodeName(name));
  if (!found) throw new Error(`bone ${name} missing`);
  return found;
};
/** Total rotation of the four hinge bones away from the pose `reference`, in radians. */
const spread = (actor: EnemyActor, reference: THREE.Quaternion[]): number =>
  PHASE_HELD_BONES.reduce(
    (sum, name, i) => sum + bone(actor, name).quaternion.angleTo(reference[i] as THREE.Quaternion),
    0,
  );
const poses = (actor: EnemyActor): THREE.Quaternion[] =>
  PHASE_HELD_BONES.map((name) => bone(actor, name).quaternion.clone());

describe('phase-change clip loading', () => {
  it('is wanted only for the guardian', () => {
    expect(ids.filter(hasPhaseClip)).toEqual(['grand-escapement']);
  });

  it('loads on the guardian asset and on no other', async () => {
    for (const id of ids) {
      const asset = await load(id);
      if (id === 'grand-escapement') {
        expect(asset.phaseClip?.name).toBe(PHASE_CLIP);
        expect(asset.phaseClip?.duration).toBeCloseTo(3, 1);
      } else {
        expect(asset.phaseClip, id).toBeNull();
      }
      expect(asset.clips.size).toBe(ENEMY_CLIPS.length);
      asset.dispose();
    }
  });

  it('is not picked up by another enemy even from a glb that carries it', async () => {
    const asset = await load('grand-escapement', 'orrery-warden');
    expect(asset.phaseClip).toBeNull();
    const actor = asset.spawn();
    actor.openCase();
    expect(actor.state).toBe('idle');
    expect(actor.caseOpening).toBe(false);
    actor.dispose();
    asset.dispose();
  });

  it('gives a non-guardian actor a no-op openCase', async () => {
    const { actor } = await spawn('orrery-warden');
    actor.openCase();
    expect(actor.state).toBe('idle');
    expect(actor.phaseChanges).toBe(0);
    expect(actor.caseOpen).toBe(false);
  });
});

describe('the guardian case', () => {
  it('holds all four hinge bones from the clip, closed until the change', async () => {
    const { actor } = await spawn('grand-escapement');
    expect(PHASE_HELD_BONES).toEqual(['door.L', 'door.R', 'plate.L', 'plate.R']);
    for (const name of PHASE_HELD_BONES) expect(bone(actor, name)).toBeDefined();
    expect(actor.caseOpen).toBe(false);
    expect(actor.state).toBe('idle');
  });

  it('plays the phase-change clip once, then stays open on idle', async () => {
    const { actor } = await spawn('grand-escapement');
    advance(actor, 0.5);
    const closed = poses(actor);
    const events: string[] = [];
    actor.onEvent = (event, clip) => events.push(`${clip}:${event}`);
    actor.openCase();
    expect(actor.state).toBe('phase-change');
    expect(actor.caseOpening).toBe(true);
    expect(actor.phaseChanges).toBe(1);
    // A second call while it plays, or after, starts nothing new.
    actor.openCase();
    expect(actor.phaseChanges).toBe(1);
    advance(actor, 1.5);
    expect(actor.state).toBe('phase-change');
    expect(events).toContain('phase-change:open');
    advance(actor, 2);
    expect(actor.caseOpen).toBe(true);
    expect(actor.caseOpening).toBe(false);
    expect(actor.state).toBe('idle');
    // Every hinge is well away from its closed pose: the door swings about 105 degrees each.
    expect(spread(actor, closed)).toBeGreaterThan(Math.PI);
    actor.openCase();
    expect(actor.phaseChanges).toBe(1);
    expect(actor.state).toBe('idle');
  });

  it('keeps the case open through idle, attack, hit, frozen and death', async () => {
    const { actor } = await spawn('grand-escapement');
    advance(actor, 0.5);
    const closed = poses(actor);
    actor.openCase();
    advance(actor, 3.5);
    const open = poses(actor);
    expect(spread(actor, closed)).toBeGreaterThan(Math.PI);
    const stays = (label: string): void => {
      expect(spread(actor, open), label).toBeLessThan(1e-4);
    };
    stays('idle');
    advance(actor, 2.7);
    stays('idle loop');
    actor.attack();
    expect(actor.state).toBe('attack');
    for (let i = 0; i < 100; i++) {
      advance(actor, 1 / 60);
      stays(`attack ${i}`);
    }
    expect(actor.state).toBe('idle');
    actor.hit();
    expect(actor.state).toBe('hit');
    for (let i = 0; i < 50; i++) {
      advance(actor, 1 / 60);
      stays(`hit ${i}`);
    }
    actor.freeze();
    advance(actor, 1);
    stays('frozen');
    actor.unfreeze();
    advance(actor, 1);
    stays('unfrozen');
    void actor.die();
    for (let i = 0; i < 200; i++) {
      advance(actor, 1 / 60);
      stays(`death ${i}`);
    }
  });

  it('plays an attack asked for mid-change after the change, and ignores a hit clip', async () => {
    const { actor } = await spawn('grand-escapement');
    actor.openCase();
    advance(actor, 0.5);
    actor.attack();
    actor.hit();
    expect(actor.state).toBe('phase-change');
    advance(actor, 1);
    expect(actor.state).toBe('phase-change');
    advance(actor, 2);
    expect(actor.state).toBe('attack');
    expect(actor.caseOpen).toBe(true);
    advance(actor, 2);
    expect(actor.state).toBe('idle');
  });

  it('keeps the case open when the guardian dies mid-change', async () => {
    const { actor } = await spawn('grand-escapement');
    advance(actor, 0.5);
    const closed = poses(actor);
    actor.openCase();
    advance(actor, 1.5);
    void actor.die();
    expect(actor.caseOpen).toBe(true);
    advance(actor, 3);
    expect(spread(actor, closed)).toBeGreaterThan(Math.PI);
  });

  it('closes again on reset, for a pooled actor reused in a new fight', async () => {
    const { actor } = await spawn('grand-escapement');
    advance(actor, 0.5);
    const closed = poses(actor);
    actor.openCase();
    advance(actor, 3.5);
    expect(actor.caseOpen).toBe(true);
    actor.reset();
    expect(actor.caseOpen).toBe(false);
    expect(actor.phaseChanges).toBe(0);
    advance(actor, 0.5);
    expect(spread(actor, closed)).toBeLessThan(0.5);
    actor.openCase();
    expect(actor.phaseChanges).toBe(1);
  });
});
