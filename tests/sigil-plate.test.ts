// @vitest-environment node
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  FLOOR,
  MAX,
  MIN_SCORE,
  PERFECT_SCORE,
  type Point,
  SIGIL_IDS,
  SIGIL_TEMPLATES,
  type SigilId,
  scoreAgainst,
  scoreToMultiplier,
} from '../src/sigil/index.ts';
import {
  CLEAN_SCORE,
  MAX_PLATE_DEPTH,
  MAX_TRACE_POINTS,
  MIN_CAST_POINTS,
  MIN_POINT_SPACING,
  makePlatePose,
  mouseToPlate,
  PLATE_MARGIN,
  type PlatePose,
  platePoseAboveTable,
  projectTip,
  projectToPlate,
  qualityWord,
  rayToPlate,
  SigilPlate,
  scoreTrace,
  TraceBuilder,
  type Vec3,
} from '../src/sigil-plate/index.ts';

const DEG = Math.PI / 180;
const HALF = 0.22;
/** Template unit box to plate metres, as the plate draws its guide glyph. */
const GLYPH = HALF * 2 * 0.8;

/** Plate at `center` facing the heading `yawDeg` (rotation about +Y of +Z), leaning back by `tiltDeg`. */
function posedPlate(
  yawDeg: number,
  tiltDeg = 0,
  center: Vec3 = { x: 0.3, y: 1.2, z: -0.4 },
): PlatePose {
  const yaw = yawDeg * DEG;
  const tilt = tiltDeg * DEG;
  const normal: Vec3 = {
    x: Math.sin(yaw) * Math.cos(tilt),
    y: Math.sin(tilt),
    z: Math.cos(yaw) * Math.cos(tilt),
  };
  return makePlatePose(center, normal, HALF);
}

function worldPoint(pose: PlatePose, x: number, y: number, depth = 0): Vec3 {
  return {
    x: pose.center.x + pose.right.x * x + pose.up.x * y + pose.normal.x * depth,
    y: pose.center.y + pose.right.y * x + pose.up.y * y + pose.normal.y * depth,
    z: pose.center.z + pose.right.z * x + pose.up.z * y + pose.normal.z * depth,
  };
}

/** A template stroke's points in plate metres. */
function templateStrokes(id: SigilId): Point[][] {
  return SIGIL_TEMPLATES[id].strokes.map((stroke) =>
    stroke.map((p) => ({ x: (p.x - 0.5) * GLYPH, y: (p.y - 0.5) * GLYPH })),
  );
}

/** Draws a template onto a posed plate through the controller tip path, one stroke per trigger pull. */
function drawOnPlate(plate: SigilPlate, pose: PlatePose, id: SigilId, depthJitter = 0): void {
  for (const stroke of templateStrokes(id)) {
    plate.beginStroke();
    stroke.forEach((p, i) => {
      plate.addTip(worldPoint(pose, p.x, p.y, i % 2 === 0 ? depthJitter : -depthJitter));
    });
    plate.endStroke();
  }
}

const FACING_Z = posedPlate(0, 0, { x: 0, y: 0, z: 0 });

