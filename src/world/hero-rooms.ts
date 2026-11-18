import { GREYBOX_TEMPLATES, type RoomTemplate } from '../content/rooms.ts';
import type { FloorView } from './floor-view.ts';
import { heroRoomTemplates, type StudyAsset, type StudyManifest } from './study-room.ts';
import { dressTableDecor, type TableDecor } from './table-decor.ts';

/**
 * The baked rooms whose manifests loaded, and the templates the world is built from. A room whose
 * manifest fails, or whose layout disagrees with its greybox, keeps the greybox template and is
 * left out of `manifests`, so its model is never loaded.
 */
export interface HeroRoomSet {
  manifests: readonly StudyManifest[];
  templates: readonly RoomTemplate[];
}

/** Fetches every baked room's manifest in parallel; each failure falls back on its own. */
export async function fetchHeroRooms(
  ids: readonly string[],
  fetchManifest: (id: string) => Promise<StudyManifest>,
  base: readonly RoomTemplate[] = GREYBOX_TEMPLATES,
): Promise<HeroRoomSet> {
  const loaded = await Promise.all(
    ids.map((id) =>
      fetchManifest(id).catch((error: unknown) => {
        console.warn(`${id} manifest unavailable, greybox ${id} kept`, error);
        return null;
      }),
    ),
  );
  const templates = heroRoomTemplates(
    loaded.map((m) => m?.template ?? null),
    base,
  );
  const manifests = loaded.filter(
    (m): m is StudyManifest => m !== null && templates.includes(m.template),
  );
  return { manifests, templates };
}

/** Loads every room model in parallel; a room whose model fails keeps its greybox. */
export async function loadHeroAssets(
  manifests: readonly StudyManifest[],
  loadAsset: (manifest: StudyManifest) => Promise<StudyAsset>,
): Promise<StudyAsset[]> {
  const assets = await Promise.all(
    manifests.map((m) =>
      loadAsset(m).catch((error: unknown) => {
        const id = m.template.id;
        console.warn(`${id} asset unavailable, greybox ${id} kept`, error);
        return null;
      }),
    ),
  );
  return assets.filter((a): a is StudyAsset => a !== null);
}

/**
 * Dresses every placed room of each loaded asset's template, spinning its rigid nodes, and stands
 * the seeded table decorations (when loaded) on the tables of those rooms.
 */
export function dressHeroRooms(
  view: FloorView,
  assets: readonly StudyAsset[],
  decor: TableDecor | null = null,
): number {
  let dressed = 0;
  for (const asset of assets) {
    dressed += view.useRoomAsset(
      asset.manifest.template.id,
      asset.instantiate,
      asset.manifest.rigidNodes,
    );
  }
  if (decor) dressTableDecor(view.world, decor, new Set(assets.map((a) => a.manifest.template.id)));
  return dressed;
}
