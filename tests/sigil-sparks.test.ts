// @vitest-environment node
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { makePlatePose, type PlatePose, SigilPlate, type Vec3 } from '../src/sigil-plate/index.ts';
import {
  emissionRate,
  FIZZ_RATE,
  type HeatRamp,
  heatColor,
  MAX_RATE,
  MAX_STEP,
  SPARK_CAPACITY,
  SPARK_LIFE_MAX,
  SPARK_LIFE_MIN,
  SparkEmitter,
  SparkPool,
  type SparkRamp,
  TRAIL_COOL_SECONDS,
  TrailHeat,
} from '../src/sigil-plate/spark-pool.ts';
import {
  DOT_SLOT,
  POINTS_SIZE_ASSIGN,
  POINTS_SIZE_DECL,
  type SigilSparks,
} from '../src/sigil-plate/sparks.ts';

const RAMP: SparkRamp = { hot: [1, 0.9, 0.2], mid: [0.9, 0.3, 0.05] };
const FRAME = 1 / 72;

describe('SparkPool', () => {
  it('holds a fixed capacity and reuses the oldest slot once the ring wraps', () => {
    const pool = new SparkPool(4);
    const positions = pool.positions;
    const slots = [0, 1, 2, 3, 4, 5].map((i) => pool.emit(i, 0, 0, 0, 0, 0, 1));
    expect(slots).toEqual([0, 1, 2, 3, 0, 1]);
    expect(pool.alive).toBe(4);
    expect(pool.positions).toBe(positions);
    expect(pool.positions.length).toBe(12);
    // Slot 0 now holds the fifth spark, not the first.
    expect(pool.positions[0]).toBe(4);
    expect(pool.nextSlot).toBe(2);
  });

  it('expires each spark at the end of its life and blacks out its colour', () => {
    const pool = new SparkPool(8);
    pool.emit(0, 0, 0, 0, 0, 0, 0.3);
    pool.emit(0, 0, 0, 0, 0, 0, 0.6);
    pool.step(FRAME, 0, 0, 0, RAMP);
    expect(pool.colors[0]).toBeGreaterThan(0);
    let t = FRAME;
    while (t < 0.31) {
      pool.step(FRAME, 0, 0, 0, RAMP);
      t += FRAME;
    }
    expect(pool.isAlive(0)).toBe(false);
    expect(pool.isAlive(1)).toBe(true);
    expect([pool.colors[0], pool.colors[1], pool.colors[2]]).toEqual([0, 0, 0]);
    while (t < 0.61) {
      pool.step(FRAME, 0, 0, 0, RAMP);
      t += FRAME;
    }
    expect(pool.alive).toBe(0);
  });

  it('starts hot, cools toward amber and fades to black', () => {
    const pool = new SparkPool(1);
    pool.emit(0, 0, 0, 0, 0, 0, 0.5);
    pool.step(0.001, 0, 0, 0, RAMP);
    const early = [...pool.colors];
    expect(early[0]).toBeCloseTo(RAMP.hot[0], 1);
    expect(early[1]).toBeCloseTo(RAMP.hot[1], 1);
    for (let i = 0; i < 20; i++) pool.step(FRAME, 0, 0, 0, RAMP);
    const late = [...pool.colors];
    expect((late[1] as number) / (late[0] as number)).toBeLessThan(
      (early[1] as number) / (early[0] as number),
    );
    expect(late[0]).toBeLessThan(early[0] as number);
  });

  it('falls under gravity', () => {
    const pool = new SparkPool(1);
    pool.emit(0, 0, 0, 0, 0, 0.3, 0.6);
    for (let i = 0; i < 20; i++) pool.step(FRAME, 0, -3, 0, RAMP);
    expect(pool.positions[1]).toBeLessThan(-0.05);
    expect(pool.positions[2]).toBeGreaterThan(0);
  });

  it('clamps a frame hitch so sparks do not teleport', () => {
    const a = new SparkPool(1);
    const b = new SparkPool(1);
    a.emit(0, 0, 0, 1, 0, 0, 0.6);
    b.emit(0, 0, 0, 1, 0, 0, 0.6);
    a.step(0.5, 0, 0, 0, RAMP);
    b.step(MAX_STEP, 0, 0, 0, RAMP);
    expect(a.positions[0]).toBeCloseTo(b.positions[0] as number, 6);
    expect(a.isAlive(0)).toBe(true);
  });

  it('clears every spark and rewinds the ring', () => {
    const pool = new SparkPool(4);
    for (let i = 0; i < 3; i++) pool.emit(0, 0, 0, 0, 0, 0, 1);
    pool.step(FRAME, 0, 0, 0, RAMP);
    pool.clear();
    expect(pool.alive).toBe(0);
    expect(pool.nextSlot).toBe(0);
    expect(pool.colors.every((c) => c === 0)).toBe(true);
  });
});

