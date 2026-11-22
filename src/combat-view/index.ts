import * as THREE from 'three';
import { getCard, type SliceCard } from '../content/cards.ts';
import { ENEMIES, type EnemyKind } from '../content/enemies.ts';
import { PALETTE } from '../palette.ts';
import { cardSteamCost, type Effect, type EnemyState, intentDamage } from '../rules/index.ts';
import { type Point, SIGIL_TEMPLATES, type SigilId } from '../sigil/index.ts';
import { mouseToPlate, type PlatePose, TraceBuilder, type Vec3 } from '../sigil-plate/index.ts';
import { INTENT_ICON, STATUS_ICON } from '../ui/icon-atlas.ts';
import type { IconChip } from '../ui/icon-sheet.ts';
import { CanvasLabel, roundRect, wrapText } from './canvas-label.ts';
import {
  CombatController,
  type CombatOptions,
  ENEMY_ORDER,
  parseCombatQuery,
  type Stage,
  type ViewUpdate,
} from './controller.ts';
import { ScryPanel } from './scry-panel.ts';

export { CombatController, parseCombatQuery } from './controller.ts';

export interface CombatViewOptions {
  /** Query string to read `enemy`, `encounter`, `seed` and `cheat` from (default `location.search`). */
  readonly search?: string;
  /** Explicit controller options; these win over `search`. */
  readonly options?: CombatOptions;
}

export interface CombatDebugView {
  readonly controller: CombatController;
  /** Starts the same fight again from the same seed. */
  restart(): void;
  /** Switches to the next enemy in the roster (same seed). */
  nextEnemy(): void;
  dispose(): void;
}

