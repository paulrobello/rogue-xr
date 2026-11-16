import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { CARDS } from '../src/content/cards.ts';
import { CardFan, type CardFanIntent, countDraws } from '../src/hand/card-fan.ts';
import {
  DEFAULT_FAN,
  fanGeometry,
  fanLayout,
  hitTestFan,
  MAX_HAND,
  type Vec3,
} from '../src/hand/fan-layout.ts';

const counts = Array.from({ length: MAX_HAND }, (_, i) => i + 1);
const hand = (n: number) => Array.from({ length: n }, (_, i) => CARDS[i % CARDS.length]!);
const dist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

describe('fanLayout', () => {
  it.each(counts)('is symmetric about the fan centre for %i cards', (n) => {
    const slots = fanLayout(n);
    // The depth stacking step is along the card normal, so it skews y; compare y without it.
    const flat = fanLayout(n, { zStep: 0 });
    expect(slots).toHaveLength(n);
    for (let i = 0; i < n; i++) {
      const a = slots[i]!;
      const b = slots[n - 1 - i]!;
      expect(a.position[0] + b.position[0]).toBeCloseTo(2 * DEFAULT_FAN.origin[0], 9);
      expect(flat[i]!.position[1]).toBeCloseTo(flat[n - 1 - i]!.position[1], 9);
      expect(a.rotation.roll + b.rotation.roll).toBeCloseTo(0, 9);
      expect(a.rotation.pitch).toBe(b.rotation.pitch);
    }
  });

  it.each(counts.filter((n) => n > 1))(
    'spaces %i cards with slight overlap and a monotonic arc',
    (n) => {
      const slots = fanLayout(n);
      const width = DEFAULT_FAN.cardWidth * slots[0]!.scale;
      for (let i = 1; i < n; i++) {
        const prev = slots[i - 1]!;
        const cur = slots[i]!;
        const gap = dist(prev.position, cur.position);
        // Visible: at least 30% of each card shows. Overlapping: neighbours are closer than one card width.
        expect(gap).toBeGreaterThanOrEqual(0.3 * width);
        expect(gap).toBeLessThan(width);
        expect(cur.position[0]).toBeGreaterThan(prev.position[0]);
        // Rolls fall left to right; the arc is highest in the middle and drops toward both ends.
        expect(cur.rotation.roll).toBeLessThan(prev.rotation.roll);
      }
      const mid = Math.floor((n - 1) / 2);
      for (let i = 1; i <= mid; i++) {
        expect(slots[i]!.position[1]).toBeGreaterThanOrEqual(slots[i - 1]!.position[1] - 1e-12);
        expect(slots[n - 1 - i]!.position[1]).toBeGreaterThanOrEqual(
          slots[n - i]!.position[1] - 1e-12,
        );
      }
    },
  );

  it('widens the arc and tightens spacing as the hand grows', () => {
    let prev = fanGeometry(2);
    for (const n of counts.slice(2)) {
      const g = fanGeometry(n);
      expect(g.radius).toBeGreaterThanOrEqual(prev.radius);
      expect(g.spacing).toBeLessThanOrEqual(prev.spacing + 1e-12);
      expect(g.scale).toBeLessThanOrEqual(prev.scale);
      prev = g;
    }
    const total = (n: number) => {
      const slots = fanLayout(n);
      return dist(slots[0]!.position, slots[n - 1]!.position);
    };
    expect(total(10)).toBeGreaterThan(total(2));
    expect(total(10)).toBeLessThan(0.4);
  });

  it('tilts every card toward the face and is deterministic', () => {
    for (const slot of fanLayout(7)) expect(slot.rotation.pitch).toBeLessThan(0);
    expect(fanLayout(7)).toEqual(fanLayout(7));
  });

  it('rejects hand sizes outside 0..10', () => {
    expect(fanLayout(0)).toEqual([]);
    expect(() => fanLayout(MAX_HAND + 1)).toThrow(RangeError);
    expect(() => fanLayout(-1)).toThrow(RangeError);
    expect(() => fanLayout(2.5)).toThrow(RangeError);
  });
});

