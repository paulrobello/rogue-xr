import type { Vec3 } from '../content/rooms.ts';
import { type Locomotion, stepTeleportAim, type TeleportAim, type Vec2 } from './locomotion.ts';

export interface DriveRay {
  origin: Vec3;
  direction: Vec3;
}

export interface DriveInput {
  dt: number;
  /** `[x, forward]` per stick, from `readThumbstick`. */
  left: Vec2;
  right: Vec2;
  /** The right controller's pointing ray in world space, or null while it is not tracked. */
  rightRay: DriveRay | null;
  /** A fight holds the table up. */
  locked: boolean;
  /** A menu board is up. */
  boardVisible: boolean;
}

/**
 * Turns the frame's sticks and controller ray into `Locomotion` input. The left stick smooth strafes
 * (x) and moves forward and back (y). The right stick turns (x, snap or smooth per the turn setting)
 * and teleports (y): pushing it forward holds the teleport aim from the right controller while
 * teleport is on, and returning the stick toward centre commits it. With teleport on, the right stick
 * turns only while no aim is held and the push is more sideways than forward. With teleport off, the
 * right stick y does nothing. While a fight or a board has the controls, nothing moves, a held
 * aim is dropped instead of committed when the controls come back, and the vignette still ramps down.
 */
export class LocomotionDrive {
  private aiming = false;

  constructor(readonly locomotion: Locomotion) {}

  /** True while the teleport aim is held. */
  get isAiming(): boolean {
    return this.aiming;
  }

  step(input: DriveInput): void {
    const { locomotion } = this;
    if (input.locked || input.boardVisible) {
      this.aiming = false;
      locomotion.cancelTeleport();
      locomotion.update(input.dt, { moveX: 0, moveY: 0, turnX: 0, teleportAim: null });
      return;
    }
    let aim: TeleportAim | null = null;
    let turnX = input.right[0];
    if (locomotion.settings.teleport) {
      const held = stepTeleportAim(this.aiming, input.right[1]);
      if (held && input.rightRay) aim = input.rightRay;
      else if (held) locomotion.cancelTeleport();
      this.aiming = aim !== null;
      if (held || Math.abs(input.right[1]) > Math.abs(input.right[0])) turnX = 0;
    } else {
      this.aiming = false;
      locomotion.cancelTeleport();
    }
    locomotion.update(input.dt, {
      moveX: input.left[0],
      moveY: input.left[1],
      turnX,
      teleportAim: aim,
    });
  }
}
