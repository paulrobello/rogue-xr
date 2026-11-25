import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getCard } from '../src/content/cards.ts';
import { mountFloorView } from '../src/world/floor-view.ts';
import {
  COFFER_INNER_DEPTH,
  type Coffer,
  type CofferCardFace,
  CofferKit,
  nearestCard,
  pickCoffer,
} from '../src/world/loot.ts';

const BODY_HEIGHT = 0.3;
const CARD_W = 0.09;
const CARD_H = 0.136;

/** A stand-in face: one plane, counting its disposals. */
function fakeFace(): CofferCardFace & { freed: () => number } {
  let freed = 0;
  const object = new THREE.Mesh(new THREE.PlaneGeometry(CARD_W, CARD_H));
  object.name = 'fake-face';
  return {
    object,
    width: CARD_W,
    height: CARD_H,
    dispose: () => {
      freed++;
    },
    freed: () => freed,
  };
}

/** A coffer at the origin facing -z, and a viewer at seated eye height 2.2 m in front of it. */
function standing() {
  const kit = new CofferKit();
  const coffer = kit.build(3, { id: 'desk-drawer', position: [0, 0, 0], yaw: 0 }, 'card', 0);
  const scene = new THREE.Scene();
  scene.add(coffer.object);
  const viewer = new THREE.Object3D();
  viewer.position.set(0, 0.55, -2.2);
  scene.add(viewer);
  scene.updateMatrixWorld(true);
  return { kit, coffer, scene, viewer };
}

const cardOf = (coffer: Coffer) => coffer.object.getObjectByName('coffer-card');
const step = (coffer: Coffer, seconds: number, dt = 1 / 60): void => {
  for (let t = 0; t < seconds; t += dt) coffer.update(dt);
  coffer.object.updateMatrixWorld(true);
};

it('picks the key lock separately and releases it only after the key arrives', () => {
  const kit = new CofferKit();
  const coffer = kit.build(
    3,
    { id: 'desk-drawer', position: [0, 0, 0], yaw: 0 },
    'card',
    0,
    false,
    true,
  );
  const from = new THREE.Vector3(0, 0.68, -2);
  const lock = coffer.keyLockHit;
  if (!lock) throw Error('Missing key-lock target');
  const aim = lock.getWorldPosition(new THREE.Vector3()).sub(from);
  expect(pickCoffer([coffer], from, aim, 4)?.lock).toBe(true);
  expect(
    pickCoffer([coffer], from, new THREE.Vector3(0.25, 0.46, -0.18).sub(from), 4)?.lock,
  ).toBeUndefined();
  const behind = new THREE.Vector3(0, 0.68, 2);
  expect(
    pickCoffer([coffer], behind, lock.getWorldPosition(new THREE.Vector3()).sub(behind), 4)?.lock,
  ).toBeUndefined();
  const model = new THREE.Group();
  const arrive = vi.fn(() => coffer.syncKeyLock(true));
  expect(coffer.flyKey(model, from, arrive)).toBe(true);
  expect(coffer.flyKey(model, from, arrive)).toBe(false);
  coffer.open(true);
  expect(coffer.opened).toBe(false);
  step(coffer, 0.4);
  expect(coffer.object.getObjectByName('coffer-flying-key')).toBeDefined();
  expect(arrive).not.toHaveBeenCalled();
  step(coffer, 0.45);
  expect(arrive).toHaveBeenCalledTimes(1);
  expect(coffer.object.getObjectByName('coffer-flying-key')).toBeUndefined();
  expect(coffer.keyLockHit).toBeNull();
  expect(coffer.opened).toBe(false);
  coffer.open(true);
  expect(coffer.opened).toBe(true);
  kit.dispose();
});

