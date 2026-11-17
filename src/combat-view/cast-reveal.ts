import * as THREE from 'three';
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
 * has loaded the card shows as its family tint.
 */
export class CastReveal extends THREE.Group {
  readonly reducedMotion: boolean;
  private readonly mesh: THREE.InstancedMesh;
  private readonly material: THREE.ShaderMaterial;
  /** The material's own 1x1 blank page, bound until the art arrives. */
  private readonly blankPage: THREE.Texture;
  private readonly frame = newRevealFrame();
  private readonly tint = new THREE.Color();
  private art: CardFaceArt | null = null;
  private age = REVEAL_SECONDS;
  private width = 0.1;
  private aspect = FALLBACK_ASPECT;
  private shownId: string | null = null;

  constructor(options: { reducedMotion?: boolean } = {}) {
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
    this.add(this.mesh);
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
  }

  private apply(): void {
    const f = revealFrame(this.age, this.reducedMotion, this.frame);
    this.visible = f.visible;
    if (!f.visible) return;
    this.mesh.scale.set(this.width * f.scale, this.width * this.aspect * f.scale, 1);
    writeCardBurn(this.mesh.geometry, 0, true, f.burn, BURN_SEED, f.flare);
  }
}
