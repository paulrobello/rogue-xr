import * as THREE from 'three';
import { cardArt } from '../cards/card-atlas.ts';
import {
  addCardFaceAttributes,
  applyCardFaceArt,
  type CardFaceArt,
  cardFaceInstance,
  createCardFaceMaterial,
  loadedCardFaceArt,
  writeCardBurn,
  writeCardFace,
  writeCardTint,
} from '../cards/card-face-material.ts';
import { getCard } from '../content/cards.ts';
import { PALETTE } from '../palette.ts';
import { newRevealFrame, REVEAL_SECONDS, revealFrame } from './cast-timing.ts';
import type { Point3 } from './impact-timing.ts';

/** The flash reaches this far past the disc's edge, as a fraction of its diameter. */
const HALO_REACH = 0.32;
/** The flash sits this far behind the disc, metres. */
const HALO_BEHIND = 0.002;
/**
 * The card face shader's window uniform for the reveal: a window centred on a square quad, aspect
 * 1, its radius just inside half the quad width so the shader's anti-aliased edge (at most
 * `FRAME_EDGE_MAX_TEXELS` frame texels past the radius) stays on the quad.
 */
export const ART_ONLY_WINDOW: readonly [number, number, number, number] = [0.5, 0.5, 0.485, 1];

const HALO_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

// A glow ring hugging a disc `uDisc` (radius over the quad's half width): hot at its rim, falling
// off outward. Behind the opaque disc, only the part past its edge shows.
const HALO_FRAGMENT = /* glsl */ `
uniform vec3 uColor;
uniform float uDisc;
uniform float uLevel;
varying vec2 vUv;
void main() {
  float r = length(vUv - 0.5) * 2.0;
  float d = max(r - uDisc, 0.0) / max(1.0 - uDisc, 1e-3);
  float glow = exp(-4.5 * d) * (1.0 - smoothstep(0.85, 1.0, r));
  gl_FragColor = vec4(uColor * glow * uLevel, 1.0);
  #include <colorspace_fragment>
}`;
/** Burn noise seed of the reveal: fixed, so every reveal burns the same way. */
const BURN_SEED = 0.37;
const TYPE_TINT: Record<string, string> = {
  attack: PALETTE.ruby,
  skill: PALETTE.sapphire,
  sigil: PALETTE.brass,
};

/**
 * The cast card's art shown over the sigil plate for a moment after its glyph flashes: only the
 * round art window (the hand card's portal layers from the shared atlas), no frame, name, cost or
 * text (Paul's playtest 2026-11-17). It grows out of the collapsed glyph, holds, and burns away as
 * the spell leaves it. One instance of the card face material, one draw: this material's window
 * uniform is set to `ART_ONLY_WINDOW` and the shader draws only the art inside the circle. The shared atlas pages
 * are bound when a reveal starts and are never disposed here. Until the atlas has loaded the disc
 * shows as its family tint. The flash is a white-gold ring around the disc (one additive quad
 * behind it), never a tint over the art.
 */
export class CastReveal extends THREE.Group {
  readonly reducedMotion: boolean;
  private readonly mesh: THREE.InstancedMesh;
  private readonly material: THREE.ShaderMaterial;
  /** The material's own 1x1 blank page, bound until the art arrives. */
  private readonly blankPage: THREE.Texture;
  private readonly halo: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  private readonly frame = newRevealFrame();
  private readonly tint = new THREE.Color();
  private art: CardFaceArt | null = null;
  private age = REVEAL_SECONDS;
  private width = 0.1;
  private shownId: string | null = null;