describe('projection', () => {
  it('maps points on the plane to plate coordinates with +x right and +y up', () => {
    expect(projectTip(FACING_Z, { x: 0.1, y: 0.05, z: 0 })).toEqual({ x: 0.1, y: 0.05 });
    expect(projectTip(FACING_Z, { x: -0.2, y: -0.15, z: 0.03 })).toEqual({ x: -0.2, y: -0.15 });
    const hit = projectToPlate(FACING_Z, { x: 0, y: 0, z: 0.05 });
    expect(hit.depth).toBeCloseTo(0.05);
  });

  it('keeps the right-handed frame: a plate facing +X has its right hand along -Z', () => {
    const pose = posedPlate(90, 0, { x: 0, y: 0, z: 0 });
    expect(pose.right.z).toBeCloseTo(-1);
    expect(pose.up.y).toBeCloseTo(1);
    expect(projectTip(pose, { x: 0, y: 0.1, z: -0.12 })).toEqual({
      x: expect.closeTo(0.12, 9),
      y: expect.closeTo(0.1, 9),
    });
  });

  it('ignores points farther than the depth tolerance on either side', () => {
    expect(projectTip(FACING_Z, { x: 0, y: 0, z: MAX_PLATE_DEPTH - 0.001 })).not.toBeNull();
    expect(projectTip(FACING_Z, { x: 0, y: 0, z: MAX_PLATE_DEPTH + 0.001 })).toBeNull();
    expect(projectTip(FACING_Z, { x: 0, y: 0, z: -MAX_PLATE_DEPTH - 0.001 })).toBeNull();
    expect(projectTip(FACING_Z, { x: 0, y: 0, z: 0.05 }, { maxDepth: 0.04 })).toBeNull();
  });

  it('ignores points outside the plate bounds plus margin', () => {
    expect(projectTip(FACING_Z, { x: HALF + PLATE_MARGIN - 0.001, y: 0, z: 0 })).not.toBeNull();
    expect(projectTip(FACING_Z, { x: HALF + PLATE_MARGIN + 0.001, y: 0, z: 0 })).toBeNull();
    expect(projectTip(FACING_Z, { x: 0, y: -HALF - PLATE_MARGIN - 0.001, z: 0 })).toBeNull();
    expect(projectTip(FACING_Z, { x: HALF + 0.03, y: 0, z: 0 }, { margin: 0 })).toBeNull();
    expect(projectTip(FACING_Z, { x: Number.NaN, y: 0, z: 0 })).toBeNull();
  });

  it.each([
    [0, 0],
    [90, 0],
    [-135, 0],
    [30, 35],
    [-135, -20],
  ])('round-trips plate points on a plate with yaw %i and tilt %i', (yaw, tilt) => {
    const pose = posedPlate(yaw, tilt);
    for (const [x, y] of [
      [0, 0],
      [0.15, -0.1],
      [-0.2, 0.2],
    ] as const) {
      const hit = projectTip(pose, worldPoint(pose, x, y, 0.02));
      expect(hit?.x).toBeCloseTo(x, 9);
      expect(hit?.y).toBeCloseTo(y, 9);
    }
    expect(projectTip(pose, worldPoint(pose, 0, 0, MAX_PLATE_DEPTH + 0.01))).toBeNull();
    expect(projectTip(pose, worldPoint(pose, HALF + 0.1, 0, 0))).toBeNull();
  });

  it('builds an orthonormal pose even for a plate facing straight up', () => {
    const pose = makePlatePose({ x: 0, y: 1, z: 0 }, { x: 0, y: 1, z: 0 }, HALF);
    expect(Math.hypot(pose.right.x, pose.right.y, pose.right.z)).toBeCloseTo(1);
    expect(pose.up.y).toBeCloseTo(0);
    expect(projectTip(pose, { x: 0.1, y: 1, z: -0.1 })).not.toBeNull();
  });

  it('places the table plate on the player side of the enemies, facing the player and leaning back', () => {
    const table = { x: 2, z: 3, yaw: 90, height: 0.85 };
    const pose = platePoseAboveTable(table);
    // yaw 90 faces +x: forward = [1, 0]; the plate faces back toward -x and upward.
    expect(pose.normal.x).toBeLessThan(0);
    expect(pose.normal.y).toBeGreaterThan(0);
    expect(pose.center.x).toBeGreaterThan(table.x);
    expect(pose.center.y).toBeCloseTo(table.height + 0.5);
    expect(pose.up.y).toBeGreaterThan(0.9);
  });
});

