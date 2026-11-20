import { PATROL_GAIT } from '../floor/patrol.ts';
import type { PatrolPoseSample } from './patrol-visual.ts';

export interface PatrolApproachSample extends PatrolPoseSample {
  along: number;
  yaw: number;
  /** Fraction of the authored stride or pivot needed to place the next foot. */
  scale: number;
  settle?: number;
  returning?: boolean;
}

export interface PatrolApproach {
  duration: number;
  sample(elapsed: number): PatrolApproachSample;
}

const wrap = (angle: number): number => Math.atan2(Math.sin(angle), Math.cos(angle));
const quarter = Math.PI / 2;
const rate = 1.4;
export const PATROL_SETTLE_SECONDS = 0.56;

function pivot(from: number, to: number, along: number) {
  const angle = wrap(to - from);
  const steps = Math.ceil(Math.abs(angle) / quarter - 1e-8);
  const scale = steps > 0 ? Math.abs(angle) / (steps * quarter) : 0;
  const perStep = (PATROL_GAIT.turn * Math.max(scale, 0.6)) / rate;
  return {
    duration: steps * perStep,
    sample(t: number): PatrolApproachSample {
      const step = Math.min(steps - 1, Math.floor(t / perStep));
      const p = Math.min(1, t / perStep - step);
      return {
        along,
        yaw: from + (angle * (step + p * p * (3 - 2 * p))) / steps,
        motion: angle > 0 ? 'turn-left' : 'turn-right',
        time: p * PATROL_GAIT.turn,
        speed: 0,
        scale,
      };
    },
  };
}

/** Plan against the measured displacement so the final stop lands on both feet at the table. */
export function planPatrolApproach(
  dx: number,
  dz: number,
  startYaw: number,
  endYaw: number,
): PatrolApproach {
  const distance = Math.hypot(dx, dz);
  const heading = distance > 1e-5 ? Math.atan2(-dx, -dz) : startYaw;
  const turnCost = (yaw: number) => Math.abs(wrap(yaw - startYaw)) + Math.abs(wrap(endYaw - yaw));
  const backward = turnCost(heading + Math.PI) + 0.15 < turnCost(heading);
  const yaw = backward ? wrap(heading + Math.PI) : heading;
  const before = pivot(startYaw, yaw, 0);
  const after = pivot(yaw, endYaw, 1);
  const { speed, start, walk, stop } = PATROL_GAIT;
  const cycles = Math.max(0, Math.ceil((distance / speed - (start + stop) / 2) / walk - 1e-8));
  const walkTime = cycles * walk;
  const nominalDistance = speed * ((start + stop) / 2 + walkTime);
  const nominalTime = start + walkTime + stop;
  const travelTime = distance > 1e-5 ? nominalTime / rate : 0;
  const scale = distance / nominalDistance;
  const duration = PATROL_SETTLE_SECONDS + before.duration + travelTime + after.duration;
  return {
    duration,
    sample(elapsed: number): PatrolApproachSample {
      let t = Math.max(0, elapsed);
      if (t < PATROL_SETTLE_SECONDS) {
        return {
          along: 0,
          yaw: startYaw,
          motion: 'idle',
          time: 0,
          speed: 0,
          scale: 1,
          settle: t / PATROL_SETTLE_SECONDS,
        };
      }
      t -= PATROL_SETTLE_SECONDS;
      if (t < before.duration) return before.sample(t);
      t -= before.duration;
      if (t < travelTime) {
        const clock = backward ? nominalTime - t * rate : t * rate;
        let motion: PatrolPoseSample['motion'];
        let time: number;
        let velocity: number;
        let travel: number;
        if (clock < start) {
          motion = 'start';
          time = clock;
          velocity = speed * (time / start);
          travel = (velocity * time) / 2;
        } else if (clock < start + walkTime) {
          motion = 'walk';
          time = clock - start;
          velocity = speed;
          travel = speed * (start / 2 + time);
        } else {
          motion = 'stop';
          time = clock - start - walkTime;
          velocity = speed * (1 - time / stop);
          travel = nominalDistance - (velocity * (stop - time)) / 2;
        }
        const along = travel / nominalDistance;
        return {
          along: backward ? 1 - along : along,
          yaw,
          motion,
          time,
          speed: velocity * scale * rate * (backward ? -1 : 1),
          scale,
        };
      }
      t -= travelTime;
      if (t < after.duration) return after.sample(t);
      return { along: 1, yaw: endYaw, motion: 'idle', time: 0, speed: 0, scale: 1 };
    },
  };
}
