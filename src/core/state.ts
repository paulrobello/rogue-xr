export type GamePhase = 'title' | 'explore' | 'combat' | 'reward' | 'workshop';

/** Legal phase transitions for one run and the workshop loop between runs. */
export const TRANSITIONS: Readonly<Record<GamePhase, readonly GamePhase[]>> = {
  title: ['explore', 'workshop'],
  explore: ['combat', 'workshop', 'title'],
  combat: ['reward', 'workshop'],
  reward: ['explore'],
  workshop: ['title', 'explore'],
};

export class GameStateMachine {
  private current: GamePhase = 'title';
  private readonly listeners = new Set<(from: GamePhase, to: GamePhase) => void>();

  get phase(): GamePhase {
    return this.current;
  }

  canTransition(to: GamePhase): boolean {
    return TRANSITIONS[this.current].includes(to);
  }

  transition(to: GamePhase): void {
    if (!this.canTransition(to)) {
      throw new Error(`Illegal phase transition ${this.current} -> ${to}`);
    }
    const from = this.current;
    this.current = to;
    for (const listener of this.listeners) listener(from, to);
  }

  onChange(listener: (from: GamePhase, to: GamePhase) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
