export const MAP_MARKER_ICONS = ['star', 'flag', 'question', 'danger', 'check'] as const;

export type MapMarkerIcon = (typeof MAP_MARKER_ICONS)[number];

export interface MapMarker {
  readonly icon: MapMarkerIcon;
  readonly position: readonly [number, number];
}

export type MapMarkerFloor = 1 | 2 | 3;

export interface StoredMapMarker extends MapMarker {
  readonly floor: MapMarkerFloor;
}
