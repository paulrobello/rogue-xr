import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  BURN_SECONDS,
  BURN_SHRINK,
  BURN_START,
  BurnPool,
  burnFrame,
  FLARE_FADE,
  FLARE_PEAK,
  newBurnFrame,
} from '../src/cards/card-burn.ts';
import { CombatController } from '../src/combat-view/controller.ts';
import { CARDS, getCard, type SliceCard } from '../src/content/cards.ts';
import { BURN_SLOTS, CardFan, type CardFanIntent, countDraws } from '../src/hand/card-fan.ts';
import { MAX_HAND } from '../src/hand/fan-layout.ts';
import { FlingController, type FlingTargetSite } from '../src/hand/fling.ts';
import type { Vec3 } from '../src/hand/velocity.ts';

describe('burnFrame', () => {
  it('starts whole and still, flares, then burns out shrunk', () => {
    const f = newBurnFrame();
    expect(burnFrame(0, f)).toEqual({ u: 0, burn: 0, flare: 0, travel: 0, scale: 1 });
    expect(burnFrame(FLARE_PEAK, f).flare).toBeCloseTo(1, 9);
    expect(burnFrame(FLARE_FADE, f).flare).toBeCloseTo(0, 9);
    expect(burnFrame(BURN_START, f).burn).toBe(0);
    const end = burnFrame(1, f);
    expect(end.burn).toBe(1);
    expect(end.travel).toBe(1);
    expect(end.flare).toBe(0);
    expect(end.scale).toBeCloseTo(1 - BURN_SHRINK, 9);
    // Out-of-range progress clamps.
    expect(burnFrame(2, f).burn).toBe(1);
    expect(burnFrame(-1, f).burn).toBe(0);
  });

  it('moves the burn front and the drift forward monotonically', () => {
    const f = newBurnFrame();
    let burn = -1;
    let travel = -1;
    let scale = 2;
    for (let i = 0; i <= 60; i++) {
      burnFrame(i / 60, f);
      expect(f.burn).toBeGreaterThanOrEqual(burn);
      expect(f.travel).toBeGreaterThanOrEqual(travel);
      expect(f.scale).toBeLessThanOrEqual(scale);
      burn = f.burn;
      travel = f.travel;
      scale = f.scale;
    }
  });

  it('writes into the given frame without allocating a new one', () => {
    const f = newBurnFrame();
    expect(burnFrame(0.5, f)).toBe(f);
  });
});

describe('BurnPool', () => {
  it('runs one burn from start to end and frees its slot', () => {
    const pool = new BurnPool(2, 0.6);
    expect(pool.active).toBe(0);
    const slot = pool.start();
    expect(slot).toBe(0);
    expect(pool.active).toBe(1);
    expect(pool.isLive(slot)).toBe(true);
    expect(pool.progress(slot)).toBe(0);
    pool.update(0.3);
    expect(pool.progress(slot)).toBeCloseTo(0.5, 9);
    pool.update(0.29);
    expect(pool.isLive(slot)).toBe(true);
    pool.update(0.02);
    expect(pool.isLive(slot)).toBe(false);
    expect(pool.active).toBe(0);
    expect(pool.progress(slot)).toBe(1);
  });

  it('defaults to BURN_SECONDS, inside the 0.4 to 0.7 s brief', () => {
    expect(new BurnPool(1).seconds).toBe(BURN_SECONDS);
    expect(BURN_SECONDS).toBeGreaterThanOrEqual(0.4);
    expect(BURN_SECONDS).toBeLessThanOrEqual(0.7);
  });

  it('reuses the oldest slot when every slot burns, and seeds each burn differently', () => {
    const pool = new BurnPool(2, 1);
    const a = pool.start();
    pool.update(0.2);
    const b = pool.start();
    expect(b).not.toBe(a);
    const seedB = pool.seed(b);
    expect(pool.seed(a)).not.toBe(seedB);
    pool.update(0.2);
    const c = pool.start();
    expect(c).toBe(a);
    expect(pool.active).toBe(2);
    expect(pool.progress(c)).toBe(0);
    expect(pool.progress(b)).toBeCloseTo(0.2, 9);
    expect(pool.seed(c)).not.toBe(seedB);
  });

  it('ignores negative steps, clears, and rejects bad sizes', () => {
    const pool = new BurnPool(1, 0.5);
    pool.start();
    pool.update(-1);
    expect(pool.progress(0)).toBe(0);
    pool.clear();
    expect(pool.active).toBe(0);
    expect(pool.isLive(0)).toBe(false);
    expect(() => new BurnPool(0)).toThrow(RangeError);
    expect(() => new BurnPool(1, 0)).toThrow(RangeError);
  });
});

