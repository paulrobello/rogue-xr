import {
  createMenuPanel,
  createRadialMenu,
  createScalableLabel,
  disposeScalableLabel,
  keepAbove,
  type MenuCell,
  type MenuPanel,
  type MenuRow,
  type RadialMenu,
} from '@par/xr-workspace';
import * as THREE from 'three';
import { Text } from 'troika-three-text';
import { TABLE_DISTANCE_CHOICES } from '../combat/placement.ts';
import {
  CanvasLabel,
  configureTextTexture,
  measuredLines as wrapText,
} from '../combat-view/canvas-label.ts';
import { cardTip } from '../combat-view/card-keywords.ts';
import { drawTip, tipCanvasHeight } from '../combat-view/status-info.ts';
import { getCard } from '../content/cards.ts';
import { PERMANENT_CARD_IDS } from '../content/rewards.ts';
import { formatSeed, normalizeSeed } from '../core/rng.ts';
import { appendSeedChar, SEED_ALPHABET, SEED_LENGTH } from '../desktop/seed-title.ts';
import { HOLO_CARD_ASPECT } from '../hand/fan-layout.ts';
import { PALETTE } from '../palette.ts';
import {
  FOVEATION_CHOICES,
  type FoveationChoice,
  MINIMAP_PLACEMENT_LIMIT,
  MINIMAP_ZOOMS,
  type Settings,
} from '../persist/db.ts';
import type { RunSnapshot } from '../persist/saves.ts';
import { brewNames, ingredientNames } from '../rules/alchemy.ts';
import { bellMelody } from '../rules/bell-chimes.ts';
import { BEARINGS, calibrationPlan, GEAR_TEETH, PLANET_NAMES } from '../rules/calibration.ts';
import { COMMISSION_TITLES } from '../rules/commissions.ts';
import {
  DIFFICULTIES,
  DIFFICULTY_LABEL,
  type Difficulty,
  runDifficulty,
} from '../rules/difficulty.ts';
import { type LogbookEntry, RUBBING_LOGBOOK_CLUE as RUBBING_NOTE } from '../rules/logbook.ts';
import type { PressureNoteId } from '../rules/pressure.ts';
import { reliquaryGlyph } from '../rules/reliquary.ts';
import { gasketFor } from '../rules/valvehouse.ts';
import {
  maxTier,
  nextCost,
  permanentCardCost,
  UPGRADE_IDS,
  UPGRADES,
  type UpgradeId,
} from '../rules/workshop.ts';
import type { PressureNoteRecord } from '../world/pressure-notes.ts';
import { CARD_FLIGHT_SECONDS, flightGoal, flightPose, flightScale } from './card-flight.ts';
import { dressClockworkDial } from './clockwork-dial.ts';
import { DECK_SORTS, type DeckSort, deckStacks } from './deck-view.ts';
import type { FlowPhase, RunFlow } from './flow.ts';
import { type BookPagePainter, createLogbookHandSwipes, Logbook, puzzlePage } from './logbook.ts';
import type { LogbookMap, MapPoint, MapView } from './logbook-map.ts';
import { type ActivePuzzlePageDeps, activePuzzlePages } from './logbook-puzzles.ts';
import { runCardPages, runStatsPages } from './logbook-run-pages.ts';
import {
  RewardCardFaces,
  type RewardCardFacesOptions,
  type RewardCardSlot,
} from './reward-cards.ts';
import { TEST_SEEDS } from './test-seeds.ts';

/**
 * The card keyword tip on the reward board and the deck viewer: canvas height (fits a four-keyword
 * card), width, and how far it stands in front of the card face (clear of the hover lift), metres.
 */
const CARD_TIP_PX_HEIGHT = Math.max(900, tipCanvasHeight(cardTip(getCard('quench-seal'))));
const CARD_TIP_WIDTH = 0.3;
const CARD_TIP_FORWARD = 0.06;
/** Control id prefix of a deck viewer card: `deck-card-<index on the page>`. */
const DECK_CARD = 'deck-card-';

/** Title key art and its runtime-title safe region (0..1, origin top-left), from `ui-atlas.json`. */
export interface KeyArt {
  readonly url: string;
  readonly titleSafe: { x: number; y: number; w: number; h: number };
}

export interface FlowUiDeps {
  flow: RunFlow;
  keyArt: KeyArt;
  /** The seed New Run uses unless the player enters another. */
  seed: string;
  snapshot: () => RunSnapshot | null;
  /** Current settings; `difficulty` is the level New Run starts at. */
  settings: () => Settings;
  onNewRun: (seed: string, difficulty: Difficulty) => void;
  onContinue: () => void;
  onSettings: (next: Settings) => void;
  setTableDistance?: (distance: number) => boolean;
  /** How the reward board draws its card faces. Default: the shared hand atlas, typeset. */
  rewardCards?: RewardCardFacesOptions;
  /**
   * Where a picked reward card flies, read at the pick: the claiming hand (standoff 0) or the head
   * (a standoff in front of it). Absent or null: the card is taken without a flight.
   */
  flyTarget?: () => FlyTarget | null;
  dialProbe?: THREE.Texture | null;
  /** A newer deployed build: the title offers the reload while one is available. */
  update?: TitleUpdate;
  onNoteOpened?: (position: THREE.Vector3) => void;
  reducedMotion?: boolean;
  logbookMaps?: () => readonly LogbookMap[];
  logbookHeading?: () => number;
  puzzlePressureNotes?: () => ActivePuzzlePageDeps['pressureNotes'];
  locationLabel?: () => string | null;
  noteRecord?: (id: PressureNoteId) => PressureNoteRecord | null;
}

/** A newer deployed build the title can reload into (`mountUpdateNotice`'s result fits). */
export interface TitleUpdate {
  readonly available: boolean;
  reload(): void;
  /** Calls `listener` when `available` may have changed; returns the unsubscribe. */
  onChange(listener: () => void): () => void;
}

/** What a picked reward card flies to: `object`'s world position, stopping `standoff` metres short. */
export interface FlyTarget {
  readonly object: THREE.Object3D;
  readonly standoff: number;
}

/** The in-run menu: closed, its main board, the deck viewer, or the abandon confirmation. */
export type MenuView =
  | 'closed'
  | 'main'
  | 'settings'
  | 'minimap'
  | 'deck'
  | 'confirm'
  | 'items'
  | 'logbook'
  | 'note';
/** Phases the in-run menu opens over. */
const MENU_PHASES: readonly FlowPhase[] = ['explore', 'combat'];
type FieldNoteId = PressureNoteId | typeof RUBBING_NOTE;

/** Card family colours (art bible): the jewel tone fills the frame field. */
const FAMILY: Readonly<Record<string, string>> = {
  attack: PALETTE.ruby,
  skill: PALETTE.sapphire,
  sigil: PALETTE.emerald,
  mechanism: PALETTE.brassDark,
};

/** What the title says about each level, under its buttons. */
const DIFFICULTY_NOTE: Readonly<Record<Difficulty, string>> = {
  casual: 'Weaker automatons, more hp for you',
  normal: 'A softer elite and guardian',
  hard: 'The Spire as it was built',
};
/** Plate of the chosen option in a row of choices (the title's difficulty). */
const SELECTED_FILL = PALETTE.brassDark;
const SELECTED_EDGE = PALETTE.candle;
/** Settings board names for the foveation levels. */
const FOVEATION_LABEL: Readonly<Record<FoveationChoice, string>> = {
  off: 'Off',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
};

const ROW = 0.07;
const BOARD_WIDTH = 0.66;
const BOARD_PAD = 0.045;
const BOARD_DISTANCE = 1.25;
const TRACKED_HAND_DISTANCE = 0.54;
const ART_DISTANCE = 2.7;
/** The deck viewer: cards per row and rows per page, card width and the gap between cards, metres. */
const DECK_COLUMNS = 4;
const DECK_ROWS = 2;
export const DECK_PAGE_SIZE = DECK_COLUMNS * DECK_ROWS;
const DECK_CARD_WIDTH = 0.15;
const DECK_GAP = 0.02;
const DECK_SORT_LABEL: Record<DeckSort, string> = {
  order: 'Deck order',
  offense: 'Offense',
  defense: 'Defense',
  utility: 'Utility',
};
const ART_WIDTH = 3.4;
const PERMANENT_CARD_PAGE_SIZE = 3;
const TEST_SEED_PAGE_SIZE = 6;

type Subview = 'main' | 'seed' | 'test-seeds';
type WorkshopSubview = 'main' | 'permanent-cards';
export const RUN_MENU_ITEMS = [
  { id: 'settings', label: 'Settings' },
  { id: 'deck', label: 'Deck' },
  { id: 'items', label: 'Items' },
  { id: 'logbook', label: 'Logbook' },
] as const;
type RunMenuAction = (typeof RUN_MENU_ITEMS)[number]['id'];

/** A reward card on its way to the player; the pick is applied when it lands. */
interface RewardFlight {
  readonly card: string;
  readonly face: RewardCardFaces;
  readonly from: THREE.Vector3;
  readonly target: FlyTarget;
  t: number;
}

interface Board {
  readonly name: string;
  readonly panel: MenuPanel;
  readonly group: THREE.Group;
  /** Palette plate behind each interactive cell, by cell id. */
  readonly plates: Map<string, THREE.Mesh>;
}

type MinimapPlacementKey = 'minimapHorizontal' | 'minimapVertical';
type MinimapPlacement = Pick<Settings, MinimapPlacementKey>;
const minimapPercentage = (value: number): number =>
  Math.round((value / MINIMAP_PLACEMENT_LIMIT) * 100);

interface MinimapSlider {
  readonly key: MinimapPlacementKey;
  readonly panel: MenuPanel;
  readonly valueId: string;
  readonly group: THREE.Group;
  readonly knob: THREE.Mesh;
  readonly length: number;
  percentage: number;
}

/** A brass-edged plate texture: flat fill, 2-step bevel, hairline frame. No rounded pills. */
function plateTexture(
  fill: string,
  edge: string,
  w: number,
  h: number,
  borderRatio = 0.035,
): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  const px = 256;
  canvas.width = Math.max(16, Math.round((px * w) / Math.max(h, 0.001)));
  canvas.height = px;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.fillStyle = fill;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const shade = ctx.createLinearGradient(0, 0, 0, canvas.height);
    shade.addColorStop(0, 'rgba(255,236,190,0.10)');
    shade.addColorStop(0.5, 'rgba(0,0,0,0)');
    shade.addColorStop(1, 'rgba(0,0,0,0.22)');
    ctx.fillStyle = shade;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const line = Math.max(1, Math.round(canvas.height * borderRatio));
    ctx.strokeStyle = edge;
    ctx.lineWidth = line;
    ctx.strokeRect(line / 2, line / 2, canvas.width - line, canvas.height - line);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function plateMesh(fill: string, edge: string, w: number, h: number): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(w, h),
    new THREE.MeshBasicMaterial({ map: plateTexture(fill, edge, w, h), toneMapped: false }),
  );
  mesh.raycast = () => undefined;
  return mesh;
}

function disposeMesh(mesh: THREE.Mesh): void {
  mesh.geometry.dispose();
  const material = mesh.material as THREE.MeshBasicMaterial;
  material.map?.dispose();
  material.dispose();
}

/**
 * The canvas fallback face for a reward choice, shown until the card atlas is loaded: family-coloured
 * field in a brass frame, name, type and cost, and the rules text on parchment. It has the atlas
 * card's aspect, so the swap keeps the card's size.
 */