describe('emission', () => {
  it('fizzes gently at rest and showers on a fast stroke, up to a ceiling', () => {
    expect(emissionRate(0)).toBe(FIZZ_RATE);
    expect(emissionRate(0.2)).toBeGreaterThan(emissionRate(0.05));
    expect(emissionRate(0.2)).toBeGreaterThan(FIZZ_RATE * 2);
    expect(emissionRate(50)).toBe(MAX_RATE);
    expect(emissionRate(-1)).toBe(FIZZ_RATE);
  });

  it('never outruns the pool: the fastest rate times the longest life fits the capacity', () => {
    expect(MAX_RATE * SPARK_LIFE_MAX).toBeLessThanOrEqual(SPARK_CAPACITY);
    expect(SPARK_LIFE_MIN).toBeGreaterThanOrEqual(0.3);
    expect(SPARK_LIFE_MAX).toBeLessThanOrEqual(0.6);
  });

  it('carries fractional sparks between frames, so a still beam emits its rate over a second', () => {
    const emitter = new SparkEmitter();
    let total = 0;
    for (let i = 0; i < 72; i++) total += emitter.take(FRAME, 0);
    expect(Math.abs(total - FIZZ_RATE)).toBeLessThanOrEqual(1);
  });

  it('clamps dt so a frame hitch does not dump a burst', () => {
    const emitter = new SparkEmitter();
    expect(emitter.take(2, 10)).toBeLessThanOrEqual(Math.ceil(MAX_RATE * MAX_STEP));
  });
});

describe('trail heat', () => {
  const ramp: HeatRamp = { cool: [0.5, 0.5, 0.4], mid: [0.9, 0.3, 0.05], hot: [1, 0.9, 0.2] };

  it('maps heat 1 to the hot colour, 0.5 to amber and 0 to the settled stroke', () => {
    const out = new Float32Array(9);
    heatColor(1, ramp, out, 0);
    heatColor(0.5, ramp, out, 3);
    heatColor(0, ramp, out, 6);
    expect([...out.slice(0, 3)].map((v) => +v.toFixed(3))).toEqual([1, 0.9, 0.2]);
    expect([...out.slice(3, 6)].map((v) => +v.toFixed(3))).toEqual([0.9, 0.3, 0.05]);
    expect([...out.slice(6, 9)].map((v) => +v.toFixed(3))).toEqual([0.5, 0.5, 0.4]);
  });

  it('cools older segments first and only revisits the warm window', () => {
    const heat = new TrailHeat(8);
    heat.push();
    heat.advance(0.3);
    heat.push();
    expect(heat.heat(1)).toBe(1);
    expect(heat.heat(0)).toBeLessThan(1);
    heat.advance(TRAIL_COOL_SECONDS - 0.29);
    expect(heat.heat(0)).toBe(0);
    expect(heat.heat(1)).toBeGreaterThan(0);
    // The segment that settled this step is still in the window once, for its final colour.
    expect(heat.advance(0)).toBe(1);
    expect(heat.firstWarm).toBe(1);
    expect(heat.push()).toBe(2);
    heat.clear();
    expect(heat.segments).toBe(0);
    expect(heat.firstWarm).toBe(0);
  });

  it('refuses segments past its capacity', () => {
    const heat = new TrailHeat(2);
    expect([heat.push(), heat.push(), heat.push()]).toEqual([0, 1, -1]);
  });
});

function facingPlate(): PlatePose {
  return makePlatePose({ x: 0, y: 1.2, z: -0.4 }, { x: 0, y: 0, z: 1 }, 0.22);
}

function onPlate(pose: PlatePose, x: number, y: number): Vec3 {
  return {
    x: pose.center.x + pose.right.x * x + pose.up.x * y,
    y: pose.center.y + pose.right.y * x + pose.up.y * y,
    z: pose.center.z + pose.right.z * x + pose.up.z * y,
  };
}

function sparksOf(plate: SigilPlate): SigilSparks {
  return plate.getObjectByName('sigil-sparks') as SigilSparks;
}

