import * as THREE from 'three';

export type TransitPhase = 'idle' | 'opening' | 'fade-out' | 'loading' | 'fade-in';

interface DoorTrip {
  swing: (fraction: number) => void;
  cross: () => void;
}

/** Cross only after the outgoing floor has rendered a fully black frame. */
export class StairTransit {
  phase: TransitPhase = 'idle';
  opacity = 0;
  private elapsed = 0;
  private trip: DoorTrip | null = null;

  constructor(private readonly reducedMotion: boolean) {}

  start(trip: DoorTrip): boolean {
    if (this.phase !== 'idle') return false;
    this.trip = trip;
    this.elapsed = 0;
    this.phase = 'opening';
    return true;
  }

  update(dt: number, ready: boolean): void {
    this.elapsed += dt;
    switch (this.phase) {
      case 'opening': {
        const t = Math.min(this.elapsed / (this.reducedMotion ? 0.3 : 0.75), 1);
        this.trip?.swing(t * t * (3 - 2 * t));
        if (t === 1) {
          this.phase = 'fade-out';
          this.elapsed = 0;
        }
        break;
      }
      case 'fade-out':
        this.opacity = Math.min(this.elapsed / 0.32, 1);
        if (this.opacity === 1) this.phase = 'loading';
        break;
      case 'loading':
        if (this.trip) {
          const { cross } = this.trip;
          this.trip = null;
          cross();
        } else if (ready) {
          this.phase = 'fade-in';
          this.elapsed = 0;
        }
        break;
      case 'fade-in':
        this.opacity = Math.max(0, 1 - this.elapsed / 0.45);
        if (this.opacity === 0) this.phase = 'idle';
        break;
    }
  }
}

/** Clip-space vertices cover each eye's entire viewport, including asymmetric XR projections. */
export class StairFade {
  readonly scene = new THREE.Scene();
  private readonly alpha = { value: 0 };

  constructor() {
    const quad = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      new THREE.ShaderMaterial({
        uniforms: { alpha: this.alpha },
        vertexShader: 'void main() { gl_Position = vec4(position.xy, 0., 1.); }',
        fragmentShader:
          'uniform float alpha; void main() { gl_FragColor = vec4(0., 0., 0., alpha); }',
        transparent: true,
        depthTest: false,
        depthWrite: false,
        toneMapped: false,
      }),
    );
    quad.frustumCulled = false;
    this.scene.add(quad);
  }

  render(renderer: THREE.WebGLRenderer, camera: THREE.Camera, opacity: number): void {
    if (opacity <= 0) return;
    this.alpha.value = opacity;
    const autoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.render(this.scene, camera);
    renderer.autoClear = autoClear;
  }
}