/** A world point: `THREE.Vector3` fits. */
export interface ReadoutPoint {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** Clear space between an automaton's silhouette and the bottom edge of its readout, metres. */
export const READOUT_MARGIN = 0.08;

export interface ReadoutFit {
  /** Clear space above the silhouette, metres (default `READOUT_MARGIN`). */
  margin?: number;
  /** How far the body may move toward the eye while the readout stays put (a lunge), metres. */
  reach?: number;
}

/**
 * World height of a readout's centre so its bottom edge clears an automaton seen from `eye`. The
 * readout is a vertical plane through `at` facing the eye; `box` is the automaton's world bounds,
 * measured from the loaded model. A head standing nearer the eye than the readout plane projects
 * higher on it than its own top (the seated eye looks up at a tall guardian), so the bottom edge
 * clears the higher of the box top and every top corner's projection, plus `margin`.
 */
export function readoutCentreY(
  eye: ReadoutPoint,
  at: ReadoutPoint,
  box: { readonly min: ReadoutPoint; readonly max: ReadoutPoint },
  labelHeight: number,
  fit: ReadoutFit = {},
): number {
  const margin = fit.margin ?? READOUT_MARGIN;
  const reach = Math.max(0, fit.reach ?? 0);
  const top = box.max.y;
  let dx = at.x - eye.x;
  let dz = at.z - eye.z;
  const planeDepth = Math.hypot(dx, dz);
  let silhouette = top;
  if (planeDepth > 1e-6) {
    dx /= planeDepth;
    dz /= planeDepth;
    for (const x of [box.min.x, box.max.x]) {
      for (const z of [box.min.z, box.max.z]) {
        const depth = (x - eye.x) * dx + (z - eye.z) * dz - reach;
        if (depth <= 1e-6 || depth >= planeDepth) continue;
        silhouette = Math.max(silhouette, eye.y + ((top - eye.y) * planeDepth) / depth);
      }
    }
  }
  return silhouette + margin + labelHeight / 2;
}

type Vec3Tuple = [number, number, number];

/**
 * The part of a model a readout must clear: its full height over the head socket's floor position.
 * A box's top front corners stand ahead of the head on wide or deep automata (claws, plinths,
 * rings), and projecting them from the seat floats the readout far above the head the eye sees.
 */
export function crownBounds(
  bounds: { readonly min: readonly number[]; readonly max: readonly number[] },
  head?: readonly number[],
): { min: Vec3Tuple; max: Vec3Tuple } {
  const [x0 = 0, y0 = 0, z0 = 0] = bounds.min;
  const [x1 = 0, y1 = 0, z1 = 0] = bounds.max;
  if (!head) return { min: [x0, y0, z0], max: [x1, y1, z1] };
  const [hx = 0, , hz = 0] = head;
  return { min: [hx, y0, hz], max: [hx, y1, hz] };
}

type PickKind = 'card' | 'enemy' | 'end-turn' | 'plate' | 'table' | 'reroll';
interface PickData {
  readonly kind: PickKind;
  readonly uid?: number;
  readonly id?: string;
}

interface CardView {
  readonly uid: number;
  readonly outer: THREE.Group;
  readonly face: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  readonly glow: THREE.Mesh;
  readonly label: CanvasLabel;
  readonly baseY: number;
  readonly affordable: boolean;
}

interface EnemyView {
  readonly id: string;
  readonly body: THREE.Mesh<THREE.CapsuleGeometry, THREE.MeshStandardMaterial>;
  readonly label: CanvasLabel;
  readonly baseScale: number;
}

const EYE_HEIGHT = 1.3;
const TABLE_Y = 0.83;
const TABLE_Z = -1.2;
const HAND_Z = -1.02;
const CARD_W = 0.19;
const CARD_H = 0.266;
const CARD_TILT = -0.95;
const ENEMY_Z = -4;
const PLATE_SIZE = 0.5;
const PLATE_GUIDE_PAD = 0.15;
const FLASH_MS = 450;
const LOG_LINES = 12;

const TYPE_COLORS = {
  attack: PALETTE.ruby,
  skill: PALETTE.sapphire,
  sigil: PALETTE.emerald,
  mechanism: PALETTE.brass,
};
const ENEMY_COLORS: Readonly<Record<string, string>> = {
  'cog-sentry': '#b08a3c',
  'spring-hound': '#9a5a2c',
  'bellows-golem': '#7a2c30',
  'orrery-warden': '#3a5aa8',
  'grand-escapement': '#2a8a5c',
};

function enemyColor(id: string): string {
  return ENEMY_COLORS[id.replace(/-\d+$/, '')] ?? PALETTE.brass;
}

function effectLine(effect: Effect): string | null {
  if (effect.type === 'block' && typeof effect.amount === 'number') return `block ${effect.amount}`;
  return null;
}

/** "ATTACK 8" / "ATTACK 3x2" / "DEFEND, block 7": the visible intent with numbers after statuses. */
export function intentText(enemy: EnemyState, damage: readonly number[]): string {
  const intent = enemy.intent;
  if (!intent) return '';
  const hits = intent.effects.flatMap((e) =>
    e.type === 'damage' ? [typeof e.hits === 'number' ? e.hits : 1] : [],
  );
  const dmg = damage.map((d, i) => ((hits[i] ?? 1) > 1 ? `${d}x${hits[i]}` : `${d}`));
  const extras = intent.effects.flatMap((e) => {
    const line = effectLine(e);
    return line === null ? [] : [line];
  });
  const status = intent.effects.flatMap((e) => (e.type === 'apply-status' ? [`${e.status}`] : []));
  return [intent.intent.toUpperCase(), ...dmg, ...extras, ...status.map((s) => `+${s}`)].join(' ');
}

/**
 * The visible intent as one icon chip per part, so a multi-part move reads unambiguously: Brace is
 * `[attack 4] [block 7]`, never "4 block 7". Damage uses the after-status numbers from `damage`.
 * A move with no numeric part shows its intent icon alone.
 */
export function intentChips(enemy: EnemyState, damage: readonly number[]): IconChip[] {
  const intent = enemy.intent;
  if (!intent) return [];
  const chips: IconChip[] = [];
  let hit = 0;
  const amount = (a: unknown): string => (typeof a === 'number' ? String(a) : '?');
  for (const effect of intent.effects) {
    if (effect.type === 'damage') {
      const d = damage[hit++];
      const hits = typeof effect.hits === 'number' ? effect.hits : 1;
      const text = d === undefined ? amount(effect.amount) : String(d);
      chips.push({
        icon: intent.intent === 'attack-debuff' ? INTENT_ICON['attack-debuff'] : 'intent-attack',
        text: hits > 1 ? `${text}x${hits}` : text,
        fallback: 'Attack',
      });
    } else if (effect.type === 'block') {
      chips.push({ icon: 'block', text: amount(effect.amount), fallback: 'Block' });
    } else if (effect.type === 'apply-status') {
      chips.push({
        icon: STATUS_ICON[effect.status],
        text: typeof effect.stacks === 'number' ? String(effect.stacks) : '?',
        fallback: effect.status,
      });
    }
  }
  return chips.length > 0
    ? chips
    : [{ icon: INTENT_ICON[intent.intent], text: '', fallback: intent.intent }];
}

function statusText(statuses: Readonly<Partial<Record<string, number>>>): string {
  return Object.entries(statuses)
    .filter(([, n]) => (n ?? 0) > 0)
    .map(([id, n]) => `${id} ${n}`)
    .join('  ');
}

function dieTag(info: SliceCard): string | null {
  if (info.dice === undefined) return null;
  return info.dice === 'glass-d8' ? 'rolls d8' : 'rolls d6';
}

function drawCard(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  info: SliceCard,
  affordable: boolean,
): void {
  const accent = TYPE_COLORS[info.type];
  roundRect(ctx, 4, 4, w - 8, h - 8, 18);
  ctx.fillStyle = PALETTE.parchment;
  ctx.fill();
  ctx.lineWidth = 8;
  ctx.strokeStyle = accent;
  ctx.stroke();
  // Art block placeholder.
  ctx.fillStyle = accent;
  ctx.fillRect(16, 62, w - 32, 96);
  ctx.fillStyle = PALETTE.parchment;
  ctx.font = '700 44px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(info.type.toUpperCase(), w / 2, 124);
  // Cost badge.
  ctx.beginPath();
  ctx.arc(38, 36, 24, 0, Math.PI * 2);
  ctx.fillStyle = affordable ? PALETTE.brass : '#8a8a8a';
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = PALETTE.brassDark;
  ctx.stroke();
  ctx.fillStyle = PALETTE.void;
  ctx.font = '700 32px system-ui, sans-serif';
  ctx.fillText(String(info.cost), 38, 47);
  // Name.
  ctx.fillStyle = PALETTE.void;
  ctx.font = '700 25px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(info.name.length > 15 ? `${info.name.slice(0, 14)}.` : info.name, 70, 44);
  // Description.
  ctx.font = '500 23px system-ui, sans-serif';
  wrapText(ctx, info.description, 20, 190, w - 40, 27);
  // Footer tags.
  ctx.font = '700 20px system-ui, sans-serif';
  ctx.fillStyle = accent;
  const tags = [
    dieTag(info),
    info.sigil === undefined ? null : `sigil: ${info.sigil}`,
    info.exhaust ? 'exhaust' : null,
  ].filter((t): t is string => t !== null);
  ctx.fillText(tags.join('  '), 20, h - 20);
}

function drawEnemyLabel(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  enemy: EnemyState,
  damage: readonly number[],
  targetable: boolean,
): void {
  const dead = enemy.hp <= 0;
  roundRect(ctx, 4, 4, w - 8, h - 8, 20);
  ctx.fillStyle = 'rgba(18, 12, 7, 0.82)';
  ctx.fill();
  ctx.lineWidth = targetable ? 8 : 4;
  ctx.strokeStyle = targetable ? PALETTE.candle : PALETTE.brassDark;
  ctx.stroke();
  ctx.textAlign = 'left';
  ctx.fillStyle = PALETTE.parchment;
  ctx.font = '700 44px system-ui, sans-serif';
  ctx.fillText(enemy.name, 24, 58);
  // HP bar.
  const frac = Math.max(0, enemy.hp) / enemy.maxHp;
  ctx.fillStyle = '#3a2418';
  ctx.fillRect(24, 76, w - 48, 34);
  ctx.fillStyle = PALETTE.ruby;
  ctx.fillRect(24, 76, (w - 48) * frac, 34);
  ctx.fillStyle = PALETTE.parchment;
  ctx.font = '700 28px system-ui, sans-serif';
  ctx.fillText(`HP ${Math.max(0, enemy.hp)}/${enemy.maxHp}`, 32, 103);
  ctx.textAlign = 'right';
  ctx.fillStyle = '#9ec3ff';
  ctx.fillText(`Block ${enemy.block}`, w - 32, 103);
  ctx.textAlign = 'left';
  ctx.fillStyle = PALETTE.candle;
  ctx.font = '700 34px system-ui, sans-serif';
  const intentLine = dead ? 'DESTROYED' : `Intent: ${intentText(enemy, damage)}`;
  ctx.font = `700 ${intentLine.length > 26 ? 26 : 34}px system-ui, sans-serif`;
  ctx.fillText(intentLine, 24, 154);
  ctx.fillStyle = PALETTE.brass;
  ctx.font = '500 26px system-ui, sans-serif';
  const moves = dead || !enemy.intent ? '' : `move: ${enemy.intent.id}`;
  const status = statusText(enemy.statuses);
  ctx.fillText([moves, status].filter(Boolean).join('   '), 24, 192);
}

function stageHint(controller: CombatController, stage: Stage): string {
  if (controller.canReroll) return 'Click the die to reroll or Keep Roll to accept';
  const uid = controller.selectedUid;
  const card = controller.state.piles.hand.find((c) => c.uid === uid);
  const name = card ? getCard(card.def.id).name : '';
  switch (stage) {
    case 'idle':
      return 'Click a card to pick it up';
    case 'target':
      return `Click an enemy to aim ${name}`;
    case 'table':
      return `Click the table to play ${name}`;
    case 'sigil':
      return `Draw the ${controller.awaitedSigil?.toUpperCase()} sigil on the plate`;
    case 'scry':
      return 'Choose any cards to discard, then confirm';
    case 'over':
      return controller.outcome === 'won' ? 'Victory' : 'Defeat';
  }
}

/**
 * `?view=combat&enemy=<enemy-id>&seed=<seed>` (or `&encounter=<tier>`): a mouse-playable debug fight at a
 * brass table. Click a card, click an enemy (or the table), drag a sigil on the plate, click End Turn.
 * `&cheat=win` starts every enemy at 1 HP and `&cheat=lose` starts the player at 1 HP, for screenshots.
 * All game logic lives in `CombatController`; this file only presents it and turns clicks into calls.
 */
export function mountCombatDebugView(
  scene: THREE.Scene,
  rig: THREE.Group,
  camera: THREE.PerspectiveCamera,
  renderer: THREE.WebGLRenderer,
  opts: CombatViewOptions = {},
): CombatDebugView {
  let startOptions: CombatOptions = {
    ...parseCombatQuery(opts.search ?? location.search),
    ...opts.options,
  };
  let controller = new CombatController(startOptions);
  let unsubscribe: (() => void) | null = null;
  let scryPanel: ScryPanel | null = null;

  const canvas = renderer.domElement;
  const host = canvas.parentElement ?? document.body;
  canvas.style.touchAction = 'none';
  camera.position.y = EYE_HEIGHT;
  rig.updateMatrixWorld(true);
  const eye = camera.getWorldPosition(new THREE.Vector3());

  // ---- scene -----------------------------------------------------------------------------------
  const root = new THREE.Group();
  root.name = 'combat-debug-view';
  rig.add(root);
  scene.background = new THREE.Color('#1c120b');
  root.add(new THREE.HemisphereLight('#fff0d0', '#2a1c10', 1.4));
  const sun = new THREE.DirectionalLight('#ffd9a0', 2.2);
  sun.position.set(1.5, 4, 1);
  root.add(sun);

  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(9, 48),
    new THREE.MeshStandardMaterial({ color: PALETTE.warmBlack, roughness: 1 }),
  );
  ground.rotation.x = -Math.PI / 2;
  root.add(ground);