describe('hitTestFan', () => {
  const { cardWidth, cardHeight } = DEFAULT_FAN;
  it.each(counts)('picks each card of a %i card hand from a ray at its centre', (n) => {
    const slots = fanLayout(n);
    slots.forEach((slot, i) => {
      const origin: Vec3 = [slot.position[0], slot.position[1] + 0.05, slot.position[2] + 0.3];
      const to: Vec3 = [
        slot.position[0] - origin[0],
        slot.position[1] - origin[1],
        slot.position[2] - origin[2],
      ];
      const len = Math.hypot(...to);
      const dir: Vec3 = [to[0] / len, to[1] / len, to[2] / len];
      expect(hitTestFan(slots, cardWidth, cardHeight, origin, dir)?.index).toBe(i);
    });
  });

  it('returns null for a miss and skips cards marked unhittable', () => {
    const slots = fanLayout(3);
    const slot = slots[1]!;
    const origin: Vec3 = [slot.position[0], slot.position[1], slot.position[2] + 0.3];
    expect(hitTestFan(slots, cardWidth, cardHeight, origin, [0, 0, -1])?.index).toBe(1);
    expect(
      hitTestFan([slots[0]!, null, slots[2]!], cardWidth, cardHeight, origin, [0, 0, -1]),
    ).toBe(null);
    expect(hitTestFan(slots, cardWidth, cardHeight, [0, 5, 0.3], [0, 0, -1])).toBeNull();
  });
});

function makeFan(n: number) {
  const scene = new THREE.Scene();
  const offGrip = new THREE.Group();
  offGrip.position.set(-0.3, 1.0, -0.2);
  offGrip.rotation.set(-0.4, 0.3, 0.1);
  const mainGrip = new THREE.Group();
  mainGrip.position.set(0.25, 1.1, -0.3);
  scene.add(offGrip, mainGrip);
  const fan = new CardFan({ syncLabels: false, mainGrip });
  fan.attach(offGrip);
  fan.setHand(
    hand(n),
    hand(n).map((_, i) => 100 + i),
  );
  scene.updateMatrixWorld(true);
  return { scene, offGrip, mainGrip, fan };
}

function instancePosition(fan: CardFan, index: number): THREE.Vector3 {
  const body = fan.root.getObjectByName('card-fan-bodies') as THREE.InstancedMesh;
  const m = new THREE.Matrix4();
  body.getMatrixAt(index, m);
  return new THREE.Vector3().setFromMatrixPosition(m);
}

describe('CardFan draw cost', () => {
  it.each(counts)('draws a %i card hand in at most 3 draw calls', (n) => {
    const { scene, fan } = makeFan(n);
    expect(fan.drawCalls).toBe(3);
    expect(countDraws(scene)).toBe(3);
    expect(countDraws(scene)).toBeLessThanOrEqual(3);
  });

  it('stays at 3 draws while hovering, holding and returning, and counts hidden fans as 0', () => {
    const { scene, fan, mainGrip } = makeFan(10);
    fan.hover(4);
    fan.update(0.2);
    expect(countDraws(scene)).toBe(3);
    fan.grab(4, mainGrip);
    fan.update(0.016);
    expect(countDraws(scene)).toBe(3);
    fan.release();
    fan.returnToFan(4);
    fan.update(0.05);
    expect(countDraws(scene)).toBe(3);
    fan.setVisible(false);
    expect(countDraws(scene)).toBe(0);
  });

  it('batches labels: three text members per card, one batched object', () => {
    const { fan } = makeFan(10);
    const batches = fan.root.children.filter((c) => c.name === 'card-fan-labels');
    expect(batches).toHaveLength(1);
    expect(fan.root.children).toHaveLength(3);
    const members = (batches[0] as unknown as { _members: Map<unknown, unknown> })._members;
    expect(members.size).toBe(30);
  });

  it('packs name and rules ink dark: the batch writes member colours as linear bytes', () => {
    const { fan } = makeFan(3);
    const batch = fan.root.children.find((c) => c.name === 'card-fan-labels') as unknown as {
      _members: Map<{ text: string; color: THREE.Color }, unknown>;
    };
    const ink = new THREE.Color('#2a1a0e');
    const packed = new THREE.Color();
    let inked = 0;
    for (const member of batch._members.keys()) {
      if (member.text === '1' || /^\d$/.test(member.text)) continue;
      packed.set(member.color);
      // BatchedText stores getHex() (sRGB bytes) and its shader reads them back as linear, so the
      // bytes must equal the ink's linear value, not its sRGB value.
      expect(packed.getHex() >> 16).toBeCloseTo(Math.round(ink.r * 255), -1);
      expect(packed.getHex() >> 16).toBeLessThan(10);
      inked++;
    }
    expect(inked).toBe(6);
  });

  it('rejects more than 10 cards', () => {
    const { fan } = makeFan(3);
    expect(() => fan.setHand(hand(11))).toThrow(RangeError);
  });
});