describe('chest card view', () => {
  it('fades its halo to zero at every edge of the glow plane', () => {
    const { kit, coffer, viewer } = standing();
    coffer.open(false);
    coffer.showCard('overwind', fakeFace(), false, viewer);
    const halo = cardOf(coffer)?.getObjectByName('coffer-card-halo');
    if (!(halo instanceof THREE.Mesh)) throw Error('Missing card halo');
    const positions = halo.geometry.getAttribute('position');
    const colors = halo.geometry.getAttribute('color');
    const red = Array.from({ length: positions.count }, (_, i) => colors.getX(i));
    expect(Math.max(...red)).toBeGreaterThan(0.5);
    expect(
      red
        .filter((_, i) => Math.hypot(positions.getX(i), positions.getY(i)) >= 0.5)
        .every((x) => x === 0),
    ).toBe(true);
    kit.dispose();
  });

  it('raises the card out of the coffer after the lid opens, then hovers it facing the viewer', () => {
    const { coffer, viewer } = standing();
    const face = fakeFace();
    coffer.open(true);
    coffer.showCard('overwind', face, true, viewer);
    const card = cardOf(coffer);
    if (!card) throw new Error('no card group');
    expect(card.visible).toBe(false);
    expect(card.position.y).toBeLessThan(BODY_HEIGHT);
    expect(card.getObjectByName('fake-face')).toBe(face.object);

    const heights: number[] = [];
    for (let i = 0; i < 90; i++) {
      step(coffer, 1 / 60, 1 / 60);
      heights.push(card.position.y);
    }
    const start = heights.findIndex((_, i) => i > 0 && (heights[i] ?? 0) > (heights[0] ?? 0));
    expect(start).toBeGreaterThan(0);
    // Rises about 0.56 m in about 0.9 s, eased, starting inside the coffer below the rim.
    expect(heights[0]).toBeLessThan(BODY_HEIGHT);
    // Monotonic while rising (the rise takes 0.9 s, 54 frames); the hover bob follows.
    for (let i = start + 1; i < Math.min(heights.length, start + 50); i++)
      expect(heights[i] ?? 0).toBeGreaterThanOrEqual((heights[i - 1] ?? 0) - 1e-9);
    step(coffer, 2);
    const rise = card.position.y - (heights[0] ?? 0);
    expect(rise).toBeGreaterThan(0.52);
    expect(rise).toBeLessThan(0.6);
    expect(card.scale.x).toBeCloseTo(1, 6);
    expect(card.visible).toBe(true);
    expect(coffer.card).toBe('overwind');
    expect(coffer.cardHit).not.toBeNull();

    // Hovering: bobs a little and turns its face (+z) toward the viewer.
    const a = card.position.y;
    step(coffer, 0.6);
    expect(Math.abs(card.position.y - a)).toBeLessThan(0.035);
    const facing = new THREE.Vector3(0, 0, 1).transformDirection(card.matrixWorld);
    const toViewer = viewer.position.clone().sub(card.getWorldPosition(new THREE.Vector3()));
    expect(facing.dot(toViewer.normalize())).toBeGreaterThan(0.9);
  });

  it('is picked along a ray as a claim, and claiming flies it off, frees it and stops the pick', () => {
    const { coffer, viewer, kit } = standing();
    const face = fakeFace();
    coffer.open(true);
    coffer.showCard('overwind', face, true, viewer);
    step(coffer, 2.5);
    const card = cardOf(coffer) as THREE.Object3D;
    const at = card.getWorldPosition(new THREE.Vector3());
    const from = viewer.position.clone();
    const pick = pickCoffer([coffer], from, at.clone().sub(from), 4);
    expect(pick).toMatchObject({ room: 3, socketId: 'desk-drawer', claim: true });
    // A shut coffer is still picked to open it.
    const { coffer: shut } = standing();
    expect(pickCoffer([shut], from, new THREE.Vector3(0, 0.3, 0).sub(from), 4)?.claim).toBe(false);

    expect(coffer.claimCard(viewer)).toBe(true);
    expect(coffer.card).toBeNull();
    expect(coffer.cardHit).toBeNull();
    expect(coffer.claimCard(viewer)).toBe(false);
    expect(pickCoffer([coffer], from, at.clone().sub(from), 4)).toBeNull();
    const before = at.distanceTo(viewer.position);
    step(coffer, 0.2);
    expect(card.getWorldPosition(new THREE.Vector3()).distanceTo(viewer.position)).toBeLessThan(
      before,
    );
    expect(card.scale.x).toBeLessThan(1);
    step(coffer, 0.3);
    expect(cardOf(coffer)).toBeUndefined();
    expect(face.freed()).toBe(1);
    kit.dispose();
    expect(face.freed()).toBe(1);
  });

  it('cannot be claimed while the lid swings or the card rises, only once it hovers', () => {
    const { coffer, viewer } = standing();
    coffer.open(true);
    coffer.showCard('overwind', fakeFace(), true, viewer);
    const gem = (coffer.object.getObjectByName('coffer-gem') as THREE.Object3D).getWorldPosition(
      new THREE.Vector3(),
    );
    const through = (): THREE.Vector3 => gem.clone().sub(viewer.position);
    for (const seconds of [0.15, 0.3, 0.3]) {
      step(coffer, seconds);
      expect(coffer.cardHit).toBeNull();
      expect(pickCoffer([coffer], viewer.position, through(), 4)).toBeNull();
      expect(nearestCard([coffer], gem, 1)).toBeNull();
      expect(coffer.card).toBe('overwind');
    }
    step(coffer, 1);
    expect(coffer.cardHit).not.toBeNull();
  });

  it('shows a resumed pending card hovering over an already open coffer at once', () => {
    const { coffer, viewer } = standing();
    coffer.open(false);
    coffer.showCard('overwind', fakeFace(), false, viewer);
    const card = cardOf(coffer);
    expect(coffer.object.getObjectByName('coffer-lid')?.rotation.x).toBeGreaterThan(1.5);
    expect(card?.visible).toBe(true);
    expect(card?.position.y).toBeGreaterThan(BODY_HEIGHT + 0.3);
    expect(card?.scale.x).toBe(1);
    expect(coffer.card).toBe('overwind');
  });

  it('a hand near the waiting card finds it; a far hand does not', () => {
    const { coffer, viewer } = standing();
    coffer.open(false);
    coffer.showCard('overwind', fakeFace(), false, viewer);
    coffer.object.updateMatrixWorld(true);
    const at = (cardOf(coffer) as THREE.Object3D).getWorldPosition(new THREE.Vector3());
    expect(nearestCard([coffer], at.clone().add(new THREE.Vector3(0.1, 0, 0)), 0.25)).toBe(coffer);
    expect(nearestCard([coffer], at.clone().add(new THREE.Vector3(0.5, 0, 0)), 0.25)).toBeNull();
  });

  it('refuses a second card while one is shown and frees the refused face', () => {
    const { coffer, viewer } = standing();
    coffer.open(false);
    coffer.showCard('overwind', fakeFace(), false, viewer);
    const extra = fakeFace();
    coffer.showCard('arc-bolt', extra, false, viewer);
    expect(coffer.card).toBe('overwind');
    expect(extra.freed()).toBe(1);
  });

  it('frees a live card face with the kit', () => {
    const { coffer, viewer, kit } = standing();
    const face = fakeFace();
    coffer.open(false);
    coffer.showCard('overwind', face, false, viewer);
    kit.dispose();
    expect(face.freed()).toBe(1);
    expect(cardOf(coffer)).toBeUndefined();
  });
});

