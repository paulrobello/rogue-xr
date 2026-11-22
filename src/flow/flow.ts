import {
  ARMORY_ALCOVE_VERSION,
  BORROWED_LIGHT_VERSION,
  BRASS_CACHE_VERSION,
  CHARGE_CONTENT_VERSION,
  CRYSTAL_GAMBIT_VERSION,
  DARK_CIRCUIT_VERSION,
  DISPATCH_ROOM_VERSION,
  DRUM_GALLERY_VERSION,
  DUNGEON_CONTENT_VERSION,
  ECHO_GLYPH_VERSION,
  ENCOUNTER_CONTENT_VERSION,
  FLOAT_ELEVATOR_VERSION,
  FOUNDRY_VERSION,
  HIDDEN_PANEL_VERSION,
  LENS_FOCUS_VERSION,
  MECHANISM_CONTENT_VERSION,
  OVERDRIVE_CONTENT_VERSION,
  PATROL_VERSION,
  PENDULUM_GALLERY_VERSION,
  PRESSURE_WORKS_VERSION,
  PRISM_ANNEX_VERSION,
  RELIQUARY_VERSION,
  RETURN_PASSAGES_VERSION,
  SHADOW_STENCIL_VERSION,
  SPEAKING_PIPES_VERSION,
  SPRING_TENSION_VERSION,
  VALVEHOUSE_VERSION,
  WAVE_A_COMPLETE_VERSION,
  WAVE_A_REPAIR_VERSION,
  WAVE_B_CHAIN_VERSION,
  WAVE_B_DICE_VERSION,
} from '../combat/encounter-choice.ts';
import {
  CRYSTAL_GAMBIT_IDS,
  DUNGEON_REWARD_IDS,
  ECHO_GLYPH_IDS,
  LEGACY_REWARD_POOL,
  LENS_FOCUS_IDS,
  PERMANENT_CARD_IDS,
  WAVE_A_COMPLETE_IDS,
  WAVE_A_REPAIR_IDS,
  WAVE_B_CHAIN_IDS,
  WAVE_B_CHARGE_IDS,
  WAVE_B_DICE_IDS,
  WAVE_B_MECHANISM_IDS,
  WAVE_B_OVERDRIVE_IDS,
} from '../content/rewards.ts';
import { brassCacheForPlayableFloor } from '../floor/return-passages.ts';
import type { FloorSnapshot, RunSnapshot } from '../persist/saves.ts';
import { snapshotRun } from '../persist/saves.ts';
import {
  addFormulaIngredient,
  addIngredient,
  alchemyRecipe,
  applyPotion,
  collectIngredient,
  type FormulaClue,
  formulaObservation,
  type Ingredient,
  learnFormulaClue,
  readAlchemy,
  readConservatoryFormula,
  revealFormula,
  takePotion,
  unlatchArchive,
} from '../rules/alchemy.ts';
import {
  type BellFeedback,
  type BellNote,
  claimChimeReward,
  listenToChimes,
  strikeChime,
} from '../rules/bell-chimes.ts';
import { operateBorrowedLight, readBorrowedLight } from '../rules/borrowed-light.ts';
import {
  claimCalibrationCard,
  type GearId,
  insertCalibrationKey,
  readCalibration,
  repairCalibrationDrive,
  seatCalibrationGear,
  selectCalibrationGear,
  takeCalibrationChart,
  takeCalibrationKey,
  takeCalibrationSpare,
  turnCalibrationRing,
  windCalibration,
} from '../rules/calibration.ts';
import {
  acceptCommission,
  claimCommission,
  collectSpring,
  commissionSummary,
} from '../rules/commissions.ts';
import {
  counterweightPuzzle,
  hangCounterweight,
  readCounterweight,
} from '../rules/counterweight.ts';
import {
  type CircuitSocket,
  type DarkCircuitOutcome,
  type DarkCircuitState,
  readDarkCircuit,
  toggleCircuitBridge,
} from '../rules/dark-circuit.ts';
import {
  DEFAULT_DIFFICULTY,
  type Difficulty,
  difficultyMaxHp,
  runDifficulty,
} from '../rules/difficulty.ts';
import {
  openDispatch,
  readDispatch,
  type StoredDispatchState,
  sendDispatch,
  turnDispatch,
} from '../rules/dispatch.ts';
import {
  type DrumControl,
  type DrumGalleryState,
  drumPattern,
  readDrumGallery,
  setDrumPin,
  windDrum,
} from '../rules/drum-gallery.ts';
import { canFlee } from '../rules/flee.ts';
import { operateFloatElevator, readFloatElevator } from '../rules/float-elevator.ts';
import {
  isLogbookClueId,
  type LogbookClueId,
  type LogbookEntry,
  RUBBING_LOGBOOK_CLUE,
} from '../rules/logbook.ts';
import {
  advancePendulumDetent,
  completePendulumTrial,
  type PendulumGalleryState,
  readPendulumGallery,
} from '../rules/pendulum-gallery.ts';
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
  latchPrismReceiver,
  type PrismChannel,
  readPrismSignal,
  type StoredPrismState,
  turnPrism,
} from '../rules/prism-signal.ts';
import {
  type ReliquarySeal,
  readReliquary,
  reliquaryGlyph,
  rememberReliquary,
  submitReliquaryTrace,
} from '../rules/reliquary.ts';
import {
  chooseReward,
  claimTreasure,
  claimWindowCache,
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
  operateShadowStencil,
  readShadowStencil,
  type ShadowStencilControl,
  type ShadowStencilState,
} from '../rules/shadow-stencil.ts';
import {
  type PipeChannel,
  primeSpeakingPipes as primePipeState,
  readSpeakingPipes,
  selectSpeakingPipe,
} from '../rules/speaking-pipes.ts';
import {
  operateSpringTension,
  readSpringTension,
  type SpringTensionOutcome,
} from '../rules/spring-tension.ts';
import type {
  FloatElevatorControl,
  FloatElevatorState,
  SpeakingPipesState,
  SpringTensionControl,
  SpringTensionState,
  StoredHiddenPanelState,
} from '../rules/types.ts';
import {
  collectValvehouse,
  readValvehouse,
  seatValvehouse,
  testValvehouse,
  type ValvehouseState,
} from '../rules/valvehouse.ts';
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
import { matchesReliquaryGlyph } from '../sigil/reliquary-trace.ts';

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
  readonly patrol?: boolean;
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
export interface CommissionEvent {
  readonly type: 'commission';
  readonly action: 'accept' | 'spring' | 'claim';
  readonly id?: 0 | 1 | 2;
}

