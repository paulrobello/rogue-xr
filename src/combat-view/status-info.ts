import { PALETTE } from '../palette.ts';
import { DECAYS_AT_TURN_END, VULNERABLE_MULTIPLIER, WEAK_MULTIPLIER } from '../rules/statuses.ts';
import type { StatusId } from '../rules/types.ts';
import { STATUS_ICON } from '../ui/icon-atlas.ts';
import { drawIconRow, type IconChip, type IconSheet } from '../ui/icon-sheet.ts';
import { roundRect } from './canvas-label.ts';

/** Display name of each status. Exhaustive: a new status fails the type check until it has one. */
export const STATUS_NAME: Readonly<Record<StatusId, string>> = {
  weak: 'Weak',
  vulnerable: 'Vulnerable',
  overheat: 'Overheat',
  'wound-up': 'Wound-up',
};

const percent = (multiplier: number): number => Math.round(Math.abs(1 - multiplier) * 100);

/**
 * A plain-language explanation of status `id` at `stacks` stacks on the player (`you`) or an enemy
 * (`it`), for the pointer tooltip. The numbers come from the rules (`src/rules/statuses.ts`), so a
 * rules change shows here. `stacks` null explains the status per stack (a card keyword, whose stack
 * count may be a dice roll).
 */
export function statusExplanation(
  id: StatusId,
  stacks: number | null,
  who: 'you' | 'it' = 'it',
): string {
  const you = who === 'you';
  const their = you ? 'your' : 'its';
  const hp = stacks === null ? '1 HP per stack' : `${stacks} HP`;
  const more = stacks === null ? '1 more damage per stack' : `${stacks} more damage`;
  const what: Record<StatusId, string> = {
    weak: `${you ? 'Your' : 'Its'} attacks deal ${percent(WEAK_MULTIPLIER)}% less damage.`,
    vulnerable: `Attacks against ${you ? 'you' : 'it'} deal ${percent(VULNERABLE_MULTIPLIER)}% more damage.`,
    overheat: `${you ? 'You lose' : 'It loses'} ${hp} at the start of ${their} turn, ignoring block, then 1 stack.`,
    'wound-up': `Each of ${their} attack hits deals ${more}.`,
  };
  const wears = DECAYS_AT_TURN_END.includes(id)
    ? ` Loses 1 stack at the end of ${their} turn.`
    : id === 'wound-up'
      ? ' Lasts the whole fight.'
      : '';
  return `${what[id]}${wears}`;
}

/** A status chip's rectangle on its label canvas, canvas pixels (origin top-left, y down). */
export interface StatusRegion {
  readonly id: StatusId;
  readonly stacks: number;
  readonly x0: number;
  readonly x1: number;
  readonly y0: number;
  readonly y1: number;
}

/** The statuses with stacks above zero, in rules order. */
export function activeStatuses(
  statuses: Readonly<Partial<Record<StatusId, number>>>,
): [StatusId, number][] {
  return (Object.keys(STATUS_NAME) as StatusId[]).flatMap((id) => {
    const n = statuses[id] ?? 0;
    return n > 0 ? [[id, n] as [StatusId, number]] : [];
  });
}

/**
 * Draws `lead` chips (hp, block, steam) then one badge per status (icon and stack count on a dark
 * plate with a brass rim) on one line centred at `centreY`, from `x` (or centred on `x`). A row
 * wider than `maxWidth` is drawn smaller, font included, so it fits. Returns where each status badge
 * was drawn, for the pointer tooltip. Uses the current font and fill.
 */
export function drawChipsWithStatuses(
  ctx: CanvasRenderingContext2D,
  icons: IconSheet | null,
  lead: readonly IconChip[],
  statuses: Readonly<Partial<Record<StatusId, number>>>,
  x: number,
  centreY: number,
  size: number,
  align: 'left' | 'center' = 'left',
  maxWidth = Number.POSITIVE_INFINITY,
): StatusRegion[] {
  const full = rowWidth(ctx, icons, lead, statuses, size);
  if (full > maxWidth) {
    const k = maxWidth / full;
    size *= k;
    ctx.font = ctx.font.replace(/(\d+(?:\.\d+)?)px/, (_, px: string) => `${Number(px) * k}px`);
  }
  const gap = size * 0.15;
  const chipGap = size * 0.4;
  const pad = size * 0.12;
  const iconLead = icons ? size + gap : 0;
  const text = (chip: IconChip) => (icons ? chip.text : `${chip.fallback} ${chip.text}`.trim());
  const status = activeStatuses(statuses).map(([id, n]) => ({
    id,
    n,
    chip: { icon: STATUS_ICON[id], text: String(n), fallback: STATUS_NAME[id] } as IconChip,
  }));
  const widths = [
    ...lead.map((chip) => iconLead + ctx.measureText(text(chip)).width),
    ...status.map(({ chip }) => iconLead + ctx.measureText(text(chip)).width + 2 * pad),
  ];
  const total = widths.reduce((sum, w) => sum + w, 0) + chipGap * Math.max(0, widths.length - 1);
  let at = align === 'center' ? x - total / 2 : x;
  lead.forEach((chip, i) => {
    drawIconRow(ctx, icons, [chip], at, centreY, size);
    at += (widths[i] as number) + chipGap;
  });
  const regions: StatusRegion[] = [];
  const fill = ctx.fillStyle;
  status.forEach(({ id, n, chip }, i) => {
    const w = widths[lead.length + i] as number;
    const half = size / 2 + pad;
    ctx.fillStyle = 'rgba(40,26,14,0.95)';
    ctx.strokeStyle = PALETTE.brass;
    ctx.lineWidth = Math.max(2, size * 0.05);
    ctx.beginPath();
    ctx.rect(at, centreY - half, w, 2 * half);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = fill;
    drawIconRow(ctx, icons, [chip], at + pad, centreY, size);
    regions.push({ id, stacks: n, x0: at, x1: at + w, y0: centreY - half, y1: centreY + half });
    at += w + chipGap;
  });
  return regions;
}

