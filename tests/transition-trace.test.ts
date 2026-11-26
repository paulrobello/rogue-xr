import { expect, it, vi } from 'vitest';
import { traceTransitions } from '../src/perf/transition-trace.ts';

it('keeps transition boundaries and WebGL activity without recording every idle frame', () => {
  const gl = {
    linkProgram: vi.fn(),
    texSubImage2D: vi.fn(),
    getProgramParameter: vi.fn((_program: WebGLProgram, _pname: number) => true),
  };
  const trace = traceTransitions(gl);
  const where = { floor: 2, room: 0, phase: 'idle', covered: false, black: false, xr: true };
  trace.frame(10, performance.now(), where);
  trace.frame(20, performance.now(), where);
  trace.mark('lift');
  const program = {} as WebGLProgram;
  gl.linkProgram(program);
  gl.texSubImage2D(0, 0, 0, 0, 0, 0, 0, 0, null);
  expect(gl.getProgramParameter(program, 0)).toBe(true);
  trace.worldRender(8);
  trace.frame(30, performance.now(), { ...where, floor: 3 });
  trace.frame(139, performance.now(), { ...where, floor: 3, room: 1 });

  const { frames, marks } = trace.log();
  expect(frames).toHaveLength(3);
  expect(marks.map((mark) => mark.name)).toEqual(['lift']);
  expect(frames[1]).toMatchObject({
    floor: 3,
    intervalMs: 10,
    worldRenderCpuMs: 8,
    operations: {
      linkProgram: { calls: 1 },
      texSubImage2D: { calls: 1 },
      getProgramParameter: { calls: 1 },
    },
  });
  expect(frames[2]).toMatchObject({ room: 1, intervalMs: 109, operations: {} });
});

it('retains lift and doorway operations after later frame work fills the ambient buffer', () => {
  const gl = { texSubImage2D: vi.fn(), linkProgram: vi.fn() };
  const trace = traceTransitions(gl);
  const where = { floor: 3, room: 0, phase: 'loading', covered: true, black: true, xr: true };
  gl.linkProgram({});
  trace.frame(10, performance.now(), where);
  gl.texSubImage2D();
  trace.frame(20, performance.now(), where);
  const arrived = { ...where, phase: 'idle', covered: false, black: false };
  trace.frame(30, performance.now(), arrived);
  gl.linkProgram({});
  trace.frame(40, performance.now(), { ...arrived, room: 1 });
  for (let time = 90; time < 70_000; time += 50) {
    gl.texSubImage2D();
    trace.frame(time, performance.now(), { ...arrived, room: 1 });
  }
  const { frames } = trace.log();
  expect(frames.find((frame) => frame.black && frame.operations.linkProgram)).toBeDefined();
  expect(frames.find((frame) => frame.black && frame.operations.texSubImage2D)).toBeDefined();
  expect(frames.find((frame) => frame.room === 1 && frame.operations.linkProgram)).toBeDefined();
  expect(frames.length).toBeLessThan(650);
});