export function rewardCardTexture(id: string, hovered: boolean): THREE.CanvasTexture {
  const card = getCard(id);
  const canvas = document.createElement('canvas');
  canvas.width = 360;
  canvas.height = Math.round(360 * HOLO_CARD_ASPECT);
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const { width: w, height: h } = canvas;
    ctx.fillStyle = PALETTE.warmBlack;
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = FAMILY[card.type] ?? PALETTE.walnut;
    ctx.fillRect(14, 14, w - 28, h - 28);
    ctx.strokeStyle = hovered ? PALETTE.candle : PALETTE.brass;
    ctx.lineWidth = hovered ? 12 : 8;
    ctx.strokeRect(ctx.lineWidth / 2, ctx.lineWidth / 2, w - ctx.lineWidth, h - ctx.lineWidth);
    // Cost medallion, upper left.
    ctx.fillStyle = PALETTE.warmBlack;
    ctx.beginPath();
    ctx.arc(54, 54, 30, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = PALETTE.brass;
    ctx.lineWidth = 4;
    ctx.stroke();
    ctx.fillStyle = PALETTE.candle;
    ctx.font = '700 34px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(card.cost), 54, 56);
    ctx.fillStyle = PALETTE.parchment;
    ctx.font = '700 36px system-ui, sans-serif';
    const nameLines = wrapText(ctx, card.name, w - 60);
    nameLines.forEach((l, i) => {
      ctx.fillText(l, w / 2, 150 + i * 40);
    });
    ctx.font = '500 22px system-ui, sans-serif';
    ctx.fillStyle = 'rgba(242,223,184,0.8)';
    const kind = { sigil: 'Sigil spell', attack: 'Attack', skill: 'Skill', mechanism: 'Mechanism' }[
      card.type
    ];
    ctx.fillText(
      card.dice ? `${kind} · rolls a die` : kind,
      w / 2,
      150 + nameLines.length * 40 + 8,
    );
    // Rules text on parchment.
    const top = 290;
    ctx.fillStyle = PALETTE.parchment;
    ctx.fillRect(30, top, w - 60, h - top - 30);
    ctx.fillStyle = PALETTE.warmBlack;
    ctx.font = '500 25px system-ui, sans-serif';
    ctx.textBaseline = 'top';
    wrapText(ctx, card.description, w - 92).forEach((l, i) => {
      ctx.fillText(l, w / 2, top + 22 + i * 32);
    });
  }
  const texture = new THREE.CanvasTexture(canvas);
  configureTextTexture(texture);
  return texture;
}

/** Settings cell id of a table distance: `tableDistance-11` for 1.1 m. */
export function tableDistanceCell(distance: number): string {
  return `tableDistance-${Math.round(distance * 10)}`;
}

function pct(v: number): string {
  return `${Math.round(v * 100)}%`;
}

const clamp01 = (v: number): number => Math.max(0, Math.min(1, Math.round(v * 10) / 10));

/**
 * Splits a control id (`<board>-<cell>`) into its board and cell. Board names prefix each other
 * ('reward-info' and 'reward'), so the longest matching board name wins.
 */
export function splitControlId(
  boards: readonly string[],
  controlId: string,
): { board: string; cell: string } | null {
  let best: string | null = null;
  for (const name of boards) {
    if (controlId.startsWith(`${name}-`) && (best === null || name.length > best.length)) {
      best = name;
    }
  }
  return best === null ? null : { board: best, cell: controlId.slice(best.length + 1) };
}

/**
 * Every between-room screen of the flow as in-scene boards built on the toolkit's `createMenuPanel`:
 * title over the key art, seed keypad, workshop, settings, reward, death and victory. The toolkit owns
 * layout, typesetting, hit-testing and activation; this layer adds the Gilded Lamplight plates (the
 * toolkit's default backplates are slate and teal) and the hover state. One input path for desktop
 * and XR: resolve a hit with `controlAt`, then `activate(controlId)`.
 */
export class FlowUi {
  readonly root = new THREE.Group();
  private readonly deps: FlowUiDeps;
  private boards: Board[] = [];
  private extras: THREE.Object3D[] = [];
  private rewardFaces: RewardCardFaces | null = null;
  private deckFaces: RewardCardFaces | null = null;
  private deckBacks: THREE.InstancedMesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial> | null =
    null;
  private deckPage = 0;
  private deckSort: DeckSort = 'order';
  /** Invisible hit planes over the deck viewer's cards, so the pointer can rest on one. */
  private deckHits: THREE.Group | null = null;
  /** Small atlas faces and their non-activating hit planes in the permanent-card shop. */
  private workshopFaces: RewardCardFaces | null = null;
  private workshopHits: THREE.Group | null = null;
  /** One stable, non-hit preview face shown while a shop thumbnail is hovered. */
  private workshopPreviews = new Map<string, RewardCardFaces>();
  private workshopPreviewId: string | null = null;
  /** Built on first use; null when the canvas is unavailable. */
  private cardTipLabel: CanvasLabel | null | undefined;
  private cardTipKey = '';
  /** The card whose keyword tip shows (its id and keyword titles), or null. */
  cardTipShown: { id: string; titles: string[] } | null = null;
  private hoveredId: string | null = null;
  /** Control ids drawn as the chosen option. */
  private readonly selectedIds = new Set<string>();
  private subview: Subview = 'main';
  private workshopSubview: WorkshopSubview = 'main';
  private permanentCardPage = 0;
  private permanentCardMessage = '';
  private tableDistanceMessage = '';
  private seedValue: string;
  private seedDraft = '';
  private testSeedPage = 0;
  private shownFor: FlowPhase | null = null;
  private menu: MenuView = 'closed';
  private settingsMinimap = false;
  private noteId: FieldNoteId | null = null;
  private logbook: Logbook | null = null;
  private logbookStart = 0;
  private logbookCard: string | null = null;
  private logbookCardFace: RewardCardFaces | null = null;
  private bookSection: 'clues' | 'map' | 'puzzles' | 'cards' | 'stats' = 'clues';
  private readonly logbookMapViews = new Map<number, MapView>();
  private readonly logbookPages = new Map<typeof this.bookSection, number>();
  private logbookHandSwipe = createLogbookHandSwipes();
  private showMapFinds = true;
  private menuHead: THREE.Object3D | null = null;
  private handTracking = false;
  private radialMenu: RadialMenu<RunMenuAction> | null = null;
  private releaseDial: (() => void) | null = null;
  private flight: RewardFlight | null = null;
  private readonly minimapSliders = new Map<string, MinimapSlider>();
  private minimapSliderId: string | null = null;
  private minimapSliderDraft: MinimapPlacement | null = null;
  private readonly minimapSliderRay = new THREE.Ray();
  private readonly minimapSliderPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
  private readonly minimapSliderHit = new THREE.Vector3();
  private readonly minimapSliderInverse = new THREE.Matrix4();
  private artTexture: THREE.Texture | null = null;
  private artLoaded = Promise.resolve(true);

  private stopAbove: (() => void) | null = null;
  private readonly stopUpdate: () => void;

  constructor(deps: FlowUiDeps) {
    this.deps = deps;
    this.seedValue = deps.seed;
    this.root.name = 'flow-ui';
    this.root.visible = false;
    // `sync` rebuilds the title on the way back from a run; this covers a build found while on it.
    this.stopUpdate =
      deps.update?.onChange(() => {
        if (this.shownFor === 'title' && this.deps.flow.phase === 'title') this.refresh();
      }) ?? (() => {});
  }

  /** Waits for the active board's artwork and for its first text geometry to be available. */
  async waitForArtwork(): Promise<void> {
    const labels: Promise<void>[] = [];
    this.root.traverseVisible((node) => {
      if (!(node instanceof Text) || !node.text || node.textRenderInfo) return;
      labels.push(
        new Promise<void>((resolve) => {
          const done = () => {
            node.removeEventListener('synccomplete', done);
            resolve();
          };
          node.addEventListener('synccomplete', done);
          node.sync();
        }),
      );
    });
    const [artLoaded] = await Promise.all([this.artLoaded, ...labels]);
    if (!artLoaded) throw new Error('Title artwork unavailable');
  }

  /** The seed New Run will use. */
  get seed(): string {
    return this.seedValue;
  }

  /** True while a board is up; exploration input should stay locked. */
  get visible(): boolean {
    return this.root.visible;
  }

  /** Which in-run menu board is up, or `'closed'`. */
  get menuView(): MenuView {
    return this.menu;
  }

  /** True while the in-run menu is up: exploration and the fight pause. */
  get menuOpen(): boolean {
    return this.menu !== 'closed';
  }

  /** The uncommitted placement while a minimap slider is captured. */
  get minimapPlacementPreview(): MinimapPlacement | null {
    return this.minimapSliderDraft ? { ...this.minimapSliderDraft } : null;
  }

  startMinimapSlider(controlId: string, ray: THREE.Ray): boolean {
    const slider = this.minimapSliders.get(controlId);
    if (!slider || !this.visible || this.minimapSliderDraft) return false;
    const s = this.deps.settings();
    this.minimapSliderId = controlId;
    this.minimapSliderDraft = {
      minimapHorizontal: s.minimapHorizontal,
      minimapVertical: s.minimapVertical,
    };
    this.dragMinimapSlider(ray);
    return true;
  }

  dragMinimapSlider(ray: THREE.Ray): boolean {
    const id = this.minimapSliderId;
    const slider = id ? this.minimapSliders.get(id) : undefined;
    const draft = this.minimapSliderDraft;
    if (!slider || !draft) return false;
    slider.group.updateWorldMatrix(true, false);
    this.minimapSliderRay.copy(ray);
    this.minimapSliderInverse.copy(slider.group.matrixWorld).invert();
    this.minimapSliderRay.applyMatrix4(this.minimapSliderInverse);
    const hit = this.minimapSliderRay.intersectPlane(
      this.minimapSliderPlane,
      this.minimapSliderHit,
    );
    if (hit) {
      draft[slider.key] =
        THREE.MathUtils.clamp((hit.x * 2) / slider.length, -1, 1) * MINIMAP_PLACEMENT_LIMIT;
      this.paintMinimapSlider(slider, draft[slider.key]);
    }
    return true;
  }

  finishMinimapSlider(commit: boolean): void {
    const slider = this.minimapSliderId ? this.minimapSliders.get(this.minimapSliderId) : undefined;
    const draft = this.minimapSliderDraft;
    this.minimapSliderId = null;
    this.minimapSliderDraft = null;
    if (!slider || !draft) return;
    const s = this.deps.settings();
    if (!commit) this.paintMinimapSlider(slider, s[slider.key]);
    else if (draft[slider.key] !== s[slider.key])
      this.deps.onSettings({ ...s, [slider.key]: draft[slider.key] });
  }

  nudgeMinimapSlider(id: string | null, key: string): boolean {
    const slider = id ? this.minimapSliders.get(id) : undefined;
    if (!slider || this.minimapSliderDraft) return false;
    const delta =
      key === 'ArrowRight' || key === 'ArrowUp'
        ? 0.05
        : key === 'ArrowLeft' || key === 'ArrowDown'
          ? -0.05
          : 0;
    if (!delta && key !== 'Home' && key !== 'End') return false;
    const s = this.deps.settings();
    const value =
      key === 'Home'
        ? -MINIMAP_PLACEMENT_LIMIT
        : key === 'End'
          ? MINIMAP_PLACEMENT_LIMIT
          : THREE.MathUtils.clamp(
              s[slider.key] + delta * MINIMAP_PLACEMENT_LIMIT,
              -MINIMAP_PLACEMENT_LIMIT,
              MINIMAP_PLACEMENT_LIMIT,
            );
    this.paintMinimapSlider(slider, value);
    if (value !== s[slider.key]) this.deps.onSettings({ ...s, [slider.key]: value });
    return true;
  }

  get radialInteractive(): boolean {
    return this.radialMenu?.interactive ?? false;
  }

  /** The front card of each stack on the displayed page. */
  get deckCards(): readonly string[] {
    return this.deckFaces?.slots.map((slot) => slot.id) ?? [];
  }

  /** True while a picked reward card is flying to the player (the pick lands when it arrives). */
  get claiming(): boolean {
    return this.flight !== null;
  }

  /**
   * Opens the in-run menu in front of `head` while exploring or fighting. Returns false, changing
   * nothing, in any other phase or when it is already open.
   */
  openMenu(head: THREE.Object3D): boolean {
    if (this.menu !== 'closed' || !MENU_PHASES.includes(this.deps.flow.phase)) return false;
    this.menu = 'main';
    this.menuHead = head;
    this.rebuild();
    this.place(head, true);
    return true;
  }

  /** Closes the in-run menu (Resume). Returns false when it was not open. */
  closeMenu(): boolean {
    if (this.menu === 'closed') return false;
    this.menu = 'closed';
    this.noteId = null;
    this.rebuild();
    return true;
  }

  /** Opens the in-run menu, or closes it when it is open. Returns whether anything changed. */
  toggleMenu(head: THREE.Object3D): boolean {
    return this.menuOpen ? this.closeMenu() : this.openMenu(head);
  }

  /** Opens the in-run logbook directly on its map, for the left controller's X button. */
  openMap(head: THREE.Object3D): boolean {
    const section = this.defaultBookSection();
    if (this.menu === 'logbook' && this.logbook) {
      this.selectBookSection(section);
      return true;
    }
    if (!this.menuOpen && !this.openMenu(head)) return false;
    this.openLogbook(undefined, section);
    return true;
  }

  /** Opens an acquired note, from a physical pickup or from Items. */
  readNote(id: PressureNoteId, head: THREE.Object3D, physical = true): boolean {
    return this.openFieldNote(id, head, physical);
  }

