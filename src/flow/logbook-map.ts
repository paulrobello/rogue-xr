import type { Rect } from '../content/rooms.ts';
import type { FloorPlan, WorldRoom } from '../floor/generate.ts';
import type { StairEntry } from '../floor/stairs.ts';
import type { LogbookDiscovery } from './logbook-discoveries.ts';

export type MapPoint = readonly [x: number, y: number];
type MapRoom = { readonly id: number; readonly bounds: Rect };
export type MapTransport = {
  readonly kind: 'stairs' | 'lift';
  readonly room: number;
  readonly position: MapPoint;
};
type MapDoor = { readonly center: MapPoint; readonly alongX: boolean; readonly width: number };

export interface LogbookMap {
  readonly floor: 1 | 2 | 3;
  readonly rooms: readonly MapRoom[];
  readonly totalRooms: number;
  readonly transport?: readonly MapTransport[];
  readonly doors: readonly MapDoor[];
  readonly discoveries?: readonly LogbookDiscovery[];
  /** The explored staircase enclosure, including its far landing. */
  readonly stair?: { readonly room: number; readonly bounds: Rect; readonly position: MapPoint };
  readonly player?: { readonly room: number; readonly label: string; readonly position: MapPoint };
}

const FLOOR_NAMES = ['Lower Works', 'Upper Works', 'Alchemical Conservatory'] as const;
const INK = '#483320';
const VISITED = '#c0b89b';
const ACTIVE = '#a1ae8e';
const PLAYER = '#85372b';

export interface MapView {
  readonly zoom: number;
  readonly x: number;
  readonly y: number;
}

export const FIT_MAP_VIEW: MapView = { zoom: 1, x: 0, y: 0 };
export const MAP_VIEWPORT = { x: 64, y: 154, width: 576, height: 720 } as const;
const CENTER_X = MAP_VIEWPORT.x + MAP_VIEWPORT.width / 2;
const CENTER_Y = MAP_VIEWPORT.y + MAP_VIEWPORT.height / 2;

function chartLayout(map: LogbookMap) {
  if (!map.rooms.length) return undefined;
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const { bounds } of map.rooms) {
    minX = Math.min(minX, bounds.min[0]);
    maxX = Math.max(maxX, bounds.max[0]);
    minZ = Math.min(minZ, bounds.min[1]);
    maxZ = Math.max(maxZ, bounds.max[1]);
  }
  if (map.stair) {
    minX = Math.min(minX, map.stair.bounds.min[0]);
    maxX = Math.max(maxX, map.stair.bounds.max[0]);
    minZ = Math.min(minZ, map.stair.bounds.min[1]);
    maxZ = Math.max(maxZ, map.stair.bounds.max[1]);
  }
  return {
    x: (minX + maxX) / 2,
    z: (minZ + maxZ) / 2,
    width: maxX - minX,
    height: maxZ - minZ,
    fit: Math.min(
      45,
      (MAP_VIEWPORT.width - 28) / (maxX - minX),
      (MAP_VIEWPORT.height - 50) / (maxZ - minZ),
    ),
  };
}

export function mapViewportContains([x, y]: MapPoint): boolean {
  const bounds = MAP_VIEWPORT;
  return (
    x >= bounds.x && x <= bounds.x + bounds.width && y >= bounds.y && y <= bounds.y + bounds.height
  );
}

export function moveMapView(
  map: LogbookMap,
  view: MapView,
  dx: number,
  dy: number,
  multiplier: number,
  anchor: MapPoint = [CENTER_X, CENTER_Y],
): MapView {
  const layout = chartLayout(map);
  if (!layout) return FIT_MAP_VIEW;
  const zoom = Math.max(1, Math.min(6, view.zoom * multiplier));
  if (zoom === 1) return FIT_MAP_VIEW;
  const ratio = zoom / view.zoom;
  const scale = layout.fit * zoom;
  const limitX = Math.max(0, (layout.width * scale + 28 - MAP_VIEWPORT.width) / 2);
  const limitY = Math.max(0, (layout.height * scale + 50 - MAP_VIEWPORT.height) / 2);
  const x = view.x * ratio + dx + (anchor[0] - CENTER_X) * (1 - ratio);
  const y = view.y * ratio + dy + (anchor[1] - CENTER_Y) * (1 - ratio);
  return {
    zoom,
    x: Math.max(-limitX, Math.min(limitX, x)),
    y: Math.max(-limitY, Math.min(limitY, y)),
  };
}

