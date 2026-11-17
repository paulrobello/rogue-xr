import * as THREE from 'three';
import { GLOW_HOT } from '../enemies/glow.ts';
import { PALETTE } from '../palette.ts';
import {
  type Point,
  SIGIL_IDS,
  SIGIL_TEMPLATES,
  type SigilId,
  type SigilLevel,
} from '../sigil/index.ts';
import { CastGlyph } from './cast-glyph.ts';
import { castPower } from './glyph-timing.ts';
import {
  formatMultiplier,
  MAX_TRACE_POINTS,
  makePlatePose,
  mouseToPlate,
  type PlatePose,
  penToPlate,
  projectTip,
  type RayCamera,
  rayToPlate,
  type SigilQuality,
  scoreTrace,
  TraceBuilder,
  type TraceResult,
  type Vec3,
} from './projection.ts';
import { type HeatRamp, heatColor, TrailHeat } from './spark-pool.ts';
import { GLOW_RENDER_ORDER, linearRgb, SigilSparks, SPARK_AMBER, SPARK_GRAVITY } from './sparks.ts';

/** Fraction of the plate's shorter side the guide glyph's unit box fills. */
const GLYPH_FILL = 0.8;
const APPEAR_SECONDS = 0.25;
const PULSE_HZ = 0.4;
const LABEL_HOLD_SECONDS = 1.6;
const LABEL_FADE_SECONDS = 0.7;
const LABEL_POP_SECONDS = 0.15;
const LABEL_WIDTH = 0.34;
const LABEL_HEIGHT = 0.17;
const TRAIL_Z = 0.004;
/** Trail ribbon width, metres: a 1 px line is lost at headset resolution and foveation. */
const TRAIL_WIDTH = 0.009;
const HINT_HEIGHT = 0.05;
const HINT_CANVAS = { width: 1024, height: 112 } as const;
const GUIDE_Z = 0.002;
const LABEL_CANVAS = { width: 256, height: 128 } as const;

/**
 * The trail skips tone mapping so its hot head can show the D11 amber. Its settled colour is what
 * the stroke's '#fff0b8' rendered as under AgX at exposure 1 (linear), so the cooled tail looks as
 * it did before the head glow existed.
 */
const TRAIL_HEAT: HeatRamp = {
  cool: [0.5931, 0.5483, 0.4312],
  mid: linearRgb(SPARK_AMBER),
  hot: linearRgb(GLOW_HOT),
};
const FLOATS_PER_SEGMENT = 18;

const QUALITY_COLOR: Readonly<Record<SigilQuality, string>> = {
  Fizzle: '#e0707a',
  Rough: PALETTE.parchment,
  Clean: PALETTE.candle,
  Masterful: '#fff0b8',
};

const GUIDE_SEGMENTS = Math.max(
  ...SIGIL_IDS.map((id) =>
    SIGIL_TEMPLATES[id].strokes.reduce((sum, stroke) => sum + Math.max(0, stroke.length - 1), 0),
  ),
);

export type PlatePhase = 'hidden' | 'ready' | 'drawing' | 'done';

function easeOutCubic(t: number): number {
  const c = Math.min(1, Math.max(0, t));
  return 1 - (1 - c) ** 3;
}

function lineBuffer(segments: number): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  const attr = new THREE.BufferAttribute(new Float32Array(segments * 2 * 3), 3);
  attr.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('position', attr);
  geometry.setDrawRange(0, 0);
  return geometry;
}

/** Room for `segments` trail quads, two triangles each. */
function ribbonBuffer(segments: number): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  const attr = new THREE.BufferAttribute(new Float32Array(segments * 6 * 3), 3);
  attr.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('position', attr);
  const color = new THREE.BufferAttribute(new Float32Array(segments * 6 * 3), 3);
  color.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('color', color);
  geometry.setDrawRange(0, 0);
  return geometry;
}

/**
 * The glowing plate a sigil card reveals above the table. Plate space is the group's local XY plane
 * (+Z faces the player), so a trace point from `projection.ts` maps to a vertex at (x, y, z) with no
 * further transform. Add it to an untransformed root and pass poses in that root's space; `addTip`
 * and `addRay` take points in the same space.
 *
 * Flow: `show` -> `beginStroke` -> `addTip` per frame -> `endStroke` (repeat for multi-stroke) ->
 * `finish` (scores through `scoreTrace`, shows the multiplier and quality word) -> `hide`.
 */
