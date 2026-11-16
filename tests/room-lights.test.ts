import * as THREE from 'three';
import { describe, expect, it, type Mock, vi } from 'vitest';
import { GREYBOX_TEMPLATES, MAX_LIGHT_SOCKETS, type RoomTemplate } from '../src/content/rooms.ts';
import {
  buildRoomLights,
  createHandLantern,
  DynamicLightBudget,
  MAX_DYNAMIC_LIGHTS,
  type RoomProbe,
  RoomProbeCache,
} from '../src/world/room-lights.ts';

function withSockets(count: number, id = 'test-room'): RoomTemplate {
  const base = GREYBOX_TEMPLATES[0] as RoomTemplate;
  return {
    ...base,
    id,
    lightSockets: Array.from({ length: count }, (_, i) => ({
      id: `s${i}`,
      position: [i, 2, -i] as const,
      yaw: 0,
    })),
  };
}

describe('buildRoomLights', () => {
  it('makes one shadowless PointLight per socket at the socket position', () => {
    const rig = buildRoomLights(withSockets(3));
    expect(rig.lights).toHaveLength(3);
    expect(rig.group.children).toHaveLength(3);
    rig.lights.forEach((light, i) => {
      expect(light).toBeInstanceOf(THREE.PointLight);
      expect(light.castShadow).toBe(false);
      expect(light.position.toArray()).toEqual([i, 2, -i]);
    });
  });

  it('accepts exactly MAX_LIGHT_SOCKETS sockets and throws on one more', () => {
    expect(buildRoomLights(withSockets(MAX_LIGHT_SOCKETS)).lights).toHaveLength(4);
    expect(() => buildRoomLights(withSockets(MAX_LIGHT_SOCKETS + 1))).toThrow(
      /5 light sockets, at most 4/,
    );
  });

  it('builds every greybox template inside the budget with the lantern alive', () => {
    for (const template of GREYBOX_TEMPLATES) {
      const budget = new DynamicLightBudget();
      const lantern = createHandLantern({ budget });
      const rig = buildRoomLights(template, { budget });
      expect(budget.inUse).toBe(template.lightSockets.length + 1);
      rig.dispose();
      lantern.dispose();
      expect(budget.inUse).toBe(0);
    }
  });
});

describe('global dynamic light budget', () => {
  it('is 4 room lights plus the lantern', () => {
    expect(MAX_DYNAMIC_LIGHTS).toBe(5);
    expect(new DynamicLightBudget().limit).toBe(5);
  });

  it('counts the lantern, so a full room plus lantern fits but nothing more does', () => {
    const budget = new DynamicLightBudget();
    const lantern = createHandLantern({ budget });
    expect(lantern.lights).toHaveLength(1);
    expect(budget.inUse).toBe(1);
    buildRoomLights(withSockets(4), { budget });
    expect(budget.inUse).toBe(5);
    expect(() => createHandLantern({ budget })).toThrow(/dynamic light budget/);
  });

  it('refuses a second room while the first one still holds its lights', () => {
    const budget = new DynamicLightBudget();
    const lantern = createHandLantern({ budget });
    const first = buildRoomLights(withSockets(3, 'a'), { budget });
    expect(() => buildRoomLights(withSockets(3, 'b'), { budget })).toThrow(/dynamic light budget/);
    first.dispose();
    expect(buildRoomLights(withSockets(3, 'b'), { budget }).lights).toHaveLength(3);
    lantern.dispose();
  });

  it('releases once, however many times dispose runs', () => {
    const budget = new DynamicLightBudget();
    const a = buildRoomLights(withSockets(2), { budget });
    const b = buildRoomLights(withSockets(2), { budget });
    a.dispose();
    a.dispose();
    expect(budget.inUse).toBe(2);
    b.dispose();
    expect(budget.inUse).toBe(0);
  });
});

describe('RoomProbeCache', () => {
  type FakeProbe = RoomProbe & { dispose: Mock<() => void> };
  function fakeProbe(): FakeProbe {
    return { texture: new THREE.Texture(), dispose: vi.fn<() => void>() };
  }

  it('bakes once per template id and shares the texture between placements', () => {
    const bake = vi.fn((_t: RoomTemplate) => fakeProbe());
    const cache = new RoomProbeCache(bake);
    const t = withSockets(1, 'study');
    const first = cache.acquire(t);
    const second = cache.acquire(t);
    expect(second).toBe(first);
    expect(bake).toHaveBeenCalledTimes(1);
    cache.acquire(withSockets(1, 'hall'));
    expect(bake).toHaveBeenCalledTimes(2);
    expect(cache.size).toBe(2);
  });

  it('disposes the probe when its last placement unloads, then rebakes on demand', () => {
    const probes: FakeProbe[] = [];
    const cache = new RoomProbeCache(() => {
      const p = fakeProbe();
      probes.push(p);
      return p;
    });
    const t = withSockets(1, 'study');
    cache.acquire(t);
    cache.acquire(t);
    cache.release(t);
    expect(probes[0]?.dispose).not.toHaveBeenCalled();
    cache.release(t);
    expect(probes[0]?.dispose).toHaveBeenCalledTimes(1);
    expect(cache.size).toBe(0);
    cache.acquire(t);
    expect(probes).toHaveLength(2);
  });

  it('disposes everything on dispose()', () => {
    const probes: FakeProbe[] = [];
    const cache = new RoomProbeCache(() => {
      const p = fakeProbe();
      probes.push(p);
      return p;
    });
    cache.acquire(withSockets(1, 'a'));
    cache.acquire(withSockets(1, 'b'));
    cache.dispose();
    expect(probes.every((p) => p.dispose.mock.calls.length === 1)).toBe(true);
    expect(cache.size).toBe(0);
  });
});
