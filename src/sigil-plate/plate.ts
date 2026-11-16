import * as THREE from 'three';
import { PALETTE } from '../palette.ts';
import { type Point, SIGIL_IDS, SIGIL_TEMPLATES, type SigilId } from '../sigil/index.ts';
import {
  formatMultiplier,
  MAX_TRACE_POINTS,
  makePlatePose,
  mouseToPlate,
  type PlatePose,
  projectTip,
  type RayCamera,
  rayToPlate,
  type SigilQuality,
  scoreTrace,
  TraceBuilder,
  type TraceResult,
  type Vec3,
} from './projection.ts';

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
const GUIDE_Z = 0.002;
const LABEL_CANVAS = { width: 256, height: 128 } as const;

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
  private readonly trail: THREE.LineSegments;
  private readonly label: THREE.Mesh;
  private readonly faceMaterial: THREE.MeshBasicMaterial;
  private readonly rimMaterial: THREE.LineBasicMaterial;
  private readonly guideMaterial: THREE.LineBasicMaterial;
  private readonly trailMaterial: THREE.LineBasicMaterial;
  private readonly labelMaterial: THREE.MeshBasicMaterial;
  private readonly labelCanvas: HTMLCanvasElement | null;
  private readonly labelTexture: THREE.CanvasTexture | null;
  private trailSegments = 0;
  private plateSigil: SigilId | null = null;
  private platePose: PlatePose | null = null;
  private currentPhase: PlatePhase = 'hidden';
  private time = 0;
  private appear = 0;
  private labelAge = Number.POSITIVE_INFINITY;
  private text = '';

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

    this.trailMaterial = new THREE.LineBasicMaterial({
      color: '#fff0b8',
      transparent: true,
      opacity: 1,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.trail = new THREE.LineSegments(lineBuffer(MAX_TRACE_POINTS), this.trailMaterial);
    this.trail.name = 'sigil-plate-trail';
    this.trail.frustumCulled = false;
    this.add(this.trail);

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

  /** Text of the result label ("×1.18 Clean"), or "" when none is shown. */
  get labelText(): string {
    return this.text;
  }

  /** Reveals the plate for `sigilId` at `pose`, clears any previous trace and plays the appear animation. */
  show(sigilId: SigilId, pose: PlatePose): void {
    this.plateSigil = sigilId;
    this.platePose = pose;
    this.builder.clear();
    this.trailSegments = 0;
    this.trail.geometry.setDrawRange(0, 0);
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
    this.builder.clear();
    this.trailSegments = 0;
    this.trail.geometry.setDrawRange(0, 0);
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
    const result = scoreTrace(this.builder.strokes, sigilId);
    if (!result.castable) {
      this.builder.clear();
      this.trailSegments = 0;
      this.trail.geometry.setDrawRange(0, 0);
      this.showLabel('', 'Too short', QUALITY_COLOR.Rough);
      this.currentPhase = 'ready';
      return null;
    }
    this.showLabel(
      formatMultiplier(result.multiplier),
      result.quality,
      QUALITY_COLOR[result.quality],
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
    this.faceMaterial.opacity = 0.26 + 0.12 * pulse + drawing;
    this.rimMaterial.opacity = 0.6 + 0.4 * pulse;
    this.guideMaterial.opacity = 0.2 + 0.14 * pulse;

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
    for (const child of [this.face, this.rim, this.guide, this.trail, this.label]) {
      child.geometry.dispose();
    }
    this.faceMaterial.dispose();
    this.rimMaterial.dispose();
    this.guideMaterial.dispose();
    this.trailMaterial.dispose();
    this.labelMaterial.dispose();
    this.labelTexture?.dispose();
  }

  private addPoint(point: Point | null): boolean {
    if (this.currentPhase !== 'drawing') return false;
    const stored = this.builder.add(point);
    if (!stored) return false;
    const strokes = this.builder.strokes;
    const stroke = strokes[strokes.length - 1] as readonly Point[];
    if (stroke.length < 2) return true;
    const a = stroke[stroke.length - 2] as Point;
    const b = stroke[stroke.length - 1] as Point;
    const attr = this.trail.geometry.getAttribute('position') as THREE.BufferAttribute;
    const i = this.trailSegments * 6;
    attr.array[i] = a.x;
    attr.array[i + 1] = a.y;
    attr.array[i + 2] = TRAIL_Z;
    attr.array[i + 3] = b.x;
    attr.array[i + 4] = b.y;
    attr.array[i + 5] = TRAIL_Z;
    this.trailSegments++;
    attr.needsUpdate = true;
    this.trail.geometry.setDrawRange(0, this.trailSegments * 2);
    return true;
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