  readReliquaryRubbing(head: THREE.Object3D, physical = true): boolean {
    return this.openFieldNote(RUBBING_NOTE, head, physical);
  }

  private openFieldNote(id: FieldNoteId, head: THREE.Object3D, physical: boolean): boolean {
    if (this.menu === 'note' && this.noteId === id) return false;
    const entry = this.fieldNote(id);
    if (!entry || !this.deps.flow.saveLogbookClue(entry)) return false;
    this.noteId = id;
    this.menuHead = head;
    this.setMenu('note');
    if (physical) this.place(head, true);
    const sheet = this.root.getObjectByName('menu-note-sheet');
    if (sheet) this.deps.onNoteOpened?.(sheet.getWorldPosition(new THREE.Vector3()));
    return true;
  }

  /**
   * Plays the picked reward card's flight by `dt` seconds; when it lands the pick is applied (once)
   * and the board closes. Call every frame.
   */
  update(dt: number): void {
    this.radialMenu?.update(dt);
    this.logbook?.update(dt);
    const flight = this.flight;
    if (!flight) return;
    this.rewardFaces?.update(dt);
    flight.t = Math.min(1, flight.t + Math.max(0, dt) / CARD_FLIGHT_SECONDS);
    this.root.updateWorldMatrix(true, false);
    const to = this.root.worldToLocal(flight.target.object.getWorldPosition(new THREE.Vector3()));
    const goal = flightGoal(flight.from, to, flight.target.standoff, new THREE.Vector3());
    const k = flightPose(flight.from, goal, flight.t, flight.face.root.position);
    flight.face.root.scale.setScalar(flightScale(k));
    if (flight.t < 1) return;
    this.endFlight();
    this.deps.flow.pickReward(flight.card);
  }

  /** The seed being typed on the keypad or the keyboard, or null when not entering one. */
  get seedEntry(): string | null {
    return this.subview === 'seed' ? this.seedDraft : null;
  }

  /** Interactive control ids in reading order, for keyboard focus. */
  controlIds(): string[] {
    const ids: string[] = [];
    if (this.menu !== 'closed') ids.push('menu-resume');
    if (this.menu === 'main' && this.radialMenu)
      ids.push('menu-settings', 'menu-deck', 'menu-items', 'menu-logbook', 'menu-cancel');
    for (const board of this.boards) {
      for (const child of board.panel.root.children) {
        const cell = board.panel.cellAt(child);
        if (cell) ids.push(`${board.name}-${cell}`);
      }
    }
    if (this.logbook) ids.push(...this.logbook.cardTargets.children.map((row) => row.name));
    if (this.workshopHits) ids.push(...this.workshopHits.children.map((hit) => hit.name));
    return ids;
  }

  /** Objects a pointer ray should test. */
  targets(): THREE.Object3D[] {
    if (!this.root.visible) return [];
    const out = this.boards.map((b) => b.panel.root);
    if (this.radialMenu?.root.visible) out.push(this.radialMenu.root);
    if (this.deckHits) out.push(this.deckHits);
    if (this.logbook?.cardTargets.children.length) out.push(this.logbook.cardTargets);
    if (this.workshopHits) out.push(this.workshopHits);
    return out;
  }

  /** Control id under a hit object, or null. A deck viewer card is `deck-card-<index>`. */
  controlAt(object: THREE.Object3D): string | null {
    const sliderId = object.userData.minimapSlider;
    if (typeof sliderId === 'string' && this.minimapSliders.has(sliderId)) return sliderId;
    if (this.radialMenu) {
      const action = this.radialMenu.actionAt(object);
      if (action === 'cancel') return 'menu-cancel';
      if (action) return `menu-${action}`;
    }
    if (object.parent && object.parent === this.logbook?.cardTargets) return object.name;
    const deckIndex: unknown = object.userData.deckCard;
    if (typeof deckIndex === 'number' && object.parent === this.deckHits)
      return `${DECK_CARD}${deckIndex}`;
    const workshopCard = object.userData.workshopCard;
    if (typeof workshopCard === 'string' && object.parent === this.workshopHits) return object.name;
    for (const board of this.boards) {
      const cell = board.panel.cellAt(object);
      if (cell) return `${board.name}-${cell}`;
    }
    return null;
  }

  activate(controlId: string): boolean {
    // A flying reward card owns the board until it lands.
    if (this.flight) return false;
    if (controlId.startsWith('workshop-card-')) {
      this.hover(controlId);
      return this.workshopPreviewId !== null;
    }
    const book = this.logbook;
    const card = book?.cardFor(controlId);
    if (book && card) {
      this.logbookPages.set(this.bookSection, book.page);
      this.logbookCard = card;
      this.refresh();
      return true;
    }
    if (controlId === 'menu-cancel' || controlId === 'menu-resume') return this.closeMenu();
    if (controlId === 'menu-abandon') {
      this.setMenu('settings');
      return this.activate('settings-abandon');
    }
    if (
      controlId.startsWith('menu-') &&
      /^(foveation|tableDistance|fpsCounter|turnMode|teleportEnabled|masterVolume|musicVolume|sfxVolume)-/.test(
        controlId.slice('menu-'.length),
      )
    ) {
      this.setMenu('settings');
      return this.activate(`settings-${controlId.slice('menu-'.length)}`);
    }
    if (controlId === 'menu-settings') {
      this.setMenu('settings');
      return true;
    }
    if (controlId === 'menu-deck') {
      this.openDeck();
      return true;
    }
    if (controlId === 'menu-items') {
      this.openItems();
      return true;
    }
    if (controlId === 'menu-logbook') {
      this.openLogbook();
      return true;
    }
    const target = this.boardOf(controlId);
    return target ? target.board.panel.activate(target.cell) : false;
  }

  hover(controlId: string | null): void {
    if (controlId === this.hoveredId) return;
    if (this.hoveredId) this.logbook?.hoverCard(this.hoveredId, false);
    this.paintHover(this.hoveredId, false);
    this.hoveredId = controlId;
    if (this.radialMenu && this.menu === 'main') {
      const action = controlId?.startsWith('menu-') ? controlId.slice('menu-'.length) : null;
      this.radialMenu.setHovered(
        action === 'cancel' ||
          action === 'settings' ||
          action === 'deck' ||
          action === 'items' ||
          action === 'logbook'
          ? action
          : null,
      );
    }
    this.paintHover(controlId, true);
    if (controlId) this.logbook?.hoverCard(controlId, true);
    if (controlId?.startsWith('workshop-card-')) {
      this.showWorkshopPreview(controlId.slice('workshop-card-'.length));
    } else {
      for (const preview of this.workshopPreviews.values()) preview.root.visible = false;
      this.workshopPreviewId = null;
    }
    this.showCardTip(controlId);
  }

  /**
   * Playtest 2026-11-17: a reward or deck viewer card the laser or mouse rests on shows the
   * explanation of each keyword it uses above it (the combat hand's tip, `drawTip` over `cardTip`).
   */
  private showCardTip(controlId: string | null): void {
    const found = controlId ? this.cardAt(controlId) : null;
    const entries = found ? cardTip(getCard(found.id)) : [];
    const label = found && entries.length > 0 ? this.cardTip() : null;
    if (!found || !label) {
      this.hideCardTip();
      return;
    }
    if (found.id !== this.cardTipKey) {
      this.cardTipKey = found.id;
      label.draw((ctx, w, h) => drawTip(ctx, w, h, entries, true));
    }
    const { slot, faces } = found;
    const height = label.mesh.geometry.parameters.height;
    faces.root.add(label.mesh);
    label.mesh.position.set(slot.x, slot.y + slot.height / 2 + height / 2, CARD_TIP_FORWARD);
    label.mesh.visible = true;
    this.cardTipShown = { id: found.id, titles: entries.map((e) => e.title) };
  }

  private hideCardTip(): void {
    this.cardTipShown = null;
    this.cardTipKey = '';
    if (this.cardTipLabel) {
      this.cardTipLabel.mesh.visible = false;
      this.cardTipLabel.mesh.removeFromParent();
    }
  }

  /** The tip label, built on first use (null when there is no 2D canvas). */
  private cardTip(): CanvasLabel | null {
    if (this.cardTipLabel === undefined) {
      try {
        this.cardTipLabel = new CanvasLabel(640, CARD_TIP_PX_HEIGHT, CARD_TIP_WIDTH);
        this.cardTipLabel.mesh.name = 'flow-card-tip';
        this.cardTipLabel.mesh.renderOrder = 4;
        this.cardTipLabel.mesh.material.depthTest = false;
        this.cardTipLabel.mesh.raycast = () => undefined;
      } catch {
        this.cardTipLabel = null;
      }
    }
    return this.cardTipLabel;
  }

  /** The card a control id names on the reward board or the deck viewer, with its face slot. */
  private cardAt(
    controlId: string,
  ): { id: string; slot: RewardCardSlot; faces: RewardCardFaces } | null {
    if (controlId.startsWith(DECK_CARD) && this.deckFaces) {
      const index = Number(controlId.slice(DECK_CARD.length));
      const slot = this.deckFaces.slot(index);
      return slot ? { id: slot.id, slot, faces: this.deckFaces } : null;
    }
    const target = this.boardOf(controlId);
    if (target?.board.name !== 'reward' || !this.rewardFaces) return null;
    const slot = this.rewardFaces.slot(target.cell);
    return slot ? { id: slot.id, slot, faces: this.rewardFaces } : null;
  }

  /** Desktop typing into the seed field. Returns whether the key was used. */
  typeKey(key: string): boolean {
    if (key === 'Escape' && this.subview !== 'main') {
      this.setSubview('main');
      return true;
    }
    if (this.subview !== 'seed') return false;
    if (key === 'Backspace') this.seedDraft = this.seedDraft.slice(0, -1);
    else if (key === 'Enter') return this.commitSeed();
    else {
      const next = appendSeedChar(this.seedDraft, key);
      if (next === null) return false;
      this.seedDraft = next;
    }
    this.refreshSeedLabel();
    return true;
  }

  /** Rebuilds the boards for the flow's phase and places them in front of `head`. */
  sync(head: THREE.Object3D): void {
    const phase = this.deps.flow.phase;
    if (phase === this.shownFor) return;
    this.shownFor = phase;
    this.tableDistanceMessage = '';
    this.settingsMinimap = false;
    if (phase !== 'title') this.subview = 'main';
    if (phase !== 'workshop') this.workshopSubview = 'main';
    this.menu = 'closed';
    this.noteId = null;
    this.endFlight();
    this.rebuild();
    if (this.root.visible) this.place(head);
  }

  /**
   * Re-places the visible boards in front of `head` without rebuilding them. `sync` only places on
   * a phase change, so an XR session that starts on a board calls this once the head pose is known.
   */
  recenter(head: THREE.Object3D): void {
    if (this.root.visible) this.place(head);
  }

  /** Keeps boards and the logbook within tracked-hand reach while preserving their angular size. */
  setHandTracking(active: boolean, head: THREE.Object3D): void {
    if (this.handTracking === active) return;
    this.handTracking = active;
    this.menuHead = head;
    if (this.root.visible) this.place(head, this.menu !== 'closed');
  }

  /** Rebuilds the current phase's boards in place (after a purchase or a settings change). */
  refresh(): void {
    const { position, quaternion } = this.root;
    const p = position.clone();
    const q = quaternion.clone();
    this.rebuild();
    this.root.position.copy(p);
    this.root.quaternion.copy(q);
  }

  dispose(): void {
    this.endFlight();
    this.clear();
    this.cardTipLabel?.dispose();
    this.cardTipLabel = null;
    this.stopUpdate();
    this.artTexture?.dispose();
    this.root.removeFromParent();
  }

  /**
   * Puts the boards in front of `head`, turned to its heading. `tilt` also follows its pitch: the
   * in-run menu opens wherever the player looks, and a fight pitches the desktop view down far
   * enough to cut a level board off.
   */
  private place(head: THREE.Object3D, tilt = false): void {
    head.updateMatrixWorld(true);
    const eye = head.getWorldPosition(new THREE.Vector3());
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(
      head.getWorldQuaternion(new THREE.Quaternion()),
    );
    const yaw = Math.atan2(-forward.x, -forward.z);
    const pitch = tilt ? Math.asin(Math.max(-1, Math.min(1, forward.y))) : 0;
    this.root.position.set(eye.x, eye.y, eye.z);
    this.root.rotation.set(pitch, yaw, 0, 'YXZ');
    this.root.scale.setScalar(this.handTracking ? TRACKED_HAND_DISTANCE / BOARD_DISTANCE : 1);
  }

