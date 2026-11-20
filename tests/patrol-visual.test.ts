// @vitest-environment node
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type EnemyActor,
  type EnemyAsset,
  parseEnemyAsset,
  parseEnemyManifest,
} from '../src/enemies/enemy-asset.ts';
import { PATROL_SETTLE_SECONDS, planPatrolApproach } from '../src/enemies/patrol-approach.ts';
import {
  loadPatrolClips,
  type PatrolClips,
  PatrolVisual,
  parsePatrolClips,
} from '../src/enemies/patrol-visual.ts';
import { type PatrolRoute, samplePatrol } from '../src/floor/patrol.ts';

const enemies = new URL('../public/assets/enemies/', import.meta.url);
const read = (path: string): ArrayBuffer =>
  Uint8Array.from(readFileSync(new URL(path, enemies))).buffer;
const route: PatrolRoute = {
  rooms: [1, 2],
  ends: [
    [0, 0],
    [0, -3.78],
  ],
  cycles: 3,
};

describe('the roaming Cog Sentry on its authored skeleton', () => {
  let asset: EnemyAsset;
  let clips: PatrolClips;
  let actor: EnemyActor;
  let gait: PatrolVisual;
  beforeAll(async () => {
    const manifest = parseEnemyManifest(
      JSON.parse(readFileSync(new URL('cog-sentry/cog-sentry.manifest.json', enemies), 'utf8')),
      'cog-sentry',
    );
    asset = await parseEnemyAsset(read('cog-sentry/cog-sentry.glb'), manifest);
    clips = await parsePatrolClips(read('cog-sentry-patrol/locomotion.glb'));
  });
  beforeEach(() => {
    actor = asset.spawn();
    gait = PatrolVisual.create(actor, clips);
  });
  afterEach(() => actor.dispose());
  afterAll(() => asset.dispose());

  const place = (time: number, dt: number): void => {
    const sample = samplePatrol(route, time);
    actor.object.position.set(sample.x, 0, sample.z);
    actor.object.rotation.y = sample.yaw;
    gait.update(dt, sample);
  };

  it('locks the planted ankle to the floor as the simulation moves forward and back', () => {
    const feet = ['footR', 'footL'].map((name) => actor.object.getObjectByName(name));
    expect(feet.every(Boolean)).toBe(true);
    for (const legStart of [0, 8.4]) {
      for (const [i, foot] of feet.entries()) {
        if (!foot) throw new Error('foot joint missing');
        const ankle = (t: number): THREE.Vector3 => {
          place(legStart + 0.5 + 1.2 + t, 0.2);
          return foot.getWorldPosition(new THREE.Vector3());
        };
        const supportStart = i * 0.6 + 0.15;
        const planted = ankle(supportStart);
        for (let j = 1; j <= 8; j++) {
          const contact = ankle(supportStart + j * 0.048);
          expect(contact.distanceTo(planted)).toBeLessThan(0.005);
        }
        const swing = ankle((i * 0.6 + 0.95) % 1.2);
        expect(swing.y - planted.y).toBeGreaterThan(0.03);
      }
    }
  });

  it('keeps each support foot stationary while the body turns around it', () => {
    for (const direction of ['left', 'right'] as const) {
      const foot = actor.object.getObjectByName(direction === 'left' ? 'footR' : 'footL');
      if (!foot) throw new Error('support foot missing');
      const planted = new THREE.Vector3();
      for (const phase of [0.08, 0.15, 0.23, 0.3]) {
        const signedAngle = ((direction === 'left' ? 1 : -1) * Math.PI) / 2;
        actor.object.rotation.y = signedAngle * phase ** 2 * (3 - 2 * phase);
        gait.update(0.2, { motion: `turn-${direction}`, time: phase * 1.2, speed: 0 });
        const ankle = foot.getWorldPosition(new THREE.Vector3());
        if (phase === 0.08) planted.copy(ankle);
        else expect(ankle.distanceTo(planted)).toBeLessThan(0.005);
      }
    }
  });

  it('samples the exact pose after skipped frames and preserves planted foot positions across phase seams', () => {
    const feet = [actor.object.getObjectByName('footR'), actor.object.getObjectByName('footL')];
    const positions = () =>
      feet.map((foot) => {
        if (!foot) throw new Error('foot joint missing');
        return foot.getWorldPosition(new THREE.Vector3());
      });
    for (const seam of [0.5, 1.7, 4.1, 4.8, 6, 7.2, 8.4]) {
      place(seam - 0.001, 0.2);
      const previous = positions();
      place(seam + 0.001, 0.002);
      for (const [i, next] of positions().entries()) {
        expect(next.distanceTo(previous[i])).toBeLessThan(0.015);
      }
    }
    place(2.1, 0.25);
    expect(actor.state).toBe('patrol-walk');
    expect(actor.action('patrol-walk').time).toBeCloseTo(0.4, 5);
  });

  it('fits forward and backward approaches to the slot and plants the shortened stride', () => {
    for (const dz of [-1.32, 1.32]) {
      const approach = planPatrolApproach(0, dz, 0.4, -0.3);
      let anchor: THREE.Vector3 | null = null;
      let contacts = 0;
      let prevAlong = 0;
      for (let i = 0; i <= Math.ceil(approach.duration * 60); i++) {
        const s = approach.sample(i / 60);
        expect(s.along).toBeGreaterThanOrEqual(prevAlong - 1e-7);
        expect(Math.abs(s.speed)).toBeLessThanOrEqual(2.16);
        prevAlong = s.along;
        actor.object.position.set(0, 0, dz * s.along);
        actor.object.rotation.y = s.yaw;
        gait.approach(1 / 60, s);
        if (s.motion !== 'walk' || s.time < 0.12 || s.time > 0.58) continue;
        expect(Math.sign(s.speed)).toBe(dz < 0 ? 1 : -1);
        const ankle = actor.object.getObjectByName('footR')?.getWorldPosition(new THREE.Vector3());
        if (!ankle) throw new Error('support joint missing');
        anchor ??= ankle;
        expect(ankle.distanceTo(anchor)).toBeLessThan(0.005);
        contacts++;
      }
      expect(contacts).toBeGreaterThan(10);
      expect(prevAlong).toBe(1);
      expect(actor.object.rotation.y).toBeCloseTo(-0.3);
      gait.release();
    }
  });

  it('fits a partial pivot to the final table heading without drifting or twisting the planted shoe', () => {
    for (const sign of [-1, 1]) {
      const approach = planPatrolApproach(0, 0, 0, (sign * Math.PI) / 3);
      const foot = actor.object.getObjectByName(sign > 0 ? 'footR' : 'footL');
      if (!foot) throw new Error('support joint missing');
      const position = new THREE.Vector3();
      const rotation = new THREE.Quaternion();
      for (const phase of [0.02, 0.1, 0.2, 0.3]) {
        const sample = approach.sample(
          PATROL_SETTLE_SECONDS + phase * (approach.duration - PATROL_SETTLE_SECONDS),
        );
        actor.object.rotation.y = sample.yaw;
        gait.approach(0.2, sample);
        if (phase === 0.02) {
          foot.getWorldPosition(position);
          foot.getWorldQuaternion(rotation);
        } else {
          expect(foot.getWorldPosition(new THREE.Vector3()).distanceTo(position)).toBeLessThan(
            0.005,
          );
          expect(foot.getWorldQuaternion(new THREE.Quaternion()).angleTo(rotation)).toBeLessThan(
            0.02,
          );
        }
      }
      gait.release();
    }
  });

  it('plants the supporting shoe while an interrupted walking pose recovers to standing', () => {
    place(1.46, 0.2);
    const foot = actor.object.getObjectByName('footL');
    if (!foot) throw new Error('support joint missing');
    const planted = foot.getWorldPosition(new THREE.Vector3());
    const approach = planPatrolApproach(0, 1.4, 0, 0);
    for (let i = 0; i <= 15; i++) {
      gait.approach(1 / 60, approach.sample(i / 60));
      expect(foot.getWorldPosition(new THREE.Vector3()).distanceTo(planted)).toBeLessThan(0.006);
    }
  });

  it('limits the head turn to the size of a small final heading correction', () => {
    const head = actor.object.getObjectByName('head');
    if (!head) throw new Error('head joint missing');
    const correction = Math.PI / 36;
    const approach = planPatrolApproach(0, 0, 0, correction);
    gait.approach(1 / 60, approach.sample(0));
    const initial = head.getWorldQuaternion(new THREE.Quaternion());
    for (let i = 1; i <= 60; i++) {
      const s = approach.sample(
        PATROL_SETTLE_SECONDS + ((approach.duration - PATROL_SETTLE_SECONDS) * i) / 60,
      );
      actor.object.rotation.y = s.yaw;
      gait.approach(1 / 60, s);
      expect(head.getWorldQuaternion(new THREE.Quaternion()).angleTo(initial)).toBeLessThan(0.25);
    }
  });

  it('yields smoothly to combat and releases actor-owned palettes', () => {
    place(1, 0.25);
    const walk = actor.action('patrol-walk');
    gait.release();
    gait.release();
    actor.attack();
    gait.release();
    actor.update(0.25);
    expect(actor.state).toBe('attack');
    expect(walk.isScheduled()).toBe(false);
    actor.reset();
    place(6.3, 0.18);
    expect(actor.state).toBe('patrol-turn-left');
    const palettes: THREE.Texture[] = [];
    const released: THREE.Texture[] = [];
    actor.object.traverse((o) => {
      if (!(o instanceof THREE.SkinnedMesh)) return;
      o.skeleton.computeBoneTexture();
      const palette = o.skeleton.boneTexture;
      if (palette) {
        palettes.push(palette);
        palette.addEventListener('dispose', () => released.push(palette));
      }
    });
    actor.dispose();
    gait.release();
    expect(palettes.length).toBeGreaterThan(0);
    expect(released).toEqual(palettes);
    expect(actor.mixer.stats.actions.total).toBe(0);
    expect(actor.mixer.stats.bindings.total).toBe(0);
  });

  it('recovers from a missing sidecar and shares one successful fetch across floors', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(read('cog-sentry-patrol/locomotion.glb')));
    vi.stubGlobal('fetch', fetch);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await loadPatrolClips()).toBeNull();
      const [first, second] = await Promise.all([loadPatrolClips(), loadPatrolClips()]);
      expect(first?.walk.name).toBe('patrol-walk');
      expect(second).toBe(first);
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
      vi.unstubAllGlobals();
    }
  });
});
