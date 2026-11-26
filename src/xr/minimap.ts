import * as THREE from 'three';
import {
  discoveryIcon,
  type LogbookMap,
  paintMapMarker,
  transportIcon,
} from '../flow/logbook-map.ts';
import { MINIMAP_PLACEMENT_LIMIT, type Settings } from '../persist/db.ts';

export type MinimapOptions = Pick<
  Settings,
  'minimapHorizontal' | 'minimapVertical' | 'minimapZoom' | 'minimapNorthUp'
>;

const SIZE = 256;
const OVERLAY_DISTANCE = 0.8;
const MARGIN = 0.045;
const DESKTOP_EDGE_MARGIN = 0.012;
const XR_HORIZONTAL_OFFSET = 0.2;
const XR_VERTICAL_OFFSET = 0.24;
const REDRAW_SECONDS = 0.075;
const INK = '#f7e6b5';
const ROOM = 'rgba(247, 230, 181, 0.12)';
const ACTIVE = '#e39a55';
const DOOR = '#b8c9b0';

function axisOffset(value: number, previousLimit: number, outerLimit: number): number {
  const distance = Math.min(MINIMAP_PLACEMENT_LIMIT, Math.abs(value));
  // Keep the original mapping through ±1 so saved positions stay put.
  const offset =
    distance <= 1
      ? distance * previousLimit
      : THREE.MathUtils.lerp(
          previousLimit,
          outerLimit,
          (distance - 1) / (MINIMAP_PLACEMENT_LIMIT - 1),
        );
  return Math.sign(value) * offset;
}

/** A small transparent map rendered in a separate pass after the world. */
export class Minimap {
  readonly scene = new THREE.Scene();
  private readonly quad: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private readonly anchor = new THREE.Group();
  private readonly canvas: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D;
  private readonly texture: THREE.CanvasTexture;
  private readonly width = 0.285;
  private paintedMap: LogbookMap | null = null;
  private mapAge = Infinity;
  private readonly forward = new THREE.Vector3(0, 0, -1);
  private lastZoom = Number.NaN;
  private lastNorthUp = false;
  private lastHeading = Number.NaN;

  constructor() {
    this.scene.name = 'minimap-overlay';
    this.anchor.name = 'minimap-anchor';
    this.anchor.matrixAutoUpdate = false;
    this.canvas = document.createElement('canvas');
    this.canvas.width = SIZE;
    this.canvas.height = SIZE;
    const context = this.canvas.getContext('2d');
    if (!context) throw new Error('2D canvas is not available');
    this.context = context;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.generateMipmaps = false;
    this.quad = new THREE.Mesh(
      new THREE.PlaneGeometry(this.width, this.width),
      new THREE.MeshBasicMaterial({
        map: this.texture,
        transparent: true,
        depthTest: false,
        depthWrite: false,
        toneMapped: false,
      }),
    );
    this.quad.name = 'minimap-overlay';
    this.quad.frustumCulled = false;
    this.quad.renderOrder = 8_500;
    this.quad.position.z = -OVERLAY_DISTANCE;
    this.quad.visible = false;
    this.anchor.add(this.quad);
    this.scene.add(this.anchor);
  }

