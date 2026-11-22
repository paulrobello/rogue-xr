import { Stream } from '../core/rng.ts';
import type { RunState } from './run.ts';
import type { ShadowStencilDetent, ShadowStencilState, ShadowStencilTile } from './types.ts';

export type { ShadowStencilDetent, ShadowStencilState, ShadowStencilTile } from './types.ts';
export type ShadowStencilControl =
  | { readonly kind: 'slide'; readonly detent: ShadowStencilDetent }
  | { readonly kind: 'pitch'; readonly pitch: 0 | 1 | 2 | 3 }
  | { readonly kind: 'tile'; readonly tile: ShadowStencilTile };

export function shadowStencilTarget(seed: string): {
  readonly detent: Exclude<ShadowStencilDetent, 0>;
  readonly tile: ShadowStencilTile;
  readonly pitch: 0 | 1 | 2 | 3;
} {
  const stream = Stream.fromKey(`${seed}:shadow-stencil`);
  return {
    detent: stream.int(1, 4) as Exclude<ShadowStencilDetent, 0>,
    tile: stream.int(0, 2) as ShadowStencilTile,
    pitch: stream.int(0, 3) as 0 | 1 | 2 | 3,
  };
}

export function readShadowStencil(run: Pick<RunState, 'shadowStencil'>): ShadowStencilState {
  return run.shadowStencil
    ? { ...run.shadowStencil, pitch: run.shadowStencil.pitch ?? 0 }
    : { detent: 0, pitch: 0, opened: false };
}

export function operateShadowStencil(
  seed: string,
  state: ShadowStencilState,
  control: ShadowStencilControl,
): ShadowStencilState {
  if (state.opened) return state;
  if (control.kind === 'slide') {
    const detent = control.detent;
    return !Number.isInteger(detent) || detent < 0 || detent > 4 || detent === state.detent
      ? state
      : { ...state, detent };
  }
  if (control.kind === 'pitch')
    return control.pitch === state.pitch ? state : { ...state, pitch: control.pitch };
  const target = shadowStencilTarget(seed);
  return control.tile === target.tile &&
    state.detent === target.detent &&
    state.pitch === target.pitch
    ? { ...state, opened: true }
    : state;
}
