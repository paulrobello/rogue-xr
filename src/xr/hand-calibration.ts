import type { StandardHand } from '@par/xr-workspace';
import * as THREE from 'three';

type Digit = 'index-finger' | 'thumb';
type Side = 'left' | 'right';
type Tip = { point: THREE.Vector3; radius: number | null };
type Source = { input: XRInputSource | null; visual: StandardHand };
type HandReading = {
  index: Tip;
  thumb: Tip | null;
  indexBone: THREE.Vector3 | null;
  thumbBone: THREE.Vector3 | null;
  indexSkin: THREE.Vector3[];
  thumbSkin: THREE.Vector3[];
};

const SAMPLE_INTERVAL_MS = 125;
const SAMPLE_LIMIT = 960;
const millimetres = (metres: number): number => Math.round(metres * 10_000) / 10;

function readTip(
  frame: XRFrame,
  reference: XRReferenceSpace,
  rig: THREE.Group,
  hand: XRHand,
  digit: Digit,
): Tip | null {
  const joint = hand.get(`${digit}-tip`);
  const pose = joint ? frame.getJointPose?.(joint, reference) : null;
  if (!pose) return null;
  const { x, y, z } = pose.transform.position;
  return { point: rig.localToWorld(new THREE.Vector3(x, y, z)), radius: pose.radius ?? null };
}

function distalVertices(mesh: THREE.SkinnedMesh, digit: Digit): number[] {
  const bones = new Set(
    mesh.skeleton.bones.flatMap((bone, index) =>
      bone.name === `${digit}-tip` || bone.name === `${digit}-phalanx-distal` ? [index] : [],
    ),
  );
  const indices = mesh.geometry.getAttribute('skinIndex');
  const weights = mesh.geometry.getAttribute('skinWeight');
  const vertices: number[] = [];
  if (!indices || !weights || bones.size === 0) return vertices;
  for (let vertex = 0; vertex < indices.count; vertex++) {
    let weight = 0;
    for (let component = 0; component < 4; component++)
      if (bones.has(indices.getComponent(vertex, component)))
        weight += weights.getComponent(vertex, component);
    if (weight >= 0.5) vertices.push(vertex);
  }
  return vertices;
}

function patchGap(left: THREE.Vector3[], right: THREE.Vector3[]): number | null {
  let nearest = Infinity;
  for (const a of left) for (const b of right) nearest = Math.min(nearest, a.distanceToSquared(b));
  return Number.isFinite(nearest) ? millimetres(Math.sqrt(nearest)) : null;
}

function compareTips(
  a: Tip,
  b: Tip,
  boneA: THREE.Vector3 | null,
  boneB: THREE.Vector3 | null,
  skinA: THREE.Vector3[],
  skinB: THREE.Vector3[],
) {
  const centreGap = a.point.distanceTo(b.point);
  return {
    jointCentreMm: millimetres(centreGap),
    trackedSurfaceEstimateMm:
      a.radius !== null && b.radius !== null ? millimetres(centreGap - a.radius - b.radius) : null,
    renderedBoneMm: boneA && boneB ? millimetres(boneA.distanceTo(boneB)) : null,
    sampledSkinMm: patchGap(skinA, skinB),
  };
}

export function createHandCalibration(rig: THREE.Group) {
  const cache = new WeakMap<THREE.SkinnedMesh, Record<Digit, number[]>>();
  let nextSample = 0;
  let observedFrames = 0;
  const samples: {
    wallMs: number;
    left: ReturnType<typeof describeHand>;
    right: ReturnType<typeof describeHand>;
    crossIndex: ReturnType<typeof compareTips> | null;
  }[] = [];

  const readHand = (
    frame: XRFrame,
    reference: XRReferenceSpace,
    sources: readonly Source[],
    side: Side,
  ): HandReading | null => {
    const source = sources.find((candidate) => candidate.input?.handedness === side);
    const hand = source?.input?.hand;
    if (!hand) return null;
    const index = readTip(frame, reference, rig, hand, 'index-finger');
    const thumb = readTip(frame, reference, rig, hand, 'thumb');
    if (!index) return null;
    const skin: Record<Digit, THREE.Vector3[]> = { 'index-finger': [], thumb: [] };
    const visible = source.visual.root.visible;
    let indexBone: THREE.Vector3 | null = null;
    let thumbBone: THREE.Vector3 | null = null;
    source.visual.root.updateWorldMatrix(true, true);
    source.visual.root.traverseVisible((node) => {
      if (!(node instanceof THREE.SkinnedMesh)) return;
      const { bones } = node.skeleton;
      indexBone =
        bones
          .find((bone) => bone.name === 'index-finger-tip')
          ?.getWorldPosition(new THREE.Vector3()) ?? indexBone;
      thumbBone =
        bones.find((bone) => bone.name === 'thumb-tip')?.getWorldPosition(new THREE.Vector3()) ??
        thumbBone;
      let vertices = cache.get(node);
      if (!vertices) {
        vertices = {
          'index-finger': distalVertices(node, 'index-finger'),
          thumb: distalVertices(node, 'thumb'),
        };
        cache.set(node, vertices);
      }
      for (const digit of ['index-finger', 'thumb'] as const)
        for (const vertex of vertices[digit])
          skin[digit].push(
            node.getVertexPosition(vertex, new THREE.Vector3()).applyMatrix4(node.matrixWorld),
          );
    });
    return {
      index,
      thumb,
      indexBone: visible ? (indexBone ?? source.visual.indexTip) : null,
      thumbBone: visible && thumb ? (thumbBone ?? source.visual.thumbTip) : null,
      indexSkin: skin['index-finger'],
      thumbSkin: skin.thumb,
    };
  };

  const describeHand = (hand: HandReading | null) =>
    hand && {
      trackedIndexRadiusMm: hand.index.radius !== null ? millimetres(hand.index.radius) : null,
      indexBoneErrorMm: hand.indexBone
        ? millimetres(hand.index.point.distanceTo(hand.indexBone))
        : null,
      indexBoneDeltaMm:
        hand.indexBone?.clone().sub(hand.index.point).toArray().map(millimetres) ?? null,
      indexSkinVertices: hand.indexSkin.length,
      pinch: hand.thumb
        ? compareTips(
            hand.index,
            hand.thumb,
            hand.indexBone,
            hand.thumbBone,
            hand.indexSkin,
            hand.thumbSkin,
          )
        : null,
    };

  return {
    sample(frame: XRFrame, reference: XRReferenceSpace, sources: readonly Source[]): void {
      const now = performance.now();
      if (now < nextSample) return;
      nextSample = now + SAMPLE_INTERVAL_MS;
      observedFrames++;
      const left = readHand(frame, reference, sources, 'left');
      const right = readHand(frame, reference, sources, 'right');
      if (!left && !right) return;
      if (samples.length >= SAMPLE_LIMIT) samples.shift();
      samples.push({
        wallMs: performance.timeOrigin + now,
        left: describeHand(left),
        right: describeHand(right),
        crossIndex:
          left && right
            ? compareTips(
                left.index,
                right.index,
                left.indexBone,
                right.indexBone,
                left.indexSkin,
                right.indexSkin,
              )
            : null,
      });
    },
    log: () => ({ intervalMs: SAMPLE_INTERVAL_MS, observedFrames, samples }),
  };
}
