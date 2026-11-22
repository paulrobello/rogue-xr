/**
 * The in-run menu button: the left controller's Y (xr-standard gamepad index 5; 4 is X). Quest 3
 * never passed the left menu button (Touch Plus index 7) to the page when the toolkit tried it on
 * 2026-11-10 (`../mux-xr/src/xr/scene.ts`, FACE_BUTTONS), and nothing in this game reads X or Y.
 */
export const MENU_BUTTON = { side: 'left', index: 5 } as const;
/** The left controller's X face button opens the exploration map directly. */
export const MAP_BUTTON = { side: 'left', index: 4 } as const;

/**
 * Turns a polled button state into presses: `step` is true only on the frame the button goes down.
 * WebXR fires no events for face buttons, so they are read from the gamepad every frame.
 */
export class ButtonEdge {
  private down = false;

  step(pressed: boolean): boolean {
    const rose = pressed && !this.down;
    this.down = pressed;
    return rose;
  }
}