describe('CardFan hover', () => {
  it('picks the card a world pointer ray crosses and lifts it', () => {
    const { scene, fan } = makeFan(6);
    const intents: CardFanIntent[] = [];
    fan.on((i) => intents.push(i));
    fan.update(0.016);
    const slot = fan.layout[3]!;
    const centre = fan.root.localToWorld(new THREE.Vector3(...slot.position));
    const normal = new THREE.Vector3(0, 0, 1).transformDirection(fan.root.matrixWorld);
    // Slightly off the main grip's axis: any origin in front of the card works.
    const origin = centre
      .clone()
      .addScaledVector(normal, 0.3)
      .add(new THREE.Vector3(0.05, 0, 0));
    const ray = new THREE.Ray(origin, centre.clone().sub(origin).normalize());
    expect(fan.pointerHover(ray)).toBe(3);
    expect(fan.hovered).toBe(3);
    expect(intents).toEqual([{ type: 'hover', index: 3, uid: 103, card: hand(6)[3] }]);

    const rest = instancePosition(fan, 3).clone();
    fan.update(0.2);
    scene.updateMatrixWorld(true);
    expect(instancePosition(fan, 3).distanceTo(rest)).toBeGreaterThan(0.01);

    const miss = new THREE.Ray(new THREE.Vector3(0, 5, 0), new THREE.Vector3(0, 1, 0));
    expect(fan.pointerHover(miss)).toBeNull();
    expect(intents.at(-1)).toMatchObject({ type: 'hover', index: null, uid: null });
    fan.update(0.2);
    expect(instancePosition(fan, 3).distanceTo(rest)).toBeLessThan(1e-6);
  });

  it('does not repeat an intent when the hovered card is unchanged', () => {
    const { fan } = makeFan(4);
    const intents: CardFanIntent[] = [];
    fan.on((i) => intents.push(i));
    fan.hover(2);
    fan.hover(2);
    fan.hover(99);
    expect(intents.map((i) => (i.type === 'hover' ? i.index : -1))).toEqual([2, null]);
  });
});

describe('CardFan grab lifecycle', () => {
  it('follows the main grip, releases, then springs back to its slot', () => {
    const { scene, fan, mainGrip } = makeFan(5);
    const intents: CardFanIntent[] = [];
    fan.on((i) => intents.push(i));
    const slotWorld = (i: number) =>
      fan.root.localToWorld(new THREE.Vector3(...fan.layout[i]!.position));

    fan.hover(2);
    const held = fan.grab(2);
    expect(held).toEqual({ index: 2, uid: 102, card: hand(5)[2] });
    expect(fan.hovered).toBeNull();
    expect(fan.grab(3)).toBeNull();
    expect(fan.grabbed?.index).toBe(2);

    fan.update(0.016);
    const worldPos = (i: number) => fan.root.localToWorld(instancePosition(fan, i));
    expect(worldPos(2).distanceTo(mainGrip.position)).toBeLessThan(0.12);

    mainGrip.position.set(0.5, 1.3, -0.5);
    scene.updateMatrixWorld(true);
    fan.update(0.016);
    expect(worldPos(2).distanceTo(mainGrip.position)).toBeLessThan(0.12);

    const released = fan.release();
    expect(released?.index).toBe(2);
    expect(released?.position.distanceTo(mainGrip.position)).toBeLessThan(0.12);
    expect(fan.grabbed).toBeNull();
    // Hidden (scale 0) while the combat view owns the card.
    const body = fan.root.getObjectByName('card-fan-bodies') as THREE.InstancedMesh;
    const m = new THREE.Matrix4();
    body.getMatrixAt(2, m);
    fan.update(0.016);
    body.getMatrixAt(2, m);
    expect(m.elements[0]).toBe(0);

    fan.returnToFan(2);
    fan.update(0.05);
    expect(worldPos(2).distanceTo(slotWorld(2))).toBeGreaterThan(0.02);
    fan.update(1);
    expect(worldPos(2).distanceTo(slotWorld(2))).toBeLessThan(1e-6);
    body.getMatrixAt(2, m);
    expect(m.elements[0]).toBeGreaterThan(0);

    expect(intents.map((i) => i.type)).toEqual(['hover', 'hover', 'grab', 'release', 'returned']);
    expect(intents.at(-1)).toMatchObject({ type: 'returned', index: 2, uid: 102 });
  });

  it('refuses to grab without a grip and ignores release with nothing held', () => {
    const fan = new CardFan({ syncLabels: false });
    fan.setHand(hand(3));
    expect(fan.grab(1)).toBeNull();
    expect(fan.release()).toBeNull();
  });

  it('can return a card that is still held', () => {
    const { fan } = makeFan(3);
    fan.grab(0);
    fan.returnToFan(0);
    expect(fan.grabbed).toBeNull();
    fan.update(1);
    expect(fan.grab(0)).not.toBeNull();
  });
});
