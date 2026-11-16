import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { type Box, type Rect, templateById, type Vec3 } from '../src/content/rooms.ts';
import { DEFAULT_SETTINGS } from '../src/persist/db.ts';
import { ComfortVignette } from '../src/xr/comfort-vignette.ts';
import {
  AIM_ENGAGE,
  AIM_RELEASE,
  DEFAULT_LOCOMOTION_SETTINGS,
  DEFAULT_VIGNETTE,
  Locomotion,
  locomotionSettingsFrom,
  stepTeleportAim,
} from '../src/xr/locomotion.ts';
import { type DriveInput, LocomotionDrive } from '../src/xr/locomotion-drive.ts';
import { INVALID_COLOR, TeleportView, VALID_COLOR } from '../src/xr/teleport-view.ts';

const study = templateById('study');
const COLLIDERS: readonly Box[] = study.colliders;
const OUTSIDE_SOUTH: Rect = { min: [-1.8, 4.4], max: [-0.2, 7] };
const WALKABLE: readonly Rect[] = [...study.walkable, OUTSIDE_SOUTH];
const DT = 1 / 72;

function build(settings = {}) {
  const rig = new THREE.Group();
  const head = new THREE.PerspectiveCamera();
  rig.add(head);
  head.position.set(0, 1.2, 0);
  const loco = new Locomotion(rig, head, settings);
  loco.setWorld(COLLIDERS, WALKABLE);
  loco.recenter();
  const drive = new LocomotionDrive(loco);
  return { rig, head, loco, drive };
}

function headXZ(head: THREE.Object3D): [number, number] {
  head.updateWorldMatrix(true, false);
  const p = new THREE.Vector3().setFromMatrixPosition(head.matrixWorld);
  return [p.x, p.z];
}

/** A level-ish aim from the hand toward -X, tilted up 20 degrees: lands about 5 m ahead, inside the room. */
const GOOD_AIM = (() => {
  const a = (20 * Math.PI) / 180;
  return { origin: [2, 1.4, 2] as Vec3, direction: [-Math.cos(a), Math.sin(a), 0] as Vec3 };
})();
/** Aimed at the east wall, which blocks the arc. */
const WALL_AIM = { origin: [2, 1.4, 2] as Vec3, direction: [1, 0.1, 0] as Vec3 };

const base: DriveInput = {
  dt: DT,
  left: [0, 0],
  right: [0, 0],
  leftRay: null,
  locked: false,
  boardVisible: false,
};

describe('comfort settings mapping', () => {
  it('maps the persisted profile onto locomotion, teleport off by default', () => {
    const mapped = locomotionSettingsFrom(DEFAULT_SETTINGS);
    expect(mapped.teleport).toBe(false);
    expect(mapped.turnMode).toBe('snap');
    expect(mapped.standingEyeHeight).toBe(DEFAULT_SETTINGS.eyeHeight);
    const on = locomotionSettingsFrom({
      ...DEFAULT_SETTINGS,
      teleportEnabled: true,
      turnMode: 'smooth',
      vignette: false,
    });
    expect(on).toMatchObject({ teleport: true, turnMode: 'smooth', vignette: false });
    expect(DEFAULT_LOCOMOTION_SETTINGS.teleport).toBe(false);
  });

  it('switching the toggle at runtime changes how the same stick behaves', () => {
    const { rig, head, loco, drive } = build();
    rig.position.set(2, rig.position.y, 2);
    const walk = () => {
      for (let i = 0; i < 20; i++) drive.step({ ...base, left: [0, 1] });
    };
    const before = headXZ(head);
    walk();
    expect(Math.hypot(headXZ(head)[0] - before[0], headXZ(head)[1] - before[1])).toBeGreaterThan(
      0.3,
    );
    Object.assign(
      loco.settings,
      locomotionSettingsFrom({ ...DEFAULT_SETTINGS, teleportEnabled: true }),
    );
    const parked = headXZ(head);
    walk();
    expect(headXZ(head)[0]).toBeCloseTo(parked[0], 9);
    expect(headXZ(head)[1]).toBeCloseTo(parked[1], 9);
  });
});

