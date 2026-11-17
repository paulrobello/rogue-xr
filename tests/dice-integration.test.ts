// @vitest-environment node
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Stream } from '../src/core/rng.ts';
import {
  DICE_ASSET_IDS,
  DICE_GLOW_INTENSITY,
  type DiceAsset,
  type DiceManifest,
  faceGlowIntensity,
  parseDice,
  parseDiceManifest,
} from '../src/dice/dice-asset.ts';
import type { DieKind } from '../src/dice/faces.ts';
import { DICE_ENV_INTENSITY, DicePresenter } from '../src/dice/presenter.ts';
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

const faceSlot = (kind: DieKind) => {
  const slot = Object.values(files[kind].manifest.materialSlots).find((s) => s.role === 'face');
  if (!slot) throw new Error(`${kind}: no face slot`);
  return slot;
};

/** The manifest slot's `envMapScale` for a dice material (1 when absent, as setEnvironment applies). */
const envScale = (kind: DieKind, m: THREE.Material) =>
  files[kind].manifest.materialSlots[m.name]?.envMapScale ?? 1;

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

  it('binds the colour pages as maps and the glow pages as emissive maps', async () => {
    const presenter = await DicePresenter.create(stream(), { ...TRAY, models: asset });
    const page = pages();
    const glow = { d6: new THREE.Texture(), d8: new THREE.Texture() };
    presenter.applyFaces({ ...page, d6Glow: glow.d6, d8Glow: glow.d8 });
    for (const kind of KINDS) {
      const face = (asset.spawn(kind).material as THREE.MeshStandardMaterial[]).find((m) =>
        m.name.endsWith('-face'),
      );
      expect(face?.map).toBe(page[kind]);
      expect(face?.emissiveMap).toBe(glow[kind]);
      expect(face?.emissiveIntensity).toBe(faceGlowIntensity(faceSlot(kind)));
    }
    presenter.dispose();
    asset.bindFaceMaps({ d6: null, d8: null });
  });

  it('leaves the faces unlit when the glow pages are absent', async () => {
    const presenter = await DicePresenter.create(stream(), { ...TRAY, models: asset });
    const page = pages();
    presenter.applyFaces(page);
    for (const kind of KINDS) {
      const face = (asset.spawn(kind).material as THREE.MeshStandardMaterial[]).find((m) =>
        m.name.endsWith('-face'),
      );
      expect(face?.map).toBe(page[kind]);
      expect(face?.emissiveMap).toBeNull();
      expect(face?.emissiveIntensity).toBe(0);
    }
    presenter.dispose();
    asset.bindFaceMaps({ d6: null, d8: null });
  });

  it('gives the greybox dice the glow page as emissive map, or none without it', async () => {
    const presenter = await DicePresenter.create(stream(), { ...TRAY });
    const greybox = (kind: DieKind) =>
      presenter.mesh(presenter.throw(kind, 0, 1))?.material as THREE.MeshStandardMaterial;
    const page = pages();
    const glow = { d6: new THREE.Texture(), d8: new THREE.Texture() };
    presenter.applyFaces({ ...page, d6Glow: glow.d6, d8Glow: glow.d8 });
    for (const kind of KINDS) {
      const m = greybox(kind);
      expect(m.map).toBe(page[kind]);
      expect(m.emissiveMap).toBe(glow[kind]);
      expect(m.emissive.getHex()).toBe(0xffffff);
      expect(m.emissiveIntensity).toBe(DICE_GLOW_INTENSITY);
    }
    presenter.applyFaces(page);
    for (const kind of KINDS) {
      const m = greybox(kind);
      expect(m.emissiveMap).not.toBe(page[kind]);
      expect(m.emissiveMap).not.toBeNull();
      expect(m.emissive.getHex()).toBe(0x000000);
    }
    presenter.dispose();
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

  // F11: a die grabbed from the tray starts its throw where the hand let go, from the same seeded
  // draws, so a run replays whatever the hand did.
  it('throws a held waiting die from the hand, landing on the RNG face with the same draws', async () => {
    const plain = Stream.fromKey('TEST0001:dice-throw');
    const handled = Stream.fromKey('TEST0001:dice-throw');
    const a = await DicePresenter.create(plain, { ...TRAY, models: asset });
    const b = await DicePresenter.create(handled, { ...TRAY, models: asset });
    b.showWaiting('d8');
    expect(b.waiting).not.toBeNull();
    b.holdWaiting(new THREE.Vector3(0.5, 0.4, -0.5));
    const first = rollToRest(a, 'd8', 6);
    const held = rollToRest(b, 'd8', 6);
    expect(b.waiting).toBeNull();
    expect(held.settled).toBe(6);
    expect(first.settled).toBe(6);
    expect(handled.next()).toBe(plain.next());
    a.dispose();
    b.dispose();
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
        expect(m.envMapIntensity).toBeCloseTo(0.5 * envScale(kind, m), 12);
      }
    }
    // A transparent face slot (the glass d8) casts no shadow; an opaque one does.
    for (const kind of KINDS)
      expect(asset.spawn(kind).castShadow).toBe(!faceSlot(kind).transparent);
    expect(asset.spawn('d6').castShadow).toBe(true);
    asset.setEnvironment(null, 0);
  });

  it('gives the thrown metal dice the supplied room probe (the tray read dark without one)', async () => {
    const env = new THREE.Texture();
    for (const models of [asset, null]) {
      const presenter = await DicePresenter.create(stream(), {
        ...TRAY,
        models,
        envMap: env,
      });
      let metal = 0;
      for (const kind of KINDS) {
        const mesh = presenter.mesh(presenter.throw(kind, 0, 1));
        const materials = [mesh?.material ?? []].flat() as THREE.MeshStandardMaterial[];
        expect(materials.length).toBeGreaterThan(0);
        for (const m of materials) {
          expect(m.envMap, `${kind} ${m.name}`).toBe(env);
          // The greybox fallback has no manifest slots, so it takes the plain intensity.
          const scale = models ? envScale(kind, m) : 1;
          expect(m.envMapIntensity).toBeCloseTo(DICE_ENV_INTENSITY * scale, 12);
          if (m.metalness >= 0.9) metal++;
        }
      }
      // The authored brass is metalness 1: the case that renders black with no reflection.
      if (models) expect(metal).toBeGreaterThan(0);
      presenter.dispose();
    }
    asset.setEnvironment(null, 0);
  });
});
