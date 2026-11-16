import type { RunSnapshot } from '../persist/saves.ts';
import { snapshotRun } from '../persist/saves.ts';
import {
  chooseReward,
  createRun,
  lootKey,
  openTreasure,
  type RewardChoice,
  type RewardOffer,
  type RewardTier,
  type RunState,
  rewardOffer,
  SKIP_REWARD,
  type TreasureKind,
  type TreasureLoot,
  useHearth,
} from '../rules/run.ts';
import {
  bankRunCogs,
  buyUpgrade,
  nextCost,
  runOptionsFrom,
  type UpgradeId,
  type WorkshopState,
} from '../rules/workshop.ts';

/**
 * Screens of the whole game loop. `title`, `workshop` and `settings` sit between runs; `explore`,
 * `combat` and `reward` are one run; `death` and `victory` summarize a finished run until the player
 * returns to the title.
 */
export type FlowPhase =
  | 'title'
  | 'workshop'
  | 'settings'
  | 'explore'
  | 'combat'
  | 'reward'
  | 'death'
  | 'victory';

export const FLOW_TRANSITIONS: Readonly<Record<FlowPhase, readonly FlowPhase[]>> = {
  title: ['explore', 'reward', 'workshop', 'settings'],
  workshop: ['title'],
  settings: ['title'],
  explore: ['combat'],
  combat: ['explore', 'reward', 'death', 'victory'],
  reward: ['explore'],
  death: ['title'],
  victory: ['title'],
};

export type FightOutcome = 'win' | 'defeat' | 'flee';

export interface FightResult {
  readonly room: number;
  readonly outcome: FightOutcome;
  /** The encounter's tier; a `guardian` win ends the run in victory. */
  readonly tier: RewardTier;
  /** Player hit points when the fight ended. Omitted keeps the run's hp (a defeat sets 0). */
  readonly playerHp?: number;
}

/** What the death and victory screens show. */
export interface RunSummary {
  readonly outcome: 'death' | 'victory';
  readonly seed: string;
  readonly roomsReached: number;
  readonly fightsWon: number;
  /** Cogs the run collected, all of which were banked. */
  readonly cogsEarned: number;
  /** Workshop balance after banking. */
  readonly bankTotal: number;
}

/** A treasure pickup opened while exploring, already applied to the run. */
export interface OpenedLoot {
  readonly room: number;
  readonly socketId: string;
  readonly loot: TreasureLoot;
}

/** A rest-room hearth used while exploring, already applied to the run. */
export interface UsedHearth {
  readonly room: number;
  readonly socketId: string;
  /** Hp actually restored, the figure the in-scene panel shows. */
  readonly healed: number;
  /** The run's hp after the heal. */
  readonly hp: number;
}

export type FlowEvent =
  | { readonly type: 'phase'; readonly from: FlowPhase; readonly to: FlowPhase }
  | { readonly type: 'workshop' }
  | ({ readonly type: 'loot' } & OpenedLoot)
  | ({ readonly type: 'hearth' } & UsedHearth);

export interface FlowOptions {
  workshop: WorkshopState;
  starterDeck: readonly string[];
  /** Card ids rewards draw from. */
  rewardPool: readonly string[];
}

/**
 * The pure game-flow machine. It owns the run across rooms: the run state from `createRun` with the
 * workshop's options, the cleared rooms, the pending reward, and banking the purse exactly once when
 * the run ends. Rendering, input and persistence observe it through `onChange`.
 */
export class RunFlow {
  private phaseValue: FlowPhase = 'title';
  private workshopValue: WorkshopState;
  private runValue: RunState | null = null;
  private offerValue: RewardOffer | null = null;
  private summaryValue: RunSummary | null = null;
  private lootValue: OpenedLoot | null = null;
  private hearthValue: UsedHearth | null = null;
  private readonly clearedRooms: number[] = [];
  private readonly reached = new Set<number>();
  private roomValue = 0;
  private readonly listeners = new Set<(event: FlowEvent) => void>();
  private readonly opts: FlowOptions;

  constructor(opts: FlowOptions) {
    this.opts = opts;
    this.workshopValue = opts.workshop;
  }

