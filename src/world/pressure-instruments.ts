import { MathUtils, type Object3D } from 'three';
import type { PressureState } from '../rules/pressure.ts';

type Channel = 0 | 1 | 2;
interface Instrument {
  node: Object3D;
  channels: readonly Channel[];
  restAngle?: number;
  /** Travel as a multiple of the authored column height; its pivot is the bottom of the glass. */
  travel: number;
  reading: number;
  target: number;
}

/** The etched scale covers 0.15π to 0.85π measured from the positive X axis on a dial face. */
function pose(g: Instrument, level: number): void {
  if (g.restAngle !== undefined) g.node.rotation.z = Math.PI * (0.85 - 0.7 * level) - g.restAngle;
  else g.node.scale.y = g.travel * level;
}

export class PressureInstruments {
  private instruments: Instrument[] = [];
  private surge = 0;
  private moving = false;

  bind(manifold: Object3D, gallery: Object3D, banks: Object3D): void {
    this.instruments.length = 0;
    const bind = (
      root: Object3D,
      name: string,
      channels: readonly Channel[],
      travel: number,
      restAngle?: number,
    ) => {
      const node = root.getObjectByName(name);
      if (node) this.instruments.push({ node, channels, travel, restAngle, reading: 0, target: 0 });
    };
    const all = [0, 1, 2] as const;
    const dialAngle = Math.atan2(0.34, 0.43);
    bind(manifold, 'gauge-needle-0', all, 1, dialAngle);
    for (const channel of all) bind(gallery, `gauge-needle-${channel}`, [channel], 1, dialAngle);
    bind(gallery, 'sight-fluid', all, 0.22 / 0.11);
    for (const [side, bank] of banks.children.entries()) {
      const pair = side === 0 ? ([0, 1] as const) : ([1, 2] as const);
      for (const [i, channel] of pair.entries())
        bind(bank, `gauge-needle-${i}`, [channel], 1, Math.atan2(0.26, 0.36));
      bind(bank, 'sight-fluid', pair, 0.64 / 0.34);
    }
  }

  sync(state: PressureState, animate: boolean): void {
    for (const g of this.instruments) {
      const valve =
        g.channels.reduce<number>((sum, i) => sum + (state.dials[i] - 1) / 2, 0) /
        g.channels.length;
      g.target = state.solved ? 0.74 + 0.18 * valve : 0.1 + 0.48 * valve;
      if (!animate) {
        g.reading = g.target;
        pose(g, g.reading);
      }
    }
    if (!animate) this.surge = 0;
    this.moving = animate;
  }

  primerStroke(): void {
    this.surge = 0.5;
    this.moving = true;
  }

  update(dt: number): void {
    if (!this.moving || dt <= 0) return;
    this.surge = Math.max(0, this.surge - dt);
    const kick = 0.18 * Math.sin(2 * Math.PI * this.surge);
    this.moving = this.surge > 0;
    for (const g of this.instruments) {
      g.reading = MathUtils.damp(g.reading, g.target, 9, dt);
      if (Math.abs(g.reading - g.target) < 0.0005) g.reading = g.target;
      else this.moving = true;
      pose(g, Math.min(1, g.reading + kick));
    }
  }
}