  update(
    viewer: THREE.Camera,
    dt: number,
    options: MinimapOptions,
    getMap: () => LogbookMap | null,
  ): boolean {
    const { minimapZoom: zoom, minimapNorthUp: northUp } = options;
    const optionsChanged = zoom !== this.lastZoom || northUp !== this.lastNorthUp;
    this.mapAge += dt;
    if (this.mapAge >= REDRAW_SECONDS || optionsChanged) {
      this.mapAge = 0;
      const map = getMap();
      this.lastZoom = zoom;
      this.lastNorthUp = northUp;
      this.quad.visible = !!map?.player;
      if (!map?.player) {
        this.paintedMap = null;
        return false;
      }
      this.forward.set(0, 0, -1).transformDirection(viewer.matrixWorld);
      const heading = Math.atan2(this.forward.x, -this.forward.z);
      const previous = this.paintedMap;
      const lastPlayer = previous?.player;
      if (
        optionsChanged ||
        map.floor !== previous?.floor ||
        !lastPlayer ||
        map.player.room !== lastPlayer.room ||
        Math.abs(map.player.position[0] - lastPlayer.position[0]) > 0.025 ||
        Math.abs(map.player.position[1] - lastPlayer.position[1]) > 0.025 ||
        Math.abs(heading - this.lastHeading) > 0.012 ||
        map.rooms.length !== previous.rooms.length ||
        map.rooms.some((room, index) => room.bounds !== previous.rooms[index].bounds) ||
        map.doors.length !== previous.doors.length ||
        map.transport?.length !== previous.transport?.length ||
        map.discoveries?.length !== previous.discoveries?.length ||
        map.discoveries?.some((item, index) => item.id !== previous.discoveries?.[index]?.id) ||
        map.personalMarkers?.length !== previous.personalMarkers?.length ||
        map.personalMarkers?.some(({ icon, position: [x, z] }, index) => {
          const marker = previous.personalMarkers?.[index];
          return marker?.icon !== icon || marker.position[0] !== x || marker.position[1] !== z;
        })
      ) {
        this.paint(map, zoom, northUp, heading);
        this.paintedMap = map;
        this.lastHeading = heading;
      }
    }
    if (!this.quad.visible) return false;
    this.place(viewer, options.minimapHorizontal, options.minimapVertical);
    return true;
  }

  hide(): void {
    this.quad.visible = false;
    this.paintedMap = null;
    this.mapAge = Infinity;
  }

  dispose(): void {
    this.hide();
    this.quad.geometry.dispose();
    this.quad.material.dispose();
    this.texture.dispose();
  }

  private place(viewer: THREE.Camera, horizontal: number, vertical: number): void {
    this.anchor.matrix.copy(viewer.matrixWorld);
    const projection = viewer.projectionMatrix.elements;
    // Leave room for both eye frusta. ArrayCamera's matrix is already supplied by WebXRManager.
    const immersive = viewer instanceof THREE.ArrayCamera;
    const viewInset = immersive ? 0.82 : 1;
    const halfWidth = (OVERLAY_DISTANCE * viewInset) / Math.abs(projection[0]);
    const halfHeight = (OVERLAY_DISTANCE * viewInset) / Math.abs(projection[5]);
    const size = Math.min(this.width, Math.max(0, Math.min(halfWidth, halfHeight) - MARGIN));
    this.quad.scale.setScalar(size / this.width);
    const half = size / 2;
    const x = Math.max(0, halfWidth - half - MARGIN);
    const y = Math.max(0, halfHeight - half - MARGIN);
    const previousX = immersive ? Math.min(x, XR_HORIZONTAL_OFFSET) : x;
    const previousY = immersive ? Math.min(y, XR_VERTICAL_OFFSET) : y;
    const outerX = immersive
      ? Math.min(x, XR_HORIZONTAL_OFFSET * MINIMAP_PLACEMENT_LIMIT)
      : Math.max(0, halfWidth - half - DESKTOP_EDGE_MARGIN);
    const outerY = immersive
      ? Math.min(y, XR_VERTICAL_OFFSET * MINIMAP_PLACEMENT_LIMIT)
      : Math.max(0, halfHeight - half - DESKTOP_EDGE_MARGIN);
    this.quad.position.set(
      axisOffset(horizontal, previousX, outerX),
      axisOffset(vertical, previousY, outerY),
      -OVERLAY_DISTANCE,
    );
    this.anchor.matrixWorldNeedsUpdate = true;
    this.scene.updateMatrixWorld(true);
  }

