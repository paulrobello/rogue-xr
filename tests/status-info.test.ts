/**
 * F6 (Quest 3 playtest 2026-11-17): "status effects need to be shown and if laser pointed at
 * explained". Statuses draw as icon badges with their stacks; pointing at one shows its name and a
 * plain-language explanation built from the rules' numbers.
 */
import { describe, expect, it } from 'vitest';
import {
  activeStatuses,
  drawChipsWithStatuses,
  STATUS_NAME,
  statusAtUv,
  statusExplanation,
} from '../src/combat-view/status-info.ts';
import { DECAYS_AT_TURN_END, STATUS_IDS } from '../src/rules/statuses.ts';

/** A 2D context stand-in: text is a quarter of the font size per character wide, drawing calls are recorded. */
function fakeCtx(): CanvasRenderingContext2D & { texts: string[] } {
  const texts: string[] = [];
  const ctx = {
    texts,
    fillStyle: '#fff',
    strokeStyle: '#000',
    lineWidth: 1,
    textAlign: 'left',
    textBaseline: 'middle',
    font: '',
    // A quarter of the font size per character (10 px with no font set), so a smaller font measures narrower.
    measureText(text: string) {
      const px = Number(/(\d+(?:\.\d+)?)px/.exec(ctx.font)?.[1] ?? 40);
      return { width: (text.length * px) / 4 };
    },
    fillText: (text: string) => texts.push(text),
    beginPath: () => {},
    rect: () => {},
    fill: () => {},
    stroke: () => {},
    drawImage: () => {},
  };
  return ctx as unknown as CanvasRenderingContext2D & { texts: string[] };
}

describe('F6 status explanations', () => {
  it.each(STATUS_IDS.map((id) => [id] as const))('names and explains %s for both sides', (id) => {
    expect(STATUS_NAME[id]).toMatch(/^[A-Z]/);
    for (const who of ['you', 'it'] as const) {
      const text = statusExplanation(id, 3, who);
      expect(text.length).toBeGreaterThan(20);
      expect(text).toMatch(/\.$/);
      if (DECAYS_AT_TURN_END.includes(id)) expect(text).toMatch(/Loses 1 stack at the end of/);
    }
  });

  it('carries the rules numbers', () => {
    expect(statusExplanation('weak', 1, 'it')).toBe(
      'Its attacks deal 25% less damage. Loses 1 stack at the end of its turn.',
    );
    expect(statusExplanation('vulnerable', 2, 'you')).toBe(
      'Attacks against you deal 50% more damage. Loses 1 stack at the end of your turn.',
    );
    expect(statusExplanation('overheat', 4, 'it')).toBe(
      'It loses 4 HP at the start of its turn, ignoring block, then 1 stack.',
    );
    expect(statusExplanation('wound-up', 2, 'you')).toBe(
      'Each of your attack hits deals 2 more damage. Lasts the whole fight.',
    );
  });
});

describe('F6 status badges', () => {
  it('lists only statuses with stacks, in rules order', () => {
    expect(activeStatuses({ 'wound-up': 2, weak: 0, overheat: 1 })).toEqual([
      ['overheat', 1],
      ['wound-up', 2],
    ]);
  });

  it('draws a badge per status after the lead chips and reports where each one is', () => {
    const ctx = fakeCtx();
    const regions = drawChipsWithStatuses(
      ctx,
      null,
      [{ icon: 'hp', text: '30/40', fallback: 'HP' }],
      { vulnerable: 2, weak: 1 },
      320,
      104,
      64,
      'center',
    );
    expect(regions.map((r) => [r.id, r.stacks])).toEqual([
      ['weak', 1],
      ['vulnerable', 2],
    ]);
    expect(ctx.texts).toEqual(['HP 30/40', 'Weak 1', 'Vulnerable 2']);
    const [weak, vulnerable] = regions as [(typeof regions)[0], (typeof regions)[0]];
    expect(weak.x1).toBeLessThan(vulnerable.x0);
    expect(weak.y0).toBeLessThan(104);
    expect(weak.y1).toBeGreaterThan(104);
    // Centred on x: the row spans evenly either side of 320.
    const left = 320 - (vulnerable.x1 - 320);
    expect(left).toBeLessThan(weak.x0);

    // A pointer at the middle of the badge (texture v runs up) finds it; between badges, nothing.
    const w = 640;
    const h = 260;
    const uvOf = (x: number, y: number) => [x / w, 1 - y / h] as const;
    const [u, v] = uvOf((vulnerable.x0 + vulnerable.x1) / 2, 104);
    expect(statusAtUv(regions, u, v, w, h)?.id).toBe('vulnerable');
    const [gu, gv] = uvOf((weak.x1 + vulnerable.x0) / 2, 104);
    expect(statusAtUv(regions, gu, gv, w, h)).toBeNull();
    expect(statusAtUv(regions, u, uvOf(0, 230)[1], w, h)).toBeNull();
  });

  it('shrinks a crowded row to fit the label: block and all four statuses stay on the canvas', () => {
    const ctx = fakeCtx();
    ctx.font = 'bold 44px system-ui, sans-serif';
    const w = 640;
    const regions = drawChipsWithStatuses(
      ctx,
      null,
      [
        { icon: 'hp', text: '120/120', fallback: 'HP' },
        { icon: 'block', text: '12', fallback: 'Block' },
      ],
      { weak: 2, vulnerable: 2, overheat: 3, 'wound-up': 4 },
      w / 2,
      104,
      64,
      'center',
      w - 24,
    );
    expect(regions).toHaveLength(4);
    for (const r of regions) {
      expect(r.x0).toBeGreaterThanOrEqual(4);
      expect(r.x1).toBeLessThanOrEqual(w - 4);
    }
    expect(ctx.font).not.toBe('bold 44px system-ui, sans-serif');
  });

  it('reports no regions without statuses', () => {
    expect(drawChipsWithStatuses(fakeCtx(), null, [], {}, 24, 122, 60)).toEqual([]);
  });
});