describe('open chest geometry', () => {
  /** First solid surface a ray meets on the coffer, skipping the pick volumes and the glow. */
  const solidHit = (coffer: Coffer, from: THREE.Vector3, to: THREE.Vector3) => {
    const solids: THREE.Object3D[] = [];
    coffer.object.traverse((o) => {
      if ((o as THREE.Mesh).isMesh && !/hit|glow|halo/.test(o.name)) solids.push(o);
    });
    coffer.object.updateMatrixWorld(true);
    const ray = new THREE.Raycaster(from, to.clone().sub(from).normalize());
    return ray.intersectObjects(solids, false)[0] ?? null;
  };

  it('has a deep inner floor near the base, inside inner walls', () => {
    const { coffer } = standing();
    coffer.open(false);
    expect(COFFER_INNER_DEPTH).toBeGreaterThanOrEqual(0.22);
    expect(COFFER_INNER_DEPTH).toBeLessThanOrEqual(0.25);
    for (const [x, z] of [
      [0, 0],
      [0.25, 0.12],
      [-0.25, -0.12],
    ] as const) {
      const hit = solidHit(coffer, new THREE.Vector3(x, 2, z), new THREE.Vector3(x, 0, z));
      expect(hit?.object.name).toBe('coffer-inner');
      expect(hit?.point.y).toBeCloseTo(BODY_HEIGHT - COFFER_INNER_DEPTH, 2);
    }
    // Looking across the opening from the front, the far inner wall is the dark inner lining.
    const across = solidHit(
      coffer,
      new THREE.Vector3(0, BODY_HEIGHT + 0.3, -1),
      new THREE.Vector3(0, BODY_HEIGHT - 0.04, 0.2),
    );
    expect(across?.object.name).toBe('coffer-inner');
  });

  it('lights the opening from inside once open, unlit and additive', () => {
    const { coffer } = standing();
    const glow = coffer.object.getObjectByName('coffer-glow') as THREE.Mesh;
    expect(glow.visible).toBe(false);
    coffer.open(false);
    expect(glow.visible).toBe(true);
    const material = glow.material as THREE.MeshBasicMaterial;
    expect(material.toneMapped).toBe(false);
    expect(material.blending).toBe(THREE.AdditiveBlending);
    const box = new THREE.Box3().setFromObject(glow);
    expect(box.min.y).toBeLessThan(BODY_HEIGHT - 0.06);
    expect(box.max.y).toBeGreaterThan(BODY_HEIGHT + 0.15);
  });

  it('shows the open lid hollow and brass rim to the approach, not a flat board', () => {
    const { coffer, viewer } = standing();
    coffer.open(false);
    expect(coffer.object.getObjectByName('coffer-lid-plate')).toBeUndefined();
    const lid = coffer.object.getObjectByName('coffer-lid') as THREE.Object3D;
    coffer.object.updateMatrixWorld(true);
    for (const z of [-0.1, -0.2, -0.3]) {
      const target = new THREE.Vector3(0.1, 0, z).applyMatrix4(lid.matrixWorld);
      const hit = solidHit(coffer, viewer.position, target);
      expect(['coffer-lid-inner', 'coffer-lid-rim']).toContain(hit?.object.name);
    }
  });

  it('closes both barrel-lid ends while retaining the inner lining', () => {
    const { coffer } = standing();
    coffer.open(false);
    const lid = coffer.object.getObjectByName('coffer-lid') as THREE.Object3D;
    coffer.object.updateMatrixWorld(true);
    for (const side of [-1, 1] as const) {
      const outer = coffer.object.getObjectByName('coffer-lid-top');
      const inner = coffer.object.getObjectByName(`coffer-lid-inner-end-${side}`);
      expect(outer?.visible).toBe(true);
      expect(inner?.visible).toBe(true);
      expect(inner?.parent).toBe(lid);
    }
  });

  it('joins the brass rails edge-to-edge, proud of the wooden lid', () => {
    const { coffer } = standing();
    const rim = coffer.object.getObjectByName('coffer-lid-rim') as THREE.Mesh;
    const wood = coffer.object.getObjectByName('coffer-lid-top') as THREE.Mesh;
    for (const mesh of [rim, wood]) mesh.geometry.computeBoundingBox();
    const bounds = rim.geometry.boundingBox as THREE.Box3;
    const shell = wood.geometry.boundingBox as THREE.Box3;
    for (const axis of ['x', 'z'] as const) {
      expect(bounds.max[axis] - shell.max[axis]).toBeGreaterThan(0.002);
      expect(shell.min[axis] - bounds.min[axis]).toBeGreaterThan(0.002);
    }
    rim.updateWorldMatrix(true, false);
    for (const x of [bounds.min.x + 0.009, bounds.max.x - 0.009]) {
      for (const z of [bounds.min.z + 0.015, bounds.max.z - 0.015]) {
        const origin = rim.localToWorld(new THREE.Vector3(x, bounds.max.y + 0.1, z));
        const down = new THREE.Vector3(0, -1, 0).transformDirection(rim.matrixWorld);
        const hits = new THREE.Raycaster(origin, down).intersectObject(rim, false);
        expect(hits.filter((hit) => Math.abs(hit.distance - 0.1) < 1e-5)).toHaveLength(1);
      }
    }
  });

  it('reveals cogs in sequence before allowing the card to hover', () => {
    const { coffer, viewer } = standing();
    coffer.open(true);
    coffer.showCogs(3);
    coffer.showCard('overwind', fakeFace(), true, viewer);
    const cogs = coffer.object.getObjectByName('coffer-cogs');
    expect(cogs?.children).toHaveLength(3);
    step(coffer, 0.39);
    expect(cogs?.children.filter((child) => child.visible)).toHaveLength(1);
    step(coffer, 0.08);
    expect(cogs?.children.filter((child) => child.visible)).toHaveLength(2);
    expect(cogs?.children[0]?.position.y).toBeGreaterThan(BODY_HEIGHT);
    expect(coffer.cardHit).toBeNull();
    step(coffer, 0.65);
    expect(cogs?.children).toHaveLength(0);
    expect(coffer.cardHit).toBeNull();
    step(coffer, 1);
    expect(coffer.cardHit).not.toBeNull();
  });

  it('dresses the lining in a darkened clone of the kit wood and the card back in brass', () => {
    const { coffer, kit, viewer } = standing();
    const wood = new THREE.MeshStandardMaterial({ color: '#806040' });
    const brass = new THREE.MeshStandardMaterial({ color: '#c0a040' });
    coffer.open(false);
    coffer.showCard('overwind', fakeFace(), false, viewer);
    kit.dress({ wood, brass });
    const mat = (name: string) =>
      (coffer.object.getObjectByName(name) as THREE.Mesh).material as THREE.MeshStandardMaterial;
    expect(mat('coffer-body')).toBe(wood);
    expect(mat('coffer-lid-top')).toBe(wood);
    expect(mat('coffer-lid-rim')).toBe(brass);
    expect(mat('coffer-card-back')).toBe(brass);
    const inner = mat('coffer-inner');
    expect(inner).not.toBe(wood);
    expect(mat('coffer-lid-inner')).toBe(inner);
    expect(inner.color.r).toBeLessThan(wood.color.r * 0.6);
    let freed = false;
    inner.addEventListener('dispose', () => {
      freed = true;
    });
    kit.dispose();
    expect(freed).toBe(true);
  });
});

