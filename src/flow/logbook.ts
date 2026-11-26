import * as THREE from 'three';
import { configureTextTexture, measuredLines } from '../combat-view/canvas-label.ts';
import type { LogbookEntry } from '../rules/logbook.ts';
import { reliquaryGlyph } from '../rules/reliquary.ts';
import {
  FIT_MAP_VIEW,
  type LogbookMap,
  type MapMarkerTool,
  type MapMarkerView,
  type MapPoint,
  type MapView,
  mapMarkerIndex,
  mapMarkerPosition,
  mapMarkerToolAt,
  mapViewportContains,
  moveMapView,
  paintMapPage,
} from './logbook-map.ts';
import type { ActivePuzzlePage } from './logbook-puzzles.ts';
import type { LogbookCardRow } from './logbook-run-pages.ts';
import type { MapMarker } from './map-markers.ts';

const PAGE_WIDTH = 0.435;
const PAGE_HEIGHT = 0.59;
const TURN_SECONDS = 0.54;
const MAP_REDRAW_SECONDS = 1 / 30;
const PAPER_WIDTH = 704;
const PAPER_HEIGHT = 944;

function paperGeometry(): THREE.PlaneGeometry {
  return new THREE.PlaneGeometry(PAGE_WIDTH, PAGE_HEIGHT, 24, 1);
}

/** Map a leaf around a fixed spine. Curl is strongest during the middle of the turn. */
function poseLeaf(
  geometry: THREE.PlaneGeometry,
  angle: number,
  curl: number,
  reverse: boolean,
  depth: number,
): void {
  const positions = geometry.getAttribute('position');
  const uv = geometry.getAttribute('uv');
  for (let i = 0; i < positions.count; i++) {
    const u = reverse ? 1 - uv.getX(i) : uv.getX(i);
    const bend = angle + u * curl;
    const distance = u * PAGE_WIDTH;
    positions.setXYZ(
      i,
      distance * Math.cos(bend),
      (uv.getY(i) - 0.5) * PAGE_HEIGHT,
      depth + distance * Math.sin(bend),
    );
  }
  positions.needsUpdate = true;
  geometry.computeBoundingSphere();
}

function paintParchment(context: CanvasRenderingContext2D, right: boolean): void {
  const wash = context.createLinearGradient(right ? 0 : PAPER_WIDTH, 0, right ? PAPER_WIDTH : 0, 0);
  wash.addColorStop(0, '#9e7a55');
  wash.addColorStop(0.08, '#dbc397');
  wash.addColorStop(0.23, '#f5e6c3');
  wash.addColorStop(0.82, '#f1dfb7');
  wash.addColorStop(1, '#d6b788');
  context.fillStyle = wash;
  context.fillRect(0, 0, PAPER_WIDTH, PAPER_HEIGHT);
  context.strokeStyle = '#a3815b';
  context.lineWidth = 2;
  context.strokeRect(42, 35, 620, 872);
}

export type BookPagePainter = ((context: CanvasRenderingContext2D) => void) & {
  readonly cardRows?: readonly LogbookCardRow[];
};

export function createLogbookHandSwipes() {
  return {
    left: { armed: false, fired: false, startX: 0, pageSide: 0 as 0 | 1 },
    right: { armed: false, fired: false, startX: 0, pageSide: 0 as 0 | 1 },
  };
}

interface BookSections {
  readonly maps?: readonly LogbookMap[];
  readonly pages?: readonly BookPagePainter[];
  readonly mapViews?: Map<number, MapView>;
  readonly showFinds?: boolean;
  readonly mapHeading?: () => number;
  readonly handSwipe?: ReturnType<typeof createLogbookHandSwipes>;
  readonly onTurn?: (root: THREE.Group) => void;
  readonly mapMarkers?: {
    read: (floor: number) => readonly MapMarker[];
    add: (floor: number, marker: MapMarker) => boolean;
    remove: (floor: number, index: number) => boolean;
  };
}