  /** `art`: the card art to use instead of the shared loaded atlas (tests). */
  constructor(options: { reducedMotion?: boolean; art?: CardFaceArt } = {}) {
    super();
    this.name = 'cast-reveal';
    this.reducedMotion = options.reducedMotion ?? false;
    const geometry = new THREE.PlaneGeometry(1, 1);
    addCardFaceAttributes(geometry, 1);
    this.material = createCardFaceMaterial();
    this.blankPage = this.material.uniforms.uFrame?.value as THREE.Texture;
    this.mesh = new THREE.InstancedMesh(geometry, this.material, 1);
    this.mesh.setMatrixAt(0, new THREE.Matrix4());
    this.mesh.name = 'cast-reveal-card';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    this.mesh.raycast = () => undefined;
    this.halo = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.ShaderMaterial({
        uniforms: {
          uColor: { value: new THREE.Color(PALETTE.candle).lerp(new THREE.Color(1, 1, 1), 0.45) },
          uDisc: { value: 0.75 },
          uLevel: { value: 0 },
        },
        vertexShader: HALO_VERTEX,
        fragmentShader: HALO_FRAGMENT,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        toneMapped: false,
      }),
    );
    this.halo.name = 'cast-reveal-flash';
    this.halo.position.z = -HALO_BEHIND;
    this.halo.frustumCulled = false;
    this.halo.renderOrder = 3;
    this.halo.raycast = () => undefined;
    this.add(this.mesh, this.halo);
    this.visible = false;
    if (options.art) this.useArt(options.art);
  }

  /** True from `show` until the art has burnt away. */
  get active(): boolean {
    return this.age < REVEAL_SECONDS;
  }

  /** The card shown or waiting to show, or null. */
  get cardId(): string | null {
    return this.active ? this.shownId : null;
  }

  /**
   * Shows card `cardId`'s art as a disc `width` metres across at `centre`, in the plane of `right`
   * and `up` (its face toward `right × up`), starting `delay` seconds from now. A new reveal
   * replaces the last.
   */
  show(cardId: string, centre: Point3, right: Point3, up: Point3, width: number, delay = 0): void {
    const art = this.art ?? loadedCardFaceArt();
    if (art && !this.art) this.useArt(art);
    const geometry = this.mesh.geometry;
    if (this.art) {
      writeCardFace(geometry, 0, cardFaceInstance(this.art.atlas, cardId));
      this.material.uniforms.uArtOnlyTexels.value = artWindowTexels(this.art, cardId);
    } else
      writeCardTint(geometry, 0, this.tint.set(TYPE_TINT[getCard(cardId).type] ?? PALETTE.brass));
    this.shownId = cardId;
    this.width = width;
    const r = new THREE.Vector3(right.x, right.y, right.z).normalize();
    const u = new THREE.Vector3(up.x, up.y, up.z).normalize();
    const n = r.clone().cross(u).normalize();
    this.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(r, u, n));
    this.position.set(centre.x, centre.y, centre.z);
    this.age = -Math.max(0, delay);
    this.apply();
  }

  update(dt: number): void {
    if (!this.active) return;
    this.age += Math.max(0, dt);
    this.apply();
  }

  /** Drops the reveal at once. */
  reset(): void {
    this.age = REVEAL_SECONDS;
    this.apply();
  }

  dispose(): void {
    // The atlas pages are shared with the hand. This material owns only its placeholder.
    this.blankPage.dispose();
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.mesh.dispose();
    this.halo.geometry.dispose();
    this.halo.material.dispose();
  }

  /** Binds the atlas pages, then narrows this material to the art window with no frame. */
  private useArt(art: CardFaceArt): void {
    this.art = art;
    applyCardFaceArt(this.material, art);
    const u = this.material.uniforms as Record<string, THREE.IUniform>;
    (u.uWindow as THREE.IUniform<THREE.Vector4>).value.set(...ART_ONLY_WINDOW);
  }

  private apply(): void {
    const f = revealFrame(this.age, this.reducedMotion, this.frame);
    this.visible = f.visible;
    if (!f.visible) return;
    const w = this.width * f.scale;
    this.mesh.scale.set(w, w, 1);
    writeCardBurn(this.mesh.geometry, 0, true, f.burn, BURN_SEED, f.flare);
    const reach = 2 * HALO_REACH * this.width;
    this.halo.scale.set(w + reach, w + reach, 1);
    const u = this.halo.material.uniforms;
    (u.uDisc as THREE.IUniform<number>).value = w / (w + reach);
    (u.uLevel as THREE.IUniform<number>).value = f.halo;
    this.halo.visible = f.halo > 0;
  }
}

/** The art window's diameter in frame texels: the span the shader's edge width is measured in. */
export function artWindowTexels(art: CardFaceArt, cardId: string): number {
  const { frame } = cardArt(art.atlas, cardId);
  return 2 * frame.window.radius * frame.rect[2];
}
