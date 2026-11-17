import * as THREE from 'three';
import { Text } from 'troika-three-text';
import { frameToCard } from '../cards/card-atlas.ts';
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

/** Card height over the plate when the frame aspect is not known yet (no atlas). */
const FALLBACK_ASPECT = 1.5;
/** Name and cost font sizes over card width and the name's glyph advance, as the hand sets them. */
const TITLE_FONT = 0.092;
const COST_FONT = 0.115;
const TITLE_ADVANCE = 0.55;
/** Labels sit this far in front of the card face, metres. */
const LABEL_Z = 0.0015;
/** The labels fade out while the burn front covers this much of its sweep. */
const LABEL_FADE_BURN = 0.4;
const INK = '#2a1a0e';
/** troika's Text has `fillOpacity` at runtime; the toolkit's type declaration leaves it out. */
type FadingText = Text & { fillOpacity: number };
/** The flash reaches this far past the card's edges, as a fraction of its width. */
const HALO_REACH = 0.32;
/** The flash sits this far behind the card face, metres. */
const HALO_BEHIND = 0.002;

const HALO_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

// A glow hugging a card-sized rectangle: hot at its edge, falling off outward. Behind the opaque
// card, only the part past its edges shows.
const HALO_FRAGMENT = /* glsl */ `
uniform vec3 uColor;
uniform vec2 uCard;
uniform float uLevel;
varying vec2 vUv;
void main() {
  vec2 p = abs(vUv - 0.5) * 2.0;
  vec2 q = max(p - uCard, 0.0) / max(1.0 - uCard, vec2(1e-3));
  float d = length(q);
  float glow = exp(-4.5 * d) * (1.0 - smoothstep(0.85, 1.0, max(p.x, p.y)));
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
 * The cast card's art shown over the sigil plate for a moment after its glyph flashes: the hand's
 * card face (frame and portal art from the shared atlas) grows out of the collapsed glyph, holds,
 * and burns away as the spell leaves it. One instance of the card face material, one draw; the
 * shared atlas pages are bound when a reveal starts and are never disposed here. Until the atlas
 * has loaded the card shows as its family tint. The flash is a white-gold glow around the card's
 * edges (one additive quad behind it), never a tint over the art.
 */
export class CastReveal extends THREE.Group {
  readonly reducedMotion: boolean;
  private readonly mesh: THREE.InstancedMesh;
  private readonly material: THREE.ShaderMaterial;
  /** The material's own 1x1 blank page, bound until the art arrives. */
  private readonly blankPage: THREE.Texture;
  private readonly halo: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  /** The card's name on its text plate and its cost on the gem, as the hand draws them. */
  private readonly labels = new THREE.Group();
  private readonly title = new Text() as FadingText;
  private readonly cost = new Text() as FadingText;
  private readonly syncLabels: boolean;
  private readonly frame = newRevealFrame();
  private readonly tint = new THREE.Color();
  private art: CardFaceArt | null = null;
  private age = REVEAL_SECONDS;
  private width = 0.1;
  private aspect = FALLBACK_ASPECT;
  private shownId: string | null = null;

  /** `syncLabels`: run troika typesetting for the name and cost. Off in tests (no font fetch). */
  constructor(options: { reducedMotion?: boolean; syncLabels?: boolean } = {}) {
    super();
    this.name = 'cast-reveal';
    this.reducedMotion = options.reducedMotion ?? false;
    this.syncLabels = options.syncLabels ?? true;
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
          uCard: { value: new THREE.Vector2(0.75, 0.8) },
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
    this.title.color = INK;
    this.title.anchorX = 'center';
    this.title.anchorY = 'middle';
    this.title.textAlign = 'center';
    this.title.whiteSpace = 'nowrap';
    this.cost.color = PALETTE.candle;
    this.cost.anchorX = 'center';
    this.cost.anchorY = 'middle';
    for (const t of [this.title, this.cost]) {
      t.renderOrder = 3;
      t.raycast = () => undefined;
      this.labels.add(t);
    }
    this.labels.name = 'cast-reveal-labels';
    this.labels.position.z = LABEL_Z;
    this.labels.visible = false;
    this.add(this.mesh, this.halo, this.labels);
    this.visible = false;
  }

  /** True from `show` until the card has burnt away. */
  get active(): boolean {
    return this.age < REVEAL_SECONDS;
  }

  /** The card shown or waiting to show, or null. */
  get cardId(): string | null {
    return this.active ? this.shownId : null;
  }

  /**
   * Shows card `cardId` `width` metres wide at `centre`, in the plane of `right` and `up` (its face
   * toward `right × up`), starting `delay` seconds from now. A new reveal replaces the last.
   */
  show(cardId: string, centre: Point3, right: Point3, up: Point3, width: number, delay = 0): void {
    const art = this.art ?? loadedCardFaceArt();
    if (art && !this.art) {
      this.art = art;
      applyCardFaceArt(this.material, art);
      this.aspect = art.atlas.frames.attack.aspect;
    }
    const geometry = this.mesh.geometry;
    if (this.art) writeCardFace(geometry, 0, cardFaceInstance(this.art.atlas, cardId));
    else
      writeCardTint(geometry, 0, this.tint.set(TYPE_TINT[getCard(cardId).type] ?? PALETTE.brass));
    this.shownId = cardId;
    this.width = width;
    this.layoutLabels(cardId, width);
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
    // The atlas pages are shared with the hand; only the blank placeholder is this material's own.
    this.blankPage.dispose();
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.mesh.dispose();
    this.halo.geometry.dispose();
    this.halo.material.dispose();
    this.title.dispose();
    this.cost.dispose();
  }

  /** Sets the name and cost text and places them on the frame's text regions (art only). */
  private layoutLabels(cardId: string, width: number): void {
    const art = this.art;
    this.labels.visible = art !== null;
    if (!art) return;
    const card = getCard(cardId);
    const frame = art.atlas.frames.attack;
    const { cost, name } = frame.textRegions;
    const h = width * this.aspect;
    const [gx, gy] = frameToCard(frame, cost.centre[0], cost.centre[1]);
    const [tx, ty] = frameToCard(
      frame,
      name.rect[0] + name.rect[2] / 2,
      name.rect[1] + name.rect[3] / 2,
    );
    const titleWidth = name.rect[2] / frame.rect[2];
    this.title.text = card.name;
    this.title.fontSize =
      Math.min(TITLE_FONT, titleWidth / (card.name.length * TITLE_ADVANCE)) * width;
    this.title.maxWidth = titleWidth * width;
    this.title.position.set(tx * width, ty * h, 0);
    this.cost.text = String(card.cost);
    this.cost.fontSize = COST_FONT * width;
    this.cost.position.set(gx * width, gy * h, 0);
    if (this.syncLabels) {
      this.title.sync();
      this.cost.sync();
    }
  }

  private apply(): void {
    const f = revealFrame(this.age, this.reducedMotion, this.frame);
    this.visible = f.visible;
    if (!f.visible) return;
    const w = this.width * f.scale;
    const h = this.width * this.aspect * f.scale;
    this.mesh.scale.set(w, h, 1);
    writeCardBurn(this.mesh.geometry, 0, true, f.burn, BURN_SEED, f.flare);
    const reach = 2 * HALO_REACH * this.width;
    this.halo.scale.set(w + reach, h + reach, 1);
    const u = this.halo.material.uniforms;
    (u.uCard as THREE.IUniform<THREE.Vector2>).value.set(w / (w + reach), h / (h + reach));
    (u.uLevel as THREE.IUniform<number>).value = f.halo;
    this.halo.visible = f.halo > 0;
    // The labels dissolve with the face: gone once the burn front is well in.
    this.labels.scale.set(f.scale, f.scale, 1);
    const ink = Math.max(0, 1 - f.burn / LABEL_FADE_BURN);
    this.title.fillOpacity = ink;
    this.cost.fillOpacity = ink;
    this.labels.visible = this.art !== null && ink > 0;
  }
}
