import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { parseCardAtlas } from '../src/cards/card-atlas.ts';
import type { CardFaceArt } from '../src/cards/card-face-material.ts';
import { STARTER_DECK } from '../src/content/cards.ts';
import { REWARD_POOL } from '../src/content/rewards.ts';
import { RunFlow } from '../src/flow/flow.ts';
import { FlowUi, rewardCardTexture } from '../src/flow/panels.ts';
import {
  REWARD_HOVER_GROW,
  REWARD_HOVER_LIFT,
  RewardCardFaces,
  type RewardCardFacesOptions,
} from '../src/flow/reward-cards.ts';
import { HOLO_CARD_ASPECT } from '../src/hand/fan-layout.ts';
import { DEFAULT_SETTINGS } from '../src/persist/db.ts';
import { createWorkshop } from '../src/rules/workshop.ts';

const atlas = parseCardAtlas(
  JSON.parse(
    readFileSync(resolve(process.cwd(), 'public/assets/cards/atlas/card-atlas.json'), 'utf8'),
  ),
);

/** A flow on its reward screen and the board showing it. */
function rewardBoard(rewardCards: RewardCardFacesOptions) {
  const flow = new RunFlow({
    workshop: createWorkshop(),
    starterDeck: STARTER_DECK,
    rewardPool: REWARD_POOL,
  });
  const ui = new FlowUi({
    flow,
    keyArt: { url: '', titleSafe: { x: 0, y: 0, w: 0.3, h: 0.4 } },
    seed: 'BRASS042',
    snapshot: () => null,
    settings: () => ({ ...DEFAULT_SETTINGS }),
    onNewRun: (seed) => flow.newRun(seed),
    onContinue: () => {},
    onSettings: () => {},
    rewardCards,
  });
  const head = new THREE.Object3D();
  flow.newRun('BRASS042');
  flow.fightStarted(1);
  flow.fightEnded({ room: 1, outcome: 'win', tier: 'regular' });
  ui.sync(head);
  const offer = flow.offer;
  if (!offer) throw new Error('no reward on screen');
  const body = ui.root.getObjectByName('reward-card-bodies') as THREE.InstancedMesh;
  const halo = ui.root.getObjectByName('reward-card-halo') as THREE.Mesh;
  return { flow, ui, head, offer, body, halo };
}

/** Position and scale of instance `i`. */
function instance(body: THREE.InstancedMesh, i: number) {
  const m = new THREE.Matrix4();
  body.getMatrixAt(i, m);
  const position = new THREE.Vector3();
  const scale = new THREE.Vector3();
  m.decompose(position, new THREE.Quaternion(), scale);
  return { position, scale };
}

const fakeArt = (): CardFaceArt => ({ atlas, pages: atlas.pages.map(() => new THREE.Texture()) });

