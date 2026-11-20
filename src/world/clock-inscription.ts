import * as THREE from 'three';
import { CanvasLabel } from '../combat-view/canvas-label.ts';

/** A brass-edged enamel plate with the writing on its outward (+Z) face. */
export class ClockInscription {
  readonly object: THREE.Mesh<THREE.BoxGeometry, THREE.MeshStandardMaterial>;
  private readonly label?: CanvasLabel;

  constructor(name: string, width: number, title: string, line1: string, line2: string) {
    const height = width / 3.7;
    const depth = 0.024;
    this.object = new THREE.Mesh(
      new THREE.BoxGeometry(width, height, depth),
      new THREE.MeshStandardMaterial({ color: 0x765938, metalness: 0.52, roughness: 0.52 }),
    );
    this.object.name = name;
    this.object.userData.labelText = [title, line1, line2].join('\n');
    if (typeof document === 'undefined' || !document.createElement('canvas').getContext('2d'))
      return;
    const label = new CanvasLabel(962, 260, width, false);
    label.draw((ctx, w, h) => {
      ctx.fillStyle = '#ad8955';
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#213530';
      ctx.fillRect(6, 6, w - 12, h - 12);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#eed6a3';
      ctx.font = 'bold 60px Georgia, serif';
      ctx.fillText(title, w / 2, 53, w - 50);
      ctx.fillStyle = '#faf3dc';
      ctx.font = '54px system-ui, sans-serif';
      ctx.fillText(line1, w / 2, 134, w - 44);
      ctx.fillText(line2, w / 2, 202, w - 44);
    });
    label.mesh.position.z = depth / 2 + 0.001;
    this.object.add(label.mesh);
    this.label = label;
  }

  dispose(): void {
    this.label?.dispose();
    this.object.geometry.dispose();
    this.object.material.dispose();
  }
}
