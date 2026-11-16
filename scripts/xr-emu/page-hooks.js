// Runs in the page before any app script, right after IWER's UMD build (global `IWER`).
// Installs an emulated Meta Quest 3, and records what the app asks of WebXR and three.js so the
// walk can read it back: the renderer and scenes (three's devtools hook), the requested session
// mode, the layer init (framebuffer scale) and every fixedFoveation write.
(() => {
  const probe = {
    renderers: [],
    scenes: [],
    requests: [],
    layerInits: [],
    foveationWrites: [],
    passes: [],
    session: null,
    device: null,
  };
  window.__xrEmu = probe;

  const devtools = new EventTarget();
  devtools.addEventListener('observe', (event) => {
    const target = event.detail;
    if (target?.isWebGLRenderer) probe.renderers.push(target);
    else if (target?.isScene) probe.scenes.push(target);
  });
  window.__THREE_DEVTOOLS__ = devtools;

  const { XRDevice, metaQuest3 } = window.IWER;
  const device = new XRDevice(metaQuest3, { stereoEnabled: true });
  // Native WebXR is exposed by desktop Chromium, so the emulator must replace it explicitly.
  device.installRuntime({ forceInstall: true });
  probe.device = device;

  const xr = navigator.xr;
  const requestSession = xr.requestSession.bind(xr);
  xr.requestSession = async (mode, init) => {
    probe.requests.push({ mode, optionalFeatures: init?.optionalFeatures ?? [] });
    const session = await requestSession(mode, init);
    probe.session = { mode, session, ended: false };
    session.addEventListener('end', () => {
      probe.session.ended = true;
    });
    return session;
  };

  const BaseLayer = window.XRWebGLLayer;
  class RecordingLayer extends BaseLayer {
    constructor(session, context, init = {}) {
      super(session, context, init);
      probe.layerInits.push({ ...init });
    }
    // three.js writes fixedFoveation only when the getter is defined; IWER's emulation mode
    // returns undefined, so record the value here to observe what the app requests.
    get fixedFoveation() {
      return this.__foveation ?? 0;
    }
    set fixedFoveation(value) {
      this.__foveation = value;
      const last = probe.foveationWrites.at(-1);
      if (!last || last.value !== value) probe.foveationWrites.push({ value, count: 1 });
      else last.count += 1;
    }
  }
  window.XRWebGLLayer = RecordingLayer;

  const Binding = window.XRWebGLBinding;
  if (Binding?.prototype && 'createProjectionLayer' in Binding.prototype) {
    const create = Binding.prototype.createProjectionLayer;
    Binding.prototype.createProjectionLayer = function (init) {
      probe.layerInits.push({ projection: true, ...init });
      return create.call(this, init);
    };
  }

  // Records which scenes each frame renders while presenting (the boards' own pass).
  probe.wrapRender = (renderer) => {
    if (renderer.__xrEmuWrapped) return;
    renderer.__xrEmuWrapped = true;
    const render = renderer.render.bind(renderer);
    renderer.render = (scene, camera) => {
      if (renderer.xr.isPresenting) {
        probe.passes.push({
          t: performance.now(),
          scene: scene.uuid,
          children: scene.children.length,
          autoClear: renderer.autoClear,
        });
        if (probe.passes.length > 400) probe.passes.splice(0, 200);
      }
      return render(scene, camera);
    };
  };

  /** The app's live objects: renderer, the world scene (holds the rig), the boards' scene. */
  probe.ctx = () => {
    const renderer = probe.renderers[0] ?? null;
    if (renderer) probe.wrapRender(renderer);
    const world = probe.scenes.find((s) => s.getObjectByName('player-rig')) ?? null;
    const rig = world?.getObjectByName('player-rig') ?? null;
    const ui = window.__flow?.ui ?? null;
    const uiScene = probe.scenes.find((s) => ui && s.children.includes(ui.root)) ?? null;
    const camera = window.__combat?.camera ?? null;
    return { renderer, world, rig, ui, uiScene, camera, flow: window.__flow?.flow ?? null };
  };

  const ctor = (object, key) => object[key].constructor;

  /**
   * Seated head pose in tracking space, looking down -Z with an optional pitch and yaw (radians,
   * yaw counter-clockwise about +Y, applied before the pitch).
   */
  probe.setHead = (y, pitch = 0, yaw = 0) => {
    device.position.set(0, y, 0);
    const sp = Math.sin(pitch / 2);
    const cp = Math.cos(pitch / 2);
    const sy = Math.sin(yaw / 2);
    const cy = Math.cos(yaw / 2);
    device.quaternion.set(cy * sp, sy * cp, -sy * sp, cy * cp);
  };

  /**
   * Poses a controller at `offset` (metres, tracking space, relative to the head) with its -Z
   * pointing at `target` (world space). Returns the pose used.
   */
  probe.aimAt = (hand, target, offset) => {
    const { rig } = probe.ctx();
    const Vector3 = ctor(rig, 'position');
    const Quaternion = ctor(rig, 'quaternion');
    const Matrix4 = ctor(rig, 'matrix');
    rig.updateMatrixWorld(true);
    const head = device.position;
    const from = new Vector3(head.x + offset[0], head.y + offset[1], head.z + offset[2]);
    const local = rig.worldToLocal(new Vector3(target.x, target.y, target.z));
    const m = new Matrix4().lookAt(from, local, new Vector3(0, 1, 0));
    const q = new Quaternion().setFromRotationMatrix(m);
    const controller = device.controllers[hand];
    controller.position.set(from.x, from.y, from.z);
    controller.quaternion.set(q.x, q.y, q.z, q.w);
    return { from: from.toArray(), target: local.toArray() };
  };

  /** Poses a controller at world point `from` with its -Z pointing at world point `target`. */
  probe.placeAt = (hand, from, target) => {
    const { rig } = probe.ctx();
    const Vector3 = ctor(rig, 'position');
    const Quaternion = ctor(rig, 'quaternion');
    const Matrix4 = ctor(rig, 'matrix');
    rig.updateMatrixWorld(true);
    const a = rig.worldToLocal(new Vector3(from.x, from.y, from.z));
    const b = rig.worldToLocal(new Vector3(target.x, target.y, target.z));
    const q = new Quaternion().setFromRotationMatrix(
      new Matrix4().lookAt(a, b, new Vector3(0, 1, 0)),
    );
    const controller = device.controllers[hand];
    controller.position.set(a.x, a.y, a.z);
    controller.quaternion.set(q.x, q.y, q.z, q.w);
    return { from: a.toArray(), target: b.toArray() };
  };

  /** World position of a named object in either scene, or of a point in its local frame. */
  probe.worldOf = (name, local = [0, 0, 0]) => {
    const { world, uiScene } = probe.ctx();
    const node =
      uiScene?.getObjectByName(name) ??
      world?.getObjectByName(name) ??
      probe.scenes.map((s) => s.getObjectByName(name)).find(Boolean) ??
      null;
    if (!node) return null;
    node.updateWorldMatrix(true, false);
    const p = node.localToWorld(new (ctor(node, 'position'))(local[0], local[1], local[2]));
    return { x: p.x, y: p.y, z: p.z };
  };

  /** The head (XR camera) in world space and its distance to a world point. */
  probe.headTo = (point) => {
    const { camera } = probe.ctx();
    camera.updateWorldMatrix(true, false);
    const e = camera.matrixWorld.elements;
    const head = { x: e[12], y: e[13], z: e[14] };
    const d = Math.hypot(point.x - head.x, point.y - head.y, point.z - head.z);
    return { head, distance: d };
  };
})();
