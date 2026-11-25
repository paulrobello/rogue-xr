import * as THREE from 'three';
import { expect, it, vi } from 'vitest';
import type { LogbookMap } from '../src/flow/logbook-map.ts';
import { DEFAULT_SETTINGS, MINIMAP_PLACEMENT_LIMIT, MINIMAP_ZOOMS } from '../src/persist/db.ts';
import { Minimap } from '../src/xr/minimap.ts';

it('adds slider travel without moving old placements or clipping either eye', () => {
  const canvas = vi
    .spyOn(HTMLCanvasElement.prototype, 'getContext')
    .mockReturnValue(new Proxy({}, { get: () => () => undefined }) as CanvasRenderingContext2D);
  const minimap = new Minimap();
  try {
    const eyes = [-0.032, 0.032].map((x) => {
      const eye = new THREE.PerspectiveCamera(80, 1, 0.05, 100);
      eye.position.x = x;
      eye.updateMatrixWorld();
      return eye;
    });
    const xr = new THREE.ArrayCamera(eyes);
    xr.projectionMatrix.copy(eyes[0].projectionMatrix);
    xr.updateMatrixWorld();
    const map: LogbookMap = {
      floor: 1,
      rooms: [],
      totalRooms: 1,
      doors: [],
      player: { room: 0, label: 'hall', position: [0, 0] },
    };
    const quad = minimap.scene.getObjectByName('minimap-anchor')?.children[0];
    if (!(quad instanceof THREE.Mesh) || !(quad.geometry instanceof THREE.PlaneGeometry)) {
      throw new Error('minimap quad missing');
    }
    const { width, height } = quad.geometry.parameters;
    const bounds = (camera: THREE.Camera) =>
      [-1, 1].flatMap((x) =>
        [-1, 1].map((y) =>
          quad
            .localToWorld(new THREE.Vector3((x * width) / 2, (y * height) / 2, 0))
            .project(camera),
        ),
      );

    for (const [horizontal, vertical] of [
      [-1, -1],
      [1, 1],
      [0, 0],
      [-MINIMAP_PLACEMENT_LIMIT, MINIMAP_PLACEMENT_LIMIT],
      [MINIMAP_PLACEMENT_LIMIT, -MINIMAP_PLACEMENT_LIMIT],
      [-1, 1],
      [1, -1],
    ] as const) {
      expect(
        minimap.update(
          xr,
          0.1,
          {
            ...DEFAULT_SETTINGS,
            minimapHorizontal: horizontal,
            minimapVertical: vertical,
          },
          () => map,
        ),
      ).toBe(true);
      expect(Math.sign(quad.position.x)).toBe(Math.sign(horizontal));
      expect(Math.sign(quad.position.y)).toBe(Math.sign(vertical));
      if (Math.abs(horizontal) <= 1) expect(quad.position.x).toBeCloseTo(horizontal * 0.2);
      else expect(Math.abs(quad.position.x)).toBeGreaterThan(0.34);
      if (Math.abs(vertical) <= 1) expect(quad.position.y).toBeCloseTo(vertical * 0.24);
      else expect(Math.abs(quad.position.y)).toBeGreaterThan(0.34);
      for (const eye of eyes) {
        for (const { x, y } of bounds(eye)) {
          expect(Math.abs(x)).toBeLessThan(0.85);
          expect(Math.abs(y)).toBeLessThan(0.85);
        }
      }
    }

    const desktop = new THREE.PerspectiveCamera(70, 16 / 9, 0.05, 100);
    desktop.updateMatrixWorld();
    minimap.update(
      desktop,
      0.1,
      {
        ...DEFAULT_SETTINGS,
        minimapZoom: 1,
        minimapNorthUp: true,
        minimapHorizontal: 1,
        minimapVertical: 1,
      },
      () => map,
    );
    const desktopBounds = bounds(desktop);
    expect(Math.max(...desktopBounds.map(({ x }) => x))).toBeGreaterThan(0.89);
    expect(Math.max(...desktopBounds.map(({ y }) => y))).toBeGreaterThan(0.89);
    const original = quad.position.clone();
    minimap.update(
      desktop,
      0.1,
      {
        ...DEFAULT_SETTINGS,
        minimapHorizontal: -MINIMAP_PLACEMENT_LIMIT,
        minimapVertical: MINIMAP_PLACEMENT_LIMIT,
      },
      () => map,
    );
    expect(quad.position.x).toBeLessThan(-original.x - 0.02);
    expect(quad.position.y).toBeGreaterThan(original.y + 0.02);
    for (const { x, y } of bounds(desktop)) {
      expect(Math.abs(x)).toBeLessThan(1);
      expect(Math.abs(y)).toBeLessThan(1);
    }
  } finally {
    minimap.dispose();
    canvas.mockRestore();
  }
});

it('scales the player arrow around the map center at each zoom level', () => {
  const scale = vi.fn();
  const translate = vi.fn();
  const context = new Proxy(
    { scale, translate },
    { get: (methods, key) => Reflect.get(methods, key) ?? (() => undefined) },
  ) as unknown as CanvasRenderingContext2D;
  const canvas = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context);
  const minimap = new Minimap();
  try {
    const viewer = new THREE.PerspectiveCamera(70, 1, 0.05, 100);
    const map: LogbookMap = {
      floor: 1,
      rooms: [],
      totalRooms: 1,
      doors: [],
      player: { room: 0, label: 'hall', position: [0, 0] },
    };
    for (const minimapZoom of MINIMAP_ZOOMS) {
      minimap.update(viewer, 0.1, { ...DEFAULT_SETTINGS, minimapZoom }, () => map);
      expect(translate).toHaveBeenLastCalledWith(128, 128);
      expect(scale).toHaveBeenLastCalledWith(minimapZoom, minimapZoom);
    }
  } finally {
    minimap.dispose();
    canvas.mockRestore();
  }
});