export interface CounterweightResultView {
  readonly type: 'counterweight';
  readonly room: number;
  readonly weight: 0 | 1 | null;
  readonly solved: boolean;
  readonly correct: boolean;
}
export interface AlchemyEvent {
  readonly type: 'alchemy';
  readonly action: 'collect' | 'add' | 'take-potion' | 'apply';
  readonly ingredient?: Ingredient;
  readonly correct?: boolean;
  readonly brewed: boolean;
  readonly opened: boolean;
}

export interface BellChimeEvent {
  readonly type: 'bell-chimes';
  readonly feedback: BellFeedback;
}
export interface PrismSignalEvent {
  readonly type: 'prism-signal';
  readonly result: 'turn' | 'matched' | 'mistake' | 'solved';
  readonly channel?: PrismChannel;
  readonly state: StoredPrismState;
}

export interface DispatchEvent {
  readonly type: 'dispatch';
  readonly action: 'turn' | 'send' | 'open';
  readonly result?: 'misrouted' | 'sent';
  readonly state: StoredDispatchState;
}
export interface SpeakingPipesEvent {
  readonly type: 'speaking-pipes';
  readonly action: 'prime' | 'open';
  readonly state: SpeakingPipesState;
}
export interface ReliquaryEvent {
  readonly type: 'reliquary';
  readonly action: 'remember' | 'open';
}
export interface PendulumGalleryEvent {
  readonly type: 'pendulum-gallery';
  readonly action: 'advance' | 'trial';
  readonly result?: 'ignored' | 'wrong' | 'opened';
  readonly state: PendulumGalleryState;
}
export interface BorrowedLightEvent {
  readonly type: 'borrowed-light';
  readonly result: 'ignored' | 'adjusted' | 'opened';
}
export interface FloatElevatorEvent {
  readonly type: 'float-elevator';
  readonly result: 'ignored' | 'adjusted' | 'released';
  readonly state: FloatElevatorState;
}
export interface ShadowStencilEvent {
  readonly type: 'shadow-stencil';
  readonly result: 'moved' | 'released' | 'ignored';
  readonly state: ShadowStencilState;
}
export interface SpringTensionEvent {
  readonly type: 'spring-tension';
  readonly action: SpringTensionControl;
  readonly outcome: SpringTensionOutcome;
  readonly state: SpringTensionState;
}

/**
 * `'opened'`: a coffer was opened (`openLoot`). `'claimed'`: its pending card went into the deck
 * (`claimLoot`); `loot` is that card. Both are `'loot'` events, so the run is saved after either.
 */
export type LootStage = 'opened' | 'claimed';

export type FlowEvent =
  | { readonly type: 'logbook'; readonly clue: LogbookClueId }
  | { readonly type: 'phase'; readonly from: FlowPhase; readonly to: FlowPhase }
  | { readonly type: 'floor-travel'; readonly room: number }
  | { readonly type: 'room-entered'; readonly room: number }
  | { readonly type: 'workshop' }
  | { readonly type: 'armory-awakened' }
  | ({ readonly type: 'loot'; readonly stage: LootStage } & OpenedLoot)
  | BorrowedLightEvent
  | FloatElevatorEvent
  | ShadowStencilEvent
  | SpringTensionEvent
  | { readonly type: 'dark-circuit' }
  | { readonly type: 'drum-gallery' }
  | ({ readonly type: 'hearth' } & UsedHearth)
  | {
      readonly type: 'book-secret';
      readonly stage: 'key' | 'unlock' | 'cogs';
      readonly room: number;
      readonly cogs: number;
      readonly inscription: string;
    }
  | {
      readonly type: 'calibration';
      readonly action:
        | 'chart'
        | 'key'
        | 'insert'
        | 'spare'
        | 'repair'
        | 'adjust'
        | 'solve'
        | 'claim';
    }
  | PressureTurnResultView
  | CommissionEvent
  | CounterweightResultView
  | AlchemyEvent
  | { readonly type: 'formula' }
  | HiddenPanelEvent
  | BellChimeEvent
  | PrismSignalEvent
  | DispatchEvent
  | SpeakingPipesEvent
  | ReliquaryEvent
  | PendulumGalleryEvent
  | { readonly type: 'brass-key'; readonly action: 'inspect' | 'take' | 'unlock' }
  | {
      readonly type: 'valvehouse';
      readonly action: 'collect' | 'seat' | 'test';
      readonly result: 'held' | 'seated' | 'leak' | 'opened';
    }
  | {
      readonly type: 'window-cache';
      readonly cogs: number;
      readonly from: 'explore';
      readonly to: 'explore';
    };