export function puzzlePage(clue: ActivePuzzlePage): BookPagePainter {
  return (context) => {
    context.fillStyle = '#3d291f';
    context.font = '30px Georgia, serif';
    context.fillText(clue.resolved ? `${clue.puzzle} · Resolved` : clue.puzzle, 77, 111, 550);
    context.font = 'bold 46px Georgia, serif';
    let y = 184;
    for (const line of measuredLines(context, clue.title, 550)) {
      context.fillText(line, 77, y);
      y += 54;
    }
    context.fillRect(77, y - 34, 550, 2);
    context.font = '36px Georgia, serif';
    y += 34;
    for (const line of measuredLines(context, clue.text, 550)) {
      context.fillText(line, 77, y);
      y += 48;
    }
    if (clue.glyphPoints) {
      context.beginPath();
      for (const [i, point] of clue.glyphPoints.entries()) {
        const x = 352 + point.x * 305;
        const z = 565 - point.y * 305;
        if (i === 0) context.moveTo(x, z);
        else context.lineTo(x, z);
      }
      context.strokeStyle = '#61422a';
      context.lineCap = 'round';
      context.lineJoin = 'round';
      context.lineWidth = 12;
      context.stroke();
    }
    if (clue.origin) {
      context.font = 'italic 27px Georgia, serif';
      context.fillText(clue.origin, 77, 817, 550);
    }
  };
}

