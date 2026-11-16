import * as THREE from 'three';

/** A flat plane textured from a 2D canvas that is redrawn on demand. Placeholder text and art for the debug view. */
export class CanvasLabel {
  readonly mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly texture: THREE.CanvasTexture;

  constructor(
    readonly pxWidth: number,
    readonly pxHeight: number,
    widthMeters: number,
    transparent = true,
  ) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = pxWidth;
    this.canvas.height = pxHeight;
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas is not available');
    this.ctx = ctx;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 4;
    this.mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(widthMeters, (widthMeters * pxHeight) / pxWidth),
      // toneMapped is off so AgX does not wash out the flat label colors.
      new THREE.MeshBasicMaterial({ map: this.texture, transparent, toneMapped: false }),
    );
  }

  /** Clears the canvas, runs `paint`, and uploads the result. */
  draw(paint: (ctx: CanvasRenderingContext2D, width: number, height: number) => void): void {
    this.ctx.clearRect(0, 0, this.pxWidth, this.pxHeight);
    this.ctx.save();
    paint(this.ctx, this.pxWidth, this.pxHeight);
    this.ctx.restore();
    this.texture.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.texture.dispose();
  }
}

export function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Draws `text` word-wrapped to `maxWidth`, returns the y below the last line. */
export function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  lineHeight: number,
): number {
  let line = '';
  let cursor = y;
  for (const word of text.split(' ')) {
    const next = line === '' ? word : `${line} ${word}`;
    if (ctx.measureText(next).width > maxWidth && line !== '') {
      ctx.fillText(line, x, cursor);
      cursor += lineHeight;
      line = word;
    } else {
      line = next;
    }
  }
  if (line !== '') {
    ctx.fillText(line, x, cursor);
    cursor += lineHeight;
  }
  return cursor;
}
