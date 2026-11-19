import { expect, it, vi } from 'vitest';
import { StairTransit } from '../src/world/stair-transit.ts';

it.each([false, true])(
  'shows blackout before crossing and holds it until ready (reduced motion %s)',
  (reduced) => {
    const t = new StairTransit(reduced);
    const cross = vi.fn();
    const swing = vi.fn();
    expect(t.start({ cross, swing })).toBe(true);
    t.update(0.1, true);
    expect(swing.mock.lastCall?.[0]).toBeGreaterThan(0);
    expect(swing.mock.lastCall?.[0]).toBeLessThan(1);
    expect(t.opacity).toBe(0);
    t.update(0.7, true);
    expect(swing).toHaveBeenLastCalledWith(1);
    expect(t.phase).toBe('fade-out');
    t.update(0.16, true);
    expect(t.opacity).toBeCloseTo(0.5);
    t.update(0.16, true);
    expect(t.opacity).toBe(1);
    expect(cross).not.toHaveBeenCalled();
    t.update(0.016, true);
    expect(cross).toHaveBeenCalledOnce();
    t.update(6, false);
    expect(t.start({ cross, swing })).toBe(false);
    expect(t.phase).toBe('loading');
    expect(t.opacity).toBe(1);
    t.update(0.016, true);
    t.update(0.2, true);
    expect(t.phase).toBe('fade-in');
    expect(t.opacity).toBeGreaterThan(0);
    expect(t.opacity).toBeLessThan(1);
    t.update(0.25, true);
    expect(t.phase).toBe('idle');
    expect(t.opacity).toBe(0);
    expect(cross).toHaveBeenCalledOnce();
  },
);
