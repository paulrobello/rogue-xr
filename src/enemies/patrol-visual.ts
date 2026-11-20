import type * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { PATROL_GAIT } from '../floor/patrol.ts';
import type { EnemyActor } from './enemy-asset.ts';
import type { PatrolApproachSample } from './patrol-approach.ts';
import { PatrolFeet } from './patrol-feet.ts';

const DURATIONS = {
  start: PATROL_GAIT.start,
  walk: PATROL_GAIT.walk,
  stop: PATROL_GAIT.stop,
  'turn-left': PATROL_GAIT.turn,
  'turn-right': PATROL_GAIT.turn,
};
type Gait = keyof typeof DURATIONS;
const GAITS = Object.keys(DURATIONS) as Gait[];
export type PatrolClipName = `patrol-${Gait}`;
export type PatrolClips = Readonly<Record<Gait, THREE.AnimationClip>>;

export interface PatrolPoseSample {
  motion: 'idle' | Gait;
  /** Seconds from the start of the current motion on the simulation clock. */
  time: number;
  speed: number;
}

export async function parsePatrolClips(bytes: ArrayBuffer): Promise<PatrolClips> {
  const gltf = await new GLTFLoader().parseAsync(bytes, '');
  const clips = {} as Record<Gait, THREE.AnimationClip>;
  for (const gait of GAITS) {
    const name = `patrol-${gait}`;
    const clip = gltf.animations.find((entry) => entry.name === name);
    if (!clip?.tracks.length || Math.abs(clip.duration - DURATIONS[gait]) > 0.002) {
      throw new Error(`Invalid Cog Sentry locomotion clip: ${name}`);
    }
    clips[gait] = clip;
  }
  return clips;
}

let loading: Promise<PatrolClips | null> | undefined;

/** Rooms share the animation data. A later load can retry a failed request. */
export function loadPatrolClips(): Promise<PatrolClips | null> {
  loading ??= fetch('/assets/enemies/cog-sentry-patrol/locomotion.glb')
    .then(async (response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return parsePatrolClips(await response.arrayBuffer());
    })
    .catch((error: unknown) => {
      console.warn('Cog Sentry patrol animation unavailable', error);
      loading = undefined;
      return null;
    });
  return loading;
}

const HANDOFF_FADE = 0.14;

/** The floor moves the actor. The gait is sampled from the same clock as that transform. */
export class PatrolVisual {
  private readonly feet: PatrolFeet;
  private approaching = false;
  private constructor(private readonly actor: EnemyActor) {
    this.feet = new PatrolFeet(actor.object);
  }

  static create(actor: EnemyActor, clips: PatrolClips): PatrolVisual {
    if (actor.kind !== 'cog-sentry' || actor.disposed) {
      throw new Error('Patrol locomotion requires a live Cog Sentry');
    }
    for (const gait of GAITS) actor.bindPatrolClip(`patrol-${gait}`, clips[gait]);
    return new PatrolVisual(actor);
  }

  update(dt: number, sample: PatrolPoseSample, lookAt: THREE.Vector3 | null = null): void {
    this.feet.restore();
    this.approaching = false;
    this.pose(dt, sample, lookAt);
  }

  private pose(dt: number, sample: PatrolPoseSample, lookAt: THREE.Vector3 | null): void {
    const actor = this.actor;
    if (!actor.disposed && !actor.dead && !actor.frozen) {
      const name = sample.motion === 'idle' ? 'idle' : (`patrol-${sample.motion}` as const);
      const previous = actor.state;
      // The authored moving phases meet on the same planted feet. Blending those seams would slide them.
      const fade =
        !this.approaching && sample.time < HANDOFF_FADE && (previous === 'idle' || name === 'idle')
          ? HANDOFF_FADE
          : 0;
      const action = previous === name ? actor.action(name) : actor.play(name, { fade });
      action.setEffectiveTimeScale(0);
      const duration = action.getClip().duration;
      const elapsed = Math.max(0, sample.time);
      action.time =
        sample.motion === 'walk' || sample.motion === 'idle'
          ? elapsed % duration
          : Math.min(elapsed, duration);
    }
    actor.update(dt, lookAt);
  }

  approach(dt: number, sample: PatrolApproachSample, lookAt: THREE.Vector3 | null = null): void {
    if (!this.approaching && !sample.returning) this.feet.begin();
    this.feet.restore();
    this.approaching = true;
    this.pose(dt, sample, lookAt);
    if (!this.actor.disposed && !this.actor.dead && !this.actor.frozen) this.feet.fit(dt, sample);
  }

  /** Combat keeps the same skinned instance, mixer, world transform and look-at. */
  release(): void {
    const actor = this.actor;
    this.feet.restore();
    this.approaching = false;
    if (actor.disposed) return;
    if (actor.state?.startsWith('patrol-')) actor.play('idle', { fade: HANDOFF_FADE });
    else if (actor.state === 'idle') actor.action('idle').setEffectiveTimeScale(1);
  }
}
