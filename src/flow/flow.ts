import {
  ENCOUNTER_CONTENT_VERSION,
  FOUNDRY_VERSION,
  PRESSURE_WORKS_VERSION,
} from '../combat/encounter-choice.ts';
import { LEGACY_REWARD_POOL, PERMANENT_CARD_IDS } from '../content/rewards.ts';
import type { FloorSnapshot, RunSnapshot } from '../persist/saves.ts';
import { snapshotRun } from '../persist/saves.ts';
import {
  DEFAULT_DIFFICULTY,
  type Difficulty,
  difficultyMaxHp,
  runDifficulty,
} from '../rules/difficulty.ts';
import { canFlee } from '../rules/flee.ts';
import {
  claimPressureReward,
  collectPressureNote,
  isPressureNoteId,
  openPressureDrawer,
  type PressureDials,
  type PressureNoteId,
  primePressure,
  readPressure,
  turnPressureValve,
} from '../rules/pressure.ts';
import {
  chooseReward,
  claimTreasure,
  createRun,
  floorSeedFor,
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
  buyPermanentCard,
  buyUpgrade,
  canBuyPermanentCard,
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
  | 'guardian-cleared'
  | 'death'
  | 'victory';

export const FLOW_TRANSITIONS: Readonly<Record<FlowPhase, readonly FlowPhase[]>> = {
  title: ['explore', 'reward', 'guardian-cleared', 'workshop', 'settings'],
  workshop: ['title'],
  settings: ['title'],
  explore: ['combat', 'victory', 'title'],
  combat: ['explore', 'reward', 'death', 'victory', 'title'],
  reward: ['explore', 'guardian-cleared'],
  'guardian-cleared': ['explore', 'victory', 'title'],
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
  /** The level the run was played on. */
  readonly difficulty: Difficulty;
  readonly roomsReached: number;
  readonly fightsWon: number;
  /** Cogs the run collected, all of which were banked. */
  readonly cogsEarned: number;
  /** Workshop balance after banking. */
  readonly bankTotal: number;
}

/**
 * A treasure pickup opened while exploring. Cogs are already paid; a card waits in the coffer
 * (`RunState.pendingLoot`) until `claimLoot`.
 */
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

export interface PressureTurnResultView {
  readonly type: 'pressure';
  readonly room: number;
  readonly action: 'note' | 'turn' | 'prime' | 'open' | 'claim';
  readonly note?: PressureNoteId;
  readonly dials: PressureDials;
  readonly solved: boolean;
  readonly notes: readonly PressureNoteId[];
  readonly drawerOpen: boolean;
  readonly rewardClaimed: boolean;
  readonly reward: 0 | 20;
}

/**
 * `'opened'`: a coffer was opened (`openLoot`). `'claimed'`: its pending card went into the deck
 * (`claimLoot`); `loot` is that card. Both are `'loot'` events, so the run is saved after either.
 */
export type LootStage = 'opened' | 'claimed';

export type FlowEvent =
  | { readonly type: 'phase'; readonly from: FlowPhase; readonly to: FlowPhase }
  | { readonly type: 'floor-travel'; readonly room: number }
  | { readonly type: 'workshop' }
  | ({ readonly type: 'loot'; readonly stage: LootStage } & OpenedLoot)
  | ({ readonly type: 'hearth' } & UsedHearth)
  | {
      readonly type: 'book-secret';
      readonly stage: 'key' | 'unlock' | 'cogs';
      readonly room: number;
      readonly cogs: number;
      readonly inscription: string;
    }
  | PressureTurnResultView;

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
  private guardianDefeatedValue = false;
  private summaryValue: RunSummary | null = null;
  private lootValue: OpenedLoot | null = null;
  private hearthValue: UsedHearth | null = null;
  private readonly clearedRooms: number[] = [];
  private readonly reached = new Set<number>();
  private roomValue = 0;
  private floorNumberValue = 1;
  private readonly floorStates = new Map<number, FloorSnapshot>();
  private readonly listeners = new Set<(event: FlowEvent) => void>();
  private readonly opts: FlowOptions;
  private contentVersionValue = ENCOUNTER_CONTENT_VERSION;

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
  get guardianDefeated(): boolean {
    return this.guardianDefeatedValue;
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
  get pressure(): ReturnType<typeof readPressure> {
    return readPressure(this.runValue ?? { pressure: undefined });
  }

  /** Records a pressure-room note once while exploring. */
  collectPressureNote(room: number, note: PressureNoteId): PressureTurnResultView | null {
    const run = this.runValue;
    if (
      this.phaseValue !== 'explore' ||
      this.contentVersionValue < PRESSURE_WORKS_VERSION ||
      !run ||
      !Number.isInteger(room) ||
      room < 0 ||
      !isPressureNoteId(note)
    )
      return null;
    const result = collectPressureNote(run, note);
    if (!result) return null;
    return this.applyPressureResult(room, result, 'note');
  }

  /** Turns one regulator valve without solving or paying. */
  turnPressureValve(room: number, valve: 0 | 1 | 2): PressureTurnResultView | null {
    const run = this.runValue;
    if (
      this.phaseValue !== 'explore' ||
      this.contentVersionValue < PRESSURE_WORKS_VERSION ||
      !run ||
      !Number.isInteger(room) ||
      room < 0 ||
      ![0, 1, 2].includes(valve)
    )
      return null;
    const result = turnPressureValve(run, valve);
    if (!result) return null;
    return this.applyPressureResult(room, result, 'turn');
  }

  /** Primes the regulator after all three lettered notes have been read and dials match. */
  primePressure(room: number): PressureTurnResultView | null {
    const run = this.runValue;
    if (
      this.phaseValue !== 'explore' ||
      this.contentVersionValue < PRESSURE_WORKS_VERSION ||
      !run ||
      !Number.isInteger(room) ||
      room < 0
    )
      return null;
    const result = primePressure(run);
    if (!result) return null;
    return this.applyPressureResult(room, result, 'prime');
  }

  /** Claims the solved regulator compartment once. */
  claimPressureReward(room: number): PressureTurnResultView | null {
    const run = this.runValue;
    if (
      this.phaseValue !== 'explore' ||
      this.contentVersionValue < PRESSURE_WORKS_VERSION ||
      !run ||
      !Number.isInteger(room) ||
      room < 0
    )
      return null;
    const result = claimPressureReward(run);
    if (!result) return null;
    return this.applyPressureResult(room, result, 'claim');
  }

  /** Opens the pressure reward drawer after the regulator has been primed. */
  openPressureDrawer(room: number): PressureTurnResultView | null {
    const run = this.runValue;
    if (
      this.phaseValue !== 'explore' ||
      this.contentVersionValue < PRESSURE_WORKS_VERSION ||
      !run ||
      !Number.isInteger(room) ||
      room < 0
    )
      return null;
    const result = openPressureDrawer(run);
    if (!result) return null;
    return this.applyPressureResult(room, result, 'open');
  }
  /** The card waiting to be claimed in the opened coffer at `socketId` in `room`, or null. */
  pendingCard(room: number, socketId: string): string | null {
    const key = lootKey(room, socketId);
    return this.runValue?.pendingLoot?.find((p) => p.key === key)?.card ?? null;
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
  get floorNumber(): number {
    return this.floorNumberValue;
  }
  get floorSeed(): string {
    return this.runValue ? floorSeedFor(this.runValue.seed, this.floorNumberValue) : '';
  }

  /** Changes floors only at an exploration boundary, preserving global deck, HP, purse and RNG. */
  travelToFloor(destination: 1 | 2, destinationRoom: number): boolean {
    const run = this.runValue;
    if (
      this.phaseValue !== 'explore' ||
      !run ||
      !Number.isInteger(destinationRoom) ||
      destinationRoom < 0
    )
      return false;
    if ((destination !== 1 && destination !== 2) || destination === this.floorNumberValue)
      return false;
    this.floorStates.set(this.floorNumberValue, this.archiveFloor());
    this.lootValue = null;
    this.hearthValue = null;
    const next = this.floorStates.get(destination) ?? {
      floorNumber: destination,
      floorSeed: floorSeedFor(run.seed, destination),
      clearedEncounters: [],
      reachedRooms: [destinationRoom],
    };
    this.floorStates.delete(destination);
    this.floorNumberValue = destination;
    this.restoreFloor(next, destinationRoom);
    this.emit({ type: 'floor-travel', room: destinationRoom });
    return true;
  }
  /** True while a run is being played, including the post-guardian exploration phase. */
  get inRun(): boolean {
    return (
      this.phaseValue === 'explore' ||
      this.phaseValue === 'combat' ||
      this.phaseValue === 'reward' ||
      this.phaseValue === 'guardian-cleared'
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
      this.guardianDefeatedValue = false;
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

  canBuyPermanentCard(id: string): boolean {
    return (
      this.phaseValue === 'workshop' &&
      canBuyPermanentCard(this.workshopValue, id, PERMANENT_CARD_IDS)
    );
  }

  buyPermanentCard(id: string): boolean {
    if (!this.canBuyPermanentCard(id)) return false;
    this.workshopValue = buyPermanentCard(this.workshopValue, id, PERMANENT_CARD_IDS);
    this.emit({ type: 'workshop' });
    return true;
  }

  /**
   * Starts a fresh run on `seed` from the title at `difficulty`, with the workshop's upgrades applied
   * and the level's player max hp on top. The level is stored on the run.
   */
  newRun(seed: string, difficulty: Difficulty = DEFAULT_DIFFICULTY): boolean {
    if (this.phaseValue !== 'title') return false;
    this.contentVersionValue = ENCOUNTER_CONTENT_VERSION;
    const base = runOptionsFrom(this.workshopValue);
    const deck = [...this.opts.starterDeck, ...this.workshopValue.permanentCards];
    this.runValue = createRun(seed, deck, {
      ...base,
      maxHp: difficultyMaxHp(base.maxHp, difficulty),
      difficulty,
    });
    this.resetRunBookkeeping(0, []);
    this.floorNumberValue = 1;
    this.floorStates.clear();
    return this.go('explore');
  }

  /** Resumes a stored snapshot from the title, in its explore or reward phase. */
  continueRun(snapshot: RunSnapshot): boolean {
    if (this.phaseValue !== 'title') return false;
    const cleared = snapshot.clearedEncounters
      .map((id) => Number(id))
      .filter((n) => Number.isInteger(n) && n >= 0);
    this.runValue = snapshot.run;
    this.contentVersionValue = snapshot.contentVersion ?? 1;
    this.floorNumberValue = snapshot.floorNumber ?? 1;
    this.floorStates.clear();
    for (const floor of snapshot.floors ?? []) this.floorStates.set(floor.floorNumber, floor);
    this.resetRunBookkeeping(snapshot.roomIndex, cleared);
    for (const room of snapshot.reachedRooms ?? []) this.reached.add(room);
    this.offerValue = snapshot.phase === 'reward' ? snapshot.pendingReward : null;
    this.guardianDefeatedValue =
      snapshot.guardianDefeated === true ||
      snapshot.phase === 'guardian-cleared' ||
      snapshot.pendingReward?.tier === 'guardian';
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
   * A fight ended. A win clears the room and opens the reward, including the guardian's required
   * card; claiming that card enters post-guardian exploration. A defeat ends the run in death; fleeing returns to exploring with the room still
   * uncleared and no reward, and is refused (changing nothing) for an elite or guardian fight
   * (`canFlee`). Only acts in `combat`, so a second end call for the same fight is a no-op.
   */
  fightEnded(result: FightResult): boolean {
    const run = this.runValue;
    if (this.phaseValue !== 'combat' || !run) return false;
    if (result.outcome === 'flee') {
      if (!canFlee(result.tier)) return false;
      this.runValue = this.withHp(run, result.playerHp);
      return this.go('explore');
    }
    if (result.outcome === 'defeat') {
      this.runValue = { ...run, hp: 0 };
      return this.finish('death');
    }
    if (!this.clearedRooms.includes(result.room)) this.clearedRooms.push(result.room);
    const healed = this.withHp(run, result.playerHp);
    const pool =
      this.contentVersionValue < FOUNDRY_VERSION ? LEGACY_REWARD_POOL : this.opts.rewardPool;
    const rolled = rewardOffer(healed, result.tier, pool);
    if (result.tier === 'guardian') this.guardianDefeatedValue = true;
    this.runValue = rolled.run;
    this.offerValue = rolled.offer;
    return this.go('reward');
  }

  /**
   * Opens a treasure pickup while exploring: rolls it from the `loot` stream and records it, so it
   * can never open twice (a resumed run keeps it recorded). Cogs are paid at once; a card waits in
   * the coffer for `claimLoot`. Returns what was found, or null (changing nothing) outside `explore`
   * or when it was already opened.
   */
  openLoot(room: number, socketId: string, kind: TreasureKind): TreasureLoot | null {
    const run = this.runValue;
    if (this.phaseValue !== 'explore' || !run) return null;
    const pool =
      this.contentVersionValue < FOUNDRY_VERSION ? LEGACY_REWARD_POOL : this.opts.rewardPool;
    const result = openTreasure(run, lootKey(room, socketId), kind, pool);
    if (!result) return null;
    this.runValue = result.run;
    this.lootValue = { room, socketId, loot: result.loot };
    this.emit({ type: 'loot', stage: 'opened', ...this.lootValue });
    return result.loot;
  }

  /**
   * Claims the card waiting in the opened coffer at `socketId` in `room` into the deck. Returns the
   * card id, or null (changing nothing) outside `explore` or when no card waits there (never
   * opened, a cog coffer, or already claimed).
   */
  claimLoot(room: number, socketId: string): string | null {
    const run = this.runValue;
    if (this.phaseValue !== 'explore' || !run) return null;
    const result = claimTreasure(run, lootKey(room, socketId));
    if (!result) return null;
    this.runValue = result.run;
    const loot: TreasureLoot = { kind: 'card', card: result.card };
    this.emit({ type: 'loot', stage: 'claimed', room, socketId, loot });
    return result.card;
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

  findBookSecretKey(room: number): boolean {
    const run = this.runValue;
    if (this.phaseValue !== 'explore' || !run || !Number.isInteger(room) || room < 0) return false;
    const keys = run.bookSecretKeyRooms ?? [];
    if (keys.includes(room) || (run.bookSecretOpenedRooms ?? []).includes(room)) return false;
    this.runValue = {
      ...run,
      bookSecretKeyRooms: [...keys, room],
    };
    this.emit({
      type: 'book-secret',
      stage: 'key',
      room,
      cogs: 0,
      inscription: 'Fits the lock below the shelves',
    });
    return true;
  }

  /** Uses a carried key to open the lower cabinet. */
  unlockBookSecret(room: number): boolean {
    const run = this.runValue;
    if (this.phaseValue !== 'explore' || !run) return false;
    const keys = run.bookSecretKeyRooms ?? [];
    const cabinets = run.bookSecretCabinetRooms ?? [];
    if (!keys.includes(room) || cabinets.includes(room)) return false;
    this.runValue = { ...run, bookSecretCabinetRooms: [...cabinets, room] };
    this.emit({
      type: 'book-secret',
      stage: 'unlock',
      room,
      cogs: 0,
      inscription: 'Collect the cogs inside',
    });
    return true;
  }

  /** Claims the cabinet's cogs once, after it has been unlocked. */
  claimBookSecret(room: number): boolean {
    const run = this.runValue;
    if (this.phaseValue !== 'explore' || !run) return false;
    const openedRooms = run.bookSecretOpenedRooms ?? [];
    if (!(run.bookSecretCabinetRooms ?? []).includes(room) || openedRooms.includes(room))
      return false;
    const cogs = 10;
    this.runValue = {
      ...run,
      cogs: run.cogs + cogs,
      bookSecretOpenedRooms: [...openedRooms, room],
    };
    this.emit({
      type: 'book-secret',
      stage: 'cogs',
      room,
      cogs,
      inscription: 'The clockmaker hid a cache for the one who noticed.',
    });
    return true;
  }

  /**
   * Gives up the run from explore or combat and returns to the title. The purse is banked as a
   * defeat banks it, and the run is dropped, so its snapshot is cleared and Continue cannot bring it
   * back. Returns false (changing nothing) in any other phase.
   */
  abandonRun(): boolean {
    const run = this.runValue;
    if (!run || (this.phaseValue !== 'explore' && this.phaseValue !== 'combat')) return false;
    this.workshopValue = bankRunCogs(this.workshopValue, run);
    this.runValue = null;
    this.offerValue = null;
    this.summaryValue = null;
    this.guardianDefeatedValue = false;
    return this.go('title');
  }

  /** Claims the reward on screen: its cogs always, plus the chosen card unless `'skip'`. */
  pickReward(choice: RewardChoice): boolean {
    const run = this.runValue;
    const offer = this.offerValue;
    if (this.phaseValue !== 'reward' || !run || !offer) return false;
    if (choice !== SKIP_REWARD && !offer.cards.includes(choice)) return false;
    if (offer.tier === 'guardian' && choice === SKIP_REWARD) return false;
    this.runValue = chooseReward(run, offer, choice);
    this.offerValue = null;
    return offer.tier === 'guardian' ? this.go('guardian-cleared') : this.go('explore');
  }

  /** Continues exploring after the guardian reward has been claimed. */
  exploreAfterGuardian(): boolean {
    return (
      this.guardianDefeatedValue && this.phaseValue === 'guardian-cleared' && this.go('explore')
    );
  }

  /** Ends a guardian-cleared run in victory, banking its purse exactly once. */
  finishVictory(): boolean {
    if (!this.guardianDefeatedValue) return false;
    if (this.phaseValue !== 'guardian-cleared' && this.phaseValue !== 'explore') return false;
    return this.finish('victory');
  }

  /**
   * The resumable state at an explore, reward or guardian-cleared boundary, or null in any other phase. `roomIndex`
   * defaults to the last room entered.
   */
  snapshot(now: number = Date.now(), roomIndex: number = this.roomValue): RunSnapshot | null {
    const run = this.runValue;
    const phase = this.phaseValue;
    if (!run || (phase !== 'explore' && phase !== 'reward' && phase !== 'guardian-cleared'))
      return null;
    return snapshotRun(
      run,
      {
        phase,
        floorSeed: this.floorSeed,
        roomIndex,
        clearedEncounters: this.clearedRooms.map(String),
        pendingReward: this.phaseValue === 'reward' ? this.offerValue : null,
        guardianDefeated: this.guardianDefeatedValue,
        contentVersion: this.contentVersionValue,
        floorNumber: this.floorNumberValue,
        reachedRooms: [...this.reached],
        floors: [...this.floorStates.values()],
      },
      now,
    );
  }

  private withHp(run: RunState, hp: number | undefined): RunState {
    if (hp === undefined) return run;
    return { ...run, hp: Math.max(0, Math.min(run.maxHp, Math.round(hp))) };
  }

  private applyPressureResult(
    room: number,
    result: {
      readonly run: RunState;
      readonly dials: PressureDials;
      readonly solved: boolean;
      readonly notes: readonly PressureNoteId[];
      readonly drawerOpen: boolean;
      readonly rewardClaimed: boolean;
      readonly reward: 0 | 20;
      readonly note?: PressureNoteId;
    },
    action: PressureTurnResultView['action'],
  ): PressureTurnResultView {
    this.enterRoom(room);
    this.runValue = result.run;
    const event: PressureTurnResultView = {
      type: 'pressure',
      room,
      action,
      ...(result.note === undefined ? {} : { note: result.note }),
      dials: result.dials,
      solved: result.solved,
      notes: result.notes,
      drawerOpen: result.drawerOpen,
      rewardClaimed: result.rewardClaimed,
      reward: result.reward,
    };
    this.emit(event);
    return event;
  }

  private resetRunBookkeeping(room: number, cleared: readonly number[]): void {
    this.offerValue = null;
    this.guardianDefeatedValue = false;
    this.summaryValue = null;
    this.lootValue = null;
    this.hearthValue = null;
    this.clearedRooms.length = 0;
    this.clearedRooms.push(...cleared);
    this.reached.clear();
    for (const r of [...cleared, room]) this.reached.add(r);
    this.roomValue = room;
  }

  private archiveFloor(): FloorSnapshot {
    const run = this.runValue;
    if (!run) throw new Error('cannot archive without a run');
    return {
      floorNumber: this.floorNumberValue,
      floorSeed: this.floorSeed,
      clearedEncounters: this.clearedRooms.map(String),
      reachedRooms: [...this.reached],
      guardianDefeated: this.guardianDefeatedValue,
      openedLoot: run.openedLoot,
      pendingLoot: run.pendingLoot,
      usedHearths: run.usedHearths,
      pressure: run.pressure,
      bookSecretOpenedRooms: run.bookSecretOpenedRooms,
      bookSecretKeyRooms: run.bookSecretKeyRooms,
      bookSecretCabinetRooms: run.bookSecretCabinetRooms,
    };
  }

  private restoreFloor(floor: FloorSnapshot, destinationRoom: number): void {
    const run = this.runValue;
    if (!run) return;
    const cleared = floor.clearedEncounters
      .map(Number)
      .filter((n) => Number.isInteger(n) && n >= 0);
    this.clearedRooms.length = 0;
    this.clearedRooms.push(...cleared);
    this.reached.clear();
    for (const room of floor.reachedRooms ?? [destinationRoom]) this.reached.add(room);
    this.reached.add(destinationRoom);
    this.roomValue = destinationRoom;
    this.offerValue = null;
    this.guardianDefeatedValue = floor.guardianDefeated === true;
    this.runValue = {
      ...run,
      floorSeed: floor.floorSeed,
      openedLoot: floor.openedLoot,
      pendingLoot: floor.pendingLoot,
      usedHearths: floor.usedHearths,
      pressure: floor.pressure,
      bookSecretOpenedRooms: floor.bookSecretOpenedRooms,
      bookSecretKeyRooms: floor.bookSecretKeyRooms,
      bookSecretCabinetRooms: floor.bookSecretCabinetRooms,
    };
  }

  /** Ends the run: banks the purse once and builds the summary. */
  private finish(outcome: 'death' | 'victory'): boolean {
    const run = this.runValue;
    if (!run || !this.canTransition(outcome)) return false;
    this.workshopValue = bankRunCogs(this.workshopValue, run);
    this.offerValue = null;
    this.summaryValue = {
      outcome,
      seed: run.seed,
      difficulty: runDifficulty(run),
      roomsReached: [...this.floorStates.values()].reduce(
        (n, f) => n + f.reachedRooms.length,
        this.reached.size,
      ),
      fightsWon: [...this.floorStates.values()].reduce(
        (n, f) => n + f.clearedEncounters.length,
        this.clearedRooms.length,
      ),
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