  const table = new THREE.Mesh(
    new THREE.BoxGeometry(2.6, 0.05, 0.95),
    new THREE.MeshStandardMaterial({ color: PALETTE.brassDark, roughness: 0.55, metalness: 0.5 }),
  );
  table.position.set(0, TABLE_Y - 0.025, TABLE_Z);
  table.userData = { kind: 'table' } satisfies PickData;
  root.add(table);
  const legGeo = new THREE.BoxGeometry(0.08, TABLE_Y, 0.08);
  for (const x of [-1.2, 1.2]) {
    for (const z of [TABLE_Z - 0.4, TABLE_Z + 0.4]) {
      const leg = new THREE.Mesh(legGeo, table.material);
      leg.position.set(x, TABLE_Y / 2, z);
      root.add(leg);
    }
  }

  /** Orients a panel so it faces the player's eye. */
  const faceEye = (object: THREE.Object3D): void => {
    object.lookAt(eye);
  };

  // Stats panel (left of the hand).
  const stats = new CanvasLabel(512, 360, 0.5);
  stats.mesh.position.set(-0.88, 1.08, TABLE_Z - 0.1);
  root.add(stats.mesh);
  faceEye(stats.mesh);

  // Dice readout (center of the table).
  const diceLabel = new CanvasLabel(512, 192, 0.4);
  diceLabel.mesh.userData = { kind: 'reroll' } satisfies PickData;
  diceLabel.mesh.position.set(0.4, 1.02, TABLE_Z - 0.25);
  root.add(diceLabel.mesh);
  faceEye(diceLabel.mesh);

