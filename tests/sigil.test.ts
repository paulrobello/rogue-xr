// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  FLOOR,
  MAX,
  MIN_SCORE,
  PERFECT_SCORE,
  type Point,
  recognize,
  SIGIL_IDS,
  SIGIL_TEMPLATES,
  type SigilId,
  type Stroke,
  scoreAgainst,
  scoreToMultiplier,
} from '../src/sigil/index.ts';

/** Resample a stroke to `count` points along its arc length, with `warp` remapping progress (drawing speed). */
function redraw(stroke: Stroke, count: number, warp: (t: number) => number): Point[] {
  const cumulative = [0];
  for (let i = 1; i < stroke.length; i++) {
    const a = stroke[i - 1] as Point;
    const b = stroke[i] as Point;
    cumulative.push((cumulative[i - 1] as number) + Math.hypot(b.x - a.x, b.y - a.y));
  }
  const total = cumulative[cumulative.length - 1] as number;
  return Array.from({ length: count }, (_, k) => {
    const s = warp(k / (count - 1)) * total;
    let j = 1;
    while (j < cumulative.length - 1 && (cumulative[j] as number) < s) j++;
    const a = stroke[j - 1] as Point;
    const b = stroke[j] as Point;
    const span = (cumulative[j] as number) - (cumulative[j - 1] as number);
    const t = span > 0 ? (s - (cumulative[j - 1] as number)) / span : 0;
    return { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) };
  });
}

interface Pose {
  readonly scale: number;
  readonly dx: number;
  readonly dy: number;
  readonly degrees: number;
  /** Horizontal stretch before rotation: a slightly wide or narrow hand. */
  readonly stretch: number;
}

function pose(strokes: readonly Stroke[], p: Pose): Stroke[] {
  const r = (p.degrees * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return strokes.map((stroke) =>
    stroke.map((q) => {
      const x = (q.x - 0.5) * p.stretch;
      const y = q.y - 0.5;
      return { x: p.dx + p.scale * (c * x - s * y), y: p.dy + p.scale * (s * x + c * y) };
    }),
  );
}

const POSES: readonly Pose[] = [
  { scale: 0.3, dx: 3, dy: -2, degrees: 6, stretch: 1.06 },
  { scale: 2, dx: -1, dy: 5, degrees: -7, stretch: 0.95 },
  { scale: 12, dx: 40, dy: 0, degrees: 4, stretch: 1 },
];

/** A player's redraw speeds up and slows down through the stroke instead of moving evenly. */
const UNEVEN_SPEED = (t: number): number => t + (0.24 * Math.sin(2 * Math.PI * t)) / (2 * Math.PI);

/**
 * A reference trace of `id`, unlike its template in point count, spacing, stroke order and
 * direction, size, position, aspect and a few degrees of tilt.
 */
function referenceTrace(id: SigilId, variant: number): Stroke[] {
  const strokes = SIGIL_TEMPLATES[id].strokes.map((stroke, i) => {
    const points = redraw(stroke, 45 + variant * 50 + i * 5, UNEVEN_SPEED);
    return (i + variant) % 2 === 1 ? points.reverse() : points;
  });
  const ordered = variant % 2 === 1 ? [...strokes].reverse() : strokes;
  return pose(ordered, POSES[variant % POSES.length] as Pose);
}

const VARIANTS = [0, 1, 2] as const;

describe('own-sigil reference traces', () => {
  for (const id of SIGIL_IDS) {
    it(`${id}: every redraw scores at least 0.85 and is recognized as ${id}`, () => {
      for (const variant of VARIANTS) {
        const trace = referenceTrace(id, variant);
        expect(scoreAgainst(trace, id), `variant ${variant}`).toBeGreaterThanOrEqual(0.85);
        expect(recognize(trace).id, `variant ${variant}`).toBe(id);
      }
    });
  }
});

describe('cross-sigil confusion', () => {
  for (const id of SIGIL_IDS) {
    it(`${id} traces stay below MIN_SCORE against every other sigil`, () => {
      for (const variant of VARIANTS) {
        const trace = referenceTrace(id, variant);
        for (const other of SIGIL_IDS) {
          if (other === id) continue;
          expect(scoreAgainst(trace, other), `variant ${variant} vs ${other}`).toBeLessThan(
            MIN_SCORE,
          );
        }
      }
    });
  }
});

/** mulberry32: a tiny deterministic PRNG returning floats in [0, 1). */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 15), z | 1);
    z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
    return ((z ^ (z >>> 14)) >>> 0) / 4294967296;
  };
}

