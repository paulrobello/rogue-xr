import * as THREE from 'three';
import { Stream } from '../core/rng.ts';
import { GLOW_HOT } from '../enemies/glow.ts';
import { PALETTE } from '../palette.ts';
import {
  type GlyphPath,
  type GlyphReveal,
  type GlyphSegment,
  glyphPath,
  revealAt,
} from '../sigil/glyph-path.ts';
import { SIGIL_IDS, SIGIL_TEMPLATES, type SigilId } from '../sigil/index.ts';
import {
  flickerGain,
  type GlyphFrame,
  glyphFrame,
  headHeat,
  newGlyphFrame,
} from './glyph-timing.ts';
import { GLOW_RENDER_ORDER, linearRgb, SPARK_AMBER } from './sparks.ts';

/** Width of the glyph's bright core line and of its soft halo, metres. */
const CORE_WIDTH = 0.011;
const HALO_WIDTH = 0.034;
/** Just above the player's trail ribbon. */
const GLYPH_Z = 0.005;
/** Vertices per segment: a halo quad then a core quad, two triangles each. */
const VERTS_PER_SEGMENT = 12;

const PATHS = new Map<SigilId, GlyphPath>(
  SIGIL_IDS.map((id) => [id, glyphPath(SIGIL_TEMPLATES[id].strokes)]),
);
const MAX_SEGMENTS = Math.max(...[...PATHS.values()].map((p) => p.segments.length));

const HOT = linearRgb(GLOW_HOT);
const COOL = linearRgb(PALETTE.candle);
const HALO = linearRgb(SPARK_AMBER);
/** The halo is a dim fringe; the core carries the light. */
const HALO_GAIN = 0.32;

/**
 * The clean sigil a finished trace turns into (Paul's Quest feedback: the stroke should become the
 * spell being cast). A plate-space ribbon (a child of `SigilPlate`) that draws the template glyph
 * in light at constant arc speed, flares, pulses and turns, then collapses into the plate centre,
 * on the `glyph-timing.ts` timeline. One draw; positions are written once per cast except the
 * growing head segment, colours once per frame. Flicker noise is visual only, from its own stream.
 */
export class CastGlyph extends THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial> {
  readonly frame: GlyphFrame = newGlyphFrame();
  private readonly positions: THREE.BufferAttribute;
  private readonly colors: THREE.BufferAttribute;
  private readonly stream = Stream.fromKey('sigil-glyph');
  private readonly reveal: GlyphReveal = { full: 0, partial: 0 };
  private path: GlyphPath | null = null;
  private size = 0;
  private power = 0;
  private reduced = false;
  private elapsed = 0;
  /** The segment last drawn shortened, rewritten whole once the head moves past it. */
  private partialSegment = -1;

  constructor() {
    const geometry = new THREE.BufferGeometry();
    const positions = new THREE.BufferAttribute(
      new Float32Array(MAX_SEGMENTS * VERTS_PER_SEGMENT * 3),
      3,
    );
    positions.setUsage(THREE.DynamicDrawUsage);
    const colors = new THREE.BufferAttribute(
      new Float32Array(MAX_SEGMENTS * VERTS_PER_SEGMENT * 3),
      3,
    );
    colors.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('position', positions);
    geometry.setAttribute('color', colors);
    geometry.setDrawRange(0, 0);
    super(
      geometry,
      new THREE.MeshBasicMaterial({
        color: '#ffffff',
        vertexColors: true,
        toneMapped: false,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
      }),
    );
    this.positions = positions;
    this.colors = colors;
    this.name = 'sigil-cast-glyph';
    this.frustumCulled = false;
    this.renderOrder = GLOW_RENDER_ORDER;
    this.visible = false;
  }

  /** True from `start` until the glyph has collapsed. */
  get active(): boolean {
    return this.path !== null;
  }

  /** Seconds since `start`. */
  get age(): number {
    return this.elapsed;
  }

  /** Starts the cast of `sigilId`, its unit box `size` metres across, at `power` (0..1). */
  start(sigilId: SigilId, size: number, power: number, reducedMotion: boolean): void {
    const path = PATHS.get(sigilId) as GlyphPath;
    this.path = path;
    this.size = size;
    this.power = power;
    this.reduced = reducedMotion;
    this.elapsed = 0;
    this.partialSegment = -1;
    for (let i = 0; i < path.segments.length; i++) this.writeSegment(i, 1);
    this.positions.needsUpdate = true;
    this.rotation.set(0, 0, 0);
    this.scale.setScalar(1);
    this.visible = true;
    this.step(0);
  }

  stop(): void {
    this.path = null;
    this.visible = false;
    this.elapsed = 0;
    this.geometry.setDrawRange(0, 0);
    this.frame.trail = 1;
    this.frame.flare = 0;
    this.frame.alive = false;
  }

