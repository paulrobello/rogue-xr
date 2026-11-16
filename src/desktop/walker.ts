import type * as THREE from 'three';
import type { Box } from '../content/rooms.ts';
import type { ActionBus } from '../core/actions.ts';
import { moveWithCollision, normalizeYaw, smoothMove } from '../xr/locomotion.ts';

export const WALK_SPEED = 2;

/**
 * Applies `move` and `turn` intents to the rig on the desktop. Heading is in degrees, 0 facing
 * north (-Z) and increasing clockwise, the same convention as the XR locomotion module.
 * Movement intents are summed per frame and resolved against the colliders on `update`.
 */
export class Walker {
  yaw = 0;
  enabled = true;
  private forward = 0;
  private strafe = 0;

  constructor(
    private readonly rig: THREE.Object3D,
    actions: ActionBus,
    private readonly colliders: () => readonly Box[],
    private readonly speed = WALK_SPEED,
  ) {
    actions.on('move', (a) => {
      this.forward += a.forward;
      this.strafe += a.strafe;
    });
    actions.on('turn', (a) => {
      if (this.enabled) this.yaw = normalizeYaw(this.yaw + a.degrees);
    });
  }

  update(dt: number): void {
    const forward = this.forward;
    const strafe = this.strafe;
    this.forward = 0;
    this.strafe = 0;
    this.rig.rotation.y = (-this.yaw * Math.PI) / 180;
    if (!this.enabled) return;
    const delta = smoothMove(this.yaw, forward, strafe, this.speed, dt);
    if (delta[0] === 0 && delta[1] === 0) return;
    const to = moveWithCollision(
      [this.rig.position.x, this.rig.position.z],
      delta,
      this.colliders(),
    );
    this.rig.position.x = to[0];
    this.rig.position.z = to[1];
  }
}
