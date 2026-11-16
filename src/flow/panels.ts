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
import { getCard } from '../content/cards.ts';
import { formatSeed } from '../core/rng.ts';
import { appendSeedChar, SEED_ALPHABET, SEED_LENGTH } from '../desktop/seed-title.ts';
import { PALETTE } from '../palette.ts';
import type { Settings } from '../persist/db.ts';
import type { RunSnapshot } from '../persist/saves.ts';
import { SKIP_REWARD } from '../rules/run.ts';
import { maxTier, nextCost, UPGRADE_IDS, UPGRADES, type UpgradeId } from '../rules/workshop.ts';
import type { FlowPhase, RunFlow } from './flow.ts';

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
  settings: () => Settings;
  onNewRun: (seed: string) => void;
  onContinue: () => void;
  onSettings: (next: Settings) => void;
}

/** Card family colours (art bible): the jewel tone fills the frame field. */
const FAMILY: Readonly<Record<string, string>> = {
  attack: PALETTE.ruby,
  skill: PALETTE.sapphire,
  sigil: PALETTE.emerald,
};

const ROW = 0.07;
const BOARD_WIDTH = 0.66;
const BOARD_PAD = 0.045;
const BOARD_DISTANCE = 1.25;
const ART_DISTANCE = 2.7;
const ART_WIDTH = 3.4;

type Subview = 'main' | 'seed';

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
 * The runtime card face for a reward choice: family-coloured field in a brass frame, name, type and
 * cost, and the rules text on parchment. Swappable for the illustrated card once the art atlas lands.
 */
export function rewardCardTexture(id: string, hovered: boolean): THREE.CanvasTexture {
  const card = getCard(id);
  const canvas = document.createElement('canvas');
  canvas.width = 360;
  canvas.height = 500;
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
  private cardFaces = new Map<string, { mesh: THREE.Mesh; card: string }>();
  private hoveredId: string | null = null;
  private subview: Subview = 'main';
  private seedValue: string;
  private seedDraft = '';
  private shownFor: FlowPhase | null = null;
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
    this.rebuild();
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
    this.clear();
    this.stopAbove();
    this.artTexture?.dispose();
    this.root.removeFromParent();
  }

  private place(head: THREE.Object3D): void {
    head.updateMatrixWorld(true);
    const eye = head.getWorldPosition(new THREE.Vector3());
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(
      head.getWorldQuaternion(new THREE.Quaternion()),
    );
    const yaw = Math.atan2(-forward.x, -forward.z);
    this.root.position.set(eye.x, eye.y, eye.z);
    this.root.rotation.set(0, yaw, 0);
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
    for (const { mesh } of this.cardFaces.values()) disposeMesh(mesh);
    this.boards = [];
    this.extras = [];
    this.cardFaces.clear();
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
    const build = builders[phase];
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
    opts: { width?: number; rowHeight?: number; heading?: string } = {},
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
      const plate = plateMesh(PALETTE.walnut, PALETTE.brass, w, h);
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
    const face = this.cardFaces.get(controlId);
    if (face) {
      const material = face.mesh.material as THREE.MeshBasicMaterial;
      material.map?.dispose();
      material.map = rewardCardTexture(face.card, on);
      face.mesh.position.z = on ? 0.012 : 0.002;
      return;
    }
    const target = this.boardOf(controlId);
    const plate = target?.board.plates.get(target.cell);
    if (!plate) return;
    const material = plate.material as THREE.MeshBasicMaterial;
    const { width, height } = (plate.geometry as THREE.PlaneGeometry).parameters;
    material.map?.dispose();
    material.map = on
      ? plateTexture('#6e4a2c', PALETTE.candle, width, height)
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
    const rows: MenuRow[] = [
      { id: 'new-run', label: 'New Run', onSelect: () => this.deps.onNewRun(this.seedValue) },
      [
        { id: 'seed', label: `Seed ${formatSeed(this.seedValue)}`, weight: 2 },
        { id: 'enter-seed', label: 'Enter seed', onSelect: () => this.setSubview('seed') },
      ],
    ];
    if (snap) {
      rows.push({
        id: 'continue',
        label: `Continue  ${formatSeed(snap.run.seed)} · ${snap.clearedEncounters.length} won · ${snap.run.cogs} cogs`,
        onSelect: () => this.deps.onContinue(),
      });
    }
    rows.push([
      { id: 'workshop', label: 'Workshop', onSelect: () => flow.openWorkshop() },
      { id: 'settings', label: 'Settings', onSelect: () => flow.openSettings() },
    ]);
    rows.push({ id: 'bank', label: `${flow.workshop.cogsBanked} cogs banked in the workshop` });
    this.board('title', rows, { x: -0.42, y: -0.08, z: -BOARD_DISTANCE }, { width: 0.6 });
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
    this.board(
      'settings',
      [
        knob('masterVolume', 'Master volume'),
        knob('musicVolume', 'Music'),
        knob('sfxVolume', 'Effects'),
        { id: 'back', label: 'Back to title', onSelect: () => this.deps.flow.toTitle() },
      ],
      { x: 0, y: 0.15, z: -BOARD_DISTANCE },
      { width: 0.8, heading: 'Settings' },
    );
  }

  private buildReward(): void {
    const { flow } = this.deps;
    const offer = flow.offer;
    if (!offer) return;
    const n = offer.cards.length;
    const width = Math.min(1.25, 0.3 * n + 0.02 * (n - 1));
    const cardHeight = ((width - 0.02 * (n - 1)) / n) * (500 / 360);
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
          onSelect: () => flow.pickReward(id),
        })),
      ],
      width,
      rowHeight: cardHeight,
      cellGap: 0.02,
    });
    const group = new THREE.Group();
    group.position.set(0, 0.32 - header.panel.height - BOARD_PAD * 2 - 0.03, -BOARD_DISTANCE);
    group.add(cards.root);
    for (const child of cards.root.children) {
      const cell = cards.cellAt(child);
      if (!cell) continue;
      const { width: w, height: h } = (child as THREE.Mesh<THREE.PlaneGeometry>).geometry
        .parameters;
      const face = new THREE.Mesh(
        new THREE.PlaneGeometry(w, h),
        new THREE.MeshBasicMaterial({ map: rewardCardTexture(cell, false), toneMapped: false }),
      );
      face.raycast = () => undefined;
      face.position.set(child.position.x, child.position.y, 0.002);
      cards.root.add(face);
      this.cardFaces.set(`reward-${cell}`, { mesh: face, card: cell });
    }
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
        { id: 'seed', label: `Seed ${formatSeed(s.seed)}` },
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
