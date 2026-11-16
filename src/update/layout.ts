/** Canvas and world size of the in-scene notice; the canvas aspect matches the plane's. */
export const PANEL = { canvasWidth: 640, canvasHeight: 300, width: 0.64, height: 0.3 } as const;

export type NoticeButton = 'reload' | 'later';

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Button rectangles in canvas pixels, origin top-left. */
export const BUTTONS: Readonly<Record<NoticeButton, Rect>> = {
  reload: { x: 40, y: 170, width: 330, height: 90 },
  later: { x: 400, y: 170, width: 200, height: 90 },
};

/** The button under a plane hit, from the intersection's `uv` (origin bottom-left, as three.js reports it). */
export function buttonAtUv(u: number, v: number): NoticeButton | null {
  const x = u * PANEL.canvasWidth;
  const y = (1 - v) * PANEL.canvasHeight;
  for (const name of ['reload', 'later'] as const) {
    const rect = BUTTONS[name];
    if (x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height) {
      return name;
    }
  }
  return null;
}
