import {
  createStandardHand,
  createXrSession,
  type FoveationLevel,
  type XrSessionOptions,
} from '@par/xr-workspace';
import * as THREE from 'three';
import type { ActionBus } from '../core/actions.ts';
import { WORKSPACE_COLORS } from '../palette.ts';
import { createLaser } from './laser.ts';
import { readThumbstick, type Vec2 } from './locomotion.ts';

/** Seated play: local-floor keeps the floor plane; medium foveation per the Quest 3 guide. */
export const XR_SESSION_OPTIONS = {
  referenceSpaces: ['local-floor', 'local'],
  foveation: 'medium',
} as const satisfies XrSessionOptions;

type Side = 'left' | 'right';

interface TrackedSource {
  update(deltaSeconds: number): void;
  hide(): void;
  aim(hit: number | null, visible: boolean): void;
  readonly input: XRInputSource | null;
  readonly grip: THREE.Object3D;
  /** The WebXR target-ray space: its -Z axis is where the controller points. */
  readonly ray: THREE.Object3D;
}

/** A per-handedness pair; null while that hand has no tracked input. */
export interface HandPair<T> {
  left: T | null;
  right: T | null;
}

export interface XrSticks {
  /** `[x, forward]` per hand, after `readThumbstick`; zero when that hand has no gamepad. */
  left: Vec2;
  right: Vec2;
}

export interface XrRig {
  supported(): Promise<boolean>;
  enter(): Promise<void>;
  exit(): Promise<void>;
  readonly presenting: boolean;
  update(deltaSeconds: number, frame?: XRFrame): void;
  sticks(): XrSticks;
  /** Whether gamepad button `index` of the `side` controller is down (false while untracked). */
  buttonPressed(side: Side, index: number): boolean;
  /** Controller grip objects by handedness, null while that hand is not tracked. */
  grips(): HandPair<THREE.Object3D>;
  /** Controller target-ray objects (pointing, -Z) by handedness. */
  rays(): HandPair<THREE.Object3D>;
  /**
   * Aims each controller's pointer beam (hidden for tracked hands and outside XR) and returns the
   * scene holding the beams, for a pass drawn after the menu boards. A hit distance ends that
   * hand's beam on what it points at; null draws the idle length.
   */
  updateLasers(hits: HandPair<number>): THREE.Scene;
  /** Changes the session's foveation; applied at once while presenting and at every session start. */
  setFoveation(level: FoveationLevel): void;
  dispose(): void;
}

export interface XrRigOptions {
  /** Foveation the session starts with. Default `XR_SESSION_OPTIONS.foveation` (medium). */
  foveation?: FoveationLevel;
}

/**
 * Owns the immersive session, both tracked inputs and the brass-tinted toolkit hands. `rig` is the
 * player's locomotion root; controllers and hands are parented to it so moving the rig moves them.
 */
export function createXrRig(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  rig: THREE.Group,
  camera: THREE.Camera,
  actions: ActionBus,
  options: XrRigOptions = {},
): XrRig {
  renderer.xr.enabled = true;

  const laserScene = new THREE.Scene();
  const sources: TrackedSource[] = [0, 1].map((index) => {
    const controller = renderer.xr.getController(index);
    const grip = renderer.xr.getControllerGrip(index);
    const hand = renderer.xr.getHand(index);
    const visual = createStandardHand({
      handColor: WORKSPACE_COLORS.handColor,
      armColor: WORKSPACE_COLORS.armColor,
      theme: {
        hand: {
          color: '#b87333',
          roughness: 0.42,
          metalness: 0.78,
          emissive: '#241006',
          emissiveIntensity: 0.08,
        },
        sleeve: {
          color: '#2b1014',
          roughness: 0.78,
          metalness: 0.12,
          emissive: '#090304',
          emissiveIntensity: 0.03,
        },
      },
    });
    const laser = createLaser(laserScene);
    let input: XRInputSource | null = null;
    controller.addEventListener('connected', (event) => {
      input = (event as unknown as { data: XRInputSource }).data;
    });
    controller.addEventListener('disconnected', () => {
      input = null;
      visual.hide();
    });
    rig.add(controller, grip, hand);
    visual.hide();
    scene.add(visual.root);
    return {
      update(deltaSeconds: number) {
        const side = input?.handedness;
        if (!input || (side !== 'left' && side !== 'right')) {
          visual.hide();
          return;
        }
        if (input.hand) visual.update(hand, camera, side as Side, deltaSeconds);
        else visual.updateController(grip, camera, side as Side, input.gamepad, deltaSeconds);
      },
      hide() {
        visual.hide();
        laser.follow(controller, null, false);
      },
      aim(hit: number | null, visible: boolean) {
        laser.follow(controller, hit, visible);
      },
      get input() {
        return input;
      },
      grip,
      ray: controller,
    };
  });

  const session = createXrSession(renderer, {
    ...XR_SESSION_OPTIONS,
    foveation: options.foveation ?? XR_SESSION_OPTIONS.foveation,
    onStart: () => actions.emit({ type: 'enter-xr' }),
    onEnd: () => {
      for (const source of sources) source.hide();
      actions.emit({ type: 'exit-xr' });
    },
    onReset: () => actions.emit({ type: 'recenter' }),
  });

  return {
    supported: () => session.supported(),
    enter: () => session.enter(),
    exit: () => session.exit(),
    get presenting() {
      return session.presenting;
    },
    update(deltaSeconds, frame) {
      if (!session.presenting) return;
      const pose = session.update(frame);
      if (pose) applyViewerPose(camera, pose);
      for (const source of sources) source.update(deltaSeconds);
    },
    sticks() {
      const out: XrSticks = { left: [0, 0], right: [0, 0] };
      for (const { input } of sources) {
        const side = input?.handedness;
        const axes = input?.gamepad?.axes;
        if (axes && (side === 'left' || side === 'right')) out[side] = readThumbstick(axes);
      }
      return out;
    },
    buttonPressed(side, index) {
      const source = sources.find((s) => s.input?.handedness === side);
      return Boolean(source?.input?.gamepad?.buttons[index]?.pressed);
    },
    grips: () => byHand(sources, (source) => source.grip),
    rays: () => byHand(sources, (source) => source.ray),
    updateLasers(hits) {
      for (const source of sources) {
        const side = source.input?.handedness;
        const isController = !!source.input && !source.input.hand;
        if (side === 'left' || side === 'right') {
          source.aim(hits[side], session.presenting && isController);
        } else source.aim(null, false);
      }
      return laserScene;
    },
    setFoveation: (level) => session.setFoveation(level),
    dispose: () => session.dispose(),
  };
}

/**
 * Puts the head camera (a child of the rig) at this frame's viewer pose. three.js only does that
 * inside render(), so without it the frame's logic before render reads last frame's head, and on
 * a session's first frame the zeroed head: the seated recenter then lifted the rig by its 1 m
 * maximum instead of to standing eye height.
 */
export function applyViewerPose(
  head: THREE.Object3D,
  pose: { readonly transform: Pick<XRRigidTransform, 'position' | 'orientation'> },
): void {
  const { position: p, orientation: q } = pose.transform;
  head.position.set(p.x, p.y, p.z);
  head.quaternion.set(q.x, q.y, q.z, q.w);
}

function byHand<T>(
  sources: readonly TrackedSource[],
  pick: (source: TrackedSource) => T,
): HandPair<T> {
  const out: HandPair<T> = { left: null, right: null };
  for (const source of sources) {
    const side = source.input?.handedness;
    if (side === 'left' || side === 'right') out[side] = pick(source);
  }
  return out;
}