export interface HiddenPanelEvent {
  readonly type: 'hidden-panel';
  readonly action: 'discover' | 'open';
}

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

  get logbookEntries(): readonly LogbookEntry[] {
    return this.runValue?.logbook ?? [];
  }

  saveLogbookClue(entry: LogbookEntry): boolean {
    const id = entry.id;
    const run = this.runValue;
    if (!run || !isLogbookClueId(id)) return false;
    const discovered =
      id === RUBBING_LOGBOOK_CLUE
        ? run.reliquarySeal !== undefined && run.reliquarySeal !== 'hidden'
        : this.pressure.notes.includes(id);
    if (!discovered) return false;
    const entries = run.logbook ?? [];
    if (entries.some((item) => item.id === id)) return true;
    this.runValue = { ...run, logbook: [...entries, entry] };
    this.emit({ type: 'logbook', clue: id });
    return true;
  }
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
  private brassCacheLookup?: { seed: string; target?: { room: number; socketId: string } };

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
  get prismSignal(): StoredPrismState {
    return readPrismSignal(this.runValue ?? { prismSignal: undefined });
  }
  get pendulumGallery(): PendulumGalleryState {
    return readPendulumGallery(this.runValue ?? { pendulumGallery: undefined });
  }
  get borrowedLight() {
    return readBorrowedLight(this.runValue ?? { seed: '', borrowedLight: undefined });
  }
  get floatElevator(): FloatElevatorState {
    return readFloatElevator(this.runValue ?? {});
  }
  get shadowStencil(): ShadowStencilState {
    return readShadowStencil(this.runValue ?? {});
  }
  get springTension(): SpringTensionState {
    return readSpringTension(this.runValue ?? {});
  }
  get darkCircuit(): DarkCircuitState {
    return readDarkCircuit(this.runValue ?? {});
  }
  get drumGallery(): DrumGalleryState {
    return readDrumGallery(this.runValue ?? {});
  }
  operateDrumGallery(action: DrumControl): boolean {
    const run = this.runValue;
    if (
      !run ||
      this.phaseValue !== 'explore' ||
      this.floorNumberValue !== 3 ||
      this.contentVersionValue < DRUM_GALLERY_VERSION
    )
      return false;
    const state = this.drumGallery;
    const pattern = drumPattern(run.seed);
    const next =
      action.kind === 'wind' ? windDrum(pattern, state) : setDrumPin(pattern, state, action.pin);
    if (next !== state) {
      this.runValue = { ...run, drumGallery: next };
      this.emit({ type: 'drum-gallery' });
    }
    return action.kind === 'wind' || next !== state;
  }
  toggleCircuitBridge(socket: CircuitSocket): DarkCircuitOutcome {
    const run = this.runValue;
    if (
      !run ||
      this.phaseValue !== 'explore' ||
      this.floorNumberValue !== 2 ||
      this.contentVersionValue < DARK_CIRCUIT_VERSION
    )
      return 'ignored';
    const state = this.darkCircuit;
    const result = toggleCircuitBridge(run.seed, state, socket);
    if (result.state !== state) {
      this.runValue = { ...run, darkCircuit: result.state };
      this.emit({ type: 'dark-circuit' });
    }
    return result.outcome;
  }
  operateSpringTension(action: SpringTensionControl): SpringTensionOutcome {
    if (
      !this.runValue ||
      this.phaseValue !== 'explore' ||
      this.floorNumberValue !== 2 ||
      this.contentVersionValue < SPRING_TENSION_VERSION
    )
      return 'ignored';
    const result = operateSpringTension(this.runValue.seed, this.springTension, action);
    if (result.outcome !== 'ignored') {
      this.runValue = { ...this.runValue, springTension: result.state };
      this.emit({ type: 'spring-tension', action, outcome: result.outcome, state: result.state });
    }
    return result.outcome;
  }
  operateShadowStencil(control: ShadowStencilControl): 'moved' | 'released' | 'ignored' {
    if (
      !this.runValue ||
      this.phaseValue !== 'explore' ||
      this.floorNumberValue !== 1 ||
      this.contentVersionValue < SHADOW_STENCIL_VERSION
    )
      return 'ignored';
    const state = this.shadowStencil;
    const next = operateShadowStencil(this.runValue.seed, state, control);
    if (next === state) return 'ignored';
    this.runValue = { ...this.runValue, shadowStencil: next };
    const result = next.opened && !state.opened ? 'released' : 'moved';
    this.emit({ type: 'shadow-stencil', result, state: next });
    return result;
  }
  operateFloatElevator(control: FloatElevatorControl): 'ignored' | 'adjusted' | 'released' {
    if (
      !this.runValue ||
      this.phaseValue !== 'explore' ||
      this.floorNumberValue !== 1 ||
      this.contentVersionValue < FLOAT_ELEVATOR_VERSION
    )
      return 'ignored';
    const state = this.floatElevator;
    const next = operateFloatElevator(this.runValue.seed, state, control);
    if (next === state) return 'ignored';
    this.runValue = { ...this.runValue, floatElevator: next };
    this.emit({
      type: 'float-elevator',
      result: control === 'take' ? 'released' : 'adjusted',
      state: next,
    });
    return control === 'take' ? 'released' : 'adjusted';
  }
  operateBorrowedLight(control: 0 | 1 | 'reset'): 'ignored' | 'adjusted' | 'opened' {
    if (
      !this.runValue ||
      this.phaseValue !== 'explore' ||
      this.floorNumberValue !== 3 ||
      this.contentVersionValue < BORROWED_LIGHT_VERSION
    )
      return 'ignored';
    const state = this.borrowedLight;
    const next = operateBorrowedLight(this.runValue.seed, state, control);
    if (next === state) return 'ignored';
    this.runValue = { ...this.runValue, borrowedLight: next };
    const result = next.open && !state.open ? 'opened' : 'adjusted';
    this.emit({ type: 'borrowed-light', result });
    return result;
  }
  advancePendulumDetent(): boolean {
    if (
      !this.runValue ||
      this.phaseValue !== 'explore' ||
      this.floorNumberValue !== 3 ||
      this.contentVersionValue < PENDULUM_GALLERY_VERSION ||
      this.pendulumGallery.open
    )
      return false;
    const next = advancePendulumDetent(this.pendulumGallery);
    this.runValue = { ...this.runValue, pendulumGallery: next };
    this.emit({ type: 'pendulum-gallery', action: 'advance', state: next });
    return true;
  }
  completePendulumTrial(): 'ignored' | 'wrong' | 'opened' {
    if (
      !this.runValue ||
      this.phaseValue !== 'explore' ||
      this.floorNumberValue !== 3 ||
      this.contentVersionValue < PENDULUM_GALLERY_VERSION
    )
      return 'ignored';
    const result = completePendulumTrial(this.runValue);
    if (result.run !== this.runValue) {
      this.runValue = result.run;
      this.emit({
        type: 'pendulum-gallery',
        action: 'trial',
        result: result.result,
        state: this.pendulumGallery,
      });
    }
    return result.result;
  }
  turnPrism(): boolean {
    if (
      !this.runValue ||
      this.phaseValue !== 'explore' ||
      this.floorNumberValue !== 3 ||
      this.contentVersionValue < PRISM_ANNEX_VERSION
    )
      return false;
    const next = turnPrism(this.prismSignal);
    if (next === this.prismSignal) return false;
    this.runValue = { ...this.runValue, prismSignal: next };
    this.emit({ type: 'prism-signal', result: 'turn', state: next });
    return true;
  }
  latchPrismReceiver(channel: PrismChannel): 'matched' | 'mistake' | 'solved' | null {
    if (
      !this.runValue ||
      this.phaseValue !== 'explore' ||
      this.floorNumberValue !== 3 ||
      this.contentVersionValue < PRISM_ANNEX_VERSION
    )
      return null;
    const result = latchPrismReceiver(this.runValue, channel);
    if (!result) return null;
    this.runValue = result.run;
    this.emit({
      type: 'prism-signal',
      result: result.result,
      channel,
      state: result.run.prismSignal ?? this.prismSignal,
    });
    return result.result;
  }
  get dispatch(): StoredDispatchState {
    return readDispatch(this.runValue ?? { dispatch: undefined });
  }
  get speakingPipes(): SpeakingPipesState {
    return readSpeakingPipes(this.runValue ?? { speakingPipes: undefined });
  }
  get reliquarySeal(): ReliquarySeal {
    return readReliquary(this.runValue ?? { reliquarySeal: undefined });
  }
  get valvehouse(): ValvehouseState {
    return readValvehouse(this.runValue ?? {});
  }
  collectValvehouseGasket(): boolean {
    if (
      !this.runValue ||
      this.phaseValue !== 'explore' ||
      this.floorNumberValue !== 1 ||
      this.contentVersionValue < VALVEHOUSE_VERSION
    )
      return false;
    const next = collectValvehouse(this.runValue);
    if (!next) return false;
    this.runValue = { ...this.runValue, valvehouse: next };
    this.emit({ type: 'valvehouse', action: 'collect', result: 'held' });
    return true;
  }
  seatValvehouseGasket(): boolean {
    if (
      !this.runValue ||
      this.phaseValue !== 'explore' ||
      this.floorNumberValue !== 1 ||
      this.contentVersionValue < VALVEHOUSE_VERSION
    )
      return false;
    const next = seatValvehouse(this.runValue);
    if (!next) return false;
    this.runValue = { ...this.runValue, valvehouse: next };
    this.emit({ type: 'valvehouse', action: 'seat', result: 'seated' });
    return true;
  }
  testValvehousePressure(): 'ignored' | 'leak' | 'opened' {
    if (
      !this.runValue ||
      this.phaseValue !== 'explore' ||
      this.floorNumberValue !== 1 ||
      this.contentVersionValue < VALVEHOUSE_VERSION
    )
      return 'ignored';
    const next = testValvehouse(this.runValue);
    if (!next) {
      return this.valvehouse === 'open' ? 'ignored' : 'leak';
    }
    this.runValue = { ...this.runValue, valvehouse: next };
    this.emit({ type: 'valvehouse', action: 'test', result: 'opened' });
    return 'opened';
  }
  rememberReliquaryRubbing(): boolean {
    if (
      !this.runValue ||
      this.phaseValue !== 'explore' ||
      this.floorNumberValue !== 2 ||
      this.contentVersionValue < RELIQUARY_VERSION
    )
      return false;
    const next = rememberReliquary(this.runValue);
    if (!next) return false;
    this.runValue = next;
    this.emit({ type: 'reliquary', action: 'remember' });
    return true;
  }
  submitReliquaryTrace(
    points: readonly { readonly x: number; readonly y: number }[],
  ): 'ignored' | 'wrong' | 'opened' {
    if (
      !this.runValue ||
      this.phaseValue !== 'explore' ||
      this.floorNumberValue !== 2 ||
      this.contentVersionValue < RELIQUARY_VERSION
    )
      return 'ignored';
    if (this.reliquarySeal !== 'known') return 'ignored';
    const glyph = reliquaryGlyph(this.runValue.seed);
    const result = submitReliquaryTrace(this.runValue, matchesReliquaryGlyph(points, glyph.points));
    if (!result) return 'ignored';
    this.runValue = result.run;
    if (result.result === 'opened') this.emit({ type: 'reliquary', action: 'open' });
    return result.result;
  }
  primeSpeakingPipes(): boolean {
    if (
      !this.runValue ||
      this.phaseValue !== 'explore' ||
      this.floorNumberValue !== 2 ||
      this.contentVersionValue < SPEAKING_PIPES_VERSION
    )
      return false;
    const before = this.speakingPipes;
    const next = primePipeState(this.runValue);
    if (!next) return false;
    this.runValue = next;
    if (before === 'idle')
      this.emit({ type: 'speaking-pipes', action: 'prime', state: this.speakingPipes });
    return true;
  }
  selectSpeakingPipe(channel: PipeChannel): 'ignored' | 'wrong' | 'opened' {
    if (
      !this.runValue ||
      this.phaseValue !== 'explore' ||
      this.floorNumberValue !== 2 ||
      this.contentVersionValue < SPEAKING_PIPES_VERSION
    )
      return 'ignored';
    const result = selectSpeakingPipe(this.runValue, channel);
    if (!result) return 'ignored';
    this.runValue = result.run;
    if (result.result === 'opened')
      this.emit({ type: 'speaking-pipes', action: 'open', state: this.speakingPipes });
    return result.result;
  }
  turnDispatch(): boolean {
    if (
      !this.runValue ||
      this.phaseValue !== 'explore' ||
      this.floorNumberValue !== 2 ||
      this.contentVersionValue < DISPATCH_ROOM_VERSION
    )
      return false;
    const next = turnDispatch(this.dispatch);
    if (next === this.dispatch) return false;
    this.runValue = { ...this.runValue, dispatch: next };
    this.emit({ type: 'dispatch', action: 'turn', state: next });
    return true;
  }
  sendDispatch(): 'misrouted' | 'sent' | null {
    if (
      !this.runValue ||
      this.phaseValue !== 'explore' ||
      this.floorNumberValue !== 2 ||
      this.contentVersionValue < DISPATCH_ROOM_VERSION
    )
      return null;
    const result = sendDispatch(this.runValue);
    if (!result) return null;
    this.runValue = result.run;
    this.emit({ type: 'dispatch', action: 'send', result: result.result, state: this.dispatch });
    return result.result;
  }
  openDispatch(): boolean {
    if (
      !this.runValue ||
      this.phaseValue !== 'explore' ||
      this.floorNumberValue !== 2 ||
      this.contentVersionValue < DISPATCH_ROOM_VERSION
    )
      return false;
    const next = openDispatch(this.runValue);
    if (!next) return false;
    this.runValue = next;
    this.emit({ type: 'dispatch', action: 'open', state: this.dispatch });
    return true;
  }
  get commission(): ReturnType<typeof commissionSummary> {
    const powered =
      this.floorNumberValue === 1
        ? this.pressure.solved
        : this.floorStates.get(1)?.pressure?.solved === true;
    return commissionSummary(this.runValue ?? { seed: '00000000' }, powered);
  }
  acceptCommission(): boolean {
    if (
      !this.runValue ||
      this.phaseValue !== 'explore' ||
      this.floorNumberValue !== 1 ||
      this.contentVersionValue < RETURN_PASSAGES_VERSION
    )
      return false;
    return this.applyCommission(acceptCommission(this.runValue), {
      type: 'commission',
      action: 'accept',
    });
  }
  collectSpring(id: 0 | 1 | 2): boolean {
    if (
      !this.runValue ||
      this.phaseValue !== 'explore' ||
      this.contentVersionValue < RETURN_PASSAGES_VERSION ||
      this.floorNumberValue !== (id === 2 ? 2 : 1)
    )
      return false;
    return this.applyCommission(collectSpring(this.runValue, id), {
      type: 'commission',
      action: 'spring',
      id,
    });
  }
  claimCommission(): boolean {
    if (
      !this.runValue ||
      this.phaseValue !== 'explore' ||
      this.floorNumberValue !== 1 ||
      this.contentVersionValue < RETURN_PASSAGES_VERSION
    )
      return false;
    return this.applyCommission(claimCommission(this.runValue, this.pressure.solved), {
      type: 'commission',
      action: 'claim',
    });
  }
  private applyCommission(next: RunState | null, event: CommissionEvent): boolean {
    if (!next) return false;
    this.runValue = next;
    this.emit(event);
    return true;
  }
  get hiddenPanel(): StoredHiddenPanelState {
    return this.runValue?.hiddenPanel ?? { discovered: false, opened: false };
  }
  discoverHiddenPanel(): boolean {
    if (
      this.phaseValue !== 'explore' ||
      !this.runValue ||
      this.floorNumberValue !== 2 ||
      this.contentVersionValue < HIDDEN_PANEL_VERSION ||
      this.hiddenPanel.discovered
    )
      return false;
    this.runValue = { ...this.runValue, hiddenPanel: { ...this.hiddenPanel, discovered: true } };
    this.emit({ type: 'hidden-panel', action: 'discover' });
    return true;
  }
  openHiddenPanel(): boolean {
    if (
      this.phaseValue !== 'explore' ||
      !this.runValue ||
      this.floorNumberValue !== 2 ||
      this.contentVersionValue < HIDDEN_PANEL_VERSION ||
      !this.hiddenPanel.discovered ||
      this.hiddenPanel.opened
    )
      return false;
    this.runValue = { ...this.runValue, hiddenPanel: { ...this.hiddenPanel, opened: true } };
    this.emit({ type: 'hidden-panel', action: 'open' });
    return true;
  }

  get calibration(): ReturnType<typeof readCalibration> {
    return readCalibration(this.runValue ?? { seed: '00000000' });
  }
  private calibrationRun(floor: number): RunState | null {
    return this.phaseValue === 'explore' &&
      this.floorNumberValue === floor &&
      this.contentVersionValue >= RETURN_PASSAGES_VERSION
      ? this.runValue
      : null;
  }
  private applyCalibration(
    next: RunState | null,
    action: Extract<FlowEvent, { type: 'calibration' }>['action'],
  ): boolean {
    if (!next) return false;
    this.runValue = next;
    this.emit({ type: 'calibration', action });
    return true;
  }
  takeCalibrationChart(): boolean {
    const r = this.calibrationRun(1);
    return !!r && this.pressure.solved && this.applyCalibration(takeCalibrationChart(r), 'chart');
  }
  takeCalibrationSpare(): boolean {
    const r = this.calibrationRun(1);
    return !!r && this.pressure.solved && this.applyCalibration(takeCalibrationSpare(r), 'spare');
  }
  takeCalibrationKey(): boolean {
    const r = this.calibrationRun(2);
    return !!r && this.applyCalibration(takeCalibrationKey(r), 'key');
  }
  insertCalibrationKey(): boolean {
    const r = this.calibrationRun(2);
    return !!r && this.applyCalibration(insertCalibrationKey(r), 'insert');
  }
  repairCalibrationDrive(): boolean {
    const r = this.calibrationRun(2);
    return !!r && this.applyCalibration(repairCalibrationDrive(r), 'repair');
  }
  selectCalibrationGear(id: GearId): boolean {
    const r = this.calibrationRun(2);
    return !!r && this.applyCalibration(selectCalibrationGear(r, id), 'adjust');
  }
  seatCalibrationGear(slot: GearId): boolean {
    const r = this.calibrationRun(2);
    return !!r && this.applyCalibration(seatCalibrationGear(r, slot), 'adjust');
  }
  turnCalibrationRing(id: GearId): boolean {
    const r = this.calibrationRun(2);
    return !!r && this.applyCalibration(turnCalibrationRing(r, id), 'adjust');
  }
  windCalibration(): 'solved' | 'stalled' | null {
    const r = this.calibrationRun(2);
    if (!r) return null;
    const next = windCalibration(r);
    if (!next) return null;
    if (next === r) return 'stalled';
    this.applyCalibration(next, 'solve');
    return 'solved';
  }
  claimCalibrationCard(): string | null {
    const r = this.calibrationRun(1);
    if (!r || !this.pressure.solved) return null;
    const result = claimCalibrationCard(r);
    if (!result) return null;
    this.applyCalibration(result.run, 'claim');
    return result.card;
  }
  get counterweight(): Omit<ReturnType<typeof readCounterweight>, 'selected'> & {
    readonly selected: 0 | 1 | null;
  } {
    const state = readCounterweight(this.runValue ?? { counterweight: undefined });
    return { ...state, selected: state.selected ?? null };
  }

  get counterweightPuzzle(): ReturnType<typeof counterweightPuzzle> {
    return counterweightPuzzle(this.runValue?.seed ?? '00000000');
  }

  get alchemy(): ReturnType<typeof readAlchemy> {
    return readAlchemy(this.runValue ?? { alchemy: undefined });
  }
  get alchemyRecipe(): readonly [Ingredient, Ingredient] {
    return alchemyRecipe(this.runValue?.seed ?? '00000000');
  }
  get conservatoryFormula(): ReturnType<typeof readConservatoryFormula> {
    return readConservatoryFormula(this.runValue ?? { seed: '00000000' });
  }
  describeFormulaClue(clue: FormulaClue): string {
    return formulaObservation(this.runValue?.seed ?? '00000000', clue, this.contentVersionValue);
  }
  learnFormulaClue(clue: FormulaClue): boolean {
    const run = this.runValue;
    if (
      !run ||
      this.phaseValue !== 'explore' ||
      this.floorNumberValue !== (clue === 'portrait' ? 3 : 2)
    )
      return false;
    return this.applyFormula(learnFormulaClue(run, clue));
  }
  addFormulaIngredient(
    ingredient: Ingredient,
    inStillInterval: boolean,
  ): 'correct' | 'mistake' | 'waiting' | null {
    if (!this.runValue || this.phaseValue !== 'explore' || this.floorNumberValue !== 3) return null;
    const result = addFormulaIngredient(
      this.runValue,
      ingredient,
      inStillInterval,
      this.contentVersionValue,
    );
    if (!result) return null;
    if (result.waiting) return 'waiting';
    this.applyFormula(result.run);
    return result.correct ? 'correct' : 'mistake';
  }
  useFormula(action: 'pour' | 'unlatch'): boolean {
    if (!this.runValue || this.phaseValue !== 'explore' || this.floorNumberValue !== 3)
      return false;
    return this.applyFormula(
      action === 'pour' ? revealFormula(this.runValue) : unlatchArchive(this.runValue),
    );
  }
  private applyFormula(next: RunState | null): boolean {
    if (!next) return false;
    this.runValue = next;
    this.emit({ type: 'formula' });
    return true;
  }
  collectIngredient(ingredient: Ingredient): boolean {
    const run = this.runValue;
    if (this.phaseValue !== 'explore' || !run || this.floorNumberValue !== 3) return false;
    const next = collectIngredient(run, ingredient, this.contentVersionValue);
    if (!next) return false;
    this.runValue = next;
    this.emit({
      type: 'alchemy',
      action: 'collect',
      ingredient,
      brewed: this.alchemy.brewed,
      opened: this.alchemy.opened,
    });
    return true;
  }
  addIngredient(ingredient: Ingredient): 'correct' | 'mistake' | null {
    const run = this.runValue;
    if (this.phaseValue !== 'explore' || !run || this.floorNumberValue !== 3) return null;
    const result = addIngredient(run, ingredient);
    if (!result) return null;
    this.runValue = result.run;
    this.emit({
      type: 'alchemy',
      action: 'add',
      ingredient,
      correct: result.correct,
      brewed: this.alchemy.brewed,
      opened: this.alchemy.opened,
    });
    return result.correct ? 'correct' : 'mistake';
  }
  takePotion(): boolean {
    const run = this.runValue;
    if (this.phaseValue !== 'explore' || !run || this.floorNumberValue !== 3) return false;
    const next = takePotion(run);
    if (!next) return false;
    this.runValue = next;
    const { brewed, opened } = this.alchemy;
    this.emit({ type: 'alchemy', action: 'take-potion', brewed, opened });
    return true;
  }
  applyPotion(): boolean {
    const run = this.runValue;
    if (this.phaseValue !== 'explore' || !run || this.floorNumberValue !== 3) return false;
    const next = applyPotion(run);
    if (!next) return false;
    this.runValue = next;
    this.emit({ type: 'alchemy', action: 'apply', brewed: true, opened: true });
    return true;
  }

  weighCounterweight(weight: 0 | 1): boolean {
    const run = this.runValue;
    if (
      this.phaseValue !== 'explore' ||
      !run ||
      this.contentVersionValue < RETURN_PASSAGES_VERSION ||
      this.floorNumberValue !== 2 ||
      run.counterweight?.solved
    )
      return false;
    this.runValue = { ...run, counterweight: { ...readCounterweight(run), selected: weight } };
    this.emit({
      type: 'counterweight',
      room: this.roomValue,
      weight,
      solved: false,
      correct: false,
    });
    return true;
  }

  hangCounterweight(room = this.roomValue): 'solved' | 'mistake' | null {
    const run = this.runValue;
    if (this.phaseValue !== 'explore' || !run || this.floorNumberValue !== 2) return null;
    const selected = readCounterweight(run).selected;
    if (selected === undefined) return null;
    const result = hangCounterweight(run, selected);
    if (!result) return null;
    this.enterRoom(room);
    this.runValue = result.run;
    const event: CounterweightResultView = {
      type: 'counterweight',
      room,
      weight: selected,
      solved: result.solved,
      correct: result.correct,
    };
    this.emit(event);
    return result.solved ? 'solved' : 'mistake';
  }

  canEnterPuzzleGate(gate: 'pressure' | 'counterweight'): boolean {
    return gate === 'pressure' ? this.pressure.solved : this.counterweight.solved;
  }

  listenToChimes(): boolean {
    const run = this.runValue;
    if (this.phaseValue !== 'explore' || !run || this.floorNumberValue !== 1) return false;
    const next = listenToChimes(run);
    if (next !== run) {
      this.runValue = next;
      this.emit({ type: 'bell-chimes', feedback: 'clue' });
    }
    return true;
  }

  strikeChime(note: BellNote): BellFeedback | null {
    const run = this.runValue;
    if (this.phaseValue !== 'explore' || !run || this.floorNumberValue !== 2) return null;
    const result = strikeChime(run, note);
    if (!result) return null;
    this.runValue = result.run;
    if (result.run !== run) this.emit({ type: 'bell-chimes', feedback: result.feedback });
    return result.feedback;
  }

  claimChimeReward(): boolean {
    if (this.phaseValue !== 'explore' || !this.runValue || this.floorNumberValue !== 2)
      return false;
    const next = claimChimeReward(this.runValue);
    if (!next) return false;
    this.runValue = next;
    this.emit({ type: 'bell-chimes', feedback: 'claimed' });
    return true;
  }

  /** Records a pressure-room note once while exploring. */
  collectPressureNote(room: number, note: PressureNoteId): PressureTurnResultView | null {
    const run = this.runValue;
    if (
      this.phaseValue !== 'explore' ||
      this.contentVersionValue < PRESSURE_WORKS_VERSION ||
      !run ||
      this.floorNumberValue !== 1 ||
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
      this.floorNumberValue !== 1 ||
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
      this.floorNumberValue !== 1 ||
      !Number.isInteger(room) ||
      room < 0
    )
      return null;
    const result = primePressure(run, this.contentVersionValue);
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
      this.floorNumberValue !== 1 ||
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
      this.floorNumberValue !== 1 ||
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

  explorationOnFloor(
    floor: number,
  ):
    | Pick<
        FloorSnapshot,
        'floorSeed' | 'reachedRooms' | 'clearedEncounters' | 'openedLoot' | 'pressure'
      >
    | undefined {
    if (!this.runValue) return undefined;
    if (floor === this.floorNumberValue)
      return {
        floorSeed: this.floorSeed,
        reachedRooms: [...this.reached],
        clearedEncounters: this.clearedRooms.map(String),
        openedLoot: this.runValue.openedLoot,
        pressure: this.runValue.pressure,
      };
    return this.floorStates.get(floor);
  }
  get brassKey(): 'missing' | 'held' | 'spent' {
    return this.runValue?.brassKey ?? 'missing';
  }
  get windowCacheOpened(): boolean {
    return this.runValue?.windowCacheOpened === true;
  }
  /** Claims the one-shot Light window cache reward on floor one. */
  openWindowCache(): boolean {
    const run = this.runValue;
    if (!run || this.phaseValue !== 'explore' || this.floorNumberValue !== 1) return false;
    const next = claimWindowCache(run);
    if (!next) return false;
    this.runValue = next;
    this.emit({ type: 'window-cache', cogs: next.cogs - run.cogs, from: 'explore', to: 'explore' });
    return true;
  }
  /** Deterministic first-floor coffer target, if this run has v7 brass-cache content. */
  get brassCache(): { room: number; socketId: string } | undefined {
    if (!this.runValue || this.contentVersionValue < BRASS_CACHE_VERSION) return undefined;
    const seed = floorSeedFor(this.runValue.seed, 1);
    if (this.brassCacheLookup?.seed !== seed)
      this.brassCacheLookup = {
        seed,
        target: brassCacheForPlayableFloor(seed),
      };
    return this.brassCacheLookup.target;
  }
  takeBrassKey(): boolean {
    if (
      !this.runValue ||
      this.phaseValue !== 'explore' ||
      this.floorNumberValue !== 2 ||
      this.contentVersionValue < BRASS_CACHE_VERSION ||
      !this.brassCache ||
      this.brassKey !== 'missing'
    )
      return false;
    this.runValue = { ...this.runValue, brassKey: 'held' };
    this.emit({ type: 'brass-key', action: 'take' });
    return true;
  }
  inspectBrassLock(room: number, socketId: string): boolean {
    const run = this.runValue;
    if (!run || this.floorNumberValue !== 1 || this.phaseValue !== 'explore') return false;
    const target = this.brassCache;
    if (
      !target ||
      target.room !== room ||
      target.socketId !== socketId ||
      this.brassKey === 'spent'
    )
      return false;
    if (this.brassKey === 'held') {
      this.runValue = { ...run, brassKey: 'spent', brassCacheSeen: true };
      this.emit({ type: 'brass-key', action: 'unlock' });
    } else if (!run.brassCacheSeen) {
      this.runValue = { ...run, brassCacheSeen: true };
      this.emit({ type: 'brass-key', action: 'inspect' });
    }
    return true;
  }

  /** Changes floors only at an exploration boundary, preserving global deck, HP, purse and RNG. */
  travelToFloor(destination: 1 | 2 | 3, destinationRoom: number): boolean {
    const run = this.runValue;
    if (
      this.phaseValue !== 'explore' ||
      !run ||
      !Number.isInteger(destinationRoom) ||
      destinationRoom < 0
    )
      return false;
    if (
      this.contentVersionValue < RETURN_PASSAGES_VERSION &&
      (destination === 3 || this.floorNumberValue === 3)
    )
      return false;
    if (![1, 2, 3].includes(destination) || Math.abs(destination - this.floorNumberValue) !== 1)
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
    this.runValue = { ...this.runValue, brassKey: 'missing' };
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
    for (const floor of snapshot.floors ?? []) {
      if (floor.floorNumber === 2) {
        const { pressure: _pressure, ...upper } = floor;
        this.floorStates.set(floor.floorNumber, upper);
      } else {
        this.floorStates.set(floor.floorNumber, floor);
      }
    }
    // Older saves can contain a regulator from the retired upper wing.
    if (this.floorNumberValue !== 1) {
      const { pressure: _pressure, ...runWithoutPressure } = this.runValue;
      this.runValue = runWithoutPressure;
    }
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
    if (!this.inRun || this.roomValue === room) return;
    this.roomValue = room;
    this.reached.add(room);
    this.emit({ type: 'room-entered', room });
  }

  /** Records the armory's irreversible activation at the exploration save boundary. */
  awakenArmory(): boolean {
    const run = this.runValue;
    if (
      this.phaseValue !== 'explore' ||
      this.floorNumberValue !== 2 ||
      this.contentVersionValue < ARMORY_ALCOVE_VERSION ||
      !run ||
      run.armoryAwakened
    )
      return false;
    this.runValue = { ...run, armoryAwakened: true };
    this.emit({ type: 'armory-awakened' });
    return true;
  }

  /** Exploration hands over to a fight. Ignored outside `explore`, so a dead run never fights again. */
  fightStarted(room: number, patrol = false): boolean {
    if (
      this.phaseValue !== 'explore' ||
      (patrol
        ? this.floorNumberValue !== 2 ||
          this.contentVersionValue < PATROL_VERSION ||
          this.runValue?.patrolDefeated
        : this.clearedRooms.includes(room))
    )
      return false;
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
    if (
      this.phaseValue !== 'combat' ||
      !run ||
      (result.patrol &&
        (result.tier !== 'regular' || this.floorNumberValue !== 2 || run.patrolDefeated))
    )
      return false;
    if (result.outcome === 'flee') {
      if (!canFlee(result.tier)) return false;
      this.runValue = this.withHp(run, result.playerHp);
      return this.go('explore');
    }
    if (result.outcome === 'defeat') {
      this.runValue = { ...run, hp: 0 };
      return this.finish('death');
    }
    if (!result.patrol && !this.clearedRooms.includes(result.room))
      this.clearedRooms.push(result.room);
    const healed = this.withHp(run, result.playerHp);
    const pool = this.rewardPoolForContentVersion();
    const rolled = rewardOffer(healed, result.tier, pool);
    if (result.tier === 'guardian') this.guardianDefeatedValue = true;
    this.runValue = result.patrol ? { ...rolled.run, patrolDefeated: true } : rolled.run;
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
    const target =
      this.floorNumberValue === 1 && this.brassKey !== 'spent' ? this.brassCache : undefined;
    if (target?.room === room && target.socketId === socketId) return null;
    const pool = this.rewardPoolForContentVersion();
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

  private rewardPoolForContentVersion(): readonly string[] {
    if (this.contentVersionValue < FOUNDRY_VERSION) return LEGACY_REWARD_POOL;
    const dice = this.contentVersionValue >= WAVE_B_DICE_VERSION;
    const mechanisms = this.contentVersionValue >= MECHANISM_CONTENT_VERSION;
    const chain = this.contentVersionValue >= WAVE_B_CHAIN_VERSION;
    const crystalGambit = this.contentVersionValue >= CRYSTAL_GAMBIT_VERSION;
    const echoGlyph = this.contentVersionValue >= ECHO_GLYPH_VERSION;
    const lensFocus = this.contentVersionValue >= LENS_FOCUS_VERSION;
    const overdrive = this.contentVersionValue >= OVERDRIVE_CONTENT_VERSION;
    const charge = this.contentVersionValue >= CHARGE_CONTENT_VERSION;
    const complete = this.contentVersionValue >= WAVE_A_COMPLETE_VERSION;
    const dungeon = this.contentVersionValue >= DUNGEON_CONTENT_VERSION;
    const repairs = this.contentVersionValue >= WAVE_A_REPAIR_VERSION;
    return this.opts.rewardPool.filter(
      (id) =>
        (overdrive || !WAVE_B_OVERDRIVE_IDS.has(id)) &&
        (charge || !WAVE_B_CHARGE_IDS.has(id)) &&
        (dice || !WAVE_B_DICE_IDS.has(id)) &&
        (mechanisms || !WAVE_B_MECHANISM_IDS.has(id)) &&
        (chain || !WAVE_B_CHAIN_IDS.has(id)) &&
        (crystalGambit || !CRYSTAL_GAMBIT_IDS.has(id)) &&
        (echoGlyph || !ECHO_GLYPH_IDS.has(id)) &&
        (lensFocus || !LENS_FOCUS_IDS.has(id)) &&
        (complete || !WAVE_A_COMPLETE_IDS.has(id)) &&
        (repairs || !WAVE_A_REPAIR_IDS.has(id)) &&
        (dungeon || !DUNGEON_REWARD_IDS.has(id)),
    );
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
      dispatch: this.floorNumberValue === 2 ? run.dispatch : undefined,
      speakingPipes: this.floorNumberValue === 2 ? run.speakingPipes : undefined,
      bookSecretOpenedRooms: run.bookSecretOpenedRooms,
      bookSecretKeyRooms: run.bookSecretKeyRooms,
      bookSecretCabinetRooms: run.bookSecretCabinetRooms,
      prismSignal: this.floorNumberValue === 3 ? run.prismSignal : undefined,
      pendulumGallery: this.floorNumberValue === 3 ? run.pendulumGallery : undefined,
      floatElevator: this.floorNumberValue === 1 ? run.floatElevator : undefined,
      shadowStencil: this.floorNumberValue === 1 ? run.shadowStencil : undefined,
      springTension: this.floorNumberValue === 2 ? run.springTension : undefined,
      darkCircuit: this.floorNumberValue === 2 ? run.darkCircuit : undefined,
      drumGallery: this.floorNumberValue === 3 ? run.drumGallery : undefined,
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
    const {
      pressure: _stalePressure,
      speakingPipes: _staleSpeakingPipes,
      ...runWithoutFloorPuzzles
    } = run;
    this.runValue = {
      ...runWithoutFloorPuzzles,
      floorSeed: floor.floorSeed,
      openedLoot: floor.openedLoot,
      pendingLoot: floor.pendingLoot,
      usedHearths: floor.usedHearths,
      ...(this.floorNumberValue === 1 && floor.pressure !== undefined
        ? { pressure: floor.pressure }
        : {}),
      ...(this.floorNumberValue === 2 && floor.dispatch !== undefined
        ? { dispatch: floor.dispatch }
        : {}),
      ...(this.floorNumberValue === 2 && floor.speakingPipes !== undefined
        ? { speakingPipes: floor.speakingPipes }
        : {}),
      bookSecretOpenedRooms: floor.bookSecretOpenedRooms,
      bookSecretKeyRooms: floor.bookSecretKeyRooms,
      bookSecretCabinetRooms: floor.bookSecretCabinetRooms,
      prismSignal: this.floorNumberValue === 3 ? floor.prismSignal : undefined,
      pendulumGallery: this.floorNumberValue === 3 ? floor.pendulumGallery : undefined,
      floatElevator: this.floorNumberValue === 1 ? floor.floatElevator : undefined,
      shadowStencil: this.floorNumberValue === 1 ? floor.shadowStencil : undefined,
      springTension: this.floorNumberValue === 2 ? floor.springTension : undefined,
      darkCircuit: this.floorNumberValue === 2 ? floor.darkCircuit : undefined,
      drumGallery: this.floorNumberValue === 3 ? floor.drumGallery : undefined,
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
        this.clearedRooms.length + Number(run.patrolDefeated === true),
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