describe('comfort vignette wiring', () => {
  const tan = { x: 1.2, y: 1.1 };
  const camera = new THREE.PerspectiveCamera();

  it('is clear while still and darkens the edge band while moving, then clears again', () => {
    const { rig, loco, drive } = build();
    rig.position.set(2, rig.position.y, 2);
    const vignette = new ComfortVignette();
    vignette.update(loco.vignetteStrength, camera, tan, true);
    expect(vignette.active).toBe(false);

    for (let i = 0; i < 20; i++) drive.step({ ...base, left: [0, 1] });
    vignette.update(loco.vignetteStrength, camera, tan, true);
    expect(vignette.active).toBe(true);
    expect(vignette.strength).toBeGreaterThan(0.4);
    expect(vignette.scene.children).toHaveLength(1);

    for (let i = 0; i < 90; i++) drive.step(base);
    vignette.update(loco.vignetteStrength, camera, tan, true);
    expect(loco.vignetteStrength).toBe(0);
    expect(vignette.active).toBe(false);
    vignette.dispose();
  });

  it('smooth turning raises it too, and the vignette setting off keeps it clear', () => {
    const smooth = build({ turnMode: 'smooth' });
    for (let i = 0; i < 20; i++) smooth.drive.step({ ...base, right: [1, 0] });
    expect(smooth.loco.vignetteStrength).toBeGreaterThan(0.3);
    const off = build({ turnMode: 'smooth', vignette: false });
    for (let i = 0; i < 20; i++) off.drive.step({ ...base, right: [1, 0] });
    expect(off.loco.vignetteStrength).toBe(0);
  });

  it('clamps to the full-aperture strength and can be held for a pixel check', () => {
    const vignette = new ComfortVignette();
    vignette.update(5, camera, tan, true);
    expect(vignette.strength).toBe(1);
    vignette.hold = DEFAULT_VIGNETTE.maxStrength / 2;
    vignette.update(0, camera, tan, true);
    expect(vignette.strength).toBeCloseTo(0.5, 9);
    expect(vignette.active).toBe(true);
    vignette.dispose();
  });
});

describe('teleport drive', () => {
  it('holds the aim with hysteresis: engages past the trigger, holds above the release', () => {
    expect(stepTeleportAim(false, AIM_ENGAGE - 0.01)).toBe(false);
    expect(stepTeleportAim(false, AIM_ENGAGE)).toBe(true);
    expect(stepTeleportAim(true, (AIM_ENGAGE + AIM_RELEASE) / 2)).toBe(true);
    expect(stepTeleportAim(true, AIM_RELEASE - 0.01)).toBe(false);
    expect(stepTeleportAim(false, Number.NaN)).toBe(false);
  });

  it('commits a valid landing on release, moves x/z only and keeps the seated height lift', () => {
    const { rig, head, loco, drive } = build({ teleport: true });
    rig.position.set(2, rig.position.y, 2);
    const lift = rig.position.y;
    expect(lift).toBeGreaterThan(0.3);
    drive.step({ ...base, left: [0, 1], leftRay: GOOD_AIM });
    expect(drive.isAiming).toBe(true);
    expect(loco.teleportPreview?.valid).toBe(true);
    const landing = loco.teleportPreview?.landing as Vec3;
    // The held stick does not smooth-move.
    expect(headXZ(head)).toEqual([2, 2]);
    drive.step({ ...base, left: [0, 0], leftRay: GOOD_AIM });
    expect(drive.isAiming).toBe(false);
    expect(headXZ(head)[0]).toBeCloseTo(landing[0], 6);
    expect(headXZ(head)[1]).toBeCloseTo(landing[2], 6);
    expect(rig.position.y).toBe(lift);
    expect(loco.teleportPreview).toBeNull();
  });

  it('pulses the vignette on the jump and fades it', () => {
    const { rig, loco, drive } = build({ teleport: true });
    rig.position.set(2, rig.position.y, 2);
    drive.step({ ...base, left: [0, 1], leftRay: GOOD_AIM });
    expect(loco.vignetteStrength).toBe(0);
    drive.step({ ...base });
    expect(loco.vignetteStrength).toBeGreaterThan(0.6);
    for (let i = 0; i < 72; i++) drive.step({ ...base });
    expect(loco.vignetteStrength).toBe(0);
  });

  it('does not move on release of an invalid landing', () => {
    const { rig, head, loco, drive } = build({ teleport: true });
    rig.position.set(2, rig.position.y, 2);
    drive.step({ ...base, left: [0, 1], leftRay: WALL_AIM });
    expect(loco.teleportPreview?.valid).toBe(false);
    expect(loco.teleportPreview?.reason).toBe('blocked');
    drive.step({ ...base });
    expect(headXZ(head)).toEqual([2, 2]);
    expect(loco.vignetteStrength).toBe(0);
  });

  it('refuses a landing outside the walkable rects even when the arc comes down in the open', () => {
    const { rig, head, loco, drive } = build({ teleport: true });
    // Without the rect beyond the south door, the same throw through the door gap lands out of bounds.
    loco.setWorld(COLLIDERS, study.walkable);
    rig.position.set(-1, rig.position.y, 2);
    const a = (20 * Math.PI) / 180;
    const aim = { origin: [-1, 1.4, 2] as Vec3, direction: [0, Math.sin(a), Math.cos(a)] as Vec3 };
    drive.step({ ...base, left: [0, 1], leftRay: aim });
    expect(loco.teleportPreview?.reason).toBe('out-of-bounds');
    drive.step({ ...base });
    expect(headXZ(head)).toEqual([-1, 2]);
  });

  it('does not aim or teleport with the toggle off, and smooth move still works', () => {
    const { rig, head, loco, drive } = build();
    rig.position.set(2, rig.position.y, 2);
    drive.step({ ...base, left: [0, 1], leftRay: GOOD_AIM });
    expect(drive.isAiming).toBe(false);
    expect(loco.teleportPreview).toBeNull();
    expect(headXZ(head)[1]).toBeLessThan(2);
  });

  it('drops an aim when the controller is lost instead of committing it', () => {
    const { rig, head, loco, drive } = build({ teleport: true });
    rig.position.set(2, rig.position.y, 2);
    drive.step({ ...base, left: [0, 1], leftRay: GOOD_AIM });
    drive.step({ ...base, left: [0, 1], leftRay: null });
    expect(loco.teleportPreview).toBeNull();
    drive.step({ ...base });
    expect(headXZ(head)).toEqual([2, 2]);
  });
});