  // End Turn button.
  const endLabel = new CanvasLabel(256, 96, 0.3);
  endLabel.mesh.position.set(-0.88, TABLE_Y + 0.045, HAND_Z + 0.02);
  endLabel.mesh.rotation.x = -1.2;
  endLabel.mesh.userData = { kind: 'end-turn' } satisfies PickData;
  root.add(endLabel.mesh);
  const endBase = new THREE.Mesh(
    new THREE.BoxGeometry(0.31, 0.02, 0.12),
    new THREE.MeshStandardMaterial({ color: PALETTE.walnut, roughness: 0.6 }),
  );
  endBase.position.set(-0.88, TABLE_Y + 0.01, HAND_Z + 0.02);
  endBase.userData = { kind: 'end-turn' } satisfies PickData;
  root.add(endBase);

  // Sigil plate.
  const plateGroup = new THREE.Group();
  plateGroup.position.set(0.95, 1.22, TABLE_Z - 0.1);
  root.add(plateGroup);
  const plateFrame = new THREE.Mesh(
    new THREE.BoxGeometry(PLATE_SIZE + 0.04, PLATE_SIZE + 0.04, 0.02),
    new THREE.MeshStandardMaterial({ color: PALETTE.brass, roughness: 0.4, metalness: 0.7 }),
  );
  plateGroup.add(plateFrame);
  const plateLabel = new CanvasLabel(512, 512, PLATE_SIZE, false);
  plateLabel.mesh.position.z = 0.012;
  plateLabel.mesh.userData = { kind: 'plate' } satisfies PickData;
  plateGroup.add(plateLabel.mesh);
  faceEye(plateGroup);

  const handGroup = new THREE.Group();
  root.add(handGroup);
  const enemyGroup = new THREE.Group();
  root.add(enemyGroup);

  // ---- DOM overlays ----------------------------------------------------------------------------
  const overlay = document.createElement('div');
  Object.assign(overlay.style, {
    position: 'fixed',
    inset: '0',
    pointerEvents: 'none',
    font: '500 13px ui-monospace, monospace',
    color: PALETTE.parchment,
  });
  host.append(overlay);

  const logPanel = document.createElement('pre');
  logPanel.id = 'combat-log';
  Object.assign(logPanel.style, {
    position: 'absolute',
    top: '12px',
    left: '12px',
    margin: '0',
    padding: '8px 10px',
    background: 'rgba(18,12,7,0.72)',
    border: `1px solid ${PALETTE.brassDark}`,
    borderRadius: '6px',
    maxWidth: '360px',
    whiteSpace: 'pre-wrap',
  });
  overlay.append(logPanel);

  const toast = document.createElement('div');
  toast.id = 'combat-toast';
  Object.assign(toast.style, {
    position: 'absolute',
    bottom: '18px',
    left: '50%',
    transform: 'translateX(-50%)',
    padding: '6px 14px',
    background: 'rgba(147,33,43,0.9)',
    borderRadius: '6px',
    opacity: '0',
    transition: 'opacity 0.2s',
  });
  overlay.append(toast);

  const banner = document.createElement('div');
  banner.id = 'combat-banner';
  Object.assign(banner.style, {
    position: 'absolute',
    top: '30%',
    left: '50%',
    transform: 'translateX(-50%)',
    padding: '18px 36px',
    textAlign: 'center',
    background: 'rgba(18,12,7,0.88)',
    border: `2px solid ${PALETTE.brass}`,
    borderRadius: '10px',
    display: 'none',
    pointerEvents: 'auto',
  });
  const bannerTitle = document.createElement('div');
  Object.assign(bannerTitle.style, {
    font: '700 44px system-ui, sans-serif',
    marginBottom: '12px',
  });
  banner.append(bannerTitle);
  const makeButton = (text: string, onClick: () => void): HTMLButtonElement => {
    const button = document.createElement('button');
    button.textContent = text;
    Object.assign(button.style, {
      margin: '0 6px',
      padding: '8px 18px',
      font: '600 15px system-ui, sans-serif',
      color: PALETTE.void,
      background: PALETTE.brass,
      border: 'none',
      borderRadius: '6px',
      cursor: 'pointer',
    });
    button.addEventListener('click', onClick);
    return button;
  };
  const restartButton = makeButton('restart', () => view.restart());
  restartButton.id = 'combat-restart';
  const nextButton = makeButton('next enemy', () => view.nextEnemy());
  nextButton.id = 'combat-next';
  banner.append(restartButton, nextButton);
  overlay.append(banner);

