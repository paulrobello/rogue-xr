/**
 * Every player intent flows through this bus so the desktop and XR presenters drive identical
 * game logic. Presenters emit; systems subscribe.
 */
export type GameAction =
  | { type: 'enter-xr' }
  | { type: 'exit-xr' }
  | { type: 'recenter' }
  | { type: 'move'; forward: number; strafe: number }
  | { type: 'turn'; degrees: number }
  | { type: 'select'; controlId: string }
  | { type: 'new-run'; seed?: string }
  /**
   * Combat pointer (desktop mouse, or any world ray): `down` presses on whatever the ray hits (a fan
   * card picks it up, the sigil plate starts a stroke, End Turn, the dice tray) or, while a card is
   * held, uses it where the ray aims; `move` carries the held card, draws or hovers; `up` ends a
   * stroke. `ndc` is the mouse in normalized device coordinates when the ray comes from the camera.
   */
  | {
      type: 'combat-pointer';
      phase: 'down' | 'move' | 'up';
      origin: readonly [number, number, number];
      direction: readonly [number, number, number];
      ndc?: readonly [number, number];
    }
  /**
   * A tracked controller button in combat: the main-hand squeeze grabs a card (letting go puts it
   * back) or the waiting die (letting go throws it); the trigger uses the held card, draws on the
   * plate and presses the table buttons.
   */
  | { type: 'combat-hand'; hand: 'main' | 'off'; control: 'squeeze' | 'trigger'; pressed: boolean }
  | { type: 'end-turn' }
  | { type: 'throw-dice' }
  | { type: 'combat-cancel' };

export type ActionType = GameAction['type'];
type Listener<T extends ActionType> = (action: Extract<GameAction, { type: T }>) => void;

export class ActionBus {
  private readonly listeners = new Map<ActionType, Set<(action: GameAction) => void>>();

  on<T extends ActionType>(type: T, listener: Listener<T>): () => void {
    const set = this.listeners.get(type) ?? new Set();
    const wrapped = listener as (action: GameAction) => void;
    set.add(wrapped);
    this.listeners.set(type, set);
    return () => set.delete(wrapped);
  }

  /** Live listeners for `type`, or across every type when omitted. */
  listenerCount(type?: ActionType): number {
    if (type) return this.listeners.get(type)?.size ?? 0;
    let total = 0;
    for (const set of this.listeners.values()) total += set.size;
    return total;
  }

  emit(action: GameAction): void {
    for (const listener of this.listeners.get(action.type) ?? []) listener(action);
  }
}
