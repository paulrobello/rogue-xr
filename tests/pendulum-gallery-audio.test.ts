import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
type JsonObject = Record<string, unknown>;
type Prompt = JsonObject & {
  id: string;
  class: string;
  duration_seconds: number;
  loop: boolean;
  procedural: { kind: string; seed: number; duration_seconds: number };
  text: string;
};
type Report = JsonObject & {
  class: string;
  runtime_probe: { codec: string; sample_rate: number; channels: number };
  measured: { true_peak_dbtp: number };
  decoded_duration_s: number;
};
type Provenance = JsonObject & {
  source_file: string;
  runtime_file: string;
  source_sha256: string;
  runtime_sha256: string;
  generation: { method: string; settings: Prompt['procedural'] };
};
const readJson = (path: string): JsonObject =>
  JSON.parse(readFileSync(resolve(root, path), 'utf8')) as JsonObject;
const digest = (path: string): string =>
  createHash('sha256')
    .update(readFileSync(resolve(root, path)))
    .digest('hex');

describe('Pendulum Gallery opening cue', () => {
  it('keeps the deterministic source contract and runtime measurements aligned', () => {
    const prompts = readJson('assets-source/audio/sfx/prompts.json').cues as Prompt[];
    const prompt = prompts.find((cue) => cue.id === 'pendulum-gallery-open');
    expect(prompt).toMatchObject({
      class: 'positional',
      duration_seconds: 1.55,
      loop: false,
      procedural: { kind: 'pendulum-gallery', seed: 7401, duration_seconds: 1.55 },
    });
    expect(prompt?.text).toMatch(/two aligned pendulums/i);
    expect(prompt?.text).toMatch(/bronze hinge movements/i);

    const source = 'assets-source/audio/sfx/procedural/pendulum-gallery-open.wav';
    const runtime = 'public/assets/audio/sfx/pendulum-gallery-open.ogg';
    const report = (readJson('public/assets/audio/report.json').sfx as JsonObject)[
      'pendulum-gallery-open'
    ] as Report;
    const provenance = (readJson('assets-source/audio/provenance.json').sfx as JsonObject)[
      'pendulum-gallery-open'
    ] as Provenance;
    expect(existsSync(resolve(root, source))).toBe(true);
    expect(existsSync(resolve(root, runtime))).toBe(true);
    expect(report).toMatchObject({
      class: 'positional',
      runtime_probe: { codec: 'opus', sample_rate: 48000, channels: 1 },
      measured: { true_peak_dbtp: expect.any(Number) },
    });
    expect(report.decoded_duration_s).toBeGreaterThanOrEqual(1.4);
    expect(report.decoded_duration_s).toBeLessThanOrEqual(1.65);
    expect(report.measured.true_peak_dbtp).toBeLessThanOrEqual(-1);
    expect(provenance).toMatchObject({
      source_file: source,
      runtime_file: runtime,
      source_sha256: digest(source),
      runtime_sha256: digest(runtime),
      generation: { method: 'deterministic additive synthesis', settings: prompt?.procedural },
    });
  });
});