describe('reward board card faces (F7)', () => {
  it('draws the offered cards with the hand atlas faces, at the atlas aspect', () => {
    const art = fakeArt();
    const { ui, offer, body } = rewardBoard({ art, syncLabels: false });
    expect(body).toBeInstanceOf(THREE.InstancedMesh);
    expect(body.count).toBe(offer.cards.length);
    const material = body.material as THREE.ShaderMaterial;
    expect(material.uniforms.uHasArt?.value).toBe(1);
    expect(art.pages).toContain(material.uniforms.uFrame?.value);
    // Each instance carries its own card's atlas rects, as the hand writes them.
    const frameUv = body.geometry.getAttribute('aFrameUv');
    expect(frameUv.getX(0)).toBeCloseTo(atlas.frames.attack.uv[0]);
    for (const id of offer.cards) {
      expect(ui.root.getObjectByName(`reward-card-fallback-${id}`)?.visible).toBe(false);
    }
    const { scale } = instance(body, 0);
    expect(scale.y / scale.x).toBeCloseTo(HOLO_CARD_ASPECT, 5);
    // Cost, name and rules text for every card ride in one batched text over the faces.
    const labels = ui.root.getObjectByName('reward-card-labels');
    expect(labels?.visible).toBe(true);
    expect(ui.root.getObjectByName('reward-card-gems')?.visible).toBe(true);
    ui.dispose();
  });

  it('lifts, grows and frames only the hovered card, and drops it on unhover', () => {
    const { ui, offer, body, halo } = rewardBoard({ art: fakeArt(), syncLabels: false });
    const rest = offer.cards.map((_, i) => instance(body, i));
    const target = 1;
    ui.hover(`reward-${offer.cards[target]}`);
    offer.cards.forEach((_, i) => {
      const now = instance(body, i);
      if (i === target) {
        expect(now.position.z - (rest[i]?.position.z ?? 0)).toBeCloseTo(REWARD_HOVER_LIFT);
        expect(now.scale.x / (rest[i]?.scale.x ?? 1)).toBeCloseTo(1 + REWARD_HOVER_GROW);
      } else {
        expect(now.position.z).toBeCloseTo(rest[i]?.position.z ?? Number.NaN);
        expect(now.scale.x).toBeCloseTo(rest[i]?.scale.x ?? Number.NaN);
      }
    });
    expect(halo.visible).toBe(true);
    expect(halo.position.x).toBeCloseTo(instance(body, target).position.x);
    // Moving off the board clears the card's highlight.
    ui.hover(null);
    expect(instance(body, target).position.z).toBeCloseTo(rest[target]?.position.z ?? Number.NaN);
    expect(halo.visible).toBe(false);
    ui.dispose();
  });

  it('picks the activated card into the deck', () => {
    const { flow, ui, offer } = rewardBoard({ art: fakeArt(), syncLabels: false });
    const pick = offer.cards[0] as string;
    const deck = flow.run?.deck.length ?? 0;
    expect(ui.controlIds()).toContain(`reward-${pick}`);
    expect(ui.activate(`reward-${pick}`)).toBe(true);
    expect(flow.phase).toBe('explore');
    expect(flow.run?.deck).toHaveLength(deck + 1);
    expect(flow.run?.deck.at(-1)).toBe(pick);
    ui.dispose();
  });

  it('frees its geometry and materials when the board closes, never the atlas pages', () => {
    const art = fakeArt();
    const { flow, ui, head, offer, body } = rewardBoard({ art, syncLabels: false });
    const disposed: string[] = [];
    body.geometry.addEventListener('dispose', () => disposed.push('geometry'));
    (body.material as THREE.Material).addEventListener('dispose', () => disposed.push('material'));
    const fallback = ui.root.getObjectByName(
      `reward-card-fallback-${offer.cards[0]}`,
    ) as THREE.Mesh;
    fallback.geometry.addEventListener('dispose', () => disposed.push('fallback'));
    for (const page of art.pages) page.addEventListener('dispose', () => disposed.push('page'));
    flow.pickReward('skip');
    ui.sync(head);
    expect(ui.root.getObjectByName('reward-card-bodies')).toBeUndefined();
    expect(disposed).toEqual(expect.arrayContaining(['geometry', 'material', 'fallback']));
    expect(disposed).not.toContain('page');
    ui.dispose();
  });

  it('shows the canvas faces until the atlas loads, hovering them as before', () => {
    const { ui, offer, body } = rewardBoard({ art: null, loadArt: false, syncLabels: false });
    expect((body.material as THREE.ShaderMaterial).uniforms.uHasArt?.value).toBe(0);
    const fallback = ui.root.getObjectByName(
      `reward-card-fallback-${offer.cards[0]}`,
    ) as THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
    expect(fallback.visible).toBe(true);
    expect(fallback.position.z).toBeGreaterThan(instance(body, 0).position.z);
    const before = fallback.material.map;
    const z = fallback.position.z;
    ui.hover(`reward-${offer.cards[0]}`);
    expect(fallback.material.map).not.toBe(before);
    expect(fallback.position.z).toBeCloseTo(z + REWARD_HOVER_LIFT);
    ui.hover(null);
    expect(fallback.position.z).toBeCloseTo(z);
    ui.dispose();
  });

  it('frees its blank placeholder page after the art replaced it, late art included', () => {
    const faces = new RewardCardFaces(
      [{ id: STARTER_DECK[0] as string, x: 0, y: 0, width: 0.3, height: 0.45 }],
      rewardCardTexture,
      { art: null, loadArt: false, syncLabels: false },
    );
    const material = faces.root.getObjectByName('reward-card-bodies') as THREE.InstancedMesh;
    const blank = (material.material as THREE.ShaderMaterial).uniforms.uFrame
      ?.value as THREE.Texture;
    let blankDisposed = false;
    blank.addEventListener('dispose', () => {
      blankDisposed = true;
    });
    const art = fakeArt();
    let pageDisposed = false;
    for (const page of art.pages) page.addEventListener('dispose', () => (pageDisposed = true));
    faces.setArt(art);
    expect(faces.hasArt).toBe(true);
    faces.dispose();
    expect(blankDisposed).toBe(true);
    expect(pageDisposed).toBe(false);
    // Art resolving after the board closed is ignored.
    faces.setArt(fakeArt());
    expect(faces.root.parent).toBeNull();
  });
});