/** Width the row would take at `size`, in the current font. */
function rowWidth(
  ctx: CanvasRenderingContext2D,
  icons: IconSheet | null,
  lead: readonly IconChip[],
  statuses: Readonly<Partial<Record<StatusId, number>>>,
  size: number,
): number {
  const iconLead = icons ? size * 1.15 : 0;
  const text = (chip: IconChip) => (icons ? chip.text : `${chip.fallback} ${chip.text}`.trim());
  const chips = [
    ...lead.map((chip) => iconLead + ctx.measureText(text(chip)).width),
    ...activeStatuses(statuses).map(
      ([id, n]) =>
        iconLead +
        ctx.measureText(icons ? String(n) : `${STATUS_NAME[id]} ${n}`).width +
        size * 0.24,
    ),
  ];
  return chips.reduce((sum, w) => sum + w, 0) + size * 0.4 * Math.max(0, chips.length - 1);
}

/** The status region under texture coordinate (`u`, `v`) of a `width` by `height` canvas, or null. */
export function statusAtUv(
  regions: readonly StatusRegion[],
  u: number,
  v: number,
  width: number,
  height: number,
): StatusRegion | null {
  const px = u * width;
  const py = (1 - v) * height;
  return regions.find((r) => px >= r.x0 && px <= r.x1 && py >= r.y0 && py <= r.y1) ?? null;
}

/** One entry of an explanation tip: a bold title and its wrapped explanation. */
export interface TipEntry {
  readonly title: string;
  readonly text: string;
}

/** The lines `text` wraps to at `maxWidth` in the current font. */
function wrapLines(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    const next = line === '' ? word : `${line} ${word}`;
    if (ctx.measureText(next).width > maxWidth && line !== '') {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line !== '') lines.push(line);
  return lines;
}

const TIP_TITLE_FONT = 'bold 40px system-ui, sans-serif';
const TIP_TEXT_FONT = '500 30px system-ui, sans-serif';
/** Tip layout, canvas pixels: inset, first title centre, title to text, text line, entry gap. */
const TIP = { inset: 24, top: 44, title: 52, line: 36, gap: 20 } as const;

/**
 * Draws an explanation tip on a `w` by `h` canvas: a dark plate with a brass rim, then each entry's
 * title in candle and its text in parchment, wrapped. The status badge tip and the card keyword tip
 * both draw through this. `fit` shrinks the plate to its entries and stands it on the canvas's
 * bottom edge (a card tip of one keyword is short); without it the plate fills the canvas.
 */
export function drawTip(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  entries: readonly TipEntry[],
  fit = false,
): void {
  const maxWidth = w - 2 * TIP.inset;
  ctx.font = TIP_TEXT_FONT;
  const wrapped = entries.map((e) => wrapLines(ctx, e.text, maxWidth));
  const used =
    TIP.top +
    wrapped.reduce((sum, lines) => sum + TIP.title + lines.length * TIP.line + TIP.gap, 0) -
    TIP.gap;
  const top = fit ? Math.max(0, h - used - 8) : 0;
  ctx.fillStyle = 'rgba(18,12,7,0.92)';
  roundRect(ctx, 4, top + 4, w - 8, h - top - 8, 16);
  ctx.fill();
  ctx.strokeStyle = PALETTE.brass;
  ctx.lineWidth = 4;
  ctx.stroke();
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  let y = top + TIP.top;
  entries.forEach(({ title }, i) => {
    ctx.fillStyle = PALETTE.candle;
    ctx.font = TIP_TITLE_FONT;
    ctx.fillText(title, TIP.inset, y);
    ctx.fillStyle = PALETTE.parchment;
    ctx.font = TIP_TEXT_FONT;
    y += TIP.title;
    for (const line of wrapped[i] ?? []) {
      ctx.fillText(line, TIP.inset, y);
      y += TIP.line;
    }
    y += TIP.gap;
  });
}