export class SigilPlate extends THREE.Group {
  private readonly builder = new TraceBuilder();
  private readonly face: THREE.Mesh;
  private readonly rim: THREE.LineLoop;
  private readonly guide: THREE.LineSegments;
  private readonly trail: THREE.Mesh;
  private readonly label: THREE.Mesh;
  private readonly hint: THREE.Mesh;
  private readonly hintMaterial: THREE.MeshBasicMaterial;
  private readonly hintCanvas: HTMLCanvasElement | null;
  private readonly hintTexture: THREE.CanvasTexture | null;
  private hintWords = '';
  private readonly faceMaterial: THREE.MeshBasicMaterial;
  private readonly rimMaterial: THREE.LineBasicMaterial;
  private readonly guideMaterial: THREE.LineBasicMaterial;
  private readonly trailMaterial: THREE.MeshBasicMaterial;
  private readonly labelMaterial: THREE.MeshBasicMaterial;
  private readonly labelCanvas: HTMLCanvasElement | null;
  private readonly labelTexture: THREE.CanvasTexture | null;
  private trailSegments = 0;
  private readonly trailHeat = new TrailHeat(MAX_TRACE_POINTS);
  private readonly sparks = new SigilSparks();
  private readonly glyph = new CastGlyph();
  private readonly gravityTurn = new THREE.Quaternion();
  private readonly gravity = new THREE.Vector3();
  private plateSigil: SigilId | null = null;
  /** The run's level: how strictly finish judges the trace. */
  level: SigilLevel = 'casual';
  private platePose: PlatePose | null = null;
  private currentPhase: PlatePhase = 'hidden';
  private time = 0;
  private appear = 0;
  private labelAge = Number.POSITIVE_INFINITY;
  private text = '';
  /** Softens the cast glyph (no spin, swell or pulse). Set by the owner from the OS preference. */
  reducedMotion = false;