/** Gaussian noise with standard deviation `level` times the trace's bounding-box size. */
function jitter(strokes: readonly Stroke[], level: number, seed: number): Stroke[] {
  const random = mulberry32(seed);
  const gaussian = (): number =>
    Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random());
  const all = strokes.flat();
  const xs = all.map((p) => p.x);
  const ys = all.map((p) => p.y);
  const size = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  return strokes.map((stroke) =>
    stroke.map((p) => ({
      x: p.x + gaussian() * level * size,
      y: p.y + gaussian() * level * size,
    })),
  );
}

describe('jittered traces', () => {
  const LEVELS = [0, 0.01, 0.02, 0.04, 0.07, 0.1];
  const SEEDS = 12;
  const averages = LEVELS.map((level) => {
    let total = 0;
    let count = 0;
    for (const id of SIGIL_IDS) {
      for (let seed = 1; seed <= SEEDS; seed++) {
        const trace = jitter(referenceTrace(id, seed % VARIANTS.length), level, seed * 7919);
        total += scoreAgainst(trace, id);
        count++;
      }
    }
    return total / count;
  });

  it('degrade smoothly: the average score never rises with more noise', () => {
    for (let i = 1; i < averages.length; i++) {
      expect(averages[i], `level ${LEVELS[i]}`).toBeLessThanOrEqual(
        (averages[i - 1] as number) + 0.01,
      );
    }
  });

  it('lose real quality at the highest noise level', () => {
    expect(averages[averages.length - 1]).toBeLessThan((averages[0] as number) - 0.2);
  });

  it('a light tremor still clears MIN_SCORE on average', () => {
    expect(averages[1]).toBeGreaterThan(MIN_SCORE);
  });
});

describe('scoreToMultiplier', () => {
  it('fizzles to FLOOR below MIN_SCORE and for non-numbers', () => {
    for (const score of [-1, 0, MIN_SCORE - 0.01, Number.NaN]) {
      expect(scoreToMultiplier(score)).toBe(FLOOR);
    }
  });

  it('clamps to MAX at and above a near-perfect score', () => {
    expect(scoreToMultiplier(PERFECT_SCORE)).toBeCloseTo(MAX, 12);
    expect(scoreToMultiplier(1)).toBe(MAX);
    expect(scoreToMultiplier(1.2)).toBe(MAX);
  });

  it('is linear from FLOOR at MIN_SCORE to MAX at PERFECT_SCORE', () => {
    expect(FLOOR).toBe(0.5);
    expect(MAX).toBe(1.25);
    expect(scoreToMultiplier(MIN_SCORE)).toBeCloseTo(FLOOR, 12);
    expect(scoreToMultiplier((MIN_SCORE + PERFECT_SCORE) / 2)).toBeCloseTo((FLOOR + MAX) / 2, 12);
    const steps = 10;
    const values = Array.from({ length: steps + 1 }, (_, i) =>
      scoreToMultiplier(MIN_SCORE + ((PERFECT_SCORE - MIN_SCORE) * i) / steps),
    );
    const increment = (MAX - FLOOR) / steps;
    for (let i = 1; i < values.length; i++) {
      expect((values[i] as number) - (values[i - 1] as number)).toBeCloseTo(increment, 12);
    }
  });
});

