import {
  createMenuPanel,
  createScalableLabel,
  disposeScalableLabel,
  keepAbove,
  type MenuCell,
  type MenuPanel,
  type MenuRow,
} from '@par/xr-workspace';
import * as THREE from 'three';
import { TABLE_DISTANCE_CHOICES } from '../combat/placement.ts';
import { getCard } from '../content/cards.ts';
import { formatSeed } from '../core/rng.ts';
import { appendSeedChar, SEED_ALPHABET, SEED_LENGTH } from '../desktop/seed-title.ts';
import { HOLO_CARD_ASPECT } from '../hand/fan-layout.ts';
import { PALETTE } from '../palette.ts';
import { FOVEATION_CHOICES, type FoveationChoice, type Settings } from '../persist/db.ts';
import type { RunSnapshot } from '../persist/saves.ts';
import {
  DIFFICULTIES,
  DIFFICULTY_LABEL,
  type Difficulty,
  runDifficulty,
} from '../rules/difficulty.ts';
import { SKIP_REWARD } from '../rules/run.ts';
import { maxTier, nextCost, UPGRADE_IDS, UPGRADES, type UpgradeId } from '../rules/workshop.ts';
import { CARD_FLIGHT_SECONDS, flightGoal, flightPose, flightScale } from './card-flight.ts';
import type { FlowPhase, RunFlow } from './flow.ts';
import { RewardCardFaces, type RewardCardFacesOptions } from './reward-cards.ts';

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
  /** How the reward board draws its card faces. Default: the shared hand atlas, typeset. */
  rewardCards?: RewardCardFacesOptions;
  /**
   * Where a picked reward card flies, read at the pick: the claiming hand (standoff 0) or the head
   * (a standoff in front of it). Absent or null: the card is taken without a flight.
   */
  flyTarget?: () => FlyTarget | null;
}

/** What a picked reward card flies to: `object`'s world position, stopping `standoff` metres short. */
export interface FlyTarget {
  readonly object: THREE.Object3D;
  readonly standoff: number;
}

/** The in-run menu: closed, its main board, or the abandon confirmation. */
export type MenuView = 'closed' | 'main' | 'confirm';
/** Phases the in-run menu opens over. */
const MENU_PHASES: readonly FlowPhase[] = ['explore', 'combat'];