/** A do-nothing 2D context: happy-dom has no canvas, and the toast draws on one. */
function stubCanvas2d(): void {
  const handler: ProxyHandler<object> = {
    get: (_target, key) =>
      key === 'measureText'
        ? (text: string) => ({ width: String(text).length * 10 })
        : () => new Proxy({}, handler),
    set: () => true,
  };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    () => new Proxy({}, handler) as unknown as CanvasRenderingContext2D,
  );
}

describe('chest card on the floor', () => {
  beforeEach(stubCanvas2d);
  afterEach(() => vi.restoreAllMocks());

  it('the floor pick claims the waiting card in the current room, and the claim panel names it', () => {
    const scene = new THREE.Scene();
    const rig = new THREE.Group();
    scene.add(rig);
    const view = mountFloorView(scene, rig, 'SPIRE001');
    const coffer = view.loot.coffers[0];
    if (coffer?.kind !== 'card') throw new Error('SPIRE001 has a card coffer');
    const fp = view.world.rooms[coffer.room]?.footprint;
    if (!fp) throw new Error('no room');
    view.world.update((fp.min[0] + fp.max[0]) / 2, (fp.min[1] + fp.max[1]) / 2);
    view.world.group.updateMatrixWorld(true);
    const head = new THREE.Object3D();
    const stand = view.loot.approachPoint(coffer.room, coffer.socketId) as THREE.Vector3;
    head.position.set(stand.x, 1.6, stand.z);
    scene.add(head);
    view.suspendTriggers = true;
    coffer.open(true);
    coffer.showCard('overwind', fakeFace(), true, head);
    for (let i = 0; i < 60; i++) view.update(head, 1 / 30);
    view.world.group.updateMatrixWorld(true);
    const at = (cardOf(coffer) as THREE.Object3D).getWorldPosition(new THREE.Vector3());
    const pick = view.loot.pick(head.position, at.clone().sub(head.position));
    expect(pick).toMatchObject({ room: coffer.room, socketId: coffer.socketId, claim: true });
    expect(coffer.claimCard(head)).toBe(true);
    expect(view.loot.open(coffer.room, coffer.socketId, { kind: 'card', card: 'overwind' })).toBe(
      true,
    );
    expect(view.loot.toast?.text).toBe(`New card: ${getCard('overwind').name}`);
    expect(view.loot.pick(head.position, at.clone().sub(head.position))).toBeNull();
    for (let i = 0; i < 20; i++) view.update(head, 1 / 30);
    expect(cardOf(coffer)).toBeUndefined();
    view.dispose();
  });
});