  let toastTimer: number | undefined;
  const showToast = (text: string): void => {
    toast.textContent = text;
    toast.style.opacity = '1';
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => {
      toast.style.opacity = '0';
    }, 1400);
  };

  // ---- view state ------------------------------------------------------------------------------
  let cards: CardView[] = [];
  let enemies: EnemyView[] = [];
  const lifts = new Map<number, number>();
  const flashes = new Map<THREE.Object3D, number>();
  let hoverUid: number | null = null;
  const trace = new TraceBuilder();
  let plateUid: number | null = null;
  let drawing = false;
  let lastTick = performance.now();

  const flash = (object: THREE.Object3D | undefined): void => {
    if (object) flashes.set(object, performance.now() + FLASH_MS);
  };
  const flashLevel = (object: THREE.Object3D, now: number): number => {
    const until = flashes.get(object);
    if (until === undefined) return 0;
    if (until <= now) {
      flashes.delete(object);
      return 0;
    }
    return (until - now) / FLASH_MS;
  };

  // ---- drawing ---------------------------------------------------------------------------------
  const refreshHand = (): void => {
    for (const card of cards) {
      handGroup.remove(card.outer);
      card.label.dispose();
      card.glow.geometry.dispose();
      (card.glow.material as THREE.Material).dispose();
    }
    const hand = controller.state.piles.hand;
    const step = Math.min(0.15, 0.95 / Math.max(1, hand.length));
    const spacing = Math.min(CARD_W * 1.0, 1.3 / Math.max(1, hand.length - 1));
    cards = hand.map((combatCard, index) => {
      const info = getCard(combatCard.def.id);
      const offset = index - (hand.length - 1) / 2;
      const angle = offset * step;
      const steam = controller.state.player.steam;
      const affordable = cardSteamCost(combatCard.def.cost, steam) <= steam;
      const label = new CanvasLabel(256, 360, CARD_W, false);
      label.draw((ctx, w, h) => drawCard(ctx, w, h, info, affordable));
      const outer = new THREE.Group();
      const baseY = TABLE_Y + 0.09 + index * 0.002;
      outer.position.set(
        offset * spacing,
        baseY,
        HAND_Z + Math.abs(offset) * 0.012 - index * 0.001,
      );
      outer.rotation.z = -angle * 0.55;
      const tilt = new THREE.Group();
      tilt.rotation.x = CARD_TILT;
      outer.add(tilt);
      const glow = new THREE.Mesh(
        new THREE.PlaneGeometry(CARD_W + 0.014, CARD_H + 0.014),
        new THREE.MeshBasicMaterial({ color: PALETTE.candle, toneMapped: false }),
      );
      glow.position.z = -0.002;
      glow.visible = controller.selectedUid === combatCard.uid;
      tilt.add(glow);
      label.mesh.userData = { kind: 'card', uid: combatCard.uid } satisfies PickData;
      tilt.add(label.mesh);
      handGroup.add(outer);
      return { uid: combatCard.uid, outer, face: label.mesh, glow, label, baseY, affordable };
    });
  };

  const refreshEnemies = (): void => {
    const stage = controller.stage;
    for (const view3 of enemies) {
      const enemy = controller.state.enemies.find((e) => e.id === view3.id);
      if (!enemy) continue;
      const dead = enemy.hp <= 0;
      view3.body.rotation.z = dead ? Math.PI / 2 : 0;
      view3.body.position.y = dead ? 0.3 * view3.baseScale : 0.9 * view3.baseScale;
      view3.body.material.color.set(dead ? '#3a2f28' : enemyColor(enemy.id));
      view3.label.draw((ctx, w, h) =>
        drawEnemyLabel(
          ctx,
          w,
          h,
          enemy,
          intentDamage(controller.state, enemy.id),
          !dead && stage === 'target',
        ),
      );
    }
  };

  const buildEnemies = (): void => {
    for (const old of enemies) {
      enemyGroup.remove(old.body, old.label.mesh);
      old.body.geometry.dispose();
      old.body.material.dispose();
      old.label.dispose();
    }
    const list = controller.state.enemies;
    enemies = list.map((enemy, index) => {
      const x = (index - (list.length - 1) / 2) * 1.5;
      const baseScale = 0.9 + (enemy.maxHp / 160) * 0.9;
      const body = new THREE.Mesh(
        new THREE.CapsuleGeometry(0.28 * baseScale, 0.7 * baseScale, 6, 16),
        new THREE.MeshStandardMaterial({
          color: enemyColor(enemy.id),
          roughness: 0.5,
          metalness: 0.4,
        }),
      );
      body.position.set(x, 0.9 * baseScale, ENEMY_Z);
      body.userData = { kind: 'enemy', id: enemy.id } satisfies PickData;
      const label = new CanvasLabel(512, 220, 1.3);
      const labelAt = new THREE.Vector3(x, 0, ENEMY_Z + 0.2);
      body.updateMatrixWorld(true);
      const bounds = new THREE.Box3().setFromObject(body);
      const labelHeight = label.mesh.geometry.parameters.height;
      label.mesh.position.set(
        x,
        readoutCentreY(new THREE.Vector3(0, EYE_HEIGHT, 0), labelAt, bounds, labelHeight),
        labelAt.z,
      );
      label.mesh.userData = { kind: 'enemy', id: enemy.id } satisfies PickData;
      enemyGroup.add(body, label.mesh);
      return { id: enemy.id, body, label, baseScale };
    });
  };

  const refreshStats = (): void => {
    const { player, piles, turn } = controller.state;
    const stage = controller.stage;
    stats.draw((ctx, w, h) => {
      roundRect(ctx, 4, 4, w - 8, h - 8, 22);
      ctx.fillStyle = 'rgba(18, 12, 7, 0.82)';
      ctx.fill();
      ctx.lineWidth = 4;
      ctx.strokeStyle = PALETTE.brassDark;
      ctx.stroke();
      ctx.textAlign = 'left';
      ctx.fillStyle = PALETTE.parchment;
      ctx.font = '700 36px system-ui, sans-serif';
      ctx.fillText(`YOU   turn ${turn}`, 24, 54);
      ctx.fillStyle = '#3a2418';
      ctx.fillRect(24, 70, w - 48, 30);
      ctx.fillStyle = PALETTE.ruby;
      ctx.fillRect(24, 70, (w - 48) * (Math.max(0, player.hp) / player.maxHp), 30);
      ctx.fillStyle = PALETTE.parchment;
      ctx.font = '700 26px system-ui, sans-serif';
      ctx.fillText(`HP ${Math.max(0, player.hp)}/${player.maxHp}`, 30, 94);
      ctx.textAlign = 'right';
      ctx.fillStyle = '#9ec3ff';
      ctx.fillText(`Block ${player.block}`, w - 30, 94);
      ctx.textAlign = 'left';
      ctx.fillStyle = PALETTE.candle;
      ctx.font = '700 32px system-ui, sans-serif';
      ctx.fillText(`Steam ${player.steam}/3`, 24, 148);
      ctx.fillStyle = PALETTE.parchment;
      ctx.font = '500 28px system-ui, sans-serif';
      ctx.fillText(
        `Draw ${piles.draw.length}  Discard ${piles.discard.length}  Exhaust ${piles.exhaust.length}`,
        24,
        192,
      );
      const status = statusText(player.statuses);
      ctx.fillStyle = PALETTE.brass;
      ctx.fillText(status === '' ? 'no statuses' : status, 24, 232);
      ctx.fillStyle = PALETTE.candle;
      ctx.font = '700 28px system-ui, sans-serif';
      wrapText(ctx, stageHint(controller, stage), 24, 288, w - 48, 34);
    });
  };

  const refreshDice = (): void => {
    const dice = controller.lastDice;
    diceLabel.draw((ctx, w, h) => {
      roundRect(ctx, 4, 4, w - 8, h - 8, 22);
      ctx.fillStyle = 'rgba(18, 12, 7, 0.82)';
      ctx.fill();
      ctx.lineWidth = 4;
      ctx.strokeStyle = PALETTE.brassDark;
      ctx.stroke();
      ctx.textAlign = 'left';
      ctx.fillStyle = PALETTE.brass;
      ctx.font = '700 28px system-ui, sans-serif';
      ctx.fillText(controller.canReroll ? 'REROLL' : 'DICE', 24, 46);
      if (!dice) {
        ctx.fillStyle = PALETTE.parchment;
        ctx.font = '500 30px system-ui, sans-serif';
        ctx.fillText('play a dice card to roll', 24, 110);
        return;
      }
      ctx.fillStyle = PALETTE.candle;
      ctx.font = '700 110px system-ui, sans-serif';
      ctx.fillText(String(dice.value), 24, 160);
      ctx.fillStyle = PALETTE.parchment;
      ctx.font = '600 28px system-ui, sans-serif';
      ctx.fillText(dice.dieName, 170, 112);
      ctx.font = '500 26px system-ui, sans-serif';
      ctx.fillText(`${dice.cardName} (d${dice.faces})`, 170, 148);
    });
  };

  const guidePoint = (p: Point, w: number, h: number): [number, number] => [
    (PLATE_GUIDE_PAD + p.x * (1 - 2 * PLATE_GUIDE_PAD)) * w,
    (1 - (PLATE_GUIDE_PAD + p.y * (1 - 2 * PLATE_GUIDE_PAD))) * h,
  ];

  const refreshPlate = (): void => {
    const awaited: SigilId | null = controller.awaitedSigil;
    const result = controller.lastSigil;
    plateLabel.draw((ctx, w, h) => {
      ctx.fillStyle = awaited ? '#2c1d12' : '#1c120b';
      ctx.fillRect(0, 0, w, h);
      ctx.lineWidth = 6;
      ctx.strokeStyle = awaited ? PALETTE.candle : PALETTE.brassDark;
      ctx.strokeRect(6, 6, w - 12, h - 12);
      if (awaited) {
        ctx.lineWidth = 10;
        ctx.strokeStyle = 'rgba(243,190,101,0.22)';
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        for (const stroke of SIGIL_TEMPLATES[awaited].strokes) {
          ctx.beginPath();
          stroke.forEach((p, i) => {
            const [x, y] = guidePoint(p, w, h);
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
          });
          ctx.stroke();
        }
      }
      ctx.textAlign = 'center';
      ctx.font = '700 38px system-ui, sans-serif';
      ctx.fillStyle = PALETTE.candle;
      ctx.fillText(awaited ? `Draw: ${awaited.toUpperCase()}` : 'SIGIL PLATE', w / 2, 52);
      const color =
        result?.quality === 'Fizzle'
          ? '#e86a5a'
          : result?.quality === 'Masterful'
            ? '#8ef0b0'
            : PALETTE.brass;
      ctx.lineWidth = 12;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.strokeStyle = awaited ? PALETTE.parchment : color;
      for (const stroke of trace.strokes) {
        ctx.beginPath();
        stroke.forEach((p, i) => {
          const x = (p.x / PLATE_SIZE + 0.5) * w;
          const y = (0.5 - p.y / PLATE_SIZE) * h;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
        ctx.stroke();
      }
      if (!awaited && result) {
        ctx.fillStyle = color;
        ctx.font = '700 40px system-ui, sans-serif';
        ctx.fillText(
          `${result.quality}  ${Math.round(result.score * 100)}%  x${result.multiplier.toFixed(2)}`,
          w / 2,
          h - 54,
        );
        ctx.fillStyle = PALETTE.parchment;
        ctx.font = '500 26px system-ui, sans-serif';
        ctx.fillText(`${result.sigil} sigil (looked like ${result.recognizedAs})`, w / 2, h - 18);
      }
    });
  };

  const refreshEndTurn = (): void => {
    endLabel.draw((ctx, w, h) => {
      ctx.fillStyle = controller.outcome === null ? PALETTE.brass : '#8a8a8a';
      roundRect(ctx, 4, 4, w - 8, h - 8, 16);
      ctx.fill();
      ctx.fillStyle = PALETTE.void;
      ctx.font = '700 44px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(controller.canReroll ? 'KEEP ROLL' : 'END TURN', w / 2, h / 2 + 15);
    });
  };

  const refreshDom = (): void => {
    const enemyName = controller.state.enemies.map((e) => e.name).join(', ');
    const cheat =
      controller.options.enemyHp !== undefined
        ? ' cheat=win'
        : controller.options.playerHp !== undefined
          ? ' cheat=lose'
          : '';
    const lines = controller.log.slice(-LOG_LINES);
    logPanel.textContent = `seed ${controller.seed} vs ${enemyName}${cheat}\n${'-'.repeat(30)}\n${lines.join('\n')}`;
    const outcome = controller.outcome;
    banner.style.display = outcome === null ? 'none' : 'block';
    bannerTitle.textContent = outcome === 'won' ? 'VICTORY' : 'DEFEAT';
    bannerTitle.style.color = outcome === 'won' ? '#8ef0b0' : '#e86a5a';
  };

  const refreshAll = (): void => {
    // A new sigil stage starts a fresh trace; the finished trace stays visible until then.
    const uid = controller.awaitedSigil === null ? null : controller.selectedUid;
    if (uid !== null && uid !== plateUid) trace.clear();
    plateUid = uid;
    refreshHand();
    refreshEnemies();
    refreshStats();
    refreshDice();
    refreshPlate();
    refreshEndTurn();
    refreshDom();
    const { scry, piles } = controller.state;
    if (scry && !scryPanel) {
      scryPanel = new ScryPanel(piles.draw.slice(0, scry.count));
      scryPanel.object.position.set(0, TABLE_Y + 0.32, TABLE_Z);
      root.add(scryPanel.object);
      scryPanel.object.lookAt(camera.getWorldPosition(new THREE.Vector3()));
    } else if (!scry && scryPanel) {
      scryPanel.dispose();
      scryPanel = null;
    }
  };

  const onUpdate = (update: ViewUpdate): void => {
    if (update.type === 'changed') {
      refreshAll();
      return;
    }
    const { subject } = update;
    if (subject.kind === 'card') flash(cards.find((c) => c.uid === subject.uid)?.face);
    else if (subject.kind === 'enemy') flash(enemies.find((e) => e.id === subject.id)?.body);
    else if (subject.kind === 'end-turn') flash(endLabel.mesh);
    else if (subject.kind === 'plate') flash(plateLabel.mesh);
    else flash(table);
    showToast(update.reason);
  };

  const bind = (next: CombatController): void => {
    unsubscribe?.();
    controller = next;
    trace.clear();
    plateUid = null;
    lifts.clear();
    flashes.clear();
    buildEnemies();
    unsubscribe = controller.subscribe(onUpdate);
    refreshAll();
    (window as unknown as { __combatDebug: unknown }).__combatDebug = debug;
  };

  // ---- input -----------------------------------------------------------------------------------
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();

  const aim = (event: PointerEvent): void => {
    const rect = canvas.getBoundingClientRect();
    ndc.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    camera.updateMatrixWorld(true);
    raycaster.setFromCamera(ndc, camera);
  };

  const pickables = (): THREE.Object3D[] => [
    ...cards.map((c) => c.face),
    ...enemies.flatMap((e) => [e.body, e.label.mesh]),
    endLabel.mesh,
    endBase,
    ...(controller.canReroll ? [diceLabel.mesh] : []),
    plateLabel.mesh,
    table,
  ];

  const pick = (event: PointerEvent): PickData | null => {
    aim(event);
    scene.updateMatrixWorld(true);
    const hit = raycaster.intersectObjects(pickables(), false)[0];
    return hit ? (hit.object.userData as PickData) : null;
  };

  /** The plate's pose in world space, from its current transform (plate space is metres from its centre). */
  const platePose = (): PlatePose => {
    plateLabel.mesh.updateWorldMatrix(true, false);
    const m = plateLabel.mesh.matrixWorld;
    const axis = (x: number, y: number, z: number): Vec3 => {
      const v = new THREE.Vector3(x, y, z).transformDirection(m);
      return { x: v.x, y: v.y, z: v.z };
    };
    const c = new THREE.Vector3().setFromMatrixPosition(m);
    return {
      center: { x: c.x, y: c.y, z: c.z },
      right: axis(1, 0, 0),
      up: axis(0, 1, 0),
      normal: axis(0, 0, 1),
      halfWidth: PLATE_SIZE / 2,
      halfHeight: PLATE_SIZE / 2,
    };
  };

  /** Feeds the pointer into the shared sigil-plate trace builder; off-plate positions end the stroke segment. */
  const addPoint = (event: PointerEvent): boolean => {
    aim(event);
    return trace.add(mouseToPlate(ndc, camera, platePose()));
  };

  canvas.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    if (scryPanel) {
      aim(event);
      const hit = scryPanel.pick(raycaster.ray);
      if (hit) event.stopImmediatePropagation();
      if (hit?.choice === 'confirm') controller.confirmScry(scryPanel.discarded());
      else if (hit) scryPanel.toggle(hit.choice);
      return;
    }
    const hit = pick(event);
    if (!hit) return;
    // Anything we use must not also start the desktop drag-to-look (registered later on this canvas).
    const claim = (): void => event.stopImmediatePropagation();
    switch (hit.kind) {
      case 'card':
        claim();
        controller.select(hit.uid as number);
        break;
      case 'enemy':
        claim();
        controller.target(hit.id as string);
        break;
      case 'end-turn':
        claim();
        if (!controller.confirmDice()) controller.endTurn();
        break;
      case 'reroll':
        claim();
        if (controller.rerollDice()) controller.confirmDice();
        break;
      case 'table':
        if (controller.selectedUid === null) return;
        claim();
        controller.table();
        break;
      case 'plate': {
        claim();
        if (controller.awaitedSigil === null) {
          flash(plateLabel.mesh);
          showToast('Select a sigil card first');
          return;
        }
        trace.clear();
        trace.beginStroke();
        addPoint(event);
        drawing = true;
        refreshPlate();
        break;
      }
    }
  });

  window.addEventListener('pointermove', (event) => {
    if (scryPanel) {
      aim(event);
      scryPanel.hover(scryPanel.pick(raycaster.ray)?.choice);
      return;
    }
    if (drawing) {
      if (addPoint(event)) refreshPlate();
      return;
    }
    if (event.target !== canvas) {
      hoverUid = null;
      return;
    }
    const hit = pick(event);
    hoverUid = hit?.kind === 'card' ? (hit.uid ?? null) : null;
  });

  const finishDrawing = (): void => {
    if (!drawing) return;
    drawing = false;
    trace.endStroke();
    const result = controller.submitSigil(trace.strokes);
    if (!result.ok) {
      trace.clear();
      refreshPlate();
    }
  };
  window.addEventListener('pointerup', finishDrawing);
  window.addEventListener('pointercancel', finishDrawing);

  const onKey = (event: KeyboardEvent): void => {
    if (event.repeat) return;
    if (event.code === 'KeyE') {
      if (!controller.confirmDice()) controller.endTurn();
    } else if (event.code === 'KeyT' && controller.rerollDice()) controller.confirmDice();
    else if (event.code === 'Escape') controller.cancel();
    else if (event.code === 'KeyR') view.restart();
    else if (event.code === 'KeyN') view.nextEnemy();
  };
  window.addEventListener('keydown', onKey);

  // ---- per-frame animation (the main loop only calls render, so hook the scene's pre-render) ----
  const previousBeforeRender = scene.onBeforeRender;
  scene.onBeforeRender = (...args) => {
    previousBeforeRender.call(scene, ...args);
    const now = performance.now();
    const dt = Math.min(0.1, (now - lastTick) / 1000);
    lastTick = now;
    const stage = controller.stage;
    for (const card of cards) {
      const selected = controller.selectedUid === card.uid;
      const target = selected ? 0.09 : hoverUid === card.uid ? 0.04 : 0;
      const lift =
        (lifts.get(card.uid) ?? 0) + (target - (lifts.get(card.uid) ?? 0)) * Math.min(1, dt * 14);
      lifts.set(card.uid, lift);
      card.outer.position.y = card.baseY + lift;
      card.glow.visible = selected;
      const f = flashLevel(card.face, now);
      const base = card.affordable ? 1 : 0.55;
      card.face.material.color.setRGB(base, base * (1 - f * 0.85), base * (1 - f * 0.85));
    }
    const pulse = 0.22 + 0.16 * Math.sin(now * 0.008);
    for (const enemy of enemies) {
      const f = flashLevel(enemy.body, now);
      const alive = (controller.state.enemies.find((e) => e.id === enemy.id)?.hp ?? 0) > 0;
      const glowAmount = alive && stage === 'target' ? pulse : 0;
      enemy.body.material.emissive.setRGB(
        glowAmount * 0.95 + f * 0.9,
        glowAmount * 0.75,
        glowAmount * 0.4,
      );
    }
    const endFlash = flashLevel(endLabel.mesh, now);
    endLabel.mesh.material.color.setRGB(1, 1 - endFlash * 0.8, 1 - endFlash * 0.8);
    const plateFlash = flashLevel(plateLabel.mesh, now);
    plateLabel.mesh.material.color.setRGB(1, 1 - plateFlash * 0.7, 1 - plateFlash * 0.7);
    const tableFlash = flashLevel(table, now);
    (table.material as THREE.MeshStandardMaterial).emissive.setRGB(tableFlash * 0.6, 0, 0);
  };

  // ---- public handle ---------------------------------------------------------------------------
  const view: CombatDebugView = {
    get controller() {
      return controller;
    },
    restart() {
      bind(new CombatController(startOptions));
    },
    nextEnemy() {
      const current = controller.state.enemies[0]?.id.replace(/-\d+$/, '') ?? 'cog-sentry';
      const index = ENEMY_ORDER.indexOf(current as EnemyKind);
      const enemy = ENEMY_ORDER[(index + 1) % ENEMY_ORDER.length] ?? 'cog-sentry';
      const { encounter: _dropped, ...rest } = startOptions;
      startOptions = { ...rest, enemy };
      const url = new URL(location.href);
      url.searchParams.set('enemy', enemy);
      url.searchParams.delete('encounter');
      history.replaceState(null, '', url);
      bind(new CombatController(startOptions));
    },
    dispose() {
      unsubscribe?.();
      scryPanel?.dispose();
      scene.onBeforeRender = previousBeforeRender;
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerup', finishDrawing);
      window.removeEventListener('pointercancel', finishDrawing);
      overlay.remove();
      rig.remove(root);
    },
  };

  /** Client-pixel position of a pickable (plate: pass `u`/`v` in 0..1), for scripted pointer tests. */
  const screenOf = (
    kind: PickKind,
    key?: number | string,
    u = 0.5,
    v = 0.5,
  ): { x: number; y: number } | null => {
    let object: THREE.Object3D | undefined;
    if (kind === 'card') object = cards.find((c) => c.uid === key)?.face;
    else if (kind === 'enemy') object = enemies.find((e) => e.id === key)?.body;
    else if (kind === 'end-turn') object = endLabel.mesh;
    else if (kind === 'reroll') object = diceLabel.mesh;
    else if (kind === 'plate') object = plateLabel.mesh;
    else object = table;
    if (!object) return null;
    scene.updateMatrixWorld(true);
    camera.updateMatrixWorld(true);
    const point = new THREE.Vector3();
    if (kind === 'plate') point.set((u - 0.5) * PLATE_SIZE, (v - 0.5) * PLATE_SIZE, 0);
    if (kind === 'table') point.set(0, 0.03, 0.2);
    object.localToWorld(point);
    point.project(camera);
    const rect = canvas.getBoundingClientRect();
    return {
      x: rect.left + ((point.x + 1) / 2) * rect.width,
      y: rect.top + ((1 - point.y) / 2) * rect.height,
    };
  };

  const debug = {
    ready: true,
    camera,
    screenOf,
    pickAt: (x: number, y: number) => {
      const rect = canvas.getBoundingClientRect();
      ndc.set(((x - rect.left) / rect.width) * 2 - 1, -((y - rect.top) / rect.height) * 2 + 1);
      camera.updateMatrixWorld(true);
      raycaster.setFromCamera(ndc, camera);
      scene.updateMatrixWorld(true);
      return raycaster.intersectObjects(pickables(), false).map((h) => ({
        ...(h.object.userData as PickData),
        distance: h.distance,
      }));
    },
    get controller() {
      return controller;
    },
    view,
    enemies: ENEMIES,
  };
  bind(controller);
  return view;
}
