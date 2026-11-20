import * as THREE from 'three';
import type { PatrolApproachSample } from './patrol-approach.ts';

const hip = new THREE.Vector3(),
  knee = new THREE.Vector3(),
  ankle = new THREE.Vector3();
const target = new THREE.Vector3(),
  axis = new THREE.Vector3(),
  pole = new THREE.Vector3();
const aim = new THREE.Vector3(),
  origin = new THREE.Vector3(),
  up = new THREE.Vector3(0, 1, 0);
const rotation = new THREE.Quaternion(),
  worldRotation = new THREE.Quaternion();
const sole = new THREE.Quaternion();

function pointBone(bone: THREE.Object3D, child: THREE.Object3D, to: THREE.Vector3): void {
  if (!bone.parent) return;
  bone.getWorldPosition(origin);
  child.getWorldPosition(aim).sub(origin).normalize();
  pole.copy(to).sub(origin).normalize();
  rotation.setFromUnitVectors(aim, pole);
  bone.getWorldQuaternion(worldRotation).premultiply(rotation);
  bone.quaternion.copy(bone.parent.getWorldQuaternion(rotation).invert()).multiply(worldRotation);
}

function placeFoot(thigh: THREE.Object3D, shin: THREE.Object3D, foot: THREE.Object3D): void {
  thigh.getWorldPosition(hip);
  shin.getWorldPosition(knee);
  foot.getWorldPosition(ankle);
  const upper = knee.distanceTo(hip),
    lower = ankle.distanceTo(knee);
  const reach = Math.min(target.distanceTo(hip), upper + lower - 1e-7);
  axis.copy(target).sub(hip).normalize();
  pole.copy(knee).sub(hip).addScaledVector(axis, -pole.dot(axis)).normalize();
  const along = (upper * upper - lower * lower + reach * reach) / (2 * reach);
  knee
    .copy(hip)
    .addScaledVector(axis, along)
    .addScaledVector(pole, Math.sqrt(Math.max(0, upper * upper - along * along)));
  pointBone(thigh, shin, knee);
  pointBone(shin, foot, target);
  foot.quaternion.copy(shin.getWorldQuaternion(rotation).invert()).multiply(sole);
}

/** Fit the authored foot placements to a shortened stride or pivot without stretching either shin. */
export class PatrolFeet {
  private readonly legs;
  private readonly bones;
  private adjusted = false;
  private blendTime = 0;
  private firstStep = 0;
  private readonly hips;

  constructor(private readonly root: THREE.Object3D) {
    this.hips = root.getObjectByName('hips');
    this.legs = ['L', 'R'].map((side) => {
      const thigh = root.getObjectByName(`thigh${side}`);
      const shin = root.getObjectByName(`shin${side}`);
      const foot = root.getObjectByName(`foot${side}`);
      if (!thigh || !shin || !foot) throw new Error('Cog Sentry patrol leg joints missing');
      return {
        thigh,
        shin,
        foot,
        rest: root.worldToLocal(foot.getWorldPosition(new THREE.Vector3())),
        entry: new THREE.Vector3(),
        entrySole: new THREE.Quaternion(),
        neutralSole: new THREE.Quaternion(),
      };
    });
    const bones: THREE.Bone[] = [];
    const upperBody = new Set<THREE.Object3D>();
    root.getObjectByName('spine')?.traverse((o) => upperBody.add(o));
    root.traverse((o) => {
      if (o instanceof THREE.Bone) bones.push(o);
    });
    this.bones = bones.map((bone) => ({
      bone,
      baseQ: new THREE.Quaternion(),
      baseP: new THREE.Vector3(),
      fromQ: new THREE.Quaternion(),
      fromP: new THREE.Vector3(),
      neutralTurn: upperBody.has(bone) ? bone.quaternion.clone() : null,
    }));
  }

  /** Capture the actual interrupted patrol pose; contact can fall between any two authored keys. */
  begin(): void {
    this.blendTime = 0;
    for (const b of this.bones) {
      b.fromQ.copy(b.bone.quaternion);
      b.fromP.copy(b.bone.position);
    }
    for (const leg of this.legs) {
      this.root.worldToLocal(leg.foot.getWorldPosition(leg.entry));
      leg.foot.getWorldQuaternion(leg.entrySole);
    }
    this.firstStep = this.legs[0].entry.y >= this.legs[1].entry.y ? 0 : 1;
  }