export function chartFloor(
  floor: LogbookMap['floor'],
  plan: FloorPlan,
  worldRooms: readonly WorldRoom[],
  explored: readonly number[],
  player?: { readonly room: number; readonly position: MapPoint },
  transport: readonly MapTransport[] = [],
  stair?: StairEntry | null,
): LogbookMap {
  const reached = new Set(explored);
  if (player) reached.add(player.room);
  const rooms = plan.rooms.flatMap(({ index }) => {
    const room = worldRooms[index];
    return room && reached.has(index) ? [{ id: index, bounds: room.footprint }] : [];
  });
  const doors = plan.connections.flatMap((connection) => {
    const [a, b] = connection;
    if (!reached.has(a.room) && !reached.has(b.room)) return [];
    if (connection.puzzleGate === 'panel' && !(reached.has(a.room) && reached.has(b.room)))
      return [];
    const door = worldRooms[a.room]?.doors.find(({ id }) => id === a.door);
    return door
      ? [
          {
            center: door.world,
            alongX: door.facing === 'N' || door.facing === 'S',
            width: door.width,
          },
        ]
      : [];
  });
  const here = player && worldRooms[player.room];
  const exploredStair = stair && reached.has(stair.room) ? stair : undefined;
  return {
    floor,
    rooms,
    totalRooms: plan.rooms.length,
    doors,
    transport: transport.filter(({ room }) => reached.has(room)),
    ...(exploredStair && {
      stair: {
        room: exploredStair.room,
        bounds: exploredStair.alcove,
        position: exploredStair.world,
      },
    }),
    ...(here && {
      player: { ...player, label: here.template.id.replaceAll('-', ' ') },
    }),
  };
}

function locationArrow(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  heading: number,
): void {
  context.save();
  context.translate(x, y);
  context.rotate(heading);
  context.beginPath();
  context.moveTo(0, -19);
  context.lineTo(13, 14);
  context.lineTo(0, 8);
  context.lineTo(-13, 14);
  context.closePath();
  context.fillStyle = PLAYER;
  context.fill();
  context.strokeStyle = '#fff0c9';
  context.lineWidth = 3;
  context.stroke();
  context.restore();
}

function transportIcon(
  context: CanvasRenderingContext2D,
  kind: MapTransport['kind'],
  x: number,
  y: number,
): void {
  context.fillStyle = kind === 'stairs' ? '#634b3b' : '#344f4e';
  context.strokeStyle = '#fff0c9';
  context.lineWidth = 3;
  context.fillRect(x - 14, y - 14, 28, 28);
  context.strokeRect(x - 14, y - 14, 28, 28);
  context.beginPath();
  if (kind === 'stairs') {
    context.moveTo(x - 8, y + 5);
    context.lineTo(x - 3, y + 5);
    context.lineTo(x - 3, y);
    context.lineTo(x + 2, y);
    context.lineTo(x + 2, y - 5);
    context.lineTo(x + 8, y - 5);
  } else {
    context.moveTo(x - 6, y - 4);
    context.lineTo(x, y - 9);
    context.lineTo(x + 6, y - 4);
    context.moveTo(x - 6, y + 4);
    context.lineTo(x, y + 9);
    context.lineTo(x + 6, y + 4);
  }
  context.stroke();
}

function discoveryIcon(
  context: CanvasRenderingContext2D,
  kind: LogbookDiscovery['kind'],
  x: number,
  y: number,
): void {
  const chest = kind === 'chest' || kind === 'cache';
  const width = chest ? 25 : 18;
  context.fillStyle = chest ? '#774c27' : '#4d5548';
  context.strokeStyle = '#fff0c9';
  context.lineWidth = 4;
  context.fillRect(x - width / 2, y - 10, width, 20);
  context.strokeRect(x - width / 2, y - 10, width, 20);
  context.fillStyle = '#fff0c9';
  if (chest) context.fillRect(x - 3, y - 1, 6, 6);
  else for (const line of [-4, 2]) context.fillRect(x - 5, y + line, 10, 2);
}