/** Card family colours (art bible): the jewel tone fills the frame field. */
const FAMILY: Readonly<Record<string, string>> = {
  attack: PALETTE.ruby,
  skill: PALETTE.sapphire,
  sigil: PALETTE.emerald,
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
const ART_DISTANCE = 2.7;
const ART_WIDTH = 3.4;

type Subview = 'main' | 'seed';

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

/** A brass-edged plate texture: flat fill, 2-step bevel, hairline frame. No rounded pills. */
function plateTexture(fill: string, edge: string, w: number, h: number): THREE.CanvasTexture {
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
    const line = Math.max(3, Math.round(canvas.height * 0.035));
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

function wrapText(ctx: CanvasRenderingContext2D, text: string, width: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    const next = line ? `${line} ${word}` : word;
    if (ctx.measureText(next).width > width && line) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines;
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
    const kind =
      card.type === 'sigil' ? 'Sigil spell' : card.type === 'attack' ? 'Attack' : 'Skill';
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
  texture.colorSpace = THREE.SRGBColorSpace;
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
 * ('reward' and 'reward-skip'), so the longest matching board name wins.
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
  private hoveredId: string | null = null;
  /** Control ids drawn as the chosen option. */
  private readonly selectedIds = new Set<string>();
  private subview: Subview = 'main';
  private seedValue: string;
  private seedDraft = '';
  private shownFor: FlowPhase | null = null;
  private menu: MenuView = 'closed';
  private flight: RewardFlight | null = null;
  private artTexture: THREE.Texture | null = null;
  private readonly stopAbove: () => void;

  constructor(deps: FlowUiDeps) {
    this.deps = deps;
    this.seedValue = deps.seed;
    this.root.name = 'flow-ui';
    this.root.visible = false;
    this.stopAbove = keepAbove(this.root);
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
    this.rebuild();
    this.place(head, true);
    return true;
  }

  /** Closes the in-run menu (Resume). Returns false when it was not open. */
  closeMenu(): boolean {
    if (this.menu === 'closed') return false;
    this.menu = 'closed';
    this.rebuild();
    return true;
  }

  /** Opens the in-run menu, or closes it when it is open. Returns whether anything changed. */
  toggleMenu(head: THREE.Object3D): boolean {
    return this.menuOpen ? this.closeMenu() : this.openMenu(head);
  }

  /**
   * Plays the picked reward card's flight by `dt` seconds; when it lands the pick is applied (once)
   * and the board closes. Call every frame.
   */
  update(dt: number): void {
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
    for (const board of this.boards) {
      for (const child of board.panel.root.children) {
        const cell = board.panel.cellAt(child);
        if (cell) ids.push(`${board.name}-${cell}`);
      }
    }
    return ids;
  }

  /** Objects a pointer ray should test. */
  targets(): THREE.Object3D[] {
    return this.root.visible ? this.boards.map((b) => b.panel.root) : [];
  }

  /** Control id under a hit object, or null. */
  controlAt(object: THREE.Object3D): string | null {
    for (const board of this.boards) {
      const cell = board.panel.cellAt(object);
      if (cell) return `${board.name}-${cell}`;
    }
    return null;
  }

  activate(controlId: string): boolean {
    // A flying reward card owns the board until it lands.
    if (this.flight) return false;
    const target = this.boardOf(controlId);
    return target ? target.board.panel.activate(target.cell) : false;
  }

  hover(controlId: string | null): void {
    if (controlId === this.hoveredId) return;
    this.paintHover(this.hoveredId, false);
    this.hoveredId = controlId;
    this.paintHover(controlId, true);
  }

  /** Desktop typing into the seed field. Returns whether the key was used. */
  typeKey(key: string): boolean {
    if (this.subview !== 'seed') return false;
    if (key === 'Backspace') this.seedDraft = this.seedDraft.slice(0, -1);
    else if (key === 'Enter') return this.commitSeed();
    else if (key === 'Escape') this.setSubview('main');
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
    if (phase !== 'title') this.subview = 'main';
    this.menu = 'closed';
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
    this.stopAbove();
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
  }

  private clear(): void {
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
    this.rewardFaces?.dispose();
    this.rewardFaces = null;
    this.boards = [];
    this.extras = [];
    this.selectedIds.clear();
    this.hoveredId = null;
  }

  private rebuild(): void {
    this.clear();
    const phase = this.deps.flow.phase;
    const builders: Partial<Record<FlowPhase, () => void>> = {
      title: () => (this.subview === 'seed' ? this.buildSeedPad() : this.buildTitle()),
      workshop: () => this.buildWorkshop(),
      settings: () => this.buildSettings(),
      reward: () => this.buildReward(),
      death: () => this.buildSummary(),
      victory: () => this.buildSummary(),
    };
    const menu = this.menu !== 'closed' && MENU_PHASES.includes(phase);
    const build = menu ? () => this.buildMenu() : builders[phase];
    this.root.visible = build !== undefined;
    build?.();
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
        fontSize: 0.05,
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
      this.artTexture = new THREE.TextureLoader().load(this.deps.keyArt.url);
      this.artTexture.colorSpace = THREE.SRGBColorSpace;
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
    const rows: MenuRow[] = [
      {
        id: 'new-run',
        label: 'New Run',
        onSelect: () => this.deps.onNewRun(this.seedValue, this.deps.settings().difficulty),
      },
      [
        { id: 'seed', label: `Seed ${formatSeed(this.seedValue)}`, weight: 2 },
        { id: 'enter-seed', label: 'Enter seed', onSelect: () => this.setSubview('seed') },
      ],
      DIFFICULTIES.map((d) => ({
        id: `difficulty-${d}`,
        label: DIFFICULTY_LABEL[d],
        onSelect: () => this.chooseDifficulty(d),
      })),
      { id: 'difficulty-note', label: `${DIFFICULTY_LABEL[level]}: ${DIFFICULTY_NOTE[level]}` },
    ];
    if (snap) {
      rows.push({
        id: 'continue',
        label: `Continue  ${formatSeed(snap.run.seed)} · ${DIFFICULTY_LABEL[runDifficulty(snap.run)]} · ${snap.clearedEncounters.length} won · ${snap.run.cogs} cogs`,
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

  private buildSettings(): void {
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
        { id: 'back', label: 'Back to title', onSelect: () => this.deps.flow.toTitle() },
      ],
      { x: 0, y: 0.26, z: -BOARD_DISTANCE },
      { width: 0.8, heading: 'Settings', selected: this.choiceSelected() },
    );
  }

  /**
   * The rows of choices the settings and the in-run menu share: table distance, foveation and the
   * frame-rate counter. The chosen one is drawn selected; picking another saves it at once.
   */
  private choiceRows(): MenuRow[] {
    const choose = (change: Partial<Settings>): void => {
      this.deps.onSettings({ ...this.deps.settings(), ...change });
      this.refresh();
    };
    return [
      [
        { id: 'tableDistance-label', label: 'Table distance', weight: 2 },
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

  /** The in-run menu: Resume, the shared choices and Abandon run, or the abandon confirmation. */
  private buildMenu(): void {
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
    this.board(
      'menu',
      [
        { id: 'resume', label: 'Resume', onSelect: () => this.closeMenu() },
        ...this.choiceRows(),
        { id: 'abandon', label: 'Abandon run', onSelect: () => this.setMenu('confirm') },
      ],
      { x: 0, y: 0.22, z: -BOARD_DISTANCE },
      { width: 0.8, heading: 'Paused', selected: this.choiceSelected() },
    );
  }

  private setMenu(view: MenuView): void {
    this.menu = view;
    this.refresh();
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
    const n = offer.cards.length;
    const width = Math.min(1.25, 0.3 * n + 0.02 * (n - 1));
    const cardHeight = ((width - 0.02 * (n - 1)) / n) * HOLO_CARD_ASPECT;
    const header = this.board(
      'reward-info',
      [{ id: 'cogs', label: `${offer.cogs} cogs collected · choose one card for the deck` }],
      { x: 0, y: 0.32, z: -BOARD_DISTANCE },
      { width, heading: 'The automatons fall silent' },
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
      const { width, height } = (child as THREE.Mesh<THREE.PlaneGeometry>).geometry.parameters;
      return [{ id, x: child.position.x, y: child.position.y, width, height }];
    });
    this.rewardFaces = new RewardCardFaces(slots, rewardCardTexture, this.deps.rewardCards);
    cards.root.add(this.rewardFaces.root);
    this.boards.push({ name: 'reward', panel: cards, group, plates: new Map() });
    this.root.add(group);
    this.board(
      'reward-skip',
      [{ id: 'skip', label: 'Skip the card', onSelect: () => flow.pickReward(SKIP_REWARD) }],
      { x: 0, y: group.position.y - cardHeight - 0.05, z: -BOARD_DISTANCE },
      { width: 0.36 },
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