describe('locomotion gate', () => {
  it('does not move, turn or teleport while a fight holds the table', () => {
    const { rig, head, loco, drive } = build({ teleport: false });
    rig.position.set(2, rig.position.y, 2);
    const yaw = rig.rotation.y;
    for (let i = 0; i < 40; i++) {
      drive.step({ ...base, left: [0.4, 1], right: [1, 0], locked: true });
    }
    expect(headXZ(head)).toEqual([2, 2]);
    expect(rig.rotation.y).toBe(yaw);
    expect(loco.vignetteStrength).toBe(0);
    const tp = build({ teleport: true });
    tp.rig.position.set(2, tp.rig.position.y, 2);
    tp.drive.step({ ...base, left: [0, 1], leftRay: GOOD_AIM, locked: true });
    expect(tp.loco.teleportPreview).toBeNull();
    expect(tp.drive.isAiming).toBe(false);
    tp.drive.step({ ...base, locked: true });
    expect(headXZ(tp.head)).toEqual([2, 2]);
  });

  it('never commits an aim that was held when the fight started, once the controls return', () => {
    const { rig, head, loco, drive } = build({ teleport: true });
    rig.position.set(2, rig.position.y, 2);
    drive.step({ ...base, left: [0, 1], leftRay: GOOD_AIM });
    expect(loco.teleportPreview).not.toBeNull();
    drive.step({ ...base, left: [0, 1], leftRay: GOOD_AIM, locked: true });
    drive.step({ ...base, locked: true });
    drive.step({ ...base });
    expect(headXZ(head)).toEqual([2, 2]);
  });

  it('lets the vignette fade while a board holds the controls', () => {
    const { rig, loco, drive } = build();
    rig.position.set(2, rig.position.y, 2);
    for (let i = 0; i < 20; i++) drive.step({ ...base, left: [0, 1] });
    expect(loco.vignetteStrength).toBeGreaterThan(0.4);
    for (let i = 0; i < 90; i++) drive.step({ ...base, left: [0, 1], boardVisible: true });
    expect(loco.vignetteStrength).toBe(0);
  });
});

describe('teleport view', () => {
  const preview = (valid: boolean, landing: Vec3 | null) => ({
    valid,
    reason: valid ? ('ok' as const) : ('out-of-bounds' as const),
    points: Array.from({ length: 30 }, (_, i): Vec3 => [i * 0.2, 1.4 - i * 0.04, 0]),
    landing,
  });

  it('is hidden with no aim', () => {
    const view = new TeleportView();
    view.update(null);
    expect(view.visible).toBe(false);
    expect(view.arc.count).toBe(0);
    view.dispose();
  });

  it('draws a brass arc and ring for a valid landing and dim red for an invalid one', () => {
    const view = new TeleportView();
    view.update(preview(true, [3, 0, 1]));
    expect(view.visible).toBe(true);
    expect(view.arc.count).toBeGreaterThan(5);
    expect(view.ring.visible).toBe(true);
    expect(view.ring.material.color.getHexString()).toBe(
      new THREE.Color(VALID_COLOR).getHexString(),
    );
    expect(view.ring.position.x).toBe(3);
    expect(view.ring.position.y).toBeGreaterThan(0);

    view.update(preview(false, [3, 0, 1]));
    expect(view.ring.material.color.getHexString()).toBe(
      new THREE.Color(INVALID_COLOR).getHexString(),
    );
    expect(view.arc.material.color.getHexString()).toBe(
      new THREE.Color(INVALID_COLOR).getHexString(),
    );

    view.update(preview(false, null));
    expect(view.ring.visible).toBe(false);
    expect(view.visible).toBe(true);
    view.dispose();
  });
});