describe('recognize and scoreAgainst edge cases', () => {
  it('scores an empty or single-dot trace 0, which maps to the FLOOR', () => {
    const traces: Stroke[][] = [[], [[]], [[{ x: 1, y: 1 }]], [[{ x: 1, y: 1 }], [{ x: 1, y: 1 }]]];
    for (const trace of traces) {
      expect(scoreAgainst(trace, 'gear')).toBe(0);
      const result = recognize(trace);
      expect(result.score).toBe(0);
      expect(scoreToMultiplier(result.score)).toBe(FLOOR);
    }
  });

  it('scores each template against itself as 1', () => {
    for (const id of SIGIL_IDS) {
      expect(scoreAgainst(SIGIL_TEMPLATES[id].strokes, id)).toBeCloseTo(1, 9);
    }
  });

  it('restricts recognition to the given candidates, best first', () => {
    const result = recognize(referenceTrace('bolt', 1), ['ward', 'bolt']);
    expect(result.id).toBe('bolt');
    expect(result.scores.map((s) => s.id)).toEqual(['bolt', 'ward']);
    expect(result.score).toBe(result.scores[0]?.score);
  });

  it('reports every sigil by default', () => {
    const result = recognize(referenceTrace('spiral', 0));
    expect(new Set(result.scores.map((s) => s.id))).toEqual(new Set(SIGIL_IDS));
  });

  it('rejects an empty candidate list', () => {
    expect(() => recognize(referenceTrace('gear', 0), [])).toThrow();
  });
});

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SIGIL_DIR = join(ROOT, 'src', 'sigil');

const SPECIFIER_PATTERNS = [
  /\b(?:import|export)\s[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]/g,
  /\bimport\s*['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];

/** Every module specifier in `source`: static imports, re-exports, side-effect and dynamic imports. */
function importSpecifiers(source: string): string[] {
  return SPECIFIER_PATTERNS.flatMap((pattern) =>
    [...source.matchAll(pattern)].map((match) => match[1] as string),
  );
}

/** Why `specifier` imported from `file` leaves src/sigil, or `null` when it stays inside. */
function boundaryViolation(file: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return `bare import '${specifier}'`;
  const target = resolve(dirname(file), specifier);
  return relative(SIGIL_DIR, target).startsWith('..') ? `outside import '${specifier}'` : null;
}

function sigilFiles(): string[] {
  return readdirSync(SIGIL_DIR, { recursive: true, encoding: 'utf8' })
    .filter((name) => name.endsWith('.ts'))
    .map((name) => join(SIGIL_DIR, name));
}

describe('sigil import boundary', () => {
  it('scans a non-empty src/sigil', () => {
    expect(sigilFiles().length).toBeGreaterThanOrEqual(4);
  });

  it('src/sigil imports nothing outside src/sigil', () => {
    const violations = sigilFiles().flatMap((file) =>
      importSpecifiers(readFileSync(file, 'utf8')).flatMap((specifier) => {
        const problem = boundaryViolation(file, specifier);
        return problem ? [`${relative(ROOT, file)}: ${problem}`] : [];
      }),
    );
    expect(violations).toEqual([]);
  });

  it('the scanner sees the real imports of index.ts', () => {
    const specifiers = importSpecifiers(readFileSync(join(SIGIL_DIR, 'index.ts'), 'utf8'));
    expect(new Set(specifiers)).toEqual(new Set(['./pdollar.ts', './templates.ts', './types.ts']));
  });

  it('the scanner flags three.js, packages and paths outside src/sigil', () => {
    const file = join(SIGIL_DIR, 'index.ts');
    const verdicts = Object.fromEntries(
      ['three', 'node:fs', '../core/rng.ts', '../rules/types.ts', './types.ts'].map((s) => [
        s,
        boundaryViolation(file, s) === null,
      ]),
    );
    expect(verdicts).toEqual({
      three: false,
      'node:fs': false,
      '../core/rng.ts': false,
      '../rules/types.ts': false,
      './types.ts': true,
    });
  });
});
