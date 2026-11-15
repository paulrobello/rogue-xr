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
  | { type: 'new-run'; seed?: string };

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

  emit(action: GameAction): void {
    for (const listener of this.listeners.get(action.type) ?? []) listener(action);
  }
}
