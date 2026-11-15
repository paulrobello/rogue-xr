import type { WorkspaceColors } from '@par/xr-workspace';

/** Gilded Lamplight: the one source of the game's base tints. Mirrors docs/art-bible.md "Palette". */
export const PALETTE = {
  void: '#120c07',
  warmBlack: '#231d1a',
  walnut: '#583c26',
  brass: '#dec16a',
  brassDark: '#7a5522',
  candle: '#f3be65',
  parchment: '#f2dfb8',
  ruby: '#93212b',
  sapphire: '#2d4a93',
  emerald: '#19744c',
} as const;

export const WORKSPACE_COLORS: WorkspaceColors = {
  handColor: '#b98a4a',
  armColor: PALETTE.brassDark,
  accentColor: PALETTE.candle,
  environmentAccentColor: PALETTE.brass,
};