const hand = (n: number) =>
  Array.from({ length: n }, (_, i) => CARDS[i % CARDS.length] as SliceCard);

function makeFan(n: number) {
  const scene = new THREE.Scene();
  const offGrip = new THREE.Object3D();
  offGrip.position.set(-0.2, 1.0, -0.35);
  const mainGrip = new THREE.Object3D();
  mainGrip.position.set(0.25, 1.1, -0.3);
  scene.add(offGrip, mainGrip);
  const fan = new CardFan({ syncLabels: false, mainGrip });
  fan.attach(offGrip);
  fan.setHand(
    hand(n),
    hand(n).map((_, i) => 100 + i),
  );
  scene.updateMatrixWorld(true);
  const body = fan.root.getObjectByName('card-fan-bodies') as THREE.InstancedMesh;
  const burnAttr = () => body.geometry.getAttribute('aBurn') as THREE.InstancedBufferAttribute;
  const worldAt = (index: number) => {
    const m = new THREE.Matrix4();
    body.getMatrixAt(index, m);
    m.premultiply(fan.root.matrixWorld);
    const p = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    m.decompose(p, q, s);
    return { position: p, scale: s };
  };
  return { scene, offGrip, mainGrip, fan, body, burnAttr, worldAt };
}

const allBurnZero = (attr: THREE.InstancedBufferAttribute): boolean => {
  for (let i = 0; i < attr.count; i++) {
    if (attr.getX(i) || attr.getY(i) || attr.getZ(i) || attr.getW(i)) return false;
  }
  return true;
};

describe('CardFan played-card burn', () => {
  it('reserves burn slots after the hand slots of the one card mesh', () => {
    const { body, burnAttr } = makeFan(5);
    expect(burnAttr().count).toBe(MAX_HAND + BURN_SLOTS);
    expect(body.instanceMatrix.count).toBe(MAX_HAND + BURN_SLOTS);
    expect(body.count).toBe(5);
    expect(allBurnZero(burnAttr())).toBe(true);
  });

  it('burns a played card in world space toward its target, then frees the slot', () => {
    const { scene, fan, body, burnAttr, worldAt, offGrip } = makeFan(5);
    fan.grab(2);
    fan.update(0.016);
    const released = fan.release();
    if (!released) throw new Error('nothing released');
    expect(fan.playOut(2, new THREE.Vector3(0.25, 1.4, -3.5))).toBe(true);
    expect(fan.burningCount).toBe(1);
    expect(body.count).toBe(MAX_HAND + BURN_SLOTS);
    // Still the fan's 3 draws: the burn is an instance of the card mesh.
    expect(countDraws(scene)).toBe(3);

    const burnIndex = MAX_HAND;
    const start = worldAt(burnIndex);
    expect(start.position.distanceTo(released.position)).toBeLessThan(1e-6);
    // Unused hand slots between the hand and the burn draw nothing.
    const raw = new THREE.Matrix4();
    for (let i = 5; i < MAX_HAND; i++) {
      body.getMatrixAt(i, raw);
      expect(raw.elements.slice(0, 11).every((v) => v === 0)).toBe(true);
    }
    expect(burnAttr().getW(burnIndex)).toBe(1);

    fan.update(BURN_SECONDS * 0.06);
    expect(burnAttr().getZ(burnIndex)).toBeGreaterThan(0.9); // flare at its peak
    // Moving the off hand does not drag the burning card with it.
    offGrip.position.x += 0.3;
    scene.updateMatrixWorld(true);
    fan.update(BURN_SECONDS * 0.44);
    const mid = worldAt(burnIndex);
    const target = new THREE.Vector3(0.25, 1.4, -3.5);
    expect(mid.position.distanceTo(target)).toBeLessThan(start.position.distanceTo(target));
    expect(mid.position.distanceTo(start.position)).toBeLessThanOrEqual(0.2 + 1e-9);
    expect(mid.position.x).toBeCloseTo(start.position.x, 1);
    expect(mid.scale.x).toBeLessThan(start.scale.x);
    expect(burnAttr().getX(burnIndex)).toBeGreaterThan(0.2);
    expect(burnAttr().getX(burnIndex)).toBeLessThan(1);

    fan.update(BURN_SECONDS);
    expect(fan.burningCount).toBe(0);
    expect(body.count).toBe(5);
    expect(allBurnZero(burnAttr())).toBe(true);
  });

  it('sinks a card played without a target', () => {
    const { fan, worldAt } = makeFan(3);
    fan.grab(0);
    fan.update(0.016);
    const released = fan.release();
    if (!released) throw new Error('nothing released');
    fan.playOut(0);
    fan.update(BURN_SECONDS * 0.9);
    const p = worldAt(MAX_HAND).position;
    expect(p.y).toBeLessThan(released.position.y - 0.03);
    expect(Math.hypot(p.x - released.position.x, p.z - released.position.z)).toBeLessThan(1e-6);
  });

  it('keeps burning when the hand is re-dealt without the card', () => {
    const { fan, body, burnAttr } = makeFan(5);
    fan.grab(4);
    fan.update(0.016);
    fan.release();
    fan.playOut(4);
    fan.setHand(hand(4));
    expect(fan.burningCount).toBe(1);
    expect(body.count).toBe(MAX_HAND + BURN_SLOTS);
    expect(burnAttr().getW(MAX_HAND)).toBe(1);
    fan.setHand(hand(2));
    fan.update(BURN_SECONDS + 0.01);
    expect(body.count).toBe(2);
  });

  it('leaves cancelled and sprung-back cards alone', () => {
    const { fan, burnAttr, body } = makeFan(5);
    const intents: CardFanIntent[] = [];
    fan.on((i) => intents.push(i));
    // Only a released card can burn.
    expect(fan.playOut(1)).toBe(false);
    fan.grab(1);
    expect(fan.playOut(1)).toBe(false);
    fan.update(0.016);
    fan.release();
    fan.returnToFan(1);
    expect(fan.playOut(1)).toBe(false);
    fan.update(1);
    expect(fan.burningCount).toBe(0);
    expect(body.count).toBe(5);
    expect(allBurnZero(burnAttr())).toBe(true);
    expect(intents.at(-1)).toMatchObject({ type: 'returned', index: 1 });
  });

  it('caps simultaneous burns at BURN_SLOTS and clears them on dispose', () => {
    const { fan } = makeFan(MAX_HAND);
    for (let i = 0; i < BURN_SLOTS + 1; i++) {
      fan.grab(i);
      fan.update(0.016);
      fan.release();
      fan.playOut(i);
    }
    expect(fan.burningCount).toBe(BURN_SLOTS);
    fan.dispose();
    expect(fan.burningCount).toBe(0);
  });
});