  private clear(): void {
    for (const slider of this.minimapSliders.values()) {
      for (const mesh of slider.group.children) if (mesh instanceof THREE.Mesh) disposeMesh(mesh);
      slider.group.removeFromParent();
    }
    this.minimapSliders.clear();
    this.minimapSliderId = null;
    this.minimapSliderDraft = null;
    this.logbook?.dispose();
    this.logbook = null;
    this.logbookCardFace?.dispose();
    this.logbookCardFace = null;
    this.stopAbove?.();
    this.stopAbove = null;
    this.releaseDial?.();
    this.releaseDial = null;
    this.radialMenu?.dispose();
    this.radialMenu = null;
    for (const board of this.boards) {
      for (const plate of board.plates.values()) disposeMesh(plate);
      board.panel.dispose();
      for (const child of board.group.children) {
        const mesh = child as THREE.Mesh;
        if (mesh.isMesh && mesh.userData.labelText === undefined) disposeMesh(mesh);
      }
      board.group.removeFromParent();
    }
    for (const extra of this.extras) {
      extra.removeFromParent();
      if ((extra as THREE.Mesh).userData.labelText !== undefined)
        disposeScalableLabel(extra as THREE.Mesh);
      else if (extra.name === 'flow-key-art') {
        const art = extra as THREE.Mesh;
        art.geometry.dispose();
        (art.material as THREE.Material).dispose();
      }
    }
    this.hideCardTip();
    this.rewardFaces?.dispose();
    this.rewardFaces = null;
    this.deckFaces?.dispose();
    this.deckFaces = null;
    if (this.deckBacks) {
      disposeMesh(this.deckBacks);
      this.deckBacks.dispose();
      this.deckBacks = null;
    }
    this.deckHits?.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose();
        (o.material as THREE.Material).dispose();
      }
    });
    this.deckHits = null;
    this.workshopHits?.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose();
        (o.material as THREE.Material).dispose();
      }
    });
    this.workshopHits = null;
    this.workshopFaces?.dispose();
    this.workshopFaces = null;
    for (const preview of this.workshopPreviews.values()) preview.dispose();
    this.workshopPreviews.clear();
    this.workshopPreviewId = null;
    this.boards = [];
    this.extras = [];
    this.selectedIds.clear();
    this.hoveredId = null;
  }

  private rebuild(): void {
    this.clear();
    const phase = this.deps.flow.phase;
    const builders: Partial<Record<FlowPhase, () => void>> = {
      title: () => {
        if (this.subview === 'seed') this.buildSeedPad();
        else if (this.subview === 'test-seeds') this.buildTestSeeds();
        else this.buildTitle();
      },
      workshop: () => this.buildWorkshop(),
      settings: () => (this.settingsMinimap ? this.buildMinimap(false) : this.buildSettings()),
      reward: () => this.buildReward(),
      'guardian-cleared': () => this.buildGuardianCleared(),
      death: () => this.buildSummary(),
      victory: () => this.buildSummary(),
    };
    const menu = this.menu !== 'closed' && MENU_PHASES.includes(phase);
    const build = menu ? () => this.buildMenu() : builders[phase];
    this.root.visible = build !== undefined;
    build?.();
    if (build) this.stopAbove = keepAbove(this.root);
  }

  private setSubview(view: Subview): void {
    this.subview = view;
    if (view === 'seed') this.seedDraft = '';
    this.refresh();
  }

  private commitSeed(): boolean {
    if (this.seedDraft.length !== SEED_LENGTH) return false;
    this.seedValue = this.seedDraft;
    this.setSubview('main');
    return true;
  }

  private refreshSeedLabel(): void {
    const board = this.boards.find((b) => b.name === 'seedpad');
    const shown = this.seedDraft.padEnd(SEED_LENGTH, '·');
    board?.panel.setLabel('draft', `${shown.slice(0, 4)}-${shown.slice(4)}`);
  }

  /** A board: a warm-black backing with a brass hairline, the menu rows, and palette cell plates. */
  private board(
    name: string,
    rows: readonly MenuRow[],
    at: THREE.Vector3Like,
    opts: {
      width?: number;
      rowHeight?: number;
      heading?: string;
      selected?: readonly string[];
    } = {},
  ): Board {
    const width = opts.width ?? BOARD_WIDTH;
    const rowHeight = opts.rowHeight ?? ROW;
    const panel = createMenuPanel({
      name,
      rows: rows.map((row) =>
        Array.isArray(row)
          ? (row as readonly MenuCell[]).map((c) => ({ ...c, backplate: false }))
          : { ...(row as MenuCell), backplate: false },
      ),
      width,
      rowHeight,
      rowGap: 0.014,
      cellGap: 0.02,
    });
    const group = new THREE.Group();
    group.name = `${name}-board`;
    group.position.set(at.x, at.y, at.z);
    const headingHeight = opts.heading ? 0.1 : 0;
    const height = panel.height + headingHeight + BOARD_PAD * 2;
    const backing = plateMesh(PALETTE.warmBlack, PALETTE.brassDark, width + BOARD_PAD * 2, height);
    backing.position.set(0, -height / 2 + BOARD_PAD + headingHeight, -0.004);
    group.add(backing);
    if (opts.heading) {
      const heading = createScalableLabel(opts.heading, width, 0.08, {
        backplate: false,
        fontSize: 0.06,
      });
      heading.position.set(0, BOARD_PAD + 0.0, 0);
      heading.position.y = 0.05;
      group.add(heading);
      this.extras.push(heading);
    }
    panel.root.position.set(0, 0, 0);
    group.add(panel.root);
    const plates = new Map<string, THREE.Mesh>();
    for (const child of panel.root.children) {
      const cell = panel.cellAt(child);
      const mesh = child as THREE.Mesh<THREE.PlaneGeometry>;
      if (!cell || !mesh.geometry?.parameters) continue;
      const { width: w, height: h } = mesh.geometry.parameters;
      const chosen = opts.selected?.includes(cell) ?? false;
      if (chosen) this.selectedIds.add(`${name}-${cell}`);
      const plate = chosen
        ? plateMesh(SELECTED_FILL, SELECTED_EDGE, w, h)
        : plateMesh(PALETTE.walnut, PALETTE.brass, w, h);
      plate.position.set(mesh.position.x, mesh.position.y, -0.002);
      plate.visible = mesh.visible;
      panel.root.add(plate);
      plates.set(cell, plate);
    }
    const board: Board = { name, panel, group, plates };
    this.boards.push(board);
    this.root.add(group);
    return board;
  }

  private paintHover(controlId: string | null, on: boolean): void {
    if (!controlId) return;
    const target = this.boardOf(controlId);
    if (target?.board.name === 'reward' && this.rewardFaces) {
      this.rewardFaces.hover(target.cell, on);
      return;
    }
    const plate = target?.board.plates.get(target.cell);
    if (!plate) return;
    const material = plate.material as THREE.MeshBasicMaterial;
    const { width, height } = (plate.geometry as THREE.PlaneGeometry).parameters;
    material.map?.dispose();
    material.map = on
      ? plateTexture('#6e4a2c', PALETTE.candle, width, height)
      : this.selectedIds.has(controlId)
        ? plateTexture(SELECTED_FILL, SELECTED_EDGE, width, height)
        : plateTexture(PALETTE.walnut, PALETTE.brass, width, height);
  }

  private boardOf(controlId: string): { board: Board; cell: string } | null {
    const split = splitControlId(
      this.boards.map((b) => b.name),
      controlId,
    );
    const board = split ? this.boards.find((b) => b.name === split.board) : undefined;
    return board && split ? { board, cell: split.cell } : null;
  }

  private keyArt(): void {
    const height = (ART_WIDTH * 9) / 16;
    if (!this.artTexture) {
      this.artLoaded = new Promise<boolean>((resolve) => {
        this.artTexture = new THREE.TextureLoader().load(
          this.deps.keyArt.url,
          () => resolve(true),
          undefined,
          () => resolve(false),
        );
        this.artTexture.colorSpace = THREE.SRGBColorSpace;
      });
    }
    const art = new THREE.Mesh(
      new THREE.PlaneGeometry(ART_WIDTH, height),
      new THREE.MeshBasicMaterial({ map: this.artTexture, toneMapped: false }),
    );
    art.name = 'flow-key-art';
    art.raycast = () => undefined;
    art.position.set(0, 0.05, -ART_DISTANCE);
    this.root.add(art);
    this.extras.push(art);
    // The wordmark sits in the painting's title-safe region on the dark left wall.
    const safe = this.deps.keyArt.titleSafe;
    const cx = (safe.x + safe.w / 2 - 0.5) * ART_WIDTH;
    const cy = (0.5 - (safe.y + safe.h * 0.3)) * height + 0.05;
    const wordmark = createScalableLabel('Clockwork\nSpire', safe.w * ART_WIDTH, 0.42, {
      backplate: false,
      wrap: true,
      fontSize: 0.14,
    });
    wordmark.position.set(cx, cy, -ART_DISTANCE + 0.01);
    this.root.add(wordmark);
    this.extras.push(wordmark);
  }

  private buildTitle(): void {
    const { flow } = this.deps;
    this.keyArt();
    const snap = this.deps.snapshot();
    const level = this.deps.settings().difficulty;
    const rows: MenuRow[] = [];
    const update = this.deps.update;
    if (update?.available) {
      rows.push({
        id: 'reload',
        label: 'New version ready · Reload',
        onSelect: () => update.reload(),
      });
    }
    rows.push(
      {
        id: 'new-run',
        label: `New Run · Seed ${formatSeed(this.seedValue)}`,
        onSelect: () => this.deps.onNewRun(this.seedValue, this.deps.settings().difficulty),
      },
      [
        { id: 'test-seeds', label: 'Test seeds ▾', onSelect: () => this.openTestSeeds() },
        { id: 'enter-seed', label: 'Enter seed', onSelect: () => this.setSubview('seed') },
      ],
      DIFFICULTIES.map((d) => ({
        id: `difficulty-${d}`,
        label: DIFFICULTY_LABEL[d],
        onSelect: () => this.chooseDifficulty(d),
      })),
      { id: 'difficulty-note', label: `${DIFFICULTY_LABEL[level]}: ${DIFFICULTY_NOTE[level]}` },
    );
    if (snap) {
      const victories = (snap.floors ?? []).reduce(
        (total, f) => total + f.clearedEncounters.length,
        snap.clearedEncounters.length,
      );
      rows.push({
        id: 'continue',
        label: `Continue  ${formatSeed(snap.run.seed)} · ${DIFFICULTY_LABEL[runDifficulty(snap.run)]} · ${victories} won · ${snap.run.cogs} cogs`,
        onSelect: () => this.deps.onContinue(),
      });
    }
    rows.push([
      { id: 'workshop', label: 'Workshop', onSelect: () => flow.openWorkshop() },
      { id: 'settings', label: 'Settings', onSelect: () => flow.openSettings() },
    ]);
    rows.push({ id: 'bank', label: `${flow.workshop.cogsBanked} cogs banked in the workshop` });
    this.board(
      'title',
      rows,
      { x: -0.42, y: -0.08, z: -BOARD_DISTANCE },
      { width: 0.6, selected: [`difficulty-${level}`] },
    );
  }

  /** Picks the level the next New Run starts at; settings remember it as the title's default. */
  private chooseDifficulty(level: Difficulty): void {
    if (this.deps.settings().difficulty === level) return;
    this.deps.onSettings({ ...this.deps.settings(), difficulty: level });
    this.refresh();
  }

  private openTestSeeds(): void {
    const selected = normalizeSeed(this.seedValue);
    const index = TEST_SEEDS.findIndex(({ seed }) => seed === selected);
    this.testSeedPage = Math.floor(Math.max(0, index) / TEST_SEED_PAGE_SIZE);
    this.setSubview('test-seeds');
  }

  private buildTestSeeds(): void {
    const pages = Math.ceil(TEST_SEEDS.length / TEST_SEED_PAGE_SIZE);
    const start = this.testSeedPage * TEST_SEED_PAGE_SIZE;
    const rows: MenuRow[] = TEST_SEEDS.slice(start, start + TEST_SEED_PAGE_SIZE).map(
      ({ seed, label }) => ({
        id: seed,
        label: `${label} · ${seed}`,
        onSelect: () => {
          this.seedValue = seed;
          this.setSubview('main');
        },
      }),
    );
    rows.push([
      {
        id: 'previous',
        label: 'Previous',
        onSelect: this.testSeedPage > 0 ? () => this.moveTestSeedPage(-1) : undefined,
      },
      { id: 'page', label: `${this.testSeedPage + 1} / ${pages}` },
      {
        id: 'next',
        label: 'Next',
        onSelect: this.testSeedPage + 1 < pages ? () => this.moveTestSeedPage(1) : undefined,
      },
      { id: 'back', label: 'Cancel', onSelect: () => this.setSubview('main') },
    ]);
    this.board(
      'test-seeds',
      rows,
      { x: 0, y: 0.28, z: -BOARD_DISTANCE },
      {
        width: 0.74,
        heading: 'Test seeds',
        selected: [normalizeSeed(this.seedValue)],
      },
    );
  }

  private moveTestSeedPage(delta: number): void {
    this.testSeedPage += delta;
    this.refresh();
  }

  private buildSeedPad(): void {
    const rows: MenuRow[] = [{ id: 'draft', label: '····-····' }];
    for (let r = 0; r < SEED_ALPHABET.length / 8; r += 1) {
      rows.push(
        [...SEED_ALPHABET.slice(r * 8, r * 8 + 8)].map((ch) => ({
          id: `k-${ch}`,
          label: ch,
          onSelect: () => this.typeKey(ch),
        })),
      );
    }
    rows.push([
      { id: 'back', label: 'Cancel', onSelect: () => this.setSubview('main') },
      { id: 'del', label: 'Delete', onSelect: () => this.typeKey('Backspace') },
      { id: 'done', label: 'Use seed', onSelect: () => this.commitSeed() },
    ]);
    this.board(
      'seedpad',
      rows,
      { x: 0, y: 0.2, z: -BOARD_DISTANCE },
      {
        width: 0.7,
        heading: 'Enter a seed',
      },
    );
    this.refreshSeedLabel();
  }

  private buildWorkshop(): void {
    if (this.workshopSubview === 'permanent-cards') {
      this.buildPermanentCards();
      return;
    }
    const { flow } = this.deps;
    const ws = flow.workshop;
    const rows: MenuRow[] = [{ id: 'bank', label: `${ws.cogsBanked} cogs banked` }];
    for (const id of UPGRADE_IDS) {
      const def = UPGRADES[id];
      const cost = nextCost(ws, id);
      const tier = `${ws.purchased[id]}/${maxTier(id)}`;
      const buy: MenuCell =
        cost === null
          ? { id: `buy-${id}`, label: 'Complete' }
          : flow.canBuy(id)
            ? { id: `buy-${id}`, label: `Buy · ${cost}`, onSelect: () => this.buy(id) }
            : { id: `buy-${id}`, label: `Needs ${cost}` };
      rows.push([{ id: `name-${id}`, label: `${def.name}  ${tier}`, weight: 2 }, buy]);
      rows.push({ id: `desc-${id}`, label: def.description });
    }
    rows.push({
      id: 'permanent-cards',
      label: 'Permanent cards',
      onSelect: () => this.openPermanentCards(),
    });
    rows.push({ id: 'back', label: 'Back to title', onSelect: () => flow.toTitle() });
    this.board(
      'workshop',
      rows,
      { x: 0, y: 0.32, z: -BOARD_DISTANCE },
      {
        width: 0.8,
        heading: 'Workshop',
      },
    );
  }

  private buy(id: UpgradeId): void {
    if (this.deps.flow.buy(id)) this.refresh();
  }

  private openPermanentCards(): void {
    this.workshopSubview = 'permanent-cards';
    this.permanentCardPage = 0;
    this.permanentCardMessage = '';
    this.refresh();
  }

  private buildPermanentCards(): void {
    const { flow } = this.deps;
    const start = this.permanentCardPage * PERMANENT_CARD_PAGE_SIZE;
    const cards = PERMANENT_CARD_IDS.slice(start, start + PERMANENT_CARD_PAGE_SIZE);
    const rows: MenuRow[] = [
      {
        id: 'bank',
        label: `${flow.workshop.cogsBanked} cogs banked`,
      },
    ];
    for (const id of cards) {
      const card = getCard(id);
      const owned = flow.workshop.permanentCards.filter((cardId) => cardId === id).length;
      const buy: MenuCell = flow.canBuyPermanentCard(id)
        ? {
            id: `buy-permanent-${id}`,
            label: `Buy · ${permanentCardCost(id)}`,
            onSelect: () => this.buyPermanent(id),
          }
        : { id: `buy-permanent-${id}`, label: `Needs ${permanentCardCost(id)}` };
      rows.push([
        { id: `icon-top-${id}`, label: '', weight: 0.5 },
        {
          id: `permanent-${id}`,
          label: `${card.name} · ${card.cost} steam · Owned ${owned}`,
          weight: 2,
        },
        buy,
      ]);
      rows.push([
        { id: `icon-bottom-${id}`, label: '', weight: 0.5 },
        { id: `permanent-effect-${id}`, label: card.description, weight: 3 },
      ]);
    }
    if (PERMANENT_CARD_IDS.length > PERMANENT_CARD_PAGE_SIZE) {
      const pageCount = Math.ceil(PERMANENT_CARD_IDS.length / PERMANENT_CARD_PAGE_SIZE);
      rows.push([
        {
          id: 'previous-page',
          label: 'Previous',
          onSelect: this.permanentCardPage > 0 ? () => this.changePermanentCardPage(-1) : undefined,
        },
        { id: 'page', label: `Page ${this.permanentCardPage + 1}/${pageCount}` },
        {
          id: 'next-page',
          label: 'Next',
          onSelect:
            this.permanentCardPage + 1 < pageCount
              ? () => this.changePermanentCardPage(1)
              : undefined,
        },
      ]);
    }
    rows.push({
      id: 'feedback',
      label: this.permanentCardMessage || 'Start every future run with each card you buy.',
    });
    rows.push({
      id: 'back',
      label: 'Back to workshop',
      onSelect: () => this.closePermanentCards(),
    });
    const board = this.board(
      'workshop',
      rows,
      { x: -0.1, y: 0.32, z: -BOARD_DISTANCE },
      {
        width: 0.9,
        heading: 'Permanent cards',
      },
    );
    const width = 0.088;
    const slots = cards.map((id) => {
      const top = board.panel.root.getObjectByName(`workshop-icon-top-${id}`);
      const bottom = board.panel.root.getObjectByName(`workshop-icon-bottom-${id}`);
      if (!top || !bottom) throw new Error(`Missing Workshop card slot for ${id}`);
      return {
        id,
        x: top.position.x,
        y: (top.position.y + bottom.position.y) / 2,
        width,
        height: width * HOLO_CARD_ASPECT,
      };
    });
    this.workshopFaces = new RewardCardFaces(slots, rewardCardTexture, this.deps.rewardCards);
    this.workshopFaces.root.name = 'workshop-card-faces';
    this.workshopFaces.root.position.z = 0.008;
    board.group.add(this.workshopFaces.root);
    this.workshopHits = new THREE.Group();
    this.workshopHits.name = 'workshop-card-hits';
    slots.forEach((slot) => {
      const hit = new THREE.Mesh(
        new THREE.PlaneGeometry(slot.width, slot.height),
        new THREE.MeshBasicMaterial({ visible: false }),
      );
      hit.name = `workshop-card-${slot.id}`;
      hit.position.set(slot.x, slot.y, 0.022);
      hit.userData.workshopCard = slot.id;
      this.workshopHits?.add(hit);
    });
    board.group.add(this.workshopHits);
  }

  private showWorkshopPreview(id: string): void {
    const faces = this.workshopFaces;
    const parent = faces?.root.parent;
    if (!parent || !faces?.slot(id) || this.workshopPreviewId === id) return;
    let preview = this.workshopPreviews.get(id);
    if (!preview) {
      const width = 0.36;
      preview = new RewardCardFaces(
        [{ id, x: 0, y: 0, width, height: width * HOLO_CARD_ASPECT }],
        rewardCardTexture,
        this.deps.rewardCards,
      );
      preview.root.name = `workshop-card-preview-${id}`;
      preview.root.position.set(0, -0.24, 0.12);
      preview.root.traverse((object) => {
        object.raycast = () => undefined;
      });
      parent.add(preview.root);
      this.workshopPreviews.set(id, preview);
    }
    const previous = this.workshopPreviewId && this.workshopPreviews.get(this.workshopPreviewId);
    if (previous) previous.root.visible = false;
    this.workshopPreviewId = id;
    preview.root.visible = true;
  }

  private buyPermanent(id: string): void {
    if (this.deps.flow.buyPermanentCard(id)) {
      this.permanentCardMessage = `${getCard(id).name} added permanently.`;
      this.refresh();
    }
  }

  private changePermanentCardPage(delta: number): void {
    const pageCount = Math.max(1, Math.ceil(PERMANENT_CARD_IDS.length / PERMANENT_CARD_PAGE_SIZE));
    this.permanentCardPage = Math.max(0, Math.min(pageCount - 1, this.permanentCardPage + delta));
    this.permanentCardMessage = '';
    this.refresh();
  }

  private closePermanentCards(): void {
    this.workshopSubview = 'main';
    this.permanentCardMessage = '';
    this.refresh();
  }

  private buildSettings(inRun = false): void {
    const s = this.deps.settings();
    const knob = (
      key: 'masterVolume' | 'musicVolume' | 'sfxVolume',
      label: string,
    ): readonly MenuCell[] => {
      const set = (delta: number) => {
        this.deps.onSettings({ ...this.deps.settings(), [key]: clamp01(s[key] + delta) });
        this.refresh();
      };
      return [
        { id: `${key}-label`, label, weight: 2 },
        { id: `${key}-down`, label: 'Lower', onSelect: () => set(-0.1) },
        { id: `${key}-value`, label: pct(s[key]) },
        { id: `${key}-up`, label: 'Raise', onSelect: () => set(0.1) },
      ];
    };
    // Comfort: a label that states the current choice and a Switch button that flips it.
    const comfort = (
      id: string,
      label: string,
      flip: (current: Settings) => Settings,
    ): readonly MenuCell[] => [
      { id: `${id}-label`, label, weight: 3 },
      {
        id: `${id}-toggle`,
        label: 'Switch',
        onSelect: () => {
          this.deps.onSettings(flip(this.deps.settings()));
          this.refresh();
        },
      },
    ];
    this.board(
      'settings',
      [
        knob('masterVolume', 'Master volume'),
        knob('musicVolume', 'Music'),
        knob('sfxVolume', 'Effects'),
        comfort('turnMode', `Turning: ${s.turnMode === 'snap' ? 'Snap' : 'Smooth'}`, (cur) => ({
          ...cur,
          turnMode: cur.turnMode === 'snap' ? 'smooth' : 'snap',
        })),
        comfort('teleportEnabled', `Teleport: ${s.teleportEnabled ? 'On' : 'Off'}`, (cur) => ({
          ...cur,
          teleportEnabled: !cur.teleportEnabled,
        })),
        ...this.choiceRows(),
        {
          id: 'minimap',
          label: 'Minimap',
          onSelect: () => {
            if (inRun) this.setMenu('minimap');
            else {
              this.settingsMinimap = true;
              this.refresh();
            }
          },
        },
        ...(inRun && !this.deps.flow.guardianDefeated
          ? [{ id: 'abandon', label: 'Abandon run', onSelect: () => this.setMenu('confirm') }]
          : []),
        ...(inRun && this.deps.flow.phase === 'explore' && this.deps.flow.guardianDefeated
          ? [
              {
                id: 'finish-run',
                label: 'Finish run',
                onSelect: () => this.deps.flow.finishVictory(),
              },
            ]
          : []),
        {
          id: 'back',
          label: inRun ? 'Back to menu' : 'Back to title',
          onSelect: () => (inRun ? this.setMenu('main') : this.deps.flow.toTitle()),
        },
      ],
      { x: 0, y: 0.26, z: -BOARD_DISTANCE },
      { width: 0.8, heading: 'Settings', selected: this.choiceSelected() },
    );
  }

  private buildMinimap(inRun: boolean): void {
    const s = this.deps.settings();
    const choose = (change: Partial<Settings>): void => {
      this.deps.onSettings({ ...this.deps.settings(), ...change });
      this.refresh();
    };
    const board = this.board(
      'minimap',
      [
        [
          { id: 'enabled-label', label: 'Show overlay', weight: 2 },
          { id: 'enabled-off', label: 'Off', onSelect: () => choose({ minimapEnabled: false }) },
          { id: 'enabled-on', label: 'On', onSelect: () => choose({ minimapEnabled: true }) },
        ],
        [
          { id: 'north-up-label', label: 'North up', weight: 2 },
          { id: 'north-up-off', label: 'Off', onSelect: () => choose({ minimapNorthUp: false }) },
          { id: 'north-up-on', label: 'On', onSelect: () => choose({ minimapNorthUp: true }) },
        ],
        [
          { id: 'zoom-label', label: 'Zoom', weight: 2 },
          ...MINIMAP_ZOOMS.map((zoom) => ({
            id: `zoom-${zoom}`,
            label: `${zoom === 1 ? '1.0' : zoom}×`,
            onSelect: () => choose({ minimapZoom: zoom }),
          })),
        ],
        [
          { id: 'horizontal-label', label: 'Horizontal', weight: 1.25 },
          { id: 'horizontal', label: '', weight: 3, onSelect: () => {} },
          { id: 'horizontal-value', label: `${minimapPercentage(s.minimapHorizontal)}%` },
        ],
        [
          { id: 'vertical-label', label: 'Vertical', weight: 1.25 },
          { id: 'vertical', label: '', weight: 3, onSelect: () => {} },
          { id: 'vertical-value', label: `${minimapPercentage(s.minimapVertical)}%` },
        ],
        {
          id: 'back',
          label: 'Back to settings',
          onSelect: () => {
            if (inRun) this.setMenu('settings');
            else {
              this.settingsMinimap = false;
              this.refresh();
            }
          },
        },
      ],
      { x: 0, y: 0.2, z: -BOARD_DISTANCE },
      {
        width: 1.05,
        heading: 'Minimap',
        selected: [
          `enabled-${s.minimapEnabled ? 'on' : 'off'}`,
          `north-up-${s.minimapNorthUp ? 'on' : 'off'}`,
          `zoom-${s.minimapZoom}`,
        ],
      },
    );
    this.addMinimapSlider(board, 'minimap-horizontal', 'minimapHorizontal', 'horizontal');
    this.addMinimapSlider(board, 'minimap-vertical', 'minimapVertical', 'vertical');
  }

  private addMinimapSlider(
    board: Board,
    id: string,
    key: MinimapPlacementKey,
    cellId: string,
  ): void {
    const cell = [...board.panel.root.children].find(
      (child) => board.panel.cellAt(child) === cellId,
    );
    if (!cell) return;
    const mesh = cell as THREE.Mesh;
    const length =
      Math.max(0.18, (mesh.geometry as THREE.PlaneGeometry)?.parameters?.width ?? 0.28) * 0.9;
    const group = new THREE.Group();
    group.name = id;
    group.position.set(cell.position.x, cell.position.y, cell.position.z + 0.012);
    const rail = new THREE.Mesh(
      new THREE.PlaneGeometry(length, 0.008),
      new THREE.MeshBasicMaterial({ color: PALETTE.brass }),
    );
    rail.name = `${id}-rail`;
    rail.userData.minimapSlider = id;
    const knob = new THREE.Mesh(
      new THREE.CircleGeometry(0.018, 12),
      new THREE.MeshBasicMaterial({ color: PALETTE.candle }),
    );
    knob.name = `${id}-knob`;
    knob.userData.minimapSlider = id;
    const center = new THREE.Mesh(
      new THREE.PlaneGeometry(0.004, 0.022),
      new THREE.MeshBasicMaterial({ color: PALETTE.brass }),
    );
    center.userData.minimapSlider = id;
    knob.position.z = 0.001;
    group.add(rail, center, knob);
    board.panel.root.add(group);
    const value = this.deps.settings()[key];
    knob.position.x = (length / 2) * (value / MINIMAP_PLACEMENT_LIMIT);
    this.minimapSliders.set(id, {
      key,
      group,
      knob,
      length,
      panel: board.panel,
      valueId: `${cellId}-value`,
      percentage: minimapPercentage(value),
    });
  }

  private paintMinimapSlider(slider: MinimapSlider, value: number): void {
    slider.knob.position.x = (slider.length / 2) * (value / MINIMAP_PLACEMENT_LIMIT);
    const percentage = minimapPercentage(value);
    if (slider.percentage === percentage) return;
    slider.percentage = percentage;
    slider.panel.setLabel(slider.valueId, `${percentage}%`);
  }

  /**
   * The rows of choices the settings and the in-run menu share: table distance, foveation and the
   * frame-rate counter. The chosen one is drawn selected; picking another saves it at once.
   */
  private choiceRows(): MenuRow[] {
    const choose = (change: Partial<Settings>): void => {
      this.tableDistanceMessage = '';
      if (
        change.tableDistance !== undefined &&
        this.deps.setTableDistance?.(change.tableDistance) === false
      ) {
        this.tableDistanceMessage = `No clearance at ${change.tableDistance.toFixed(1)} m`;
      } else {
        this.deps.onSettings({ ...this.deps.settings(), ...change });
      }
      this.refresh();
    };
    return [
      [
        {
          id: 'tableDistance-label',
          label: this.tableDistanceMessage || 'Table distance',
          weight: 2,
        },
        ...TABLE_DISTANCE_CHOICES.map((d) => ({
          id: tableDistanceCell(d),
          label: `${d.toFixed(1)} m`,
          onSelect: () => choose({ tableDistance: d }),
        })),
      ],
      [
        { id: 'foveation-label', label: 'Foveation', weight: 2 },
        ...FOVEATION_CHOICES.map((level) => ({
          id: `foveation-${level}`,
          label: FOVEATION_LABEL[level],
          onSelect: () => choose({ foveation: level }),
        })),
      ],
      [
        { id: 'fpsCounter-label', label: 'FPS counter', weight: 2 },
        { id: 'fpsCounter-off', label: 'Off', onSelect: () => choose({ fpsCounter: false }) },
        { id: 'fpsCounter-on', label: 'On', onSelect: () => choose({ fpsCounter: true }) },
      ],
    ];
  }

  /** Cells `choiceRows` draws as chosen. */
  private choiceSelected(): string[] {
    const s = this.deps.settings();
    return [
      tableDistanceCell(s.tableDistance),
      `foveation-${s.foveation}`,
      `fpsCounter-${s.fpsCounter ? 'on' : 'off'}`,
    ];
  }

  /**
   * The in-run menu: Resume, the deck viewer (exploring only), the shared choices and Abandon run;
   * or the deck viewer; or the abandon confirmation.
   */
  private buildMenu(): void {
    if (this.menu === 'items') {
      this.buildItems();
      return;
    }
    if (this.menu === 'logbook') {
      this.buildLogbook();
      return;
    }
    if (this.menu === 'note') {
      this.buildNote();
      return;
    }
    if (this.menu === 'settings') {
      this.buildRunSettings();
      return;
    }
    if (this.menu === 'minimap') {
      this.buildMinimap(true);
      return;
    }
    if (this.menu === 'deck') {
      this.buildDeck();
      return;
    }
    if (this.menu === 'confirm') {
      this.board(
        'menu-confirm',
        [
          [
            { id: 'yes', label: 'Yes, abandon', onSelect: () => this.deps.flow.abandonRun() },
            { id: 'no', label: 'No', onSelect: () => this.setMenu('main') },
          ],
        ],
        { x: 0, y: 0.2, z: -BOARD_DISTANCE },
        { width: 0.6, heading: 'Abandon this run?' },
      );
      return;
    }
    this.buildRadialMenu();
  }

  private buildRadialMenu(): void {
    this.radialMenu = createRadialMenu<RunMenuAction>({
      items: [...RUN_MENU_ITEMS],
      accentColor: PALETTE.brass,
      theme: {
        glass: '#244541',
        selected: '#996830',
        cancel: '#60422b',
        text: PALETTE.parchment,
        outline: PALETTE.brass,
      },
      centerLabel: 'Resume',
    });
    this.radialMenu.root.position.set(0, 0, -BOARD_DISTANCE);
    this.radialMenu.root.scale.setScalar(1.18);
    this.radialMenu.open();
    this.releaseDial = dressClockworkDial(this.radialMenu.root, this.deps.dialProbe ?? null);
    const room = this.deps.locationLabel?.();
    if (room) {
      const plaque = createScalableLabel(room, 0.55, 0.063, {
        background: PALETTE.warmBlack,
        border: PALETTE.brass,
      });
      plaque.name = 'showcase-room-plaque';
      plaque.position.set(0, -0.44, 0.01);
      this.radialMenu.root.add(plaque);
      this.extras.push(plaque);
    }
    this.root.add(this.radialMenu.root);
    this.extras.push(this.radialMenu.root);
  }

  private buildRunSettings(): void {
    this.buildSettings(true);
  }

  private setMenu(view: MenuView): void {
    this.tableDistanceMessage = '';
    this.menu = view;
    this.refresh();
  }

  private openDeck(): void {
    this.deckPage = 0;
    this.setMenu('deck');
  }

  private openItems(): void {
    this.noteId = null;
    this.setMenu('items');
  }

  private openLogbook(clueId?: LogbookEntry['id'], section?: typeof this.bookSection): void {
    this.bookSection = section ?? (clueId ? 'clues' : this.defaultBookSection());
    this.logbookCard = null;
    this.logbookMapViews.clear();
    this.logbookPages.clear();
    this.logbookHandSwipe = createLogbookHandSwipes();
    this.logbookStart = clueId
      ? Math.max(
          0,
          this.deps.flow.logbookEntries.findIndex(({ id }) => id === clueId),
        )
      : 0;
    this.setMenu('logbook');
    if (this.logbook)
      this.deps.onNoteOpened?.(this.logbook.root.getWorldPosition(new THREE.Vector3()));
  }

  private turnLogbook(offset: -1 | 1): void {
    const book = this.logbook;
    if (book?.turn(offset, this.deps.reducedMotion ?? false)) {
      this.logbookPages.set(
        this.bookSection,
        book.page + (this.deps.reducedMotion ? 0 : offset * 2),
      );
      return;
    }
    if (!book) return;
    this.crossLogbookBoundary(book);
  }

  private crossLogbookBoundary(book: Logbook): boolean {
    const offset = book.takeBoundary();
    if (offset === null || book.turning) return false;
    this.logbookPages.set(this.bookSection, book.page);
    const sections = this.availableBookSections();
    const current = sections.indexOf(this.bookSection);
    const next = sections[current + offset];
    if (!next) return false;
    this.bookSection = next;
    const pageCount = this.bookPageCount(next);
    this.logbookPages.set(next, offset > 0 ? 0 : Math.max(0, pageCount - 1));
    this.animateBookSection(offset);
    return true;
  }

  tapLogbookEdge(ray: THREE.Ray): boolean {
    if (this.menu !== 'logbook') return false;
    const book = this.logbook;
    if (!book) return false;
    const result = book.tapEdge(ray, this.deps.reducedMotion ?? false);
    return this.crossLogbookBoundary(book) || result;
  }

  sampleLogbookHand(side: 'left' | 'right', point: THREE.Vector3 | null): boolean {
    if (this.menu !== 'logbook') return false;
    const book = this.logbook;
    if (!book) return false;
    const result = book.sampleHand(side, point, this.deps.reducedMotion ?? false);
    return this.crossLogbookBoundary(book) || result;
  }

  logbookMapPoint(ray: THREE.Ray, inside = true): MapPoint | null {
    return this.logbook?.mapPoint(ray, inside) ?? null;
  }

  selectLogbookMarkerTool(ray: THREE.Ray): boolean {
    return this.logbook?.selectMarkerTool(ray) ?? false;
  }

  applyLogbookMarker(ray: THREE.Ray): boolean {
    return this.logbook?.applyMapMarker(ray) ?? false;
  }

  adjustLogbookMap(dx: number, dy: number, multiplier = 1, anchor?: MapPoint): void {
    this.logbook?.adjustMap(dx, dy, multiplier, anchor);
  }

  panLogbookStick(x: number, forward: number, dt: number): boolean {
    if (this.bookSection !== 'map' || this.menu !== 'logbook') return false;
    const strength = Math.hypot(x, forward);
    if (strength < 0.18) return false;
    const distance = (760 * Math.min(dt, 0.05) * (strength - 0.18)) / (0.82 * strength);
    this.adjustLogbookMap(-x * distance, forward * distance);
    return true;
  }

  private selectBookSection(section: typeof this.bookSection): void {
    if (this.bookSection === section || this.logbook?.turning) return;
    const sections = this.availableBookSections();
    const offset = sections.indexOf(section) > sections.indexOf(this.bookSection) ? 1 : -1;
    if (this.logbook) this.logbookPages.set(this.bookSection, this.logbook.page);
    this.bookSection = section;
    this.logbookHandSwipe = createLogbookHandSwipes();
    this.animateBookSection(offset);
  }

  private animateBookSection(offset: -1 | 1): void {
    const outgoing = this.deps.reducedMotion ? null : this.logbook?.spreadTextures();
    this.refresh();
    if (outgoing) this.logbook?.animateBoundary(offset, outgoing);
    if (this.logbook)
      this.deps.onNoteOpened?.(this.logbook.root.getWorldPosition(new THREE.Vector3()));
  }

  private defaultBookSection(): 'map' | 'clues' {
    return this.deps.logbookMaps?.().length ? 'map' : 'clues';
  }

  private bookPages(section = this.bookSection): readonly BookPagePainter[] | undefined {
    const flow = this.deps.flow;
    switch (section) {
      case 'cards':
        return runCardPages(flow);
      case 'stats':
        return runStatsPages(flow);
      case 'puzzles': {
        const clues = activePuzzlePages(flow, { pressureNotes: this.deps.puzzlePressureNotes?.() });
        if (clues.length) return clues.map(puzzlePage);
        return [
          puzzlePage({
            puzzle: 'Puzzles',
            title: 'No clues found yet',
            text: 'Read a clue in the Spire to find it here.',
          }),
        ];
      }
      default:
        return undefined;
    }
  }

  private availableBookSections(): (typeof this.bookSection)[] {
    return this.defaultBookSection() === 'map'
      ? ['map', 'clues', 'puzzles', 'cards', 'stats']
      : ['clues', 'puzzles', 'cards', 'stats'];
  }

  private bookPageCount(section: typeof this.bookSection): number {
    if (section === 'clues') return this.deps.flow.logbookEntries.length;
    if (section === 'map') return (this.deps.logbookMaps?.() ?? []).length * 2;
    return this.bookPages(section)?.length ?? 0;
  }

  private buildLogbook(): void {
    if (this.logbookCard) {
      const board = this.board(
        'logbook-inspection',
        [
          [
            {
              id: 'back',
              label: 'Back to cards',
              onSelect: () => {
                this.logbookCard = null;
                this.refresh();
              },
            },
          ],
        ],
        { x: 0, y: -0.36, z: -BOARD_DISTANCE },
        { width: 0.34 },
      );
      const width = 0.41;
      this.logbookCardFace = new RewardCardFaces(
        [{ id: this.logbookCard, x: 0, y: 0.37, width, height: width * HOLO_CARD_ASPECT }],
        rewardCardTexture,
        this.deps.rewardCards,
      );
      this.logbookCardFace.root.name = 'logbook-inspected-card';
      board.group.add(this.logbookCardFace.root);
      return;
    }
    const sections = [
      { id: 'map', label: 'Map' },
      { id: 'clues', label: 'Clues' },
      { id: 'puzzles', label: 'Puzzles' },
      { id: 'cards', label: 'Cards' },
      { id: 'stats', label: 'Stats' },
    ] as const;
    const availableMaps = this.deps.logbookMaps?.();
    const tabs: MenuCell[] = sections
      .filter(({ id }) => id !== 'map' || Boolean(availableMaps?.length))
      .map(({ id, label }) => ({ id, label, onSelect: () => this.selectBookSection(id) }));
    tabs.push({ id: 'close', label: 'Close book', onSelect: () => this.closeMenu() });
    const maps = this.bookSection === 'map' ? availableMaps : undefined;
    const pages = this.bookPages();
    const entries = this.bookSection === 'clues' ? this.deps.flow.logbookEntries : [];
    const controls: MenuCell[] = [
      { id: 'previous', label: 'Back a page', onSelect: () => this.turnLogbook(-1) },
      { id: 'next', label: 'Next page', onSelect: () => this.turnLogbook(1) },
    ];
    if (maps)
      controls.push(
        {
          id: 'zoom-out',
          label: 'Zoom out',
          onSelect: () => this.adjustLogbookMap(0, 0, 1 / Math.SQRT2),
        },
        { id: 'fit', label: 'Fit map', onSelect: () => this.logbook?.fitMap() },
        {
          id: 'zoom-in',
          label: 'Zoom in',
          onSelect: () => this.adjustLogbookMap(0, 0, Math.SQRT2),
        },
      );
    const board = this.board(
      'menu-logbook',
      [tabs, controls],
      { x: 0, y: -0.36, z: -BOARD_DISTANCE },
      { width: 1.13, selected: [this.bookSection] },
    );
    const activeMap = maps?.findIndex(({ floor }) => floor === this.deps.flow.floorNumber) ?? 0;
    const openedAt =
      this.logbookPages.get(this.bookSection) ??
      (maps ? 2 * Math.max(0, activeMap) : this.bookSection === 'clues' ? this.logbookStart : 0);
    this.logbook = new Logbook(entries, this.deps.flow.run?.seed ?? '', openedAt, {
      maps,
      pages,
      mapViews: this.logbookMapViews,
      showFinds: this.showMapFinds,
      mapHeading: this.deps.logbookHeading,
      handSwipe: this.logbookHandSwipe,
      onTurn: (root) => this.deps.onNoteOpened?.(root.getWorldPosition(new THREE.Vector3())),
      mapMarkers: maps
        ? {
            read: (floor) => this.deps.flow.mapMarkersOnFloor(floor),
            add: (floor, marker) => this.deps.flow.addMapMarker(floor, marker),
            remove: (floor, index) => this.deps.flow.removeMapMarker(floor, index),
          }
        : undefined,
    });
    this.logbook.root.userData.section = this.bookSection;
    this.logbook.root.position.y = 0.406;
    board.group.add(this.logbook.root);
  }

  private buildItems(): void {
    const ids = this.deps.flow.pressure.notes;
    const rows: MenuRow[] = ids.map((id) => {
      const record = this.deps.noteRecord?.(id);
      return {
        id: `item-${id}`,
        label: record ? `${record.title} · ${record.source}` : id,
        onSelect: () => {
          if (!this.menuHead || !record) return;
          this.readNote(id, this.menuHead, false);
        },
      };
    });
    const run = this.deps.flow.run;
    if (run?.bellChimes?.clueHeard) {
      const phrase = bellMelody(run.seed)
        .map((note) => note + 1)
        .join(' · ');
      rows.unshift({ id: 'bell-score', label: `Bell score · ${phrase}` });
    }
    if (run?.commission && (run.commission.accepted || run.commission.recovered.length)) {
      const job = this.deps.flow.commission;
      const status = job.claimed
        ? 'Paid'
        : job.progress === job.total && job.accepted
          ? 'Payment ready'
          : `${job.progress}/${job.total}`;
      rows.push({ id: 'keeper-order', label: COMMISSION_TITLES[job.kind] + ' · ' + status });
    }
    if (run?.brassCacheSeen && this.deps.flow.brassKey !== 'spent') {
      const place =
        this.deps.flow.brassCache?.socketId === 'desk-drawer' ? 'Study drawer' : 'Treasure chest';
      rows.push({ id: 'brass-stamp', label: place + ' · Upper Works stamp' });
    }
    if (this.deps.flow.brassKey === 'held')
      rows.push({ id: 'brass-coffer-key', label: 'Brass key · lower-floor coffer' });
    if (this.deps.flow.brassKey === 'spent')
      rows.push({ id: 'brass-coffer-open', label: 'Lower-floor coffer · unlocked' });
    if (run?.calibration?.key === 'held')
      rows.push({ id: 'orrery-winding-key', label: 'Winding key · insert in the orrery arbor' });
    if (run?.calibration?.spare && !run.calibration.repaired)
      rows.push({ id: 'orrery-service-coupling', label: 'Orrery shaft coupling · carried' });
    if (run?.calibration?.chart) {
      const plan = calibrationPlan(run.seed);
      rows.push({
        id: 'instrument-diagram',
        label:
          plan.kind === 'gears'
            ? 'Gear train · ' + plan.gearOrder.map((id) => GEAR_TEETH[id]).join(' / ')
            : 'Star chart · ' +
              plan.detents.map((d, i) => PLANET_NAMES[i] + ' ' + BEARINGS[d][0]).join(' / '),
      });
      if (run.calibration.solved && !run.calibration.claimed)
        rows.push({ id: 'instrument-prize', label: 'Supply cabinet · released' });
    }
    if (run?.hiddenPanel?.discovered)
      rows.push({
        id: 'discovered-panel',
        label: run.hiddenPanel.opened
          ? 'Upper Works · service recess open'
          : 'Upper Works · loose service catch',
      });
    const formula = run?.conservatoryFormula;
    if (run && formula) {
      if (formula.carried) rows.unshift({ id: 'archive-potion', label: brewNames[formula.recipe] });
      for (const clue of formula.clues)
        rows.push({
          id: 'formula-' + clue,
          label:
            (clue === 'portrait' ? 'Portrait' : 'Upper Works') +
            ' · ' +
            this.deps.flow.describeFormulaClue(clue),
        });
    }
    if (run?.alchemy?.carried)
      rows.unshift({ id: 'thornwake-draught', label: 'Thornwake Draught' });
    else if (run?.alchemy && (!run.alchemy.brewed || (run.alchemy.opened && !formula?.brewed))) {
      const added = run.alchemy.opened ? formula?.added : run.alchemy.added;
      for (const id of run.alchemy.found.filter((id) => !added?.includes(id)))
        rows.unshift({ id: 'ingredient-' + id, label: ingredientNames[id] });
    }
    const keys = run?.bookSecretKeyRooms ?? [];
    const unlocked = new Set(run?.bookSecretCabinetRooms ?? []);
    const carriedKeys = keys.filter((room) => !unlocked.has(room)).length;
    if (carriedKeys)
      rows.unshift({
        id: 'clockmakers-key',
        label: carriedKeys === 1 ? 'Clockmaker’s key' : `Clockmaker’s keys ×${carriedKeys}`,
      });
    if (run && this.deps.flow.valvehouse === 'held') {
      rows.push({
        id: 'valvehouse-gasket',
        label: `Valvehouse · ${gasketFor(run.seed)} gasket`,
      });
    }
    if (this.deps.flow.reliquarySeal !== 'hidden')
      rows.push({
        id: RUBBING_NOTE,
        label: 'Keeper’s rubbing · Stone Reliquary',
        onSelect: () => {
          if (this.menuHead) this.readReliquaryRubbing(this.menuHead, false);
        },
      });
    if (!rows.length) rows.push({ id: 'empty', label: 'No items collected yet' });
    rows.push({ id: 'back', label: 'Back', onSelect: () => this.setMenu('main') });
    this.board(
      'menu-items',
      rows,
      { x: 0, y: 0.22, z: -BOARD_DISTANCE },
      { width: 0.8, heading: 'Items' },
    );
  }

  private fieldNote(id: FieldNoteId): LogbookEntry | null {
    if (id === RUBBING_NOTE) {
      return {
        id,
        title: 'Keeper’s rubbing',
        body: 'Copy this mark in one continuous stroke.',
        origin: 'Stone Reliquary · seal plate',
      };
    }
    const record = this.deps.noteRecord?.(id);
    if (!record) return null;
    return {
      id,
      title: record.title,
      body: record.body,
      origin: record.origin ?? `Found on the ${record.source}`,
    };
  }

  private buildNote(): void {
    const entry = this.noteId && this.fieldNote(this.noteId);
    if (!entry) {
      this.setMenu('items');
      return;
    }
    const { id, title, body, origin } = entry;
    const seed = this.deps.flow.run?.seed;
    const glyph = id === RUBBING_NOTE && seed ? reliquaryGlyph(seed) : null;
    const controls: MenuRow = [
      { id: 'add-show', label: 'Add & show', onSelect: () => this.openLogbook(id) },
      { id: 'add-close', label: 'Add & close', onSelect: () => this.closeMenu() },
    ];
    const board = this.board(
      'menu-note',
      [controls],
      { x: 0, y: -0.34, z: -BOARD_DISTANCE },
      { width: 0.78 },
    );
    const paper = document.createElement('canvas');
    paper.width = 1200;
    paper.height = 760;
    const ctx = paper.getContext('2d');
    if (ctx) {
      const wash = ctx.createLinearGradient(0, 0, paper.width, paper.height);
      wash.addColorStop(0, '#f3e3c1');
      wash.addColorStop(0.7, '#e7d1a5');
      wash.addColorStop(1, '#d2b88d');
      ctx.fillStyle = wash;
      ctx.fillRect(0, 0, paper.width, paper.height);
      ctx.strokeStyle = '#917650';
      ctx.lineWidth = 3;
      ctx.strokeRect(26, 26, 1148, 708);
      ctx.fillStyle = '#624429';
      ctx.font = '600 32px system-ui, sans-serif';
      ctx.fillText(glyph ? 'UPPER WORKS' : 'PRESSURE WORKS', 76, 104);
      ctx.fillStyle = '#2e2118';
      ctx.font = 'bold 66px Georgia, serif';
      ctx.fillText(title, 72, 213, 1050);
      ctx.fillRect(76, 253, 1048, 3);
      ctx.font = '43px system-ui, sans-serif';
      let y = 350;
      for (const line of wrapText(ctx, body, 1028)) {
        ctx.fillText(line, 76, y);
        y += 62;
      }
      if (glyph) {
        ctx.beginPath();
        glyph.points.forEach(({ x, y }, i) => {
          const px = 600 + x * 238;
          const py = 500 - y * 238;
          if (i === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        });
        ctx.lineWidth = 14;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.strokeStyle = '#453123';
        ctx.stroke();
      }
      ctx.fillStyle = '#5b422b';
      ctx.font = 'italic 32px Georgia, serif';
      ctx.fillText(origin, 76, 678, 1042);
    }
    const texture = new THREE.CanvasTexture(paper);
    configureTextTexture(texture);
    const sheet = new THREE.Mesh(
      new THREE.PlaneGeometry(0.84, (0.84 * 760) / 1200),
      new THREE.MeshBasicMaterial({ map: texture, toneMapped: false }),
    );
    sheet.name = 'menu-note-sheet';
    sheet.userData.noteId = id;
    sheet.userData.title = title;
    sheet.userData.body = body;
    sheet.position.set(0, 0.336, 0.004);
    sheet.raycast = () => undefined;
    board.group.add(sheet);
  }

  private turnDeckPage(page: number): void {
    this.deckPage = page;
    this.refresh();
  }

  private buildDeck(): void {
    const deck = this.deps.flow.run?.deck ?? [];
    const stacks = deckStacks(deck, this.deckSort);
    const pages = Math.max(1, Math.ceil(stacks.length / DECK_PAGE_SIZE));
    this.deckPage = Math.min(Math.max(0, this.deckPage), pages - 1);
    const page = this.deckPage;
    const cards = stacks.slice(page * DECK_PAGE_SIZE, (page + 1) * DECK_PAGE_SIZE);
    const cardHeight = DECK_CARD_WIDTH * HOLO_CARD_ASPECT;
    const width = DECK_COLUMNS * DECK_CARD_WIDTH + (DECK_COLUMNS - 1) * DECK_GAP;
    const top = 0.37;
    const info = this.board(
      'menu-deck',
      [
        {
          id: 'count',
          label: `${deck.length} ${deck.length === 1 ? 'card' : 'cards'} · ${stacks.length} distinct · page ${page + 1} of ${pages}`,
        },
        DECK_SORTS.map((sort) => ({
          id: sort,
          label: DECK_SORT_LABEL[sort],
          onSelect: () => {
            if (this.deckSort === sort) return;
            this.deckSort = sort;
            this.turnDeckPage(0);
          },
        })),
      ],
      { x: 0, y: top, z: -BOARD_DISTANCE },
      { width, heading: 'Your deck', selected: [this.deckSort] },
    );
    const cardsTop = top - info.panel.height - BOARD_PAD * 2 - 0.03;
    const slots = cards.map((stack, i) => {
      const column = i % DECK_COLUMNS;
      const row = Math.floor(i / DECK_COLUMNS);
      return {
        ...stack,
        x: -width / 2 + DECK_CARD_WIDTH / 2 + column * (DECK_CARD_WIDTH + DECK_GAP),
        y: -cardHeight / 2 - row * (cardHeight + DECK_GAP),
        width: DECK_CARD_WIDTH,
        height: cardHeight,
      };
    });
    this.deckFaces = new RewardCardFaces(slots, rewardCardTexture, this.deps.rewardCards);
    this.deckFaces.root.name = 'deck-card-faces';
    this.deckFaces.root.position.set(0, cardsTop, -BOARD_DISTANCE);
    this.root.add(this.deckFaces.root);
    this.addStackDecorations(this.deckFaces.root, slots, cardHeight);
    // The faces only draw; these undrawn planes take the pointer for the keyword tip.
    this.deckHits = new THREE.Group();
    this.deckHits.name = 'deck-card-hits';
    slots.forEach((slot, i) => {
      const hit = new THREE.Mesh(
        new THREE.PlaneGeometry(slot.width, slot.height),
        new THREE.MeshBasicMaterial({ visible: false }),
      );
      hit.position.set(slot.x, slot.y, 0);
      hit.userData.deckCard = i;
      this.deckHits?.add(hit);
    });
    this.deckFaces.root.add(this.deckHits);
    const rows = pages > 1 ? DECK_ROWS : Math.max(1, Math.ceil(cards.length / DECK_COLUMNS));
    const navY = cardsTop - rows * cardHeight - (rows - 1) * DECK_GAP - 0.05;
    this.board(
      'menu-deck-nav',
      [
        [
          ...(pages > 1
            ? [
                {
                  id: 'prev',
                  label: 'Previous',
                  ...(page > 0 ? { onSelect: () => this.turnDeckPage(page - 1) } : {}),
                },
                {
                  id: 'next',
                  label: 'Next',
                  ...(page < pages - 1 ? { onSelect: () => this.turnDeckPage(page + 1) } : {}),
                },
              ]
            : []),
          { id: 'back', label: 'Back', onSelect: () => this.setMenu('main') },
        ],
      ],
      { x: 0, y: navY, z: -BOARD_DISTANCE },
      { width: pages > 1 ? width : 0.26 },
    );
  }

  private addStackDecorations(
    root: THREE.Group,
    slots: readonly (RewardCardSlot & { count: number })[],
    height: number,
  ): void {
    const layerCount = slots.reduce((total, slot) => total + Math.min(2, slot.count - 1), 0);
    if (!layerCount) return;
    const backs = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(DECK_CARD_WIDTH, height),
      new THREE.MeshBasicMaterial({
        map: plateTexture(PALETTE.walnut, PALETTE.brass, DECK_CARD_WIDTH, height, 0.009),
        toneMapped: false,
      }),
      layerCount,
    );
    backs.name = 'deck-stack-backs';
    backs.raycast = () => undefined;
    const matrix = new THREE.Matrix4();
    let index = 0;
    for (const slot of slots) {
      if (slot.count < 2) continue;
      for (let layer = 1; layer <= Math.min(2, slot.count - 1); layer++) {
        const offset = layer * 0.0065;
        backs.setMatrixAt(
          index++,
          matrix.makeTranslation(slot.x + offset, slot.y + offset, -0.0015 * layer),
        );
      }
      const text = `×${slot.count}`;
      const width = Math.min(slot.width * 0.76, 0.019 + 0.014 * text.length);
      const badge = createScalableLabel(text, width, 0.033, {
        background: PALETTE.warmBlack,
        border: PALETTE.brass,
        fontSize: Math.min(0.024, width / (text.length * 0.7)),
      });
      badge.name = `deck-stack-count-${slot.id}`;
      badge.position.set(slot.x + (slot.width - width) / 2 - 0.004, slot.y - height * 0.075, 0.008);
      badge.traverse((node) => {
        node.raycast = () => undefined;
      });
      root.add(badge);
      this.extras.push(badge);
    }
    root.add(backs);
    this.deckBacks = backs;
  }

  /** Drops a reward flight without applying its pick (the board went away under it). */
  private endFlight(): void {
    if (!this.flight) return;
    this.flight.face.dispose();
    this.flight = null;
  }

  /**
   * Takes reward card `slot.id`: it leaves the board and a copy flies from its slot to the fly
   * target, shrinking, while the other cards drop away; `update` applies the pick when it lands.
   * Without a target the pick applies at once.
   */
  private pickRewardCard(slot: { id: string; x: number; y: number; width: number }): void {
    const { flow } = this.deps;
    this.hideCardTip();
    const target = this.deps.flyTarget?.() ?? null;
    if (!target || !this.rewardFaces?.claim(slot.id)) {
      flow.pickReward(slot.id);
      return;
    }
    const face = new RewardCardFaces(
      [{ id: slot.id, x: 0, y: 0, width: slot.width, height: slot.width * HOLO_CARD_ASPECT }],
      rewardCardTexture,
      this.deps.rewardCards,
    );
    face.root.name = 'reward-flight';
    const cards = this.boards.find((b) => b.name === 'reward')?.panel.root;
    this.root.updateWorldMatrix(true, true);
    const at = cards
      ? this.root.worldToLocal(cards.localToWorld(new THREE.Vector3(slot.x, slot.y, 0.01)))
      : new THREE.Vector3();
    face.root.position.copy(at);
    this.root.add(face.root);
    this.flight = { card: slot.id, face, from: at.clone(), target, t: 0 };
  }

  private buildReward(): void {
    const { flow } = this.deps;
    const offer = flow.offer;
    if (!offer) return;
    const deck = new Set(flow.run?.deck ?? []);
    const n = offer.cards.length;
    const width = Math.min(1.25, 0.3 * n + 0.02 * (n - 1));
    const cardHeight = ((width - 0.02 * (n - 1)) / n) * HOLO_CARD_ASPECT;
    const header = this.board(
      'reward-info',
      [{ id: 'cogs', label: `${offer.cogs} cogs · choose one card for the deck` }],
      { x: 0, y: 0.32, z: -BOARD_DISTANCE },
      {
        width,
        heading: offer.tier === 'guardian' ? 'Guardian reward' : 'The automatons fall silent',
      },
    );
    const cards = createMenuPanel({
      name: 'reward',
      rows: [
        offer.cards.map((id) => ({
          id,
          label: '',
          backplate: false,
          onSelect: () => {
            const slot = slots.find((sl) => sl.id === id);
            if (slot) this.pickRewardCard(slot);
            else flow.pickReward(id);
          },
        })),
      ],
      width,
      rowHeight: cardHeight,
      cellGap: 0.02,
    });
    const group = new THREE.Group();
    group.position.set(0, 0.32 - header.panel.height - BOARD_PAD * 2 - 0.03, -BOARD_DISTANCE);
    group.add(cards.root);
    const slots = cards.root.children.flatMap((child) => {
      const id = cards.cellAt(child);
      if (!id) return [];
      child.userData.accessibleLabel = `${deck.has(id) ? 'Choose' : 'NEW · choose'} ${getCard(id).name}`;
      const { width, height } = (child as THREE.Mesh<THREE.PlaneGeometry>).geometry.parameters;
      return [{ id, x: child.position.x, y: child.position.y, width, height }];
    });
    const newCardIds = offer.cards.filter((id) => !deck.has(id));
    this.rewardFaces = new RewardCardFaces(slots, rewardCardTexture, {
      ...this.deps.rewardCards,
      newCardIds,
    });
    cards.root.add(this.rewardFaces.root);
    this.boards.push({ name: 'reward', panel: cards, group, plates: new Map() });
    this.root.add(group);
  }

  private buildGuardianCleared(): void {
    const { flow } = this.deps;
    this.board(
      'guardian',
      [
        {
          id: 'explore',
          label: 'Continue exploring',
          onSelect: () => flow.exploreAfterGuardian(),
        },
        { id: 'finish', label: 'Finish run', onSelect: () => flow.finishVictory() },
      ],
      { x: 0, y: 0.18, z: -BOARD_DISTANCE },
      { width: 0.72, heading: 'The guardian falls' },
    );
  }

  private buildSummary(): void {
    const { flow } = this.deps;
    const s = flow.summary;
    if (!s) return;
    const victory = s.outcome === 'victory';
    this.board(
      'summary',
      [
        [
          { id: 'seed', label: `Seed ${formatSeed(s.seed)}`, weight: 2 },
          { id: 'difficulty', label: DIFFICULTY_LABEL[s.difficulty] },
        ],
        [
          { id: 'rooms-l', label: 'Rooms reached', weight: 2 },
          { id: 'rooms', label: String(s.roomsReached) },
        ],
        [
          { id: 'fights-l', label: 'Fights won', weight: 2 },
          { id: 'fights', label: String(s.fightsWon) },
        ],
        [
          { id: 'cogs-l', label: 'Cogs earned and banked', weight: 2 },
          { id: 'cogs', label: String(s.cogsEarned) },
        ],
        [
          { id: 'bank-l', label: 'Workshop now holds', weight: 2 },
          { id: 'bank', label: String(s.bankTotal) },
        ],
        { id: 'title', label: 'Return to the title', onSelect: () => flow.toTitle() },
      ],
      { x: 0, y: 0.3, z: -BOARD_DISTANCE },
      { width: 0.7, heading: victory ? 'The guardian falls' : 'The Spire claims you' },
    );
  }
}