  get phase(): FlowPhase {
    return this.phaseValue;
  }
  get workshop(): WorkshopState {
    return this.workshopValue;
  }
  /** The run in progress, or null between runs. Kept on the death and victory screens. */
  get run(): RunState | null {
    return this.runValue;
  }
  /** The reward on screen in `reward`, otherwise null. */
  get offer(): RewardOffer | null {
    return this.offerValue;
  }
  get summary(): RunSummary | null {
    return this.summaryValue;
  }
  /** The treasure pickup opened last in this run, or null before the first one. */
  get lastLoot(): OpenedLoot | null {
    return this.lootValue;
  }
  /** The hearth used last in this run, or null before the first one. */
  get lastHearth(): UsedHearth | null {
    return this.hearthValue;
  }
  /** Whether the run already used the hearth at `socketId` in `room`. */
  isHearthUsed(room: number, socketId: string): boolean {
    return this.runValue?.usedHearths?.includes(lootKey(room, socketId)) ?? false;
  }
  /** Whether the run already opened the pickup at `socketId` in `room`. */
  isLootOpened(room: number, socketId: string): boolean {
    return this.runValue?.openedLoot?.includes(lootKey(room, socketId)) ?? false;
  }
  get cleared(): readonly number[] {
    return this.clearedRooms;
  }
  /** Room index the player last entered. */
  get room(): number {
    return this.roomValue;
  }
  /** True while a run is being played (explore, combat or reward). */
  get inRun(): boolean {
    return (
      this.phaseValue === 'explore' || this.phaseValue === 'combat' || this.phaseValue === 'reward'
    );
  }