  private paint(map: LogbookMap, zoom: number, northUp: boolean, heading: number): void {
    const ctx = this.context;
    ctx.clearRect(0, 0, SIZE, SIZE);
    const [px, pz] = map.player?.position ?? [0, 0];
    const scale = 13 * zoom;
    const angle = northUp ? 0 : -heading;
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    const project = (x: number, z: number): [number, number] => {
      const dx = x - px;
      const dz = z - pz;
      return [128 + (dx * c - dz * s) * scale, 128 + (dx * s + dz * c) * scale];
    };
    ctx.save();
    ctx.beginPath();
    ctx.rect(2, 2, SIZE - 4, SIZE - 4);
    ctx.clip();
    for (const { id, bounds } of map.rooms) {
      const [x0, y0] = project(bounds.min[0], bounds.min[1]);
      const [x1, y1] = project(bounds.max[0], bounds.min[1]);
      const [x2, y2] = project(bounds.max[0], bounds.max[1]);
      const [x3, y3] = project(bounds.min[0], bounds.max[1]);
      ctx.fillStyle = id === map.player?.room ? 'rgba(227, 154, 85, 0.2)' : ROOM;
      ctx.strokeStyle = id === map.player?.room ? ACTIVE : INK;
      ctx.lineWidth = id === map.player?.room ? 2 : 1.25;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.lineTo(x3, y3);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
    if (map.stair) {
      const [x0, y0] = project(map.stair.bounds.min[0], map.stair.bounds.min[1]);
      const [x1, y1] = project(map.stair.bounds.max[0], map.stair.bounds.min[1]);
      const [x2, y2] = project(map.stair.bounds.max[0], map.stair.bounds.max[1]);
      const [x3, y3] = project(map.stair.bounds.min[0], map.stair.bounds.max[1]);
      ctx.fillStyle = 'rgba(143, 128, 104, 0.42)';
      ctx.strokeStyle = INK;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.lineTo(x3, y3);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
    ctx.strokeStyle = DOOR;
    ctx.lineWidth = 2;
    for (const door of map.doors) {
      const half = door.width / 2;
      const [x0, y0] = door.alongX
        ? project(door.center[0] - half, door.center[1])
        : project(door.center[0], door.center[1] - half);
      const [x1, y1] = door.alongX
        ? project(door.center[0] + half, door.center[1])
        : project(door.center[0], door.center[1] + half);
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
    }
    for (const transport of map.transport ?? []) {
      const [x, y] = project(transport.position[0], transport.position[1]);
      ctx.save();
      ctx.translate(x, y);
      ctx.scale(0.42, 0.42);
      transportIcon(ctx, transport.kind, 0, 0);
      ctx.restore();
    }
    for (const discovery of map.discoveries ?? []) {
      const [x, y] = project(discovery.position[0], discovery.position[1]);
      ctx.save();
      ctx.translate(x, y);
      ctx.scale(0.42, 0.42);
      discoveryIcon(ctx, discovery.kind, 0, 0);
      ctx.restore();
    }
    for (const {
      icon,
      position: [worldX, worldZ],
    } of map.personalMarkers ?? []) {
      const [x, y] = project(worldX, worldZ);
      ctx.save();
      ctx.translate(x, y);
      const markerScale = 0.55 * zoom;
      ctx.scale(markerScale, markerScale);
      paintMapMarker(ctx, icon, 0, 0);
      ctx.restore();
    }
    ctx.restore();
    const arrowAngle = northUp ? heading : 0;
    ctx.save();
    ctx.translate(128, 128);
    ctx.rotate(arrowAngle);
    ctx.scale(zoom, zoom);
    ctx.fillStyle = ACTIVE;
    ctx.strokeStyle = '#fff4d0';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(0, -13);
    ctx.lineTo(7, 8);
    ctx.lineTo(0, 4);
    ctx.lineTo(-7, 8);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
    const northX = Math.sin(angle);
    const northY = -Math.cos(angle);
    const compassX = 220;
    const compassY = 32;
    ctx.strokeStyle = INK;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(compassX, compassY);
    ctx.lineTo(compassX + northX * 13, compassY + northY * 13);
    ctx.stroke();
    ctx.fillStyle = INK;
    ctx.font = 'bold 12px Georgia, serif';
    ctx.textAlign = 'center';
    ctx.fillText('N', compassX + northX * 18, compassY + northY * 18 + 4);
    this.texture.needsUpdate = true;
  }
}
