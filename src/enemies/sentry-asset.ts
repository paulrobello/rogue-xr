import {
  ENEMY_ASSET_ROOT,
  ENEMY_CLIPS,
  ENEMY_SOCKETS,
  type EnemyActor,
  type EnemyAsset,
  type EnemyClip,
  type EnemyClipSpec,
  type EnemyLoadOptions,
  type EnemyManifest,
  type EnemyMaterialSlot,
  type EnemyPlayOptions,
  type EnemySocket,
  loadEnemyAsset,
  parseEnemyAsset,
  parseEnemyManifest,
} from './enemy-asset.ts';

/**
 * The Cog Sentry under its P4 names. Every automaton loads through the per-id loader in
 * enemy-asset.ts; these aliases keep older importers (combat-session's actor type, asset checks)
 * compiling unchanged.
 */
export const SENTRY_ID = 'cog-sentry';
export const SENTRY_ASSET_BASE = `${ENEMY_ASSET_ROOT}/${SENTRY_ID}`;
export const SENTRY_CLIPS = ENEMY_CLIPS;
export const SENTRY_SOCKETS = ENEMY_SOCKETS;
export type SentryClip = EnemyClip;
export type SentrySocket = EnemySocket;
export type SentryClipSpec = EnemyClipSpec;
export type SentryMaterialSlot = EnemyMaterialSlot;
export type SentryManifest = EnemyManifest;
export type SentryAsset = EnemyAsset;
export type SentryActor = EnemyActor;
export type SentryPlayOptions = EnemyPlayOptions;

export const parseSentryManifest = (raw: unknown): SentryManifest => parseEnemyManifest(raw);
export const parseSentry = parseEnemyAsset;
export const loadSentry = (options: Omit<EnemyLoadOptions, 'root'> = {}): Promise<SentryAsset> =>
  loadEnemyAsset(SENTRY_ID, options);
