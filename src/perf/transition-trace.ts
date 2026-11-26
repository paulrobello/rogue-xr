const GL_OPERATIONS = [
  'compileShader',
  'linkProgram',
  'getProgramParameter',
  'getShaderParameter',
  'getProgramInfoLog',
  'getShaderInfoLog',
  'getActiveAttrib',
  'getActiveUniform',
  'getAttribLocation',
  'getUniformLocation',
  'useProgram',
  'createBuffer',
  'createVertexArray',
  'bindVertexArray',
  'vertexAttribPointer',
  'vertexAttribIPointer',
  'vertexAttribDivisor',
  'drawArrays',
  'drawElements',
  'drawArraysInstanced',
  'drawElementsInstanced',
  'texImage2D',
  'texSubImage2D',
  'compressedTexImage2D',
  'compressedTexSubImage2D',
  'texStorage2D',
  'texImage3D',
  'texSubImage3D',
  'compressedTexImage3D',
  'compressedTexSubImage3D',
  'texStorage3D',
  'generateMipmap',
  'bufferData',
  'bufferSubData',
] as const;

type GlOperation = (typeof GL_OPERATIONS)[number];
type OperationTiming = { calls: number; totalMs: number; maxMs: number };
type Operations = Partial<Record<GlOperation, OperationTiming>>;
type FrameLocation = {
  floor: number | null;
  room: number | null;
  phase: string;
  covered: boolean;
  black: boolean;
  xr: boolean;
};
type FrameTrace = FrameLocation & {
  wallMs: number;
  intervalMs: number | null;
  frameCpuMs: number;
  worldRenderCpuMs: number | null;
  operations: Operations;
};
type TraceMark = { name: string; wallMs: number };

const TRANSITION_FRAME_LIMIT = 2400;
const AMBIENT_FRAME_LIMIT = 600;
const DOORWAY_WINDOW_MS = 350;
const MARK_LIMIT = 150;

/** Measures synchronous WebGL call duration. Veil marks delimit asynchronous program waits. */
export function traceTransitions(gl: Partial<Record<GlOperation, unknown>>) {
  let operations: Operations = {};
  const transitions: FrameTrace[] = [];
  const ambient: FrameTrace[] = [];
  const marks: TraceMark[] = [];
  let lastTime: number | undefined;
  let lastLocation: FrameLocation | undefined;
  let lastDoorwayTime = -Infinity;
  let worldRenderCpuMs: number | null = null;

  for (const name of GL_OPERATIONS) {
    const call = gl[name];
    if (typeof call !== 'function') continue;
    Object.defineProperty(gl, name, {
      configurable: true,
      value: (...args: unknown[]) => {
        const start = performance.now();
        try {
          return Reflect.apply(call, gl, args);
        } finally {
          const ms = performance.now() - start;
          operations[name] ??= { calls: 0, totalMs: 0, maxMs: 0 };
          const stats = operations[name];
          stats.calls++;
          stats.totalMs += ms;
          stats.maxMs = Math.max(stats.maxMs, ms);
        }
      },
    });
  }

  return {
    mark(name: string): void {
      if (marks.length === MARK_LIMIT) marks.shift();
      marks.push({ name, wallMs: performance.timeOrigin + performance.now() });
    },
    worldRender(ms: number): void {
      worldRenderCpuMs = ms;
    },
    frame(time: number, begin: number, location: FrameLocation): void {
      const end = performance.now();
      const intervalMs = lastTime === undefined ? null : time - lastTime;
      if (location.floor === 3 && lastLocation?.floor === 3 && location.room !== lastLocation.room)
        lastDoorwayTime = time;
      const changed =
        !lastLocation ||
        location.floor !== lastLocation.floor ||
        location.room !== lastLocation.room ||
        location.phase !== lastLocation.phase ||
        location.covered !== lastLocation.covered ||
        location.black !== lastLocation.black ||
        location.xr !== lastLocation.xr;
      const focused =
        changed || location.phase !== 'idle' || time - lastDoorwayTime <= DOORWAY_WINDOW_MS;
      const notable =
        (intervalMs ?? 0) >= 40 ||
        (worldRenderCpuMs ?? 0) >= 30 ||
        !!operations.linkProgram ||
        !!operations.compileShader ||
        Object.values(operations).some((operation) => operation.maxMs >= 2);
      if (focused || notable) {
        const buffer = focused ? transitions : ambient;
        const limit = focused ? TRANSITION_FRAME_LIMIT : AMBIENT_FRAME_LIMIT;
        if (buffer.length === limit) buffer.shift();
        buffer.push({
          ...location,
          wallMs: performance.timeOrigin + begin,
          intervalMs,
          frameCpuMs: end - begin,
          worldRenderCpuMs,
          operations,
        });
      }
      lastLocation = location;
      lastTime = time;
      worldRenderCpuMs = null;
      operations = {};
    },
    log: () => ({
      marks,
      frames: [...transitions, ...ambient].sort((a, b) => a.wallMs - b.wallMs),
    }),
  };
}
