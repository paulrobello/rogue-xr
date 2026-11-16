/**
 * Regenerates the controller trace fixtures next to this file: `bun tests/fixtures/fling/generate.ts`.
 * Traces are synthetic but shaped like Quest controller captures: pose noise of 2 mm per axis, a
 * 400 ms wind-up before the flick, and a damaged final frame. `expectedVelocity` is the noiseless
 * mean velocity over the final `windowSeconds` before the true release, which is what a fit
 * should recover.
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

type V3 = [number, number, number];

interface Motion {
  /** Noiseless position at time t. */
  at(t: number): V3;
  release: number;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const WINDOW = 0.09;
const NOISE = 0.002;
const START: V3 = [0.25, 1.05, -0.35];

function unit(v: V3): V3 {
  const l = Math.hypot(...v);
  return [v[0] / l, v[1] / l, v[2] / l];
}

const FLICK_DIR = unit([0.1, 0.12, -1]);

function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gauss(next: () => number): number {
  return Math.sqrt(-2 * Math.log(1 - next())) * Math.cos(2 * Math.PI * next());
}

const smoothstep = (u: number): number => {
  const c = Math.min(1, Math.max(0, u));
  return c * c * (3 - 2 * c);
};

/** Integrates a speed profile along `dir` from `START`. */
function alongLine(speed: (t: number) => number, dir: V3, release: number): Motion {
  const step = 1e-4;
  const table: number[] = [0];
  for (let i = 1; i <= Math.ceil(release / step) + 1; i++) {
    table.push((table[i - 1] as number) + speed((i - 0.5) * step) * step);
  }
  return {
    release,
    at(t) {
      const x = t / step;
      const i = Math.min(table.length - 2, Math.floor(x));
      const s = (table[i] as number) + ((table[i + 1] as number) - (table[i] as number)) * (x - i);
      return [START[0] + dir[0] * s, START[1] + dir[1] * s, START[2] + dir[2] * s];
    },
  };
}

/** Wind-up back along the throw line for 400 ms, then a flick to 3 m/s held until release. */
const flickMotion = (): Motion =>
  alongLine(
    (t) => (t < 0.4 ? -0.5 * Math.sin((Math.PI * t) / 0.4) : 3.0 * smoothstep((t - 0.4) / 0.12)),
    FLICK_DIR,
    0.6,
  );

/** A slow lowering toward the table: peak 0.35 m/s, nowhere near a throw. */
const dropMotion = (): Motion =>
  alongLine((t) => 0.35 * Math.sin((Math.PI * t) / 0.6) ** 2, unit([0.05, -1, -0.3]), 0.6);

/** Hand held still-ish with a 3 Hz, 15 mm lateral tremor and a slow forward creep. */
const wobbleMotion = (): Motion => {
  const creep = alongLine(() => 0.1, unit([0, 0, -1]), 0.6);
  return {
    release: 0.6,
    at(t) {
      const p = creep.at(t);
      return [p[0] + 0.015 * Math.sin(2 * Math.PI * 3 * t), p[1], p[2]];
    },
  };
};

interface Fixture {
  name: string;
  description: string;
  hz: number;
  windowSeconds: number;
  releaseTime: number;
  expectedVelocity: V3;
  samples: [number, number, number, number][];
}

type FinalFrame = 'intact' | 'dropped' | 'sagged' | 'jittered';

function record(
  name: string,
  description: string,
  motion: Motion,
  hz: number,
  seed: number,
  finalFrame: FinalFrame,
): Fixture {
  const next = rng(seed);
  const frames: number[] = [];
  for (let k = 0; k / hz <= motion.release + 1e-9; k++) frames.push(k / hz);
  if (finalFrame === 'dropped') frames.pop();
  const samples = frames.map((t, i): [number, number, number, number] => {
    const p = motion.at(t);
    const last = i === frames.length - 1;
    let [x, y, z] = p;
    if (last && finalFrame === 'sagged') {
      // The pose sags as the fingers open: back along the throw and down.
      x -= FLICK_DIR[0] * 0.03;
      y -= FLICK_DIR[1] * 0.03 + 0.02;
      z -= FLICK_DIR[2] * 0.03;
    }
    if (last && finalFrame === 'jittered') {
      x += 0.018;
      y -= 0.012;
    }
    const r = (v: number): number => Math.round((v + gauss(next) * NOISE) * 1e4) / 1e4;
    return [Math.round(t * 1e5) / 1e5, r(x), r(y), r(z)];
  });
  const a = motion.at(motion.release - WINDOW);
  const b = motion.at(motion.release);
  const expectedVelocity = [0, 1, 2].map(
    (i) => Math.round((((b[i] as number) - (a[i] as number)) * 1e5) / WINDOW) / 1e5,
  ) as V3;
  return {
    name,
    description,
    hz,
    windowSeconds: WINDOW,
    releaseTime: motion.release,
    expectedVelocity,
    samples,
  };
}

const fixtures: Fixture[] = [
  record(
    'flick-72hz',
    '400 ms wind-up, flick, final frame dropped',
    flickMotion(),
    72,
    7201,
    'dropped',
  ),
  record(
    'flick-90hz',
    '400 ms wind-up, flick, final frame sagged 36 mm',
    flickMotion(),
    90,
    9001,
    'sagged',
  ),
  record(
    'flick-120hz',
    '400 ms wind-up, flick, final frame jittered 22 mm',
    flickMotion(),
    120,
    12001,
    'jittered',
  ),
  record('drop-90hz', 'slow lowering toward the table', dropMotion(), 90, 9002, 'intact'),
  record('wobble-90hz', 'held still with a lateral tremor', wobbleMotion(), 90, 9003, 'intact'),
];

for (const f of fixtures) {
  const rows = f.samples.map((s) => `    ${JSON.stringify(s).replaceAll(',', ', ')}`).join(',\n');
  const body = `{\n  "name": ${JSON.stringify(f.name)},\n  "description": ${JSON.stringify(f.description)},\n  "hz": ${f.hz},\n  "windowSeconds": ${f.windowSeconds},\n  "releaseTime": ${f.releaseTime},\n  "expectedVelocity": ${JSON.stringify(f.expectedVelocity).replaceAll(',', ', ')},\n  "samples": [\n${rows}\n  ]\n}\n`;
  writeFileSync(join(HERE, `${f.name}.json`), body);
  console.log(f.name, f.samples.length, 'samples', f.expectedVelocity.join(' '));
}