export function paintMapPage(
  context: CanvasRenderingContext2D,
  map: LogbookMap,
  right: boolean,
  view: MapView = FIT_MAP_VIEW,
  showFinds = false,
  heading = 0,
): void {
  context.fillStyle = INK;
  context.textAlign = 'left';
  if (!right) {
    context.font = 'bold 50px Georgia, serif';
    context.fillText('Exploration map', 77, 145, 550);
    context.fillRect(77, 176, 550, 2);
    context.font = '36px Georgia, serif';
    context.fillText(`Floor ${map.floor}`, 77, 253);
    context.font = 'bold 42px Georgia, serif';
    context.fillText(FLOOR_NAMES[map.floor - 1], 77, 314, 550);
    context.fillStyle = VISITED;
    context.fillRect(79, 497, 30, 25);
    context.strokeStyle = INK;
    context.lineWidth = 3;
    context.strokeRect(79, 497, 30, 25);
    context.fillStyle = INK;
    context.font = '34px Georgia, serif';
    context.fillText('Explored room', 131, 521);
    if (map.player) {
      locationArrow(context, 94, 583, 0);
      context.fillStyle = INK;
      context.fillText('You are here', 131, 594);
      context.font = 'italic 30px Georgia, serif';
      context.fillText(map.player.label, 131, 636, 480);
    }
    discoveryIcon(context, 'chest', 94, 683);
    discoveryIcon(context, 'note', 254, 683);
    context.fillStyle = INK;
    context.font = '28px Georgia, serif';
    context.fillText('Chest', 117, 693);
    context.fillText('Clue', 277, 693);
    transportIcon(context, 'stairs', 94, 733);
    transportIcon(context, 'lift', 254, 733);
    context.fillStyle = INK;
    context.fillText('Stairs', 117, 743);
    context.fillText('Lift', 277, 743);
    context.fillText('Desktop · Drag and scroll', 79, 812);
    context.fillText('VR · Pan with the right stick', 79, 851);
    return;
  }

  context.font = '32px Georgia, serif';
  const exploredPercent =
    map.totalRooms > 0 && map.rooms.length === map.totalRooms
      ? 100
      : Math.floor((map.rooms.length / Math.max(1, map.totalRooms)) * 100);
  context.fillText(`${exploredPercent}% of rooms explored`, 77, 105);
  context.font = 'bold 34px Georgia, serif';
  context.textAlign = 'center';
  context.fillText('N', 604, 101);
  context.beginPath();
  context.moveTo(604, 115);
  context.lineTo(593, 139);
  context.lineTo(615, 139);
  context.closePath();
  context.fill();

  const layout = chartLayout(map);
  if (!layout) return;
  const scale = layout.fit * view.zoom;
  const projectX = (x: number) => CENTER_X + view.x + (x - layout.x) * scale;
  const projectZ = (z: number) => CENTER_Y + view.y + (z - layout.z) * scale;

  context.save();
  context.beginPath();
  context.rect(MAP_VIEWPORT.x, MAP_VIEWPORT.y, MAP_VIEWPORT.width, MAP_VIEWPORT.height);
  context.clip();
  for (const { id, bounds } of map.rooms) {
    const x = projectX(bounds.min[0]) + 2;
    const y = projectZ(bounds.min[1]) + 2;
    const w = (bounds.max[0] - bounds.min[0]) * scale - 4;
    const h = (bounds.max[1] - bounds.min[1]) * scale - 4;
    context.fillStyle = id === map.player?.room ? ACTIVE : VISITED;
    context.strokeStyle = INK;
    context.lineWidth = 3;
    context.fillRect(x, y, w, h);
    context.strokeRect(x, y, w, h);
  }
  if (map.stair) {
    const x = projectX(map.stair.bounds.min[0]) + 2;
    const y = projectZ(map.stair.bounds.min[1]) + 2;
    const w = (map.stair.bounds.max[0] - map.stair.bounds.min[0]) * scale - 4;
    const h = (map.stair.bounds.max[1] - map.stair.bounds.min[1]) * scale - 4;
    context.fillStyle = '#8f8068';
    context.globalAlpha = 0.42;
    context.fillRect(x, y, w, h);
    context.globalAlpha = 1;
    context.strokeStyle = INK;
    context.lineWidth = 3;
    context.strokeRect(x, y, w, h);
  }
  context.fillStyle = INK;
  for (const door of map.doors) {
    const x = projectX(door.center[0]);
    const y = projectZ(door.center[1]);
    const width = Math.max(10, door.width * scale);
    if (door.alongX) context.fillRect(x - width / 2, y - 4, width, 8);
    else context.fillRect(x - 4, y - width / 2, 8, width);
  }
  if (showFinds) {
    for (const {
      kind,
      position: [x, z],
    } of map.discoveries ?? []) {
      discoveryIcon(context, kind, projectX(x), projectZ(z));
    }
  }
  for (const {
    kind,
    position: [x, z],
  } of map.transport ?? []) {
    transportIcon(context, kind, projectX(x), projectZ(z));
  }
  if (map.player) {
    const [x, z] = map.player.position;
    locationArrow(context, projectX(x), projectZ(z), heading);
  }
  context.restore();
}