describe('rayToPlate and mouseToPlate', () => {
  it('intersects a ray with the plate and rejects misses', () => {
    const hit = rayToPlate(FACING_Z, { x: 0.1, y: 0.1, z: 2 }, { x: 0, y: 0, z: -1 });
    expect(hit).toEqual({ x: expect.closeTo(0.1, 9), y: expect.closeTo(0.1, 9) });
    expect(rayToPlate(FACING_Z, { x: 0.1, y: 0.1, z: 2 }, { x: 0, y: 0, z: 1 })).toBeNull();
    expect(rayToPlate(FACING_Z, { x: 0.1, y: 0.1, z: 2 }, { x: 1, y: 0, z: 0 })).toBeNull();
    expect(rayToPlate(FACING_Z, { x: 1, y: 0, z: 2 }, { x: 0, y: 0, z: -1 })).toBeNull();
  });

  it('round-trips plate points through a PerspectiveCamera', () => {
    const pose = posedPlate(-20, 15, { x: 0, y: 1.3, z: -0.5 });
    const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 50);
    camera.position.set(0.1, 1.5, 1.1);
    camera.lookAt(pose.center.x, pose.center.y, pose.center.z);
    camera.updateMatrixWorld();
    camera.updateProjectionMatrix();
    for (const [x, y] of [
      [0, 0],
      [0.12, 0.1],
      [-0.2, -0.18],
    ] as const) {
      const w = worldPoint(pose, x, y);
      const ndc = new THREE.Vector3(w.x, w.y, w.z).project(camera);
      const hit = mouseToPlate({ x: ndc.x, y: ndc.y }, camera, pose);
      expect(hit?.x).toBeCloseTo(x, 5);
      expect(hit?.y).toBeCloseTo(y, 5);
    }
    expect(mouseToPlate({ x: 0.99, y: 0.99 }, camera, pose)).toBeNull();
  });

  it('round-trips through an OrthographicCamera', () => {
    const pose = posedPlate(0, 0, { x: 0, y: 1, z: 0 });
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
    camera.position.set(0, 1, 3);
    camera.lookAt(0, 1, 0);
    camera.updateMatrixWorld();
    const w = worldPoint(pose, 0.1, -0.05);
    const ndc = new THREE.Vector3(w.x, w.y, w.z).project(camera);
    const hit = mouseToPlate({ x: ndc.x, y: ndc.y }, camera, pose);
    expect(hit?.x).toBeCloseTo(0.1, 5);
    expect(hit?.y).toBeCloseTo(-0.05, 5);
  });
});

describe('TraceBuilder', () => {
  it('drops points closer than the minimum spacing', () => {
    const t = new TraceBuilder();
    t.beginStroke();
    expect(t.add({ x: 0, y: 0 })).toBe(true);
    expect(t.add({ x: MIN_POINT_SPACING / 2, y: 0 })).toBe(false);
    expect(t.add({ x: MIN_POINT_SPACING, y: 0 })).toBe(true);
    expect(t.add({ x: MIN_POINT_SPACING * 1.5, y: 0 })).toBe(false);
    t.endStroke();
    expect(t.strokes).toHaveLength(1);
    expect(t.strokes[0]).toHaveLength(2);
  });

  it('keeps one stroke per trigger pull and ignores points while the trigger is up', () => {
    const t = new TraceBuilder();
    expect(t.add({ x: 0, y: 0 })).toBe(false);
    for (let s = 0; s < 3; s++) {
      t.beginStroke();
      for (let i = 0; i < 5; i++) t.add({ x: i * 0.05, y: s * 0.1 });
      t.endStroke();
      expect(t.add({ x: 9, y: 9 })).toBe(false);
    }
    expect(t.strokes).toHaveLength(3);
    expect(t.pointCount).toBe(15);
  });

  it('splits a stroke when the tip leaves the plate, instead of bridging the gap', () => {
    const t = new TraceBuilder();
    t.beginStroke();
    t.add({ x: 0, y: 0 });
    t.add({ x: 0.05, y: 0 });
    t.add(null);
    t.add(null);
    t.add({ x: 0.2, y: 0.2 });
    t.add({ x: 0.25, y: 0.2 });
    t.endStroke();
    expect(t.strokes).toHaveLength(2);
    expect(t.strokes[1]?.[0]).toEqual({ x: 0.2, y: 0.2 });
  });

  it('discards a lone point and caps the stored points', () => {
    const t = new TraceBuilder();
    t.beginStroke();
    t.add({ x: 0, y: 0 });
    t.endStroke();
    expect(t.strokes).toHaveLength(0);
    expect(t.pointCount).toBe(0);

    t.beginStroke();
    for (let i = 0; i < MAX_TRACE_POINTS + 50; i++) t.add({ x: i, y: 0 });
    expect(t.pointCount).toBe(MAX_TRACE_POINTS);
    t.clear();
    expect(t.pointCount).toBe(0);
    expect(t.isDrawing).toBe(false);
  });
});

