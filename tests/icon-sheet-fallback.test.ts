// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { drawIconRow, type IconChip, iconSheet, loadIconSheet } from '../src/ui/icon-sheet.ts';

function recordingContext() {
  const calls = { fillText: [] as string[], drawImage: 0 };
  const ctx = {
    textAlign: 'left',
    textBaseline: 'alphabetic',
    measureText: (text: string) => ({ width: text.length * 10 }),
    fillText: (text: string) => calls.fillText.push(text),
    drawImage: () => {
      calls.drawImage += 1;
    },
  } as unknown as CanvasRenderingContext2D;
  return { ctx, calls };
}

const chips: IconChip[] = [
  { icon: 'intent-attack', text: '7', fallback: 'Attack' },
  { icon: 'status-weak', text: '2', fallback: 'Weak' },
];

describe('UI icon sheet fallback', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('draws the fallback words and no icon while the sheet is unavailable', () => {
    const { ctx, calls } = recordingContext();
    drawIconRow(ctx, null, chips, 0, 10, 24);
    expect(calls.drawImage).toBe(0);
    expect(calls.fillText).toEqual(['Attack 7', 'Weak 2']);
  });

  it('rejects a failed manifest fetch, keeps no sheet, and retries on the next call', async () => {
    const fetchFn = vi.fn(async () => new Response('missing', { status: 404 }));
    vi.stubGlobal('fetch', fetchFn);
    await expect(loadIconSheet()).rejects.toThrow(/HTTP 404/);
    expect(iconSheet()).toBeNull();
    await expect(loadIconSheet()).rejects.toThrow(/HTTP 404/);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});