  constructor() {
    super();
    this.name = 'sigil-plate';
    this.visible = false;

    this.faceMaterial = new THREE.MeshBasicMaterial({
      color: PALETTE.brassDark,
      transparent: true,
      opacity: 0.3,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.face = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.faceMaterial);
    this.face.name = 'sigil-plate-face';
    this.add(this.face);

    const rimGeometry = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-0.5, -0.5, 0),
      new THREE.Vector3(0.5, -0.5, 0),
      new THREE.Vector3(0.5, 0.5, 0),
      new THREE.Vector3(-0.5, 0.5, 0),
    ]);
    this.rimMaterial = new THREE.LineBasicMaterial({
      color: PALETTE.brass,
      transparent: true,
      opacity: 0.8,
      depthWrite: false,
    });
    this.rim = new THREE.LineLoop(rimGeometry, this.rimMaterial);
    this.rim.frustumCulled = false;
    this.add(this.rim);

    this.guideMaterial = new THREE.LineBasicMaterial({
      color: PALETTE.candle,
      transparent: true,
      opacity: 0.28,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.guide = new THREE.LineSegments(lineBuffer(GUIDE_SEGMENTS), this.guideMaterial);
    this.guide.name = 'sigil-plate-guide';
    this.guide.frustumCulled = false;
    this.add(this.guide);

    this.trailMaterial = new THREE.MeshBasicMaterial({
      color: '#ffffff',
      vertexColors: true,
      toneMapped: false,
      transparent: true,
      opacity: 1,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });
    this.trail = new THREE.Mesh(ribbonBuffer(MAX_TRACE_POINTS), this.trailMaterial);
    this.trail.name = 'sigil-plate-trail';
    this.trail.frustumCulled = false;
    this.trail.renderOrder = GLOW_RENDER_ORDER;
    this.add(this.trail);
    this.add(this.glyph);
    this.add(this.sparks);

    this.labelCanvas = typeof document === 'undefined' ? null : document.createElement('canvas');
    if (this.labelCanvas) {
      this.labelCanvas.width = LABEL_CANVAS.width;
      this.labelCanvas.height = LABEL_CANVAS.height;
    }
    this.labelTexture = this.labelCanvas ? new THREE.CanvasTexture(this.labelCanvas) : null;
    if (this.labelTexture) this.labelTexture.colorSpace = THREE.SRGBColorSpace;
    this.labelMaterial = new THREE.MeshBasicMaterial({
      map: this.labelTexture,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.label = new THREE.Mesh(
      new THREE.PlaneGeometry(LABEL_WIDTH, LABEL_HEIGHT),
      this.labelMaterial,
    );
    this.label.name = 'sigil-plate-label';
    this.label.visible = false;
    this.add(this.label);

    this.hintCanvas = typeof document === 'undefined' ? null : document.createElement('canvas');
    if (this.hintCanvas) {
      this.hintCanvas.width = HINT_CANVAS.width;
      this.hintCanvas.height = HINT_CANVAS.height;
    }
    this.hintTexture = this.hintCanvas ? new THREE.CanvasTexture(this.hintCanvas) : null;
    if (this.hintTexture) this.hintTexture.colorSpace = THREE.SRGBColorSpace;
    this.hintMaterial = new THREE.MeshBasicMaterial({
      map: this.hintTexture,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.hint = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.hintMaterial);
    this.hint.name = 'sigil-plate-hint';
    this.hint.visible = false;
    this.add(this.hint);
  }

  get phase(): PlatePhase {
    return this.currentPhase;
  }

  /** The sigil being drawn, or null while hidden. */
  get sigilId(): SigilId | null {
    return this.plateSigil;
  }

  /** Current plate pose, or null while hidden. */
  get pose(): PlatePose | null {
    return this.platePose;
  }

  /** Strokes drawn so far, in plate space. */
  get strokes(): readonly (readonly Point[])[] {
    return this.builder.strokes;
  }

  get pointCount(): number {
    return this.builder.pointCount;
  }

  /** True while the clean glyph of a finished cast is playing. */
  get casting(): boolean {
    return this.glyph.active;
  }

  /** Seconds since the cast glyph started (0 when none is playing). */
  get castAge(): number {
    return this.glyph.age;
  }

  /** The cast glyph's current flare, 0..1. */
  get castFlare(): number {
    return this.glyph.active ? this.glyph.frame.flare : 0;
  }

  /** How-to-draw line shown above the plate while it waits for a trace. */
  get hintText(): string {
    return this.hintWords;
  }

  /** Sets the how-to-draw line; an empty string hides it. */
  setHint(text: string): void {
    if (text === this.hintWords) return;
    this.hintWords = text;
    if (!text) return;
    const ctx = this.hintCanvas?.getContext('2d');
    if (!ctx || !this.hintTexture) return;
    const { width, height } = HINT_CANVAS;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = 'rgba(18,12,7,0.78)';
    ctx.beginPath();
    ctx.roundRect(4, 4, width - 8, height - 8, 24);
    ctx.fill();
    ctx.fillStyle = PALETTE.parchment;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = 'bold 44px system-ui, sans-serif';
    ctx.fillText(text, width / 2, height / 2, width - 40);
    this.hintTexture.needsUpdate = true;
  }

  /** Text of the result label ("×1.18 Clean"), or "" when none is shown. */
  get labelText(): string {
    return this.text;
  }

  /** Reveals the plate for `sigilId` at `pose`, clears any previous trace and plays the appear animation. */
  show(sigilId: SigilId, pose: PlatePose): void {
    this.plateSigil = sigilId;
    this.platePose = pose;
    this.resetTrail();
    this.sparks.reset();
    this.clearLabel();

    const basis = new THREE.Matrix4().makeBasis(
      new THREE.Vector3(pose.right.x, pose.right.y, pose.right.z),
      new THREE.Vector3(pose.up.x, pose.up.y, pose.up.z),
      new THREE.Vector3(pose.normal.x, pose.normal.y, pose.normal.z),
    );
    this.position.set(pose.center.x, pose.center.y, pose.center.z);
    this.quaternion.setFromRotationMatrix(basis);
    this.face.scale.set(pose.halfWidth * 2, pose.halfHeight * 2, 1);
    this.rim.scale.set(pose.halfWidth * 2, pose.halfHeight * 2, 1);
    this.writeGuide(sigilId, pose);

    this.appear = 0;
    this.time = 0;
    this.scale.setScalar(0.001);
    this.visible = true;
    this.currentPhase = 'ready';
  }

  /** Hides the plate and drops the trace. Safe to call at any time. */
  hide(): void {
    this.visible = false;
    this.currentPhase = 'hidden';
    this.plateSigil = null;
    this.platePose = null;
    this.resetTrail();
    this.sparks.reset();
    this.clearLabel();
  }

  /** Trigger or mouse button down. Ignored unless the plate is showing and not yet finished. */
  beginStroke(): void {
    if (this.currentPhase !== 'ready' && this.currentPhase !== 'drawing') return;
    this.builder.beginStroke();
    this.currentPhase = 'drawing';
  }

  /** Feeds a controller tip position while the trigger is held. Returns true when a point was stored. */
  addTip(worldPoint: Vec3): boolean {
    if (!this.platePose) return false;
    return this.addPoint(projectTip(this.platePose, worldPoint));
  }

  /**
   * Feeds one controller sample per frame while the trigger is held: the tip when it touches the
   * plate, else where `ray` meets it (`penToPlate`). Returns true when a point was stored.
   */
  addPen(tip: Vec3, ray: { readonly origin: Vec3; readonly direction: Vec3 } | null): boolean {
    if (!this.platePose) return false;
    return this.addPoint(penToPlate(this.platePose, tip, ray));
  }

  /** Feeds a world-space ray (a point-and-trigger controller ray, or any desktop pick ray). */
  addRay(origin: Vec3, direction: Vec3): boolean {
    if (!this.platePose) return false;
    return this.addPoint(rayToPlate(this.platePose, origin, direction));
  }

  /** Feeds the mouse position (normalized device coordinates) through `camera`: the desktop path. */
  addMouse(ndc: Point, camera: RayCamera): boolean {
    if (!this.platePose) return false;
    return this.addPoint(mouseToPlate(ndc, camera, this.platePose));
  }

  /** Trigger or mouse button up. The stroke is kept; the player may start another. */
  endStroke(): void {
    if (this.currentPhase !== 'drawing') return;
    this.builder.endStroke();
    this.sparks.clearContact();
    this.currentPhase = 'ready';
  }

  /**
   * Scores the trace and shows the multiplier and quality word. Returns null (and shows "Too short")
   * for a stray tap, leaving the plate ready for another attempt; the caller should not cast then.
   */
  finish(): TraceResult | null {
    if (this.currentPhase !== 'ready' && this.currentPhase !== 'drawing') return null;
    const sigilId = this.plateSigil as SigilId;
    this.builder.endStroke();
    const result = scoreTrace(this.builder.strokes, sigilId, this.level);
    this.sparks.clearContact();
    if (!result.castable) {
      this.resetTrail();
      this.showLabel('', 'Too short', QUALITY_COLOR.Rough);
      this.currentPhase = 'ready';
      return null;
    }
    this.showLabel(
      formatMultiplier(result.multiplier),
      result.quality,
      QUALITY_COLOR[result.quality],
    );
    // The raw stroke gives way to the clean glyph of the sigil; the strokes stay for the caller.
    const pose = this.platePose as PlatePose;
    this.glyph.start(
      sigilId,
      Math.min(pose.halfWidth, pose.halfHeight) * 2 * GLYPH_FILL,
      castPower(result.multiplier),
      this.reducedMotion,
    );
    this.currentPhase = 'done';
    return result;
  }

  /** Advances the appear animation, glow pulse and label fade. Call once per frame. */
  update(dt: number): void {
    if (!this.visible) return;
    this.time += dt;
    if (this.appear < 1) {
      this.appear = Math.min(1, this.appear + dt / APPEAR_SECONDS);
      this.scale.setScalar(Math.max(0.001, easeOutCubic(this.appear)));
    }
    const pulse = 0.5 + 0.5 * Math.sin(this.time * Math.PI * 2 * PULSE_HZ);
    const drawing = this.currentPhase === 'drawing' ? 0.12 : 0;
    this.glyph.update(dt);
    const cast = this.glyph.active ? this.glyph.frame : null;
    const flare = cast ? cast.flare : 0;
    this.faceMaterial.opacity = 0.26 + 0.12 * pulse + drawing + 0.3 * flare;
    this.rimMaterial.opacity = Math.min(1, 0.6 + 0.4 * pulse + flare);
    // The guide and the raw stroke fade out under the cast glyph and stay out until the next show.
    const under = cast ? cast.trail : this.currentPhase === 'done' ? 0 : 1;
    this.guideMaterial.opacity = (0.2 + 0.14 * pulse) * under;
    this.trailMaterial.opacity = under;
    this.trail.visible = under > 0;
    this.stepTrace(dt);

    const waiting = this.currentPhase === 'ready' || this.currentPhase === 'drawing';
    this.hint.visible = waiting && this.hintWords !== '' && !this.label.visible;

    if (this.label.visible) {
      this.labelAge += dt;
      const fade = 1 - (this.labelAge - LABEL_HOLD_SECONDS) / LABEL_FADE_SECONDS;
      this.labelMaterial.opacity = Math.min(1, Math.max(0, fade));
      this.label.scale.setScalar(0.8 + 0.2 * easeOutCubic(this.labelAge / LABEL_POP_SECONDS));
      if (fade <= 0) {
        this.label.visible = false;
        this.text = '';
      }
    }
  }

  dispose(): void {
    this.sparks.dispose();
    this.glyph.dispose();
    for (const child of [this.face, this.rim, this.guide, this.trail, this.label, this.hint]) {
      child.geometry.dispose();
    }
    this.hintMaterial.dispose();
    this.hintTexture?.dispose();
    this.faceMaterial.dispose();
    this.rimMaterial.dispose();
    this.guideMaterial.dispose();
    this.trailMaterial.dispose();
    this.labelMaterial.dispose();
    this.labelTexture?.dispose();
  }

  private addPoint(point: Point | null): boolean {
    if (this.currentPhase !== 'drawing') return false;
    // The contact follows every sample, stored or not: a resting beam still fizzes.
    if (point) this.sparks.setContact(point.x, point.y);
    else this.sparks.clearContact();
    const stored = this.builder.add(point);
    if (!stored) return false;
    const strokes = this.builder.strokes;
    const stroke = strokes[strokes.length - 1] as readonly Point[];
    if (stroke.length < 2) return true;
    const a = stroke[stroke.length - 2] as Point;
    const b = stroke[stroke.length - 1] as Point;
    const attr = this.trail.geometry.getAttribute('position') as THREE.BufferAttribute;
    // A quad across the segment, TRAIL_WIDTH wide, extended by half a width at each end so
    // neighbouring quads overlap at the joins.
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    const half = TRAIL_WIDTH / 2;
    const tx = length > 1e-9 ? ((b.x - a.x) / length) * half : half;
    const ty = length > 1e-9 ? ((b.y - a.y) / length) * half : 0;
    const corners = [
      [a.x - tx - ty, a.y - ty + tx],
      [a.x - tx + ty, a.y - ty - tx],
      [b.x + tx - ty, b.y + ty + tx],
      [b.x + tx + ty, b.y + ty - tx],
    ] as const;
    let i = this.trailSegments * 18;
    for (const k of [0, 1, 2, 2, 1, 3] as const) {
      const corner = corners[k];
      attr.array[i++] = corner[0];
      attr.array[i++] = corner[1];
      attr.array[i++] = TRAIL_Z;
    }
    this.trailSegments++;
    attr.needsUpdate = true;
    this.trail.geometry.setDrawRange(0, this.trailSegments * 6);
    const segment = this.trailHeat.push();
    if (segment >= 0) this.writeHeat(segment, 1);
    return true;
  }

  /** Cools the trail behind the tip and runs the contact sparks under world gravity. */
  private stepTrace(dt: number): void {
    const from = this.trailHeat.advance(dt);
    const to = this.trailHeat.segments;
    for (let i = from; i < to; i++) this.writeHeat(i, this.trailHeat.heat(i));

    if (this.currentPhase !== 'drawing') this.sparks.clearContact();
    this.getWorldQuaternion(this.gravityTurn).invert();
    this.gravity.set(0, -SPARK_GRAVITY, 0).applyQuaternion(this.gravityTurn);
    this.sparks.update(dt, this.gravity.x, this.gravity.y, this.gravity.z);
  }

  private writeHeat(segment: number, heat: number): void {
    const color = this.trail.geometry.getAttribute('color') as THREE.BufferAttribute;
    const array = color.array as Float32Array;
    const o = segment * FLOATS_PER_SEGMENT;
    heatColor(heat, TRAIL_HEAT, array, o);
    for (let k = 3; k < FLOATS_PER_SEGMENT; k++) array[o + k] = array[o + (k % 3)] as number;
    color.needsUpdate = true;
  }

  private resetTrail(): void {
    this.glyph.stop();
    this.trail.visible = true;
    this.trailMaterial.opacity = 1;
    this.builder.clear();
    this.trailSegments = 0;
    this.trailHeat.clear();
    this.trail.geometry.setDrawRange(0, 0);
  }

  private writeGuide(sigilId: SigilId, pose: PlatePose): void {
    const size = Math.min(pose.halfWidth, pose.halfHeight) * 2 * GLYPH_FILL;
    const attr = this.guide.geometry.getAttribute('position') as THREE.BufferAttribute;
    let segments = 0;
    for (const stroke of SIGIL_TEMPLATES[sigilId].strokes) {
      for (let i = 1; i < stroke.length; i++) {
        const a = stroke[i - 1] as Point;
        const b = stroke[i] as Point;
        const o = segments * 6;
        attr.array[o] = (a.x - 0.5) * size;
        attr.array[o + 1] = (a.y - 0.5) * size;
        attr.array[o + 2] = GUIDE_Z;
        attr.array[o + 3] = (b.x - 0.5) * size;
        attr.array[o + 4] = (b.y - 0.5) * size;
        attr.array[o + 5] = GUIDE_Z;
        segments++;
      }
    }
    attr.needsUpdate = true;
    this.guide.geometry.setDrawRange(0, segments * 2);
    this.label.position.set(0, pose.halfHeight + LABEL_HEIGHT * 0.6, 0.01);
    this.hint.scale.set(pose.halfWidth * 2, HINT_HEIGHT, 1);
    this.hint.position.set(0, pose.halfHeight + HINT_HEIGHT * 0.8, 0.01);
  }

  private showLabel(top: string, bottom: string, color: string): void {
    this.text = top ? `${top} ${bottom}` : bottom;
    this.labelAge = 0;
    this.label.visible = true;
    this.label.scale.setScalar(0.8);
    this.labelMaterial.opacity = 1;
    const ctx = this.labelCanvas?.getContext('2d');
    if (!ctx || !this.labelTexture) return;
    const { width, height } = LABEL_CANVAS;
    ctx.clearRect(0, 0, width, height);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = color;
    if (top) {
      ctx.font = 'bold 64px serif';
      ctx.fillText(top, width / 2, height * 0.38);
      ctx.font = 'bold 36px serif';
      ctx.fillText(bottom, width / 2, height * 0.8);
    } else {
      ctx.font = 'bold 44px serif';
      ctx.fillText(bottom, width / 2, height / 2);
    }
    this.labelTexture.needsUpdate = true;
  }

  private clearLabel(): void {
    this.text = '';
    this.labelAge = Number.POSITIVE_INFINITY;
    this.label.visible = false;
    this.labelMaterial.opacity = 0;
  }
}

/**
 * Plate pose from a scene node, for the real table asset's `socket-sigil-plate`: the node's world
 * position is the plate centre, its local +Z (world) is the facing direction toward the player and
 * its local +Y gives the roll.
 */
export function platePoseFromNode(
  node: THREE.Object3D,
  halfWidth = 0.22,
  halfHeight: number = halfWidth,
): PlatePose {
  node.updateWorldMatrix(true, false);
  const e = node.matrixWorld.elements;
  return makePlatePose(
    { x: e[12] as number, y: e[13] as number, z: e[14] as number },
    { x: e[8] as number, y: e[9] as number, z: e[10] as number },
    halfWidth,
    halfHeight,
    { x: e[4] as number, y: e[5] as number, z: e[6] as number },
  );
}

/**
 * Corners of the result label ("×1.25 Masterful") the plate shows above itself after a cast, at
 * full size, in the pose's space. The desktop HUD keeps the enemy readouts clear of it.
 */
export function plateLabelCorners(pose: PlatePose): Vec3[] {
  const rise = pose.halfHeight + LABEL_HEIGHT * 0.6;
  const out: Vec3[] = [];
  for (const x of [-LABEL_WIDTH / 2, LABEL_WIDTH / 2])
    for (const y of [rise - LABEL_HEIGHT / 2, rise + LABEL_HEIGHT / 2])
      out.push({
        x: pose.center.x + pose.right.x * x + pose.up.x * y,
        y: pose.center.y + pose.right.y * x + pose.up.y * y,
        z: pose.center.z + pose.right.z * x + pose.up.z * y,
      });
  return out;
}
