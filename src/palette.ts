import type { WorkspaceColors } from '@par/xr-workspace';

/** Warm arcane brass: the one source of the game's base tints. */
export const PALETTE = {
  void: '#120c07',
  walnut: '#4a2e1b',
  brass: '#c8963e',
  brassDark: '#7a5522',
  candle: '#ffc070',
  parchment: '#f2dfb8',
  stainedTeal: '#2f8f8a',
  stainedRuby: '#9c2a3a',
} as const;

export const WORKSPACE_COLORS: WorkspaceColors = {
  handColor: '#b98a4a',
  armColor: '#7a5522',
  accentColor: PALETTE.candle,
  environmentAccentColor: PALETTE.brass,
};
