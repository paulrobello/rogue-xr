import { createPerfGaugeWidget, type PerfGaugeWidget } from '@par/xr-workspace';
import * as THREE from 'three';
import type { RateSample } from './frame-stats.ts';

/** Quest 3 default refresh rate; the gauge judges frame pacing against it. */
export const DEFAULT_TARGET_HZ = 72;
/** The toolkit gauge is 0.46 m wide; this makes it about 0.17 m across on the wrist. */
const WRIST_SCALE = 0.37;
/** Fallback scale and placement when no wrist is tracked (desktop preview, controllers idle). */
const FLOAT_SCALE = 0.6;
const FLOAT_OFFSET = new THREE.Vector3(-0.28, -0.2, -0.7);
const WRIST_LIFT = 0.1;

export interface PerfGauge {
  setSample(sample: RateSample): void;
  /** Positions the gauge: above the left wrist when tracked, else floating in front of the view. */
  update(viewCamera: THREE.Camera): void;
  setVisible(visible: boolean): void;
  readonly visible: boolean;
  dispose(): void;
}

type Side = 'left' | 'right';

interface ConnectedEvent {
  data: XRInputSource;
}

const worldPosition = new THREE.Vector3();
const worldQuaternion = new THREE.Quaternion();
const parentQuaternion = new THREE.Quaternion();
const cameraPosition = new THREE.Vector3();
const lookMatrix = new THREE.Matrix4();
const up = new THREE.Vector3(0, 1, 0);

/**
 * Mounts the toolkit's perf gauge under `rig`. It follows the `side` wrist joint (hand tracking)
 * or controller grip, turned to face the viewer, and falls back to a floating position when
 * neither is tracked so it is also visible in the desktop preview.
 */
export function mountPerfGauge(
  renderer: THREE.WebGLRenderer,
  rig: THREE.Group,
  options: { targetHz?: number; side?: Side } = {},
): PerfGauge {
  const side = options.side ?? 'left';
  const targetHz = options.targetHz ?? DEFAULT_TARGET_HZ;
  let visible = true;
  const widget: PerfGaugeWidget = createPerfGaugeWidget(null, {
    onClose: () => {
      visible = false;
      widget.root.visible = false;
    },
  });
  rig.add(widget.root);

  const sources = [0, 1].map((index) => ({
    controller: renderer.xr.getController(index),
    grip: renderer.xr.getControllerGrip(index),
    hand: renderer.xr.getHand(index),
    handedness: null as XRHandedness | null,
  }));
  const listeners = sources.map((source) => {
    const connected = (event: unknown): void => {
      source.handedness = (event as ConnectedEvent).data.handedness;
    };
    const disconnected = (): void => {
      source.handedness = null;
    };
    source.controller.addEventListener('connected', connected);
    source.controller.addEventListener('disconnected', disconnected);
    return { source, connected, disconnected };
  });

  function wristAnchor(): THREE.Object3D | null {
    const source = sources.find((candidate) => candidate.handedness === side);
    if (!source) return null;
    const wrist = source.hand.joints.wrist;
    if (wrist?.visible) return wrist;
    return source.grip.visible ? source.grip : null;
  }

  return {
    get visible() {
      return visible;
    },
    setSample(sample) {
      widget.setPerfSample({ fps: sample.fps, worstFrameMs: sample.worstFrameMs, targetHz });
    },
    update(viewCamera) {
      if (!visible) return;
      widget.update(performance.now());
      viewCamera.getWorldPosition(cameraPosition);
      const anchor = renderer.xr.isPresenting ? wristAnchor() : null;
      if (anchor) {
        anchor.getWorldPosition(worldPosition);
        worldPosition.y += WRIST_LIFT;
        lookMatrix.lookAt(cameraPosition, worldPosition, up);
        worldQuaternion.setFromRotationMatrix(lookMatrix);
        widget.root.scale.setScalar(WRIST_SCALE);
      } else {
        viewCamera.getWorldQuaternion(worldQuaternion);
        worldPosition.copy(FLOAT_OFFSET).applyQuaternion(worldQuaternion).add(cameraPosition);
        widget.root.scale.setScalar(FLOAT_SCALE);
      }
      rig.updateWorldMatrix(true, false);
      widget.root.position.copy(rig.worldToLocal(worldPosition));
      rig.getWorldQuaternion(parentQuaternion).invert();
      widget.root.quaternion.copy(parentQuaternion.multiply(worldQuaternion));
    },
    setVisible(next) {
      visible = next;
      widget.root.visible = next;
    },
    dispose() {
      for (const { source, connected, disconnected } of listeners) {
        source.controller.removeEventListener('connected', connected);
        source.controller.removeEventListener('disconnected', disconnected);
      }
      rig.remove(widget.root);
      widget.dispose();
    },
  };
}