describe('scoring', () => {
  it('maps score bands to quality words', () => {
    expect(qualityWord(0)).toBe('Fizzle');
    expect(qualityWord(MIN_SCORE - 0.001)).toBe('Fizzle');
    expect(qualityWord(MIN_SCORE)).toBe('Rough');
    expect(qualityWord(CLEAN_SCORE - 0.001)).toBe('Rough');
    expect(qualityWord(CLEAN_SCORE)).toBe('Clean');
    expect(qualityWord(PERFECT_SCORE - 0.001)).toBe('Clean');
    expect(qualityWord(PERFECT_SCORE)).toBe('Masterful');
    expect(qualityWord(1)).toBe('Masterful');
  });

  it('delegates to src/sigil scoring', () => {
    for (const id of SIGIL_IDS) {
      const strokes = templateStrokes(id);
      const result = scoreTrace(strokes, id);
      expect(result.score).toBe(scoreAgainst(strokes, id));
      expect(result.multiplier).toBe(scoreToMultiplier(result.score));
      expect(result.recognizedAs).toBe(id);
      expect(result.multiplier).toBeGreaterThanOrEqual(FLOOR);
      expect(result.multiplier).toBeLessThanOrEqual(MAX);
    }
  });

  it('fizzles an empty trace and a trace of the wrong sigil', () => {
    const empty = scoreTrace([], 'gear');
    expect(empty).toMatchObject({
      score: 0,
      multiplier: FLOOR,
      quality: 'Fizzle',
      castable: false,
    });
    const wrong = scoreTrace(templateStrokes('bolt'), 'gear');
    expect(wrong.score).toBeLessThan(MIN_SCORE);
    expect(wrong.quality).toBe('Fizzle');
    expect(wrong.recognizedAs).toBe('bolt');
    expect(wrong.castable).toBe(true);
  });
});

