// @vitest-environment node
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { ENEMIES, type EnemyKind } from '../src/content/enemies.ts';
import { parseEnemyAsset, parseEnemyManifest } from '../src/enemies/enemy-asset.ts';

async function load(id: EnemyKind) {
  const base = `public/assets/enemies/${id}/${id}`;
  const manifest = parseEnemyManifest(
    JSON.parse(readFileSync(base + '.manifest.json', 'utf8')),
    id,
  );
  return parseEnemyAsset(Uint8Array.from(readFileSync(base + '.glb')).buffer, manifest);
}

async function loadWithManifest(id: EnemyKind, edit: (raw: Record<string, unknown>) => void) {
  const base = `public/assets/enemies/${id}/${id}`;
  const raw = JSON.parse(readFileSync(base + '.manifest.json', 'utf8')) as Record<string, unknown>;
  edit(raw);
  const manifest = parseEnemyManifest(raw, id);
  return parseEnemyAsset(Uint8Array.from(readFileSync(base + '.glb')).buffer, manifest);
}

describe('Foundry actor lifecycle', () => {
  it.each(['furnace-mite', 'glasswing-scrivener', 'null-crown-auditor'] as const)(
    'holds each %s tell and returns to it after a hit',
    async (id) => {
      const asset = await load(id);
      const actor = asset.spawn();
      try {
        for (const move of ENEMIES[id].moves) {
          actor.showIntent(move.id);
          const name = `intent-${move.id}` as const;
          expect(actor.state).toBe(name);
          actor.update(1.1);
          const action = actor.action(name);
          const held = action.time;
          expect(held).toBeCloseTo(action.getClip().duration);
          actor.showIntent(move.id);
          actor.update(0.2);
          expect(action.time).toBe(held);
          actor.hit();
          actor.update(1);
          expect(actor.state).toBe(name);
        }
        actor.reset();
        expect(actor.state).toBe('idle');
      } finally {
        actor.dispose();
        asset.dispose();
      }
    },
  );
  it('preserves both enamel variants across freeze and thaw, without tinting the other mite', async () => {
    const asset = await load('furnace-mite'),
      one = asset.spawn(0),
      two = asset.spawn(1);
    try {
      const read = (obj: THREE.Object3D) => {
        let color = -1;
        obj.traverse((c) => {
          if (c instanceof THREE.Mesh && c.material.name === 'foundry-mark')
            color = c.material.color.getHex();
        });
        return color;
      };
      expect(one.object.getObjectByName('furnace-mark-extra')?.visible).toBe(false);
      expect(two.object.getObjectByName('furnace-mark-extra')?.visible).toBe(true);
      const original = read(one.object);
      expect(original).toBe(0xa52533);
      expect(read(two.object)).toBe(0xfff1c7);
      one.freeze();
      one.showIntent('stoke');
      expect(read(one.object)).toBe(original);
      expect(read(two.object)).toBe(0xfff1c7);
    } finally {
      one.dispose();
      two.dispose();
      asset.dispose();
    }
  });
  it('keeps the Auditor stamp raised during the warning and drops it for the actual Levy impact', async () => {
    const asset = await load('null-crown-auditor'),
      actor = asset.spawn();
    try {
      actor.showIntent('levy');
      actor.update(0.8);
      expect(actor.state).toBe('intent-levy');
      const cues: string[] = [];
      actor.onEvent = (event) => cues.push(event);
      actor.attack('levy');
      actor.update(0.55);
      expect(actor.state).toBe('action-levy');
      expect(cues).not.toContain('impact');
      actor.update(0.08);
      expect(cues).toContain('impact');
      actor.showIntent('tally');
      actor.update(0.5);
      expect(actor.state).toBe('intent-tally');
    } finally {
      actor.dispose();
      asset.dispose();
    }
  });

  it('keeps legacy damaging moves on the authored attack clip', async () => {
    const asset = await load('cog-sentry');
    const actor = asset.spawn();
    try {
      actor.attack();
      expect(actor.state).toBe('attack');
    } finally {
      actor.dispose();
      asset.dispose();
    }
  });

  it('uses authored action timing for a custom action and falls back for untimed actions', async () => {
    const baseline = await load('null-crown-auditor');
    const duration = baseline.moveClips.get('action-levy')?.duration ?? 0;
    baseline.dispose();
    const asset = await loadWithManifest('null-crown-auditor', (raw) => {
      raw.actionTimings = { levy: { duration, impact: 0.25 } };
    });
    const actor = asset.spawn();
    try {
      expect(actor.timingForMove('reconcile').duration).toBe(1);
      const cues: string[] = [];
      actor.showIntent('levy');
      actor.onEvent = (event) => cues.push(event);
      actor.attack('levy');
      actor.update(0.3);
      expect(actor.state).toBe('action-levy');
      expect(cues).toContain('impact');
      actor.update(duration);
      expect(actor.state).toBe('intent-levy');
    } finally {
      actor.dispose();
      asset.dispose();
    }
  });
});
