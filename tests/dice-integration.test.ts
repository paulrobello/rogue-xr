// @vitest-environment node
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Stream } from '../src/core/rng.ts';
import {
  DICE_ASSET_IDS,
  type DiceAsset,
  type DiceManifest,
  parseDice,
  parseDiceManifest,
} from '../src/dice/dice-asset.ts';
import type { DieKind } from '../src/dice/faces.ts';
import { DicePresenter } from '../src/dice/presenter.ts';
import type { UiAtlasManifest } from '../src/ui/icon-atlas.ts';

const KINDS: readonly DieKind[] = ['d6', 'd8'];
const DT = 1 / 60;
const root = new URL('../public/assets/', import.meta.url);
const atlas = JSON.parse(
  readFileSync(new URL('ui/ui-atlas.json', root), 'utf8'),
) as UiAtlasManifest;

const files = Object.fromEntries(
  KINDS.map((kind) => {
    const id = DICE_ASSET_IDS[kind];
    const base = new URL(`dice/${id}/`, root);
    const manifest = parseDiceManifest(
      JSON.parse(readFileSync(new URL(`${id}.manifest.json`, base), 'utf8')),
    );
    const bytes = readFileSync(new URL(manifest.glb, base));
    const glb = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    return [kind, { manifest, glb }];
  }),
) as Record<DieKind, { manifest: DiceManifest; glb: ArrayBuffer }>;

const loadAsset = () =>
  parseDice(
    { d6: files.d6.glb.slice(0), d8: files.d8.glb.slice(0) },
    { d6: files.d6.manifest, d8: files.d8.manifest },
  );

const TRAY = { halfX: 0.2, halfZ: 0.11 };
const stream = () => Stream.fromKey('TEST0001:dice-integration');
const pages = (): { manifest: UiAtlasManifest; d6: THREE.Texture; d8: THREE.Texture } => ({
  manifest: atlas,
  d6: new THREE.Texture(),
  d8: new THREE.Texture(),
});

function rollToRest(presenter: DicePresenter, kind: DieKind, face: number) {
  let settled: number | null = null;
  const off = presenter.onSettled((roll) => {
    settled = roll.face;
  });
  const id = presenter.throw(kind, face, face + 1);
  for (let i = 0; i < 900 && settled === null; i++) presenter.update(DT);
  off();
  return { id, settled };
}

describe('dice presenter with the authored models', () => {
  let asset: DiceAsset;
  beforeAll(async () => {
    asset = await loadAsset();
  });
  afterAll(() => asset.dispose());

  it('spawns the model for each kind, sharing its geometry and materials', async () => {
    const presenter = await DicePresenter.create(stream(), { ...TRAY, models: asset });
    for (const kind of KINDS) {
      const mesh = presenter.mesh(presenter.throw(kind, 0, 1));
      const model = asset.spawn(kind);
      expect(mesh?.geometry).toBe(model.geometry);
      expect(mesh?.material).toEqual(model.material);
      expect(Array.isArray(mesh?.material)).toBe(true);
    }
    presenter.dispose();
  });

  it('keeps the greybox dice when models is null or absent', async () => {
    for (const options of [{ ...TRAY, models: null }, { ...TRAY }]) {
      const presenter = await DicePresenter.create(stream(), options);
      for (const kind of KINDS) {
        const mesh = presenter.mesh(presenter.throw(kind, 0, 1));
        expect(mesh).toBeDefined();
        expect(Array.isArray(mesh?.material)).toBe(false);
        expect(mesh?.geometry).not.toBe(asset.spawn(kind).geometry);
      }
      presenter.dispose();
    }
  });

  it('binds the atlas pages to the face materials when the faces arrive', async () => {
    const presenter = await DicePresenter.create(stream(), { ...TRAY, models: asset });
    const page = pages();
    presenter.applyFaces(page);
    for (const kind of KINDS) {
      const face = (asset.spawn(kind).material as THREE.MeshStandardMaterial[]).find((m) =>
        m.name.endsWith('-face'),
      );
      expect(face?.map).toBe(page[kind]);
      expect(face?.emissiveMap).toBe(page[kind]);
    }
    presenter.dispose();
    asset.bindFaceMaps({ d6: null, d8: null });
  });

  it('lands every throw on the RNG face with the model mesh', async () => {
    const presenter = await DicePresenter.create(stream(), { ...TRAY, models: asset });
    for (const [kind, face] of [
      ['d6', 0],
      ['d6', 5],
      ['d8', 7],
      ['d8', 3],
    ] as const) {
      const { id, settled } = rollToRest(presenter, kind, face);
      expect(settled).toBe(face);
      expect(presenter.upFace(id)).toBe(face);
      expect(presenter.mesh(id)?.geometry).toBe(asset.spawn(kind).geometry);
    }
    presenter.dispose();
  });

  it('leaves the injected asset usable after the presenter is disposed', async () => {
    const presenter = await DicePresenter.create(stream(), { ...TRAY, models: asset });
    presenter.throw('d6', 1, 2);
    presenter.dispose();
    expect(() => asset.spawn('d6')).not.toThrow();
  });

  it('lights the shared materials from an environment map and casts no glass shadow', () => {
    const env = new THREE.Texture();
    asset.setEnvironment(env, 0.5);
    for (const kind of KINDS) {
      for (const m of asset.spawn(kind).material as THREE.MeshStandardMaterial[]) {
        expect(m.envMap).toBe(env);
        expect(m.envMapIntensity).toBe(0.5);
      }
    }
    expect(asset.spawn('d6').castShadow).toBe(true);
    expect(asset.spawn('d8').castShadow).toBe(false);
    asset.setEnvironment(null, 0);
  });
});