describe('SigilPlate sparks', () => {
  it('fizzes while the beam rests on the plate, with the contact dot lit', () => {
    const pose = facingPlate();
    const plate = new SigilPlate();
    plate.show('ward', pose);
    plate.beginStroke();
    for (let i = 0; i < 36; i++) {
      plate.addTip(onPlate(pose, 0.05, 0.02));
      plate.update(FRAME);
    }
    const sparks = sparksOf(plate);
    expect(sparks.touching).toBe(true);
    expect(sparks.pool.alive).toBeGreaterThan(3);
    expect(sparks.pool.alive).toBeLessThan(20);
    const points = plate.getObjectByName('sigil-sparks-points') as THREE.Points;
    expect(points.visible).toBe(true);
    expect(sparks.dotBrightness).toBe(1);
    const position = points.geometry.getAttribute('position');
    expect(position.getX(DOT_SLOT)).toBeCloseTo(0.05);
    expect(position.getY(DOT_SLOT)).toBeCloseTo(0.02);
    const scale = points.geometry.getAttribute('pointScale');
    expect(scale.getX(DOT_SLOT)).toBeGreaterThan(2);
    expect(points.geometry.getAttribute('color').getX(DOT_SLOT)).toBeGreaterThan(0.5);
    plate.dispose();
  });

  it('showers more on a fast stroke than at rest', () => {
    const count = (moving: boolean): number => {
      const pose = facingPlate();
      const plate = new SigilPlate();
      plate.show('ward', pose);
      plate.beginStroke();
      let emitted = 0;
      for (let i = 0; i < 24; i++) {
        const x = moving ? -0.18 + i * 0.015 : 0;
        plate.addTip(onPlate(pose, x, 0));
        const before = sparksOf(plate).pool.nextSlot;
        plate.update(FRAME);
        emitted += (sparksOf(plate).pool.nextSlot - before + SPARK_CAPACITY) % SPARK_CAPACITY;
      }
      plate.dispose();
      return emitted;
    };
    expect(count(true)).toBeGreaterThan(count(false) * 3);
  });

  it('stops emitting when the stroke ends or the beam leaves the plate, and clears on hide', () => {
    const pose = facingPlate();
    const plate = new SigilPlate();
    plate.show('ward', pose);
    plate.update(FRAME);
    expect(sparksOf(plate).pool.alive).toBe(0);
    plate.beginStroke();
    for (let i = 0; i < 20; i++) {
      plate.addTip(onPlate(pose, 0, 0));
      plate.update(FRAME);
    }
    plate.addTip(onPlate(pose, 1, 1));
    expect(sparksOf(plate).touching).toBe(false);
    plate.endStroke();
    const slot = sparksOf(plate).pool.nextSlot;
    for (let i = 0; i < 72; i++) plate.update(FRAME);
    expect(sparksOf(plate).pool.nextSlot).toBe(slot);
    expect(sparksOf(plate).pool.alive).toBe(0);
    plate.beginStroke();
    for (let i = 0; i < 10; i++) {
      plate.addTip(onPlate(pose, 0, 0));
      plate.update(FRAME);
    }
    plate.hide();
    expect(sparksOf(plate).pool.alive).toBe(0);
    plate.dispose();
  });

  it('pulls sparks toward world down whatever the plate faces', () => {
    const pose = makePlatePose({ x: 0, y: 1.2, z: -0.4 }, { x: 0, y: 0.7, z: 0.7 }, 0.22);
    const plate = new SigilPlate();
    plate.show('ward', pose);
    for (let i = 0; i < 30; i++) plate.update(FRAME);
    const pool = sparksOf(plate).pool;
    plate.beginStroke();
    while (!pool.isAlive(0)) {
      plate.addTip(onPlate(pose, 0, 0));
      plate.update(FRAME);
    }
    plate.endStroke();
    plate.updateMatrixWorld(true);
    const points = plate.getObjectByName('sigil-sparks-points') as THREE.Points;
    const start = points.localToWorld(new THREE.Vector3().fromArray(pool.positions, 0));
    // Climb first (sparks spit out and slightly up), then fall below where they started.
    for (let i = 0; i < 24; i++) plate.update(FRAME);
    expect(pool.isAlive(0)).toBe(true);
    const end = points.localToWorld(new THREE.Vector3().fromArray(pool.positions, 0));
    expect(end.y).toBeLessThan(start.y);
    plate.dispose();
  });

  it('draws the trail head hot and lets it cool to the settled stroke colour', () => {
    const pose = facingPlate();
    const plate = new SigilPlate();
    plate.show('ward', pose);
    plate.beginStroke();
    for (let i = 0; i < 40; i++) {
      plate.addTip(onPlate(pose, -0.18 + i * 0.008, 0));
      plate.update(FRAME);
    }
    const trail = plate.getObjectByName('sigil-plate-trail') as THREE.Mesh;
    const color = trail.geometry.getAttribute('color') as THREE.BufferAttribute;
    const segments = trail.geometry.drawRange.count / 6;
    const blue = (segment: number): number => color.getZ(segment * 6);
    const red = (segment: number): number => color.getX(segment * 6);
    // The settled stroke is a pale cream; the hot head is saturated, so it carries less blue.
    expect(blue(segments - 1)).toBeLessThan(blue(0));
    expect(red(segments - 1)).toBeGreaterThan(red(0));
    expect((trail.material as THREE.MeshBasicMaterial).toneMapped).toBe(false);
    plate.endStroke();
    for (let i = 0; i < 72; i++) plate.update(FRAME);
    expect(blue(segments - 1)).toBeCloseTo(blue(0), 5);
    expect(red(segments - 1)).toBeCloseTo(red(0), 5);
    plate.dispose();
  });

  it('draws the sparks and the contact dot in one Points call', () => {
    const plate = new SigilPlate();
    const sparks = sparksOf(plate);
    const drawables: THREE.Object3D[] = [];
    sparks.traverse((o) => {
      if ((o as THREE.Mesh).isMesh || (o as THREE.Points).isPoints || (o as THREE.Line).isLine)
        drawables.push(o);
    });
    expect(drawables.map((o) => o.name)).toEqual(['sigil-sparks-points']);
    expect(DOT_SLOT).toBe(SPARK_CAPACITY);
    // The per-point scale is spliced into three's own points shader: both lines must still exist.
    const source = THREE.ShaderLib.points.vertexShader;
    expect(source).toContain(POINTS_SIZE_DECL);
    expect(source).toContain(POINTS_SIZE_ASSIGN);
    const material = (plate.getObjectByName('sigil-sparks-points') as THREE.Points)
      .material as THREE.PointsMaterial;
    const shader = { vertexShader: source, fragmentShader: '', uniforms: {} };
    material.onBeforeCompile(
      shader as unknown as THREE.WebGLProgramParametersWithUniforms,
      {} as THREE.WebGLRenderer,
    );
    expect(shader.vertexShader).toContain('attribute float pointScale;');
    expect(shader.vertexShader).toContain('gl_PointSize = size * pointScale;');
    expect(material.customProgramCacheKey()).toBe('sigil-sparks-scaled');
    plate.dispose();
  });

  it('keeps one fixed point buffer and disposes everything it made', () => {
    const plate = new SigilPlate();
    const points = plate.getObjectByName('sigil-sparks-points') as THREE.Points;
    expect(points.geometry.drawRange.count).toBe(SPARK_CAPACITY + 1);
    expect(points.geometry.getAttribute('position').count).toBe(SPARK_CAPACITY + 1);
    expect(points.geometry.getAttribute('pointScale').count).toBe(SPARK_CAPACITY + 1);
    const pointsMaterial = points.material as THREE.PointsMaterial;
    expect(pointsMaterial.blending).toBe(THREE.AdditiveBlending);
    expect(pointsMaterial.depthWrite).toBe(false);
    const disposed = new Set<string>();
    const watch = (name: string, target: THREE.EventDispatcher<{ dispose: object }>): void => {
      target.addEventListener('dispose', () => disposed.add(name));
    };
    watch('points-geometry', points.geometry);
    watch('points-material', pointsMaterial);
    watch('texture', pointsMaterial.map as THREE.Texture);
    plate.dispose();
    expect([...disposed].sort()).toEqual(['points-geometry', 'points-material', 'texture']);
  });

  it('replays identically: the sparks draw from their own keyed stream', () => {
    const run = (): number[] => {
      const pose = facingPlate();
      const plate = new SigilPlate();
      plate.show('ward', pose);
      plate.beginStroke();
      for (let i = 0; i < 20; i++) {
        plate.addTip(onPlate(pose, -0.1 + i * 0.01, 0));
        plate.update(FRAME);
      }
      const out = [...sparksOf(plate).pool.positions];
      plate.dispose();
      return out;
    };
    expect(run()).toEqual(run());
  });
});
