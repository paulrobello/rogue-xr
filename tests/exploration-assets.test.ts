// @vitest-environment node
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const digest = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const json = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const source = 'assets-source/props';
describe('exploration kit receipts', () => {
  it('verifies the service compartment, both paintings and the runtime pump gears against their sources', () => {
    for (const receipts of [
      json(`${source}/pressure-compartment/provenance.json`).inputs,
      json(`${source}/paintings/provenance.json`).sha256,
    ]) {
      for (const [path, hash] of Object.entries(receipts)) expect(digest(path), path).toBe(hash);
    }
    const kit = json(`${source}/puzzle-instruments/manifest.json`);
    expect(kit.pieces).toHaveLength(34);
    for (const [name, hash] of Object.entries(kit.hashes)) {
      const base = name.endsWith('.py')
        ? 'scripts/assets'
        : name.endsWith('.glb')
          ? 'public/assets/props/puzzle-instruments'
          : `${source}/puzzle-instruments`;
      expect(digest(`${base}/${name}`), name).toBe(hash);
    }
    const gears = kit.pump_drive_derivative;
    expect(digest('public/assets/props/pressure-works/pump-drive.glb')).toBe(gears.glb_sha256);
    expect(digest('scripts/assets/export-pump-drive.py')).toBe(gears.helper_sha256);
  });
  it('binds the reusable furniture kit to its generator, Blender source and runtime GLB', () => {
    const prov = json(`${source}/interior-furnishings/provenance.json`);
    expect(digest(prov.generator)).toBe(prov.generator_sha256);
    expect(digest(prov.output)).toBe(prov.glb_sha256);
    expect(digest(`${source}/interior-furnishings/${prov.source}`)).toBe(prov.blend_sha256);
    expect(
      Object.keys(json(`${source}/interior-furnishings/interior-furnishings.report.json`).roots),
    ).toHaveLength(11);
  });
});