function paperTexture(
  entry: LogbookEntry | undefined,
  index: number,
  seed: string,
  empty: boolean,
  map: LogbookMap | undefined,
  view: MapView | undefined,
  showFinds: boolean,
  render: BookPagePainter | undefined,
  heading: number,
  mark?: MapMarkerView,
): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = PAPER_WIDTH;
  canvas.height = PAPER_HEIGHT;
  const context = canvas.getContext('2d');
  if (context) {
    const right = index % 2 === 1;
    paintParchment(context, right);
    context.fillStyle = '#3d291f';
    context.font = 'bold 46px Georgia, serif';
    if (map) paintMapPage(context, map, right, view, showFinds, heading, mark);
    else if (render) render(context);
    else if (entry) {
      let y = 131;
      for (const line of measuredLines(context, entry.title, 548)) {
        context.fillText(line, 77, y);
        y += 54;
      }
      context.fillRect(77, y - 34, 550, 2);
      context.font = '37px Georgia, serif';
      y += 35;
      for (const line of measuredLines(context, entry.body, 550)) {
        context.fillText(line, 77, y);
        y += 49;
      }
      if (entry.id === 'reliquary-rubbing') {
        const glyph = reliquaryGlyph(seed);
        context.beginPath();
        glyph.points.forEach(({ x, y }, i) => {
          const px = 352 + x * 305;
          const py = 570 - y * 305;
          if (i === 0) context.moveTo(px, py);
          else context.lineTo(px, py);
        });
        context.lineWidth = 12;
        context.lineJoin = 'round';
        context.lineCap = 'round';
        context.stroke();
      }
      context.font = 'italic 27px Georgia, serif';
      y = 782;
      for (const line of measuredLines(context, entry.origin, 550)) {
        context.fillText(line, 77, y);
        y += 34;
      }
      context.font = '27px Georgia, serif';
      context.textAlign = 'center';
      context.fillText(String(index + 1), 352, 882);
    } else if (empty && index === 0) {
      context.fillText('Logbook', 77, 148);
      context.font = '37px Georgia, serif';
      const lines = measuredLines(context, 'Clues you read in the Spire are kept here.', 550);
      for (const [i, line] of lines.entries()) context.fillText(line, 77, 255 + 49 * i);
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  configureTextTexture(texture);
  return texture;
}

export class Logbook {
  readonly root = new THREE.Group();
  readonly cardTargets = new THREE.Group();
  private readonly rowGeometry = new THREE.PlaneGeometry(
    (550 / PAPER_WIDTH) * PAGE_WIDTH,
    (55 / PAPER_HEIGHT) * PAGE_HEIGHT,
  );
  private readonly rowIdle = new THREE.MeshBasicMaterial({ visible: false });
  private readonly rowHover = new THREE.MeshBasicMaterial({
    color: 0x926534,
    transparent: true,
    opacity: 0.16,
    depthWrite: false,
  });
  private heading = 0;
  private readonly textures = new Map<number, THREE.CanvasTexture>();
  private readonly pages = [this.leaf('logbook-left-page'), this.leaf('logbook-right-page')];
  private readonly faces = [this.leaf('logbook-turn-front'), this.leaf('logbook-turn-back')];
  private spread: number;
  private readonly mapViews: Map<number, MapView>;
  private showFinds: boolean;
  private readonly pageTransform = new THREE.Matrix4();
  private readonly pageRay = new THREE.Ray();
  private readonly pagePlane = new THREE.Plane(new THREE.Vector3(0, 0, 1));
  private readonly pageHit = new THREE.Vector3();
  private readonly pagePicker = new THREE.Raycaster();
  private readonly handSwipe: ReturnType<typeof createLogbookHandSwipes>;
  private markerTool: MapMarkerTool | null = null;
  private mapDirty = false;
  private mapRedrawAge = MAP_REDRAW_SECONDS;
  private turnState:
    | { offset: -1 | 1; age: number; next: number; outgoing?: readonly THREE.Texture[] }
    | undefined;
  private turnBoundary: -1 | 1 | null = null;

  constructor(
    private readonly entries: readonly LogbookEntry[],
    private readonly seed: string,
    openedAt: number,
    private readonly sections: BookSections = {},
  ) {
    this.handSwipe = sections.handSwipe ?? createLogbookHandSwipes();
    this.spread = Math.floor(openedAt / 2);
    this.root.name = 'keeper-logbook';
    this.mapViews = sections.mapViews ?? new Map();
    this.showFinds = sections.showFinds ?? false;
    this.heading = sections.mapHeading?.() ?? 0;
    this.root.add(this.cardTargets);
    const cover = new THREE.MeshBasicMaterial({ color: 0x472721, toneMapped: false });
    const lining = new THREE.MeshBasicMaterial({ color: 0x754932, toneMapped: false });
    const edges = new THREE.MeshBasicMaterial({ color: 0xb3976e, toneMapped: false });
    for (const side of [-1, 1]) {
      const x = side * PAGE_WIDTH * 0.5;
      this.box(PAGE_WIDTH + 0.014, PAGE_HEIGHT + 0.044, 0.018, x + side * 0.012, -0.037, cover);
      this.box(PAGE_WIDTH + 0.008, PAGE_HEIGHT + 0.018, 0.005, x + side * 0.007, -0.028, lining);
      this.box(PAGE_WIDTH - 0.006, PAGE_HEIGHT - 0.003, 0.021, x, -0.015, edges);
      for (const z of [-0.023, -0.016, -0.009])
        this.box(PAGE_WIDTH - 0.004, PAGE_HEIGHT, 0.001, x, z, lining);
    }
    const spine = new THREE.Mesh(
      new THREE.CylinderGeometry(0.023, 0.023, PAGE_HEIGHT + 0.044, 12),
      cover,
    );
    spine.position.z = -0.026;
    spine.name = 'logbook-spine';
    this.root.add(spine);
    poseLeaf(this.pages[0].geometry, Math.PI, -0.026, true, 0);
    poseLeaf(this.pages[1].geometry, 0, 0.026, false, 0);
    for (const face of this.faces) face.visible = false;
    this.showSpread();
  }

  private box(
    width: number,
    height: number,
    depth: number,
    x: number,
    z: number,
    material: THREE.MeshBasicMaterial,
  ): void {
    const part = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), material);
    part.position.set(x, 0, z);
    this.root.add(part);
  }

  private leaf(name: string): THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial> {
    const page = new THREE.Mesh(
      paperGeometry(),
      new THREE.MeshBasicMaterial({ toneMapped: false }),
    );
    page.name = name;
    page.frustumCulled = false;
    this.root.add(page);
    return page;
  }

  private print(page: (typeof this.pages)[number], index: number): void {
    let texture = this.textures.get(index);
    const map = this.sections.maps?.[Math.floor(index / 2)];
    if (!texture) {
      texture = paperTexture(
        this.entries[index],
        index,
        this.seed,
        !this.entries.length && !this.sections.pages,
        map,
        this.mapViews.get(Math.floor(index / 2)),
        this.showFinds,
        this.sections.pages?.[index],
        this.heading,
        this.markerView(map),
      );
      this.textures.set(index, texture);
    }
    page.material.map = texture;
    page.material.needsUpdate = true;
    page.userData.clueId = this.entries[index]?.id;
    page.userData.map = this.sections.maps?.[Math.floor(index / 2)];
    page.userData.showFinds = this.showFinds;
    page.userData.mapView = this.sections.maps
      ? (this.mapViews.get(Math.floor(index / 2)) ?? FIT_MAP_VIEW)
      : undefined;
  }

  private showSpread(): void {
    this.print(this.pages[0], this.spread * 2);
    this.print(this.pages[1], this.spread * 2 + 1);
    this.cardTargets.clear();
    for (const side of [0, 1]) {
      const index = this.spread * 2 + side;
      const rows = this.sections.pages?.[index]?.cardRows ?? [];
      for (const [row, { id, baseline }] of rows.entries()) {
        const hit = new THREE.Mesh(this.rowGeometry, this.rowIdle);
        hit.name = `logbook-card-${index}-${row}`;
        hit.userData.cardId = id;
        hit.position.set(
          (side - 0.5) * PAGE_WIDTH,
          (0.5 - baseline / PAPER_HEIGHT) * PAGE_HEIGHT,
          0.014,
        );
        this.cardTargets.add(hit);
      }
    }
  }

  get page(): number {
    return this.spread * 2;
  }

  get turning(): boolean {
    return this.turnState !== undefined;
  }

  takeBoundary(): -1 | 1 | null {
    const boundary = this.turnBoundary;
    this.turnBoundary = null;
    return boundary;
  }

  cardFor(control: string): string | undefined {
    return this.cardTargets.getObjectByName(control)?.userData.cardId;
  }

  hoverCard(control: string, hovered: boolean): void {
    const row = this.cardTargets.getObjectByName(control);
    if (row instanceof THREE.Mesh) row.material = hovered ? this.rowHover : this.rowIdle;
  }

  mapPoint(ray: THREE.Ray, inside = true): MapPoint | null {
    if (!this.sections.maps || this.turnState) return null;
    const page = this.pages[1];
    page.updateWorldMatrix(true, false);
    this.pageTransform.copy(page.matrixWorld).invert();
    this.pageRay.copy(ray).applyMatrix4(this.pageTransform);
    if (!this.pageRay.intersectPlane(this.pagePlane, this.pageHit)) return null;
    const point: MapPoint = [
      (this.pageHit.x / PAGE_WIDTH) * PAPER_WIDTH,
      (0.5 - this.pageHit.y / PAGE_HEIGHT) * PAPER_HEIGHT,
    ];
    return !inside || mapViewportContains(point) ? point : null;
  }

  private markerView(map: LogbookMap | undefined): MapMarkerView | undefined {
    if (!map || !this.sections.mapMarkers) return undefined;
    return { tool: this.markerTool, markers: this.sections.mapMarkers.read(map.floor) };
  }

  private clickedPagePoint(ray: THREE.Ray, side: 0 | 1): MapPoint | null {
    const page = this.pages[side];
    page.updateWorldMatrix(true, false);
    this.pagePicker.ray.copy(ray);
    const uv = this.pagePicker.intersectObject(page, false)[0]?.uv;
    return uv ? [uv.x * PAPER_WIDTH, (1 - uv.y) * PAPER_HEIGHT] : null;
  }

  private setMarkerTool(tool: MapMarkerTool | null): void {
    if (this.markerTool === tool) return;
    this.markerTool = tool;
    const map = this.sections.maps?.[this.spread];
    const texture = this.textures.get(this.spread * 2);
    if (!map || !texture) return;
    const context = (texture.image as HTMLCanvasElement).getContext('2d');
    if (!context) return;
    paintParchment(context, false);
    paintMapPage(
      context,
      map,
      false,
      undefined,
      this.showFinds,
      this.heading,
      this.markerView(map),
    );
    texture.needsUpdate = true;
  }

  selectMarkerTool(ray: THREE.Ray): boolean {
    if (!this.sections.maps || !this.sections.mapMarkers || this.turnState) return false;
    const point = this.clickedPagePoint(ray, 0);
    const tool = point && mapMarkerToolAt(point);
    if (!tool) return false;
    this.setMarkerTool(tool === this.markerTool ? null : tool);
    return true;
  }

  applyMapMarker(ray: THREE.Ray): boolean {
    const map = this.sections.maps?.[this.spread];
    const edits = this.sections.mapMarkers;
    const tool = this.markerTool;
    if (!map || !edits || !tool || this.turnState) return false;
    const point = this.clickedPagePoint(ray, 1);
    if (!point || !mapViewportContains(point)) return false;
    const view = this.mapViews.get(this.spread) ?? FIT_MAP_VIEW;
    let changed: boolean;
    if (tool === 'erase') {
      changed = edits.remove(map.floor, mapMarkerIndex(map, view, edits.read(map.floor), point));
    } else {
      const position = mapMarkerPosition(map, view, point);
      changed = position !== null && edits.add(map.floor, { icon: tool, position });
    }
    if (changed) {
      this.setMarkerTool(null);
      this.mapDirty = true;
    }
    return true;
  }

  adjustMap(dx: number, dy: number, multiplier = 1, anchor?: MapPoint): void {
    const map = this.sections.maps?.[this.spread];
    if (!map || this.turnState) return;
    const previous = this.mapViews.get(this.spread) ?? FIT_MAP_VIEW;
    const view = moveMapView(map, previous, dx, dy, multiplier, anchor);
    if (previous.zoom === view.zoom && previous.x === view.x && previous.y === view.y) return;
    this.mapViews.set(this.spread, view);
    this.mapDirty = true;
  }

  fitMap(): void {
    if (!this.sections.maps || this.turnState || !this.mapViews.delete(this.spread)) return;
    this.mapDirty = true;
  }

  setMapFinds(show: boolean): boolean {
    if (!this.sections.maps || this.turnState) return false;
    this.showFinds = show;
    this.mapDirty = true;
    for (const [index, texture] of this.textures) {
      if (index % 2 === 0 || index === this.spread * 2 + 1) continue;
      texture.dispose();
      this.textures.delete(index);
    }
    return true;
  }

  private redrawMap(): void {
    const map = this.sections.maps?.[this.spread];
    const texture = this.textures.get(this.spread * 2 + 1);
    if (!this.mapDirty || !map || !texture) return;
    this.mapDirty = false;
    this.mapRedrawAge = 0;
    const view = this.mapViews.get(this.spread) ?? FIT_MAP_VIEW;
    const context = (texture.image as HTMLCanvasElement).getContext('2d');
    if (context) {
      paintParchment(context, true);
      paintMapPage(context, map, true, view, this.showFinds, this.heading, this.markerView(map));
      texture.needsUpdate = true;
    }
    this.pages[1].userData.mapView = view;
    this.pages[1].userData.showFinds = this.showFinds;
  }

  turn(offset: -1 | 1, reduced: boolean): boolean {
    this.turnBoundary = null;
    const next = this.spread + offset;
    const spreadPages = this.sections.pages?.length ?? this.entries.length;
    const spreads = Math.max(1, this.sections.maps?.length ?? Math.ceil(spreadPages / 2));
    if (this.turnState) return false;
    if (next < 0 || next >= spreads) {
      this.turnBoundary = offset;
      return false;
    }
    this.setMarkerTool(null);
    this.redrawMap();
    if (reduced) {
      this.spread = next;
      this.showSpread();
      this.sections.onTurn?.(this.root);
      return true;
    }
    const forward = offset > 0;
    const lifted = forward ? 1 : 0;
    this.print(this.faces[0], this.spread * 2 + lifted);
    this.print(this.faces[1], next * 2 + (1 - lifted));
    this.print(this.pages[lifted], next * 2 + lifted);
    this.beginTurn(offset, next);
    this.sections.onTurn?.(this.root);
    return true;
  }

  spreadTextures(): readonly [THREE.Texture, THREE.Texture] | null {
    this.redrawMap();
    const [left, right] = this.pages;
    const leftMap = left.material.map;
    const rightMap = right.material.map;
    return leftMap && rightMap ? [leftMap, rightMap] : null;
  }

  /** Lifts the old section's outer page to expose the destination section beneath it. */
  animateBoundary(offset: -1 | 1, outgoing: readonly [THREE.Texture, THREE.Texture]): void {
    const lifted = offset > 0 ? 1 : 0;
    const still = 1 - lifted;
    const oldLeaf = outgoing[lifted].clone();
    const oldRestingLeaf = outgoing[still].clone();
    this.faces[0].material.map = oldLeaf;
    this.faces[0].material.needsUpdate = true;
    this.pages[still].material.map = oldRestingLeaf;
    this.print(this.faces[1], this.spread * 2 + still);
    this.beginTurn(offset, this.spread, [oldLeaf, oldRestingLeaf]);
  }

  private beginTurn(offset: -1 | 1, next: number, outgoing?: readonly THREE.Texture[]): void {
    this.cardTargets.clear();
    this.turnState = { offset, next, age: 0, outgoing };
    for (const face of this.faces) face.visible = true;
    this.update(0);
  }

  /** Turns when a pointer ray lands in the narrow outer margin of a visible page. */
  tapEdge(ray: THREE.Ray, reduced: boolean): boolean {
    if (this.turnState) return false;
    const left = this.clickedPagePoint(ray, 0);
    if (left && left[0] < PAPER_WIDTH * 0.08) return this.turn(-1, reduced);
    const right = this.clickedPagePoint(ray, 1);
    if (right && right[0] > PAPER_WIDTH * 0.92) return this.turn(1, reduced);
    return false;
  }

  /** Samples one tracked index fingertip and consumes one deliberate inward edge swipe. */
  sampleHand(side: 'left' | 'right', point: THREE.Vector3 | null, reduced: boolean): boolean {
    const state = this.handSwipe[side];
    if (!point) {
      state.armed = false;
      state.fired = false;
      return false;
    }
    if (this.turnState) return state.fired;
    let pageSide: 0 | 1 | null = null;
    let distance = 0;
    for (const candidate of [0, 1] as const) {
      const page = this.pages[candidate];
      page.updateWorldMatrix(true, false);
      const candidateLocal = page.worldToLocal(point.clone());
      const outward = candidate === 0 ? -candidateLocal.x : candidateLocal.x;
      if (
        candidateLocal.y >= -PAGE_HEIGHT * 0.62 &&
        candidateLocal.y <= PAGE_HEIGHT * 0.62 &&
        Math.abs(candidateLocal.z) <= 0.075 &&
        outward >= -PAGE_WIDTH * 0.04 &&
        outward <= PAGE_WIDTH * 1.04
      ) {
        pageSide = candidate;
        distance = outward;
        break;
      }
    }
    if (pageSide === null) {
      state.armed = false;
      state.fired = false;
      return false;
    }
    if (!state.armed) {
      if (distance < PAGE_WIDTH * 0.92) return false;
      state.armed = true;
      state.fired = false;
      state.pageSide = pageSide;
      state.startX = distance;
      return true;
    }
    if (state.fired) return true;
    if (pageSide !== state.pageSide) {
      state.armed = false;
      return false;
    }
    const inward = state.startX - distance;
    if (inward < PAGE_WIDTH * 0.18) return true;
    state.fired = true;
    this.turn(state.pageSide === 0 ? -1 : 1, reduced);
    return true;
  }

  update(dt: number): void {
    if (this.sections.maps?.[this.spread]?.player && this.sections.mapHeading && !this.turnState) {
      const heading = this.sections.mapHeading();
      if (Math.abs(Math.sin((heading - this.heading) / 2)) > 0.014) {
        this.heading = heading;
        this.mapDirty = true;
      }
    }
    if (this.mapDirty) {
      this.mapRedrawAge += Math.max(0, dt);
      if (this.mapRedrawAge >= MAP_REDRAW_SECONDS) this.redrawMap();
    }
    const turn = this.turnState;
    if (!turn) return;
    turn.age = Math.min(TURN_SECONDS, turn.age + Math.max(0, dt));
    if (turn.age === TURN_SECONDS) {
      this.spread = turn.next;
      this.turnState = undefined;
      this.showSpread();
      this.mapDirty = Boolean(this.sections.maps?.[this.spread]?.player);
      for (const face of this.faces) face.visible = false;
      if (turn.outgoing) {
        this.faces[0].material.map = null;
        for (const texture of turn.outgoing) texture.dispose();
      }
      return;
    }
    const t = THREE.MathUtils.smoothstep(turn.age, 0, TURN_SECONDS);
    const forward = turn.offset > 0;
    const angle = (forward ? t : 1 - t) * Math.PI;
    const curl = (forward ? 1 : -1) * 0.27 * Math.sin(Math.PI * t);
    poseLeaf(this.faces[0].geometry, angle, curl, !forward, 0.007);
    poseLeaf(this.faces[1].geometry, angle, curl, forward, 0.007);
  }

  dispose(): void {
    this.root.removeFromParent();
    for (const texture of this.turnState?.outgoing ?? []) texture.dispose();
    this.cardTargets.clear();
    this.rowGeometry.dispose();
    this.rowIdle.dispose();
    this.rowHover.dispose();
    const materials = new Set<THREE.Material>();
    for (const part of this.root.children) {
      if (!(part instanceof THREE.Mesh)) continue;
      part.geometry.dispose();
      materials.add(part.material);
    }
    for (const material of materials) material.dispose();
    for (const texture of this.textures.values()) texture.dispose();
  }
}