  update(dt: number): void {
    if (!this.path) return;
    this.elapsed += Math.max(0, dt);
    this.step(this.elapsed);
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }

  private step(t: number): void {
    const path = this.path as GlyphPath;
    const f = glyphFrame(t, this.power, this.reduced, this.frame);
    if (!f.alive) {
      this.stop();
      return;
    }
    const reveal = revealAt(path, f.reveal, this.reveal);
    const head = reveal.partial > 0 ? reveal.full : -1;
    if (head !== this.partialSegment) {
      if (this.partialSegment >= 0) this.writeSegment(this.partialSegment, 1);
      this.partialSegment = head;
    }
    if (head >= 0) this.writeSegment(head, reveal.partial);
    if (head >= 0 || this.partialSegment >= 0) this.positions.needsUpdate = true;
    const drawn = reveal.full + (head >= 0 ? 1 : 0);
    this.geometry.setDrawRange(0, drawn * VERTS_PER_SEGMENT);

    const light = f.brightness * flickerGain(this.power, this.stream.next());
    const total = path.length > 0 ? path.length : 1;
    const array = this.colors.array as Float32Array;
    for (let i = 0; i < drawn; i++) {
      const seg = path.segments[i] as GlyphSegment;
      const end = (seg.start + seg.length * (i === head ? reveal.partial : 1)) / total;
      const heat = Math.max(headHeat(f.reveal - end), f.flare * 0.85);
      const r = (COOL[0] + (HOT[0] - COOL[0]) * heat) * light;
      const g = (COOL[1] + (HOT[1] - COOL[1]) * heat) * light;
      const b = (COOL[2] + (HOT[2] - COOL[2]) * heat) * light;
      const halo = light * HALO_GAIN * (1 + f.flare);
      let o = i * VERTS_PER_SEGMENT * 3;
      for (let v = 0; v < 6; v++) {
        array[o++] = HALO[0] * halo;
        array[o++] = HALO[1] * halo;
        array[o++] = HALO[2] * halo;
      }
      for (let v = 0; v < 6; v++) {
        array[o++] = r;
        array[o++] = g;
        array[o++] = b;
      }
    }
    this.colors.needsUpdate = true;
    this.rotation.z = f.spin;
    this.scale.setScalar(Math.max(0.001, f.scale));
  }

  /** Writes segment `i`'s halo and core quads, its first `fraction` drawn. */
  private writeSegment(i: number, fraction: number): void {
    const seg = (this.path as GlyphPath).segments[i] as GlyphSegment;
    const s = this.size;
    const ax = (seg.ax - 0.5) * s;
    const ay = (seg.ay - 0.5) * s;
    const bx = (seg.ax + (seg.bx - seg.ax) * fraction - 0.5) * s;
    const by = (seg.ay + (seg.by - seg.ay) * fraction - 0.5) * s;
    const o = i * VERTS_PER_SEGMENT * 3;
    this.writeQuad(o, ax, ay, bx, by, HALO_WIDTH);
    this.writeQuad(o + 18, ax, ay, bx, by, CORE_WIDTH);
  }

  /** A quad `width` wide over a to b, overhanging half a width at each end so joins overlap. */
  private writeQuad(
    o: number,
    ax: number,
    ay: number,
    bx: number,
    by: number,
    width: number,
  ): void {
    const array = this.positions.array as Float32Array;
    const length = Math.hypot(bx - ax, by - ay);
    const half = width / 2;
    const tx = length > 1e-9 ? ((bx - ax) / length) * half : half;
    const ty = length > 1e-9 ? ((by - ay) / length) * half : 0;
    // Corners 0..3, emitted as triangles (0, 1, 2) and (2, 1, 3).
    const c0x = ax - tx - ty;
    const c0y = ay - ty + tx;
    const c1x = ax - tx + ty;
    const c1y = ay - ty - tx;
    const c2x = bx + tx - ty;
    const c2y = by + ty + tx;
    const c3x = bx + tx + ty;
    const c3y = by + ty - tx;
    let i = o;
    array[i++] = c0x;
    array[i++] = c0y;
    array[i++] = GLYPH_Z;
    array[i++] = c1x;
    array[i++] = c1y;
    array[i++] = GLYPH_Z;
    array[i++] = c2x;
    array[i++] = c2y;
    array[i++] = GLYPH_Z;
    array[i++] = c2x;
    array[i++] = c2y;
    array[i++] = GLYPH_Z;
    array[i++] = c1x;
    array[i++] = c1y;
    array[i++] = GLYPH_Z;
    array[i++] = c3x;
    array[i++] = c3y;
    array[i++] = GLYPH_Z;
  }
}