  onChange(listener: (event: FlowEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  canTransition(to: FlowPhase): boolean {
    return FLOW_TRANSITIONS[this.phaseValue].includes(to);
  }

  openWorkshop(): boolean {
    return this.go('workshop');
  }

  openSettings(): boolean {
    return this.go('settings');
  }

  /** Leaves the workshop, the settings or a finished run's summary for the title. */
  toTitle(): boolean {
    if (this.inRun || this.phaseValue === 'title') return false;
    if (this.phaseValue === 'death' || this.phaseValue === 'victory') {
      this.runValue = null;
      this.offerValue = null;
    }
    return this.go('title');
  }

  /** Whether the next tier of `id` is affordable and not maxed. */
  canBuy(id: UpgradeId): boolean {
    const cost = nextCost(this.workshopValue, id);
    return cost !== null && this.workshopValue.cogsBanked >= cost;
  }

  /** Buys one tier in the workshop screen. Returns false (changing nothing) when it cannot. */
  buy(id: UpgradeId): boolean {
    if (this.phaseValue !== 'workshop' || !this.canBuy(id)) return false;
    this.workshopValue = buyUpgrade(this.workshopValue, id);
    this.emit({ type: 'workshop' });
    return true;
  }

  /** Starts a fresh run on `seed` from the title, with the workshop's upgrades applied. */
  newRun(seed: string): boolean {
    if (this.phaseValue !== 'title') return false;
    this.runValue = createRun(seed, this.opts.starterDeck, runOptionsFrom(this.workshopValue));
    this.resetRunBookkeeping(0, []);
    return this.go('explore');
  }

  /** Resumes a stored snapshot from the title, in its explore or reward phase. */
  continueRun(snapshot: RunSnapshot): boolean {
    if (this.phaseValue !== 'title') return false;
    const cleared = snapshot.clearedEncounters
      .map((id) => Number(id))
      .filter((n) => Number.isInteger(n) && n >= 0);
    this.runValue = snapshot.run;
    this.resetRunBookkeeping(snapshot.roomIndex, cleared);
    this.offerValue = snapshot.phase === 'reward' ? snapshot.pendingReward : null;
    return this.go(snapshot.phase);
  }

  /** Records the room the player stands in. */
  enterRoom(room: number): void {
    if (!this.inRun) return;
    this.roomValue = room;
    this.reached.add(room);
  }

  /** Exploration hands over to a fight. Ignored outside `explore`, so a dead run never fights again. */
  fightStarted(room: number): boolean {
    if (this.phaseValue !== 'explore' || this.clearedRooms.includes(room)) return false;
    this.enterRoom(room);
    return this.go('combat');
  }

  /**
   * A fight ended. A win clears the room and opens the reward, or ends the run in victory when the
   * guardian fell; a defeat ends the run in death; fleeing returns to exploring. Only acts in
   * `combat`, so a second end call for the same fight is a no-op.
   */
  fightEnded(result: FightResult): boolean {
    const run = this.runValue;
    if (this.phaseValue !== 'combat' || !run) return false;
    if (result.outcome === 'flee') {
      this.runValue = this.withHp(run, result.playerHp);
      return this.go('explore');
    }
    if (result.outcome === 'defeat') {
      this.runValue = { ...run, hp: 0 };
      return this.finish('death');
    }
    if (!this.clearedRooms.includes(result.room)) this.clearedRooms.push(result.room);
    const healed = this.withHp(run, result.playerHp);
    const rolled = rewardOffer(healed, result.tier, this.opts.rewardPool);
    if (result.tier === 'guardian') {
      // The run is over, so a card would never be played: pay the guardian purse and skip the card.
      this.runValue = chooseReward(rolled.run, rolled.offer, SKIP_REWARD);
      return this.finish('victory');
    }
    this.runValue = rolled.run;
    this.offerValue = rolled.offer;
    return this.go('reward');
  }

  /**
   * Opens a treasure pickup while exploring: rolls it from the `loot` stream, applies it to the run
   * and records it, so it can never open twice (a resumed run keeps it recorded). Returns what was
   * found, or null (changing nothing) outside `explore` or when it was already opened.
   */
  openLoot(room: number, socketId: string, kind: TreasureKind): TreasureLoot | null {
    const run = this.runValue;
    if (this.phaseValue !== 'explore' || !run) return null;
    const result = openTreasure(run, lootKey(room, socketId), kind, this.opts.rewardPool);
    if (!result) return null;
    this.runValue = result.run;
    this.lootValue = { room, socketId, loot: result.loot };
    this.emit({ type: 'loot', ...this.lootValue });
    return result.loot;
  }

  /**
   * Uses a rest-room hearth while exploring: heals the run by `hearthHeal` and records the hearth, so
   * it can never be used twice (a resumed run keeps it recorded). Returns what was used, or null
   * (changing nothing) outside `explore` or when it was already used.
   */
  useHearth(room: number, socketId: string): UsedHearth | null {
    const run = this.runValue;
    if (this.phaseValue !== 'explore' || !run) return null;
    const result = useHearth(run, lootKey(room, socketId));
    if (!result) return null;
    this.runValue = result.run;
    this.hearthValue = { room, socketId, healed: result.healed, hp: result.run.hp };
    this.emit({ type: 'hearth', ...this.hearthValue });
    return this.hearthValue;
  }

  /** Claims the reward on screen: its cogs always, plus the chosen card unless `'skip'`. */
  pickReward(choice: RewardChoice): boolean {
    const run = this.runValue;
    const offer = this.offerValue;
    if (this.phaseValue !== 'reward' || !run || !offer) return false;
    if (choice !== SKIP_REWARD && !offer.cards.includes(choice)) return false;
    this.runValue = chooseReward(run, offer, choice);
    this.offerValue = null;
    return this.go('explore');
  }

  /**
   * The resumable state at an explore or reward boundary, or null in any other phase. `roomIndex`
   * defaults to the last room entered.
   */
  snapshot(now: number = Date.now(), roomIndex: number = this.roomValue): RunSnapshot | null {
    const run = this.runValue;
    if (!run || (this.phaseValue !== 'explore' && this.phaseValue !== 'reward')) return null;
    return snapshotRun(
      run,
      {
        phase: this.phaseValue,
        floorSeed: run.seed,
        roomIndex,
        clearedEncounters: this.clearedRooms.map(String),
        pendingReward: this.phaseValue === 'reward' ? this.offerValue : null,
      },
      now,
    );
  }

  private withHp(run: RunState, hp: number | undefined): RunState {
    if (hp === undefined) return run;
    return { ...run, hp: Math.max(0, Math.min(run.maxHp, Math.round(hp))) };
  }

  private resetRunBookkeeping(room: number, cleared: readonly number[]): void {
    this.offerValue = null;
    this.summaryValue = null;
    this.lootValue = null;
    this.hearthValue = null;
    this.clearedRooms.length = 0;
    this.clearedRooms.push(...cleared);
    this.reached.clear();
    for (const r of [...cleared, room]) this.reached.add(r);
    this.roomValue = room;
  }

  /** Ends the run: banks the purse once and builds the summary. */
  private finish(outcome: 'death' | 'victory'): boolean {
    const run = this.runValue;
    if (!run) return false;
    this.workshopValue = bankRunCogs(this.workshopValue, run);
    this.offerValue = null;
    this.summaryValue = {
      outcome,
      seed: run.seed,
      roomsReached: this.reached.size,
      fightsWon: this.clearedRooms.length,
      cogsEarned: run.cogs,
      bankTotal: this.workshopValue.cogsBanked,
    };
    return this.go(outcome);
  }

  private go(to: FlowPhase): boolean {
    if (!this.canTransition(to)) return false;
    const from = this.phaseValue;
    this.phaseValue = to;
    this.emit({ type: 'phase', from, to });
    return true;
  }

  private emit(event: FlowEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}