describe('SigilPlate', () => {
  it.each([
    [0, 0],
    [90, 0],
    [-135, 0],
    [-135, 30],
  ])('scores a template drawn in the air on a plate with yaw %i and tilt %i', (yaw, tilt) => {
    const pose = posedPlate(yaw, tilt);
    for (const id of SIGIL_IDS) {
      const plate = new SigilPlate();
      plate.show(id, pose);
      drawOnPlate(plate, pose, id, 0.015);
      const result = plate.finish();
      expect(result, id).not.toBeNull();
      expect(result?.score, id).toBeGreaterThanOrEqual(0.85);
      expect(result?.recognizedAs).toBe(id);
      expect(plate.phase).toBe('done');
      plate.dispose();
    }
  });

  it('feeds the mouse through the same projection and scoring path as the controller tip', () => {
    const pose = posedPlate(0, 20, { x: 0, y: 1.3, z: -0.5 });
    const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 50);
    camera.position.set(0, 1.4, 1);
    camera.lookAt(pose.center.x, pose.center.y, pose.center.z);
    camera.updateMatrixWorld();
    camera.updateProjectionMatrix();

    for (const id of ['flame', 'gear'] as const) {
      const tip = new SigilPlate();
      tip.show(id, pose);
      drawOnPlate(tip, pose, id);
      const viaTip = tip.finish();

      const mouse = new SigilPlate();
      mouse.show(id, pose);
      for (const stroke of templateStrokes(id)) {
        mouse.beginStroke();
        for (const p of stroke) {
          const w = worldPoint(pose, p.x, p.y);
          const ndc = new THREE.Vector3(w.x, w.y, w.z).project(camera);
          mouse.addMouse({ x: ndc.x, y: ndc.y }, camera);
        }
        mouse.endStroke();
      }
      const viaMouse = mouse.finish();

      expect(viaTip).not.toBeNull();
      expect(viaMouse?.score).toBeCloseTo(viaTip?.score ?? -1, 4);
      expect(viaMouse?.multiplier).toBeCloseTo(viaTip?.multiplier ?? -1, 4);
      expect(viaMouse?.quality).toBe(viaTip?.quality);
    }
  });

  it('shows the multiplier and quality word, then fades them', () => {
    const pose = posedPlate(0);
    const plate = new SigilPlate();
    plate.show('bolt', pose);
    expect(plate.visible).toBe(true);
    expect(plate.phase).toBe('ready');
    drawOnPlate(plate, pose, 'bolt');
    const result = plate.finish();
    expect(plate.labelText).toBe(`×${result?.multiplier.toFixed(2)} ${result?.quality}`);
    plate.update(0.5);
    expect(plate.labelText).not.toBe('');
    plate.update(5);
    expect(plate.labelText).toBe('');
    plate.hide();
    expect(plate.visible).toBe(false);
    expect(plate.phase).toBe('hidden');
  });

  it('refuses to cast a stray tap and stays ready for another attempt', () => {
    const pose = posedPlate(0);
    const plate = new SigilPlate();
    plate.show('ward', pose);
    plate.beginStroke();
    for (let i = 0; i < MIN_CAST_POINTS - 3; i++) plate.addTip(worldPoint(pose, i * 0.02, 0));
    expect(plate.finish()).toBeNull();
    expect(plate.phase).toBe('ready');
    expect(plate.pointCount).toBe(0);
    expect(plate.labelText).toBe('Too short');
  });

  it('splits strokes when the tip leaves the plate plane mid-stroke', () => {
    const pose = posedPlate(0);
    const plate = new SigilPlate();
    plate.show('bolt', pose);
    plate.beginStroke();
    plate.addTip(worldPoint(pose, -0.1, 0));
    plate.addTip(worldPoint(pose, -0.05, 0));
    plate.addTip(worldPoint(pose, 0, 0, 0.3));
    plate.addTip(worldPoint(pose, 0.05, 0));
    plate.addTip(worldPoint(pose, 0.1, 0));
    plate.endStroke();
    expect(plate.strokes).toHaveLength(2);
  });

  it('ignores input before the trigger is pulled and after the cast', () => {
    const pose = posedPlate(0);
    const plate = new SigilPlate();
    expect(plate.addTip(worldPoint(pose, 0, 0))).toBe(false);
    plate.show('gear', pose);
    expect(plate.addTip(worldPoint(pose, 0, 0))).toBe(false);
    drawOnPlate(plate, pose, 'gear');
    plate.finish();
    plate.beginStroke();
    expect(plate.addTip(worldPoint(pose, 0, 0))).toBe(false);
    expect(plate.finish()).toBeNull();
  });

  it('caps the trail buffer and updates it in place', () => {
    const pose = posedPlate(0);
    const plate = new SigilPlate();
    plate.show('spiral', pose);
    const trail = plate.getObjectByName('sigil-plate-trail') as THREE.LineSegments;
    const attr = trail.geometry.getAttribute('position') as THREE.BufferAttribute;
    const array = attr.array;
    const length = array.length;

    plate.beginStroke();
    for (let i = 0; i < MAX_TRACE_POINTS * 3; i++) {
      plate.addTip(worldPoint(pose, -0.2 + (i % 40) * 0.01, ((i * 7) % 40) * 0.01 - 0.2));
      plate.update(1 / 72);
    }
    expect(plate.pointCount).toBe(MAX_TRACE_POINTS);
    expect(trail.geometry.getAttribute('position')).toBe(attr);
    expect(attr.array).toBe(array);
    expect(attr.array.length).toBe(length);
    expect(trail.geometry.drawRange.count).toBeLessThanOrEqual(MAX_TRACE_POINTS * 2);
    expect(trail.geometry.drawRange.count).toBeGreaterThan(0);

    plate.show('flame', pose);
    expect(trail.geometry.drawRange.count).toBe(0);
    expect(trail.geometry.getAttribute('position')).toBe(attr);
  });

  it('draws the guide glyph from the sigil template and pulses the glow', () => {
    const pose = posedPlate(0);
    const plate = new SigilPlate();
    plate.show('ward', pose);
    const guide = plate.getObjectByName('sigil-plate-guide') as THREE.LineSegments;
    const template = SIGIL_TEMPLATES.ward.strokes.reduce((n, s) => n + s.length - 1, 0);
    expect(guide.geometry.drawRange.count).toBe(template * 2);
    const face = plate.getObjectByName('sigil-plate-face') as THREE.Mesh;
    const material = face.material as THREE.MeshBasicMaterial;
    const opacities = new Set<number>();
    for (let i = 0; i < 10; i++) {
      plate.update(0.25);
      opacities.add(Number(material.opacity.toFixed(3)));
    }
    expect(opacities.size).toBeGreaterThan(1);
    expect(plate.scale.x).toBeCloseTo(1);
  });
});