  /** Remove last frame's correction before the mixer evaluates even its constant tracks. */
  restore(): void {
    if (!this.adjusted) return;
    for (const b of this.bones) {
      b.bone.quaternion.copy(b.baseQ);
      b.bone.position.copy(b.baseP);
    }
    this.adjusted = false;
  }

  fit(dt: number, sample: PatrolApproachSample): void {
    const pivoting = sample.motion === 'turn-left' || sample.motion === 'turn-right';
    for (const b of this.bones) {
      b.baseQ.copy(b.bone.quaternion);
      b.baseP.copy(b.bone.position);
      if (sample.settle !== undefined) b.neutralTurn?.copy(b.baseQ);
      if (pivoting && b.neutralTurn) b.bone.quaternion.slerp(b.neutralTurn, 1 - sample.scale);
    }
    this.adjusted = true;
    if (sample.settle !== undefined) {
      this.settle(sample.settle);
      this.blendTime = 0.14;
      return;
    }
    if (sample.scale < 0.9999) {
      for (const { thigh, shin, foot, rest } of this.legs) {
        foot.getWorldPosition(ankle);
        foot.getWorldQuaternion(sole);
        this.root.worldToLocal(target.copy(ankle));
        if (pivoting) {
          // The support shoe's authored local arc counter-rotates the root. Scale the same arc and its yaw.
          const arc = Math.atan2(
            rest.z * target.x - rest.x * target.z,
            rest.x * target.x + rest.z * target.z,
          );
          const delta = arc * (sample.scale - 1);
          target.applyAxisAngle(up, delta);
          sole.premultiply(rotation.setFromAxisAngle(up, delta));
        } else {
          target.z = rest.z + (target.z - rest.z) * sample.scale;
        }
        target.y = rest.y + (target.y - rest.y) * Math.sqrt(sample.scale);
        this.root.localToWorld(target);
        placeFoot(thigh, shin, foot);
      }
    }
    this.blendTime = Math.min(0.14, this.blendTime + dt);
    if (this.blendTime < 0.14) {
      const u = this.blendTime / 0.14;
      const from = 1 - u * u * (3 - 2 * u);
      for (const b of this.bones) {
        b.bone.quaternion.slerp(b.fromQ, from);
        b.bone.position.lerp(b.fromP, from);
      }
    }
  }

  private settle(t: number): void {
    const ease = t * t * (3 - 2 * t);
    for (const leg of this.legs) leg.foot.getWorldQuaternion(leg.neutralSole);
    for (const b of this.bones) {
      b.bone.quaternion.slerp(b.fromQ, 1 - ease);
      b.bone.position.lerp(b.fromP, 1 - ease);
    }
    // Keep enough knee bend to support a staggered foot until its recovery step.
    if (this.hips?.parent) {
      const planted = this.legs[1 - this.firstStep];
      const reach = Math.hypot(planted.entry.x - planted.rest.x, planted.entry.z - planted.rest.z);
      this.hips.getWorldPosition(origin).y -= reach * reach * Math.sin(Math.PI * t);
      this.hips.position.copy(this.hips.parent.worldToLocal(origin));
    }
    for (const [i, leg] of this.legs.entries()) {
      const p = Math.max(0, Math.min(1, t * 2 - (i === this.firstStep ? 0 : 1)));
      const landing = p * p * (3 - 2 * p);
      target.lerpVectors(leg.entry, leg.rest, landing);
      const step = Math.hypot(leg.entry.x - leg.rest.x, leg.entry.z - leg.rest.z);
      target.y += Math.min(0.045, step * 0.24) * Math.sin(Math.PI * p) ** 2;
      this.root.localToWorld(target);
      sole.slerpQuaternions(leg.entrySole, leg.neutralSole, landing);
      placeFoot(leg.thigh, leg.shin, leg.foot);
    }
  }
}