describe('FlingController starts the burn', () => {
  function rig() {
    const combat = new CombatController({
      seed: 'FLING001',
      enemy: 'cog-sentry',
      deck: ['strike', 'defend', 'furnace-brand', 'warding-glyph', 'cogstorm'],
    });
    const cards = combat.state.piles.hand;
    const fan = new CardFan({ syncLabels: false });
    fan.setHand(
      cards.map((c) => getCard(c.def.id)),
      cards.map((c) => c.uid),
    );
    const grip = new THREE.Object3D();
    grip.position.set(0, 1.2, -0.3);
    fan.setMainGrip(grip);
    const enemyId = (combat.state.enemies[0] as { id: string }).id;
    const sites: FlingTargetSite[] = [];
    const pointer = { current: null as { origin: Vec3; direction: Vec3 } | null };
    const fling = new FlingController({
      fan,
      combat,
      mainGrip: grip,
      targets: () => sites,
      table: () => null,
      pointRay: () => pointer.current,
    });
    const strike = cards.findIndex((c) => c.def.id === 'strike');
    return { fan, fling, sites, pointer, enemyId, strike };
  }

  it('burns a card played at an enemy', () => {
    const r = rig();
    expect(r.fling.grab(r.strike)).not.toBeNull();
    for (let i = 0; i < 5; i++) {
      r.fling.update(0.011);
      r.fan.update(0.011);
    }
    r.sites.push({ id: r.enemyId, position: [0, 1.2, -3] });
    r.pointer.current = { origin: [0, 1.2, 0], direction: [0, 0, -1] };
    expect(r.fling.release()?.outcome).toBe('played');
    expect(r.fan.burningCount).toBe(1);
  });

  it('does not burn a card that springs back', () => {
    const r = rig();
    r.fling.grab(r.strike);
    r.fling.update(0.011);
    r.fan.update(0.011);
    expect(r.fling.release()?.outcome).toBe('sprung-back');
    expect(r.fan.burningCount).toBe(0);
  });
});
