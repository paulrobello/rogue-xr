import * as THREE from 'three';
import { Stream } from '../core/rng.ts';
import type { FloorWorld } from './floor-world.ts';

const PUFFS = 8;
const BURST_SECONDS = 1.85;
// The aperture lies between the third and fourth blades, behind their forward lips.
const OUTLET = new THREE.Matrix4().makeTranslation(0, 2.103, 0.122);

interface RoomVent {
  readonly poses: THREE.Matrix4[];
  readonly interval: number;
  readonly phase: number;
}

/** A short pressure bleed from the steel service bay's louver. */
export class WallVentSteam {
  private readonly plume: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  private readonly vents = new Map<number, RoomVent>();
  private reducedMotion: boolean;
  private elapsed = 0;
  private activeRoom = -1;
  private activeBurst = -1;

  constructor(
    private readonly world: FloorWorld,
    reducedMotion = false,
  ) {
    this.reducedMotion = reducedMotion;
    const geometry = new THREE.BufferGeometry();
    const positions: number[] = [];
    const ids: number[] = [];
    const indices: number[] = [];
    for (let i = 0; i < PUFFS; i++) {
      const base = i * 4;
      positions.push(-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0);
      ids.push(i, i, i, i);
      indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('puff', new THREE.Float32BufferAttribute(ids, 1));
    geometry.setIndex(indices);
    const material = new THREE.ShaderMaterial({
      uniforms: { time: { value: 0 } },
      transparent: true,
      depthWrite: false,
      vertexShader: `
        attribute float puff;
        uniform float time;
        varying vec2 vCoord;
        varying float vAge;
        varying float vPuff;
        void main() {
          vAge = (time - puff * 0.095) / 1.17;
          vPuff = puff;
          float age = clamp(vAge, 0.0, 1.0);
          vec3 center = vec3(
            sin(puff * 2.4) * (0.055 + 0.055 * age) + 0.08 * age * age,
            0.22 * age * age + 0.007 * sin(puff),
            0.38 * age
          );
          vec4 eye = modelViewMatrix * vec4(center, 1.0);
          vec2 radius = vec2(0.042 + 0.10 * age, 0.025 + 0.095 * age);
          eye.xy += position.xy * radius;
          vCoord = position.xy;
          gl_Position = projectionMatrix * eye;
        }
      `,
      fragmentShader: `
        varying vec2 vCoord;
        varying float vAge;
        varying float vPuff;
        void main() {
          if (vAge <= 0.0 || vAge >= 1.0) discard;
          vec2 p = vCoord + 0.115 * vec2(
            sin(4.1 * vCoord.y + 1.55 * vPuff + 2.1 * vAge),
            sin(3.7 * vCoord.x + 2.71 * vPuff - 1.7 * vAge));
          float edge = 1.0 - smoothstep(0.16, 1.0, dot(p,p));
          float alpha = 0.24 * edge * sin(vAge * 3.14159) * (1.0 - 0.48 * vAge);
          gl_FragColor = vec4(vec3(0.73, 0.78, 0.78), alpha);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
    });
    this.plume = new THREE.Mesh(geometry, material);
    this.plume.name = 'wall-louver-steam';
    this.plume.matrixAutoUpdate = false;
    this.plume.frustumCulled = false;
    this.plume.raycast = () => undefined;
    this.plume.visible = false;
    world.roomGroups.forEach((room, index) => {
      const poses: THREE.Matrix4[] = [];
      room.updateWorldMatrix(true, true);
      const inverse = room.matrixWorld.clone().invert();
      room.traverse((node) => {
        const locals: THREE.Matrix4[] | undefined = node.userData.serviceVentPoses;
        if (!locals) return;
        const transform = new THREE.Matrix4().multiplyMatrices(inverse, node.matrixWorld);
        for (const local of locals)
          poses.push(new THREE.Matrix4().multiplyMatrices(transform, local));
      });
      if (!poses.length) return;
      const rng = Stream.fromKey(`${world.plan.seed}:louver-steam:${index}`);
      this.vents.set(index, {
        poses: rng.shuffle(poses),
        interval: rng.int(8, 13),
        phase: rng.int(0, 5),
      });
    });
  }

  setReducedMotion(reduced: boolean): void {
    this.reducedMotion = reduced;
    if (reduced) this.plume.visible = false;
  }

  update(dt: number): void {
    if (this.reducedMotion) return;
    this.elapsed += dt;
    const room = this.world.current;
    const vent = this.vents.get(room);
    if (!vent) {
      this.plume.visible = false;
      return;
    }
    const clock = this.elapsed + vent.phase;
    const burst = Math.floor(clock / vent.interval);
    const time = clock % vent.interval;
    this.plume.visible = time < BURST_SECONDS;
    if (!this.plume.visible) return;
    if (room !== this.activeRoom || burst !== this.activeBurst) {
      this.activeRoom = room;
      this.activeBurst = burst;
      this.plume.matrix.multiplyMatrices(vent.poses[burst % vent.poses.length], OUTLET);
      this.plume.matrixWorldNeedsUpdate = true;
      this.world.roomGroups[room].add(this.plume);
    }
    this.plume.material.uniforms.time.value = time;
  }

  dispose(): void {
    this.plume.removeFromParent();
    this.plume.geometry.dispose();
    this.plume.material.dispose();
  }
}
