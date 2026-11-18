/**
 * Quest 3 playtest 2026-11-17: "in combat the user info hud often overlaps the huds of enemies".
 * Every encounter in the content, on the enemy layouts the placement can produce (spread scales 1
 * to 0.25, 2 to 3 m beyond the table, tables 0.5 to 1.3 m from the seat), opened as a real combat
 * session with each enemy's shipped manifest bounds. Every panel (the player's status panel and each
 * enemy readout) is projected through the seat camera (both Quest 3 eyes) for the XR layout, and
 * through the framed desktop view after `fitHudToView`, and no two rectangles may overlap.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as THREE from 'three';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CombatSession, chooseEncounter } from '../src/combat/combat-session.ts';
import {
  type CombatRoom,
  placeEnemies,
  type TablePose,
  tableHeightFor,
  WAIST_DROP,
} from '../src/combat/placement.ts';
import { crownBounds, READOUT_MARGIN, readoutCentreY } from '../src/combat-view/index.ts';
import { readoutCorners, readoutHeightsClear } from '../src/combat-view/panel-layout.ts';
import { ENCOUNTERS, type Encounter, type EncounterTier } from '../src/content/enemies.ts';
import { ActionBus } from '../src/core/actions.ts';
import { fitCombatFraming } from '../src/desktop/combat-framing.ts';
import type { SentryActor } from '../src/enemies/sentry-asset.ts';

const DEG = Math.PI / 180;

interface Manifest {
  bounds: { min: number[]; max: number[] };
  sockets: Record<string, { position: number[] } | undefined>;
}
const manifests = new Map<string, Manifest>();
const manifest = (kind: string): Manifest => {
  let m = manifests.get(kind);
  if (!m) {
    m = JSON.parse(
      readFileSync(
        join(process.cwd(), `public/assets/enemies/${kind}/${kind}.manifest.json`),
        'utf8',
      ),
    ) as Manifest;
    manifests.set(kind, m);
  }
  return m;
};

/** An actor stand-in carrying a kind's shipped manifest: all the session reads while it lays out. */
const stubActor = (kind: string): SentryActor =>
  ({
    asset: { manifest: manifest(kind) },
    onEvent: null,
    dead: false,
    disposed: false,
    socket: () => null,
  }) as unknown as SentryActor;

/** A do-nothing 2D context, so the canvas labels (status panel, readouts) exist in happy-dom. */
function stubCanvas2d(): void {
  const handler: ProxyHandler<object> = {
    get: (_target, key) =>
      key === 'measureText'
        ? (text: string) => ({ width: String(text).length * 10 })
        : () => new Proxy({}, handler),
    set: () => true,
  };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    () => new Proxy({}, handler) as unknown as CanvasRenderingContext2D,
  );
}

const OPEN_ROOM: CombatRoom = {
  footprint: { min: [-40, -40], max: [40, 40] },
  walkable: [{ min: [-40, -40], max: [40, 40] }],
  colliders: [],
};

/** A seed whose room 1 of `tier` with `count` bodies plays `encounter` (the session picks by seed). */
function seedFor(encounter: Encounter): string {
  for (let i = 0; i < 500; i++) {
    const seed = `HUDCLR${i.toString().padStart(2, '0')}`;
    if (chooseEncounter(seed, 1, encounter.tier, encounter.enemies.length).id === encounter.id)
      return seed;
  }
  throw new Error(`no seed plays ${encounter.id}`);
}

interface Rect {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}
function rectOf(camera: THREE.Camera, points: readonly THREE.Vector3[]): Rect {
  camera.updateMatrixWorld(true);
  const ndc = points.map((p) => p.clone().project(camera));
  return {
    x0: Math.min(...ndc.map((p) => p.x)),
    x1: Math.max(...ndc.map((p) => p.x)),
    y0: Math.min(...ndc.map((p) => p.y)),
    y1: Math.max(...ndc.map((p) => p.y)),
  };
}
const overlap = (a: Rect, b: Rect): boolean =>
  a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;

/** The panels of the HUD: the player's status panel and every enemy readout. */
function panels(session: CombatSession): { name: string; points: THREE.Vector3[] }[] {
  return session.hudPoints().filter((e) => e.name === 'status' || e.name.startsWith('readout:'));
}

/** True when a point of `points` is behind `camera`'s image plane, so its projection is meaningless. */
function behind(camera: THREE.Camera, points: readonly THREE.Vector3[]): boolean {
  camera.updateMatrixWorld(true);
  const inverse = camera.matrixWorld.clone().invert();
  return points.some((p) => p.clone().applyMatrix4(inverse).z > -0.05);
}

/**
 * Names of every overlapping pair of panels seen through `camera`. A panel partly behind the
 * camera cannot overlap anything on screen; it is listed in `hidden` instead.
 */
function overlaps(camera: THREE.Camera, session: CombatSession, hidden: string[] = []): string[] {
  const shown = panels(session).filter((p) => {
    if (!behind(camera, p.points)) return true;
    hidden.push(p.name);
    return false;
  });
  const rects = shown.map((p) => ({ name: p.name, rect: rectOf(camera, p.points) }));
  const out: string[] = [];
  rects.forEach((a, i) => {
    for (const b of rects.slice(i + 1))
      if (overlap(a.rect, b.rect)) out.push(`${a.name} x ${b.name}`);
  });
  return out;
}

interface Layout {
  readonly encounter: Encounter;
  readonly seat: number;
  readonly spread: number;
  readonly beyond: number;
}

/** Opens a session on `layout`: the table `seat` metres ahead of a seated player at the origin. */
async function open(
  layout: Layout,
  tableAsset: boolean,
  deck?: readonly string[],
): Promise<CombatSession> {
  const { encounter, seat, spread, beyond } = layout;
  const height = tableHeightFor();
  const pose: TablePose = { x: 0, z: -seat, yaw: 0, height };
  const guardian = encounter.tier === 'guardian';
  const placed = placeEnemies(pose, encounter.enemies.length, OPEN_ROOM, {
    tableDistance: seat,
    radius: guardian ? 0.8 : 0.5,
    spacing: 1.2 * spread,
    preferred: beyond,
  });
  if (!placed.ok) throw new Error(`no layout for ${JSON.stringify(layout)}`);
  const root = new THREE.Scene();
  const bodies = placed.placements.map((p, i) => {
    const body = new THREE.Object3D();
    body.position.set(p.x, 0, p.z);
    body.rotation.y = -p.yaw * DEG;
    body.userData.enemyKind = encounter.enemies[i];
    if (guardian) body.userData.tier = 'guardian';
    root.add(body);
    return body;
  });
  const actors = new Map(bodies.map((b) => [b, stubActor(b.userData.enemyKind as string)]));
  const sockets = { diceTray: null, sigilPlate: null } as {
    diceTray: THREE.Object3D | null;
    sigilPlate: THREE.Object3D | null;
  };
  if (tableAsset) {
    // The real table's authored tray and plate sockets (`combat-table.manifest.json`), scaled to
    // the waist height the way the floor view fits the asset.
    const fit = new THREE.Group();
    fit.position.set(pose.x, 0, pose.z);
    fit.scale.set(1, height / 0.756, 1);
    for (const [name, y, z] of [
      ['socket-dice-tray', 0.724, 0.18],
      ['socket-sigil-plate', 1.05, -0.15],
    ] as const) {
      const socket = new THREE.Object3D();
      socket.name = name;
      socket.position.set(0, y, z);
      fit.add(socket);
    }
    root.add(fit);
    root.updateMatrixWorld(true);
    sockets.diceTray = fit.getObjectByName('socket-dice-tray') ?? null;
    sockets.sigilPlate = fit.getObjectByName('socket-sigil-plate') ?? null;
  }
  const camera = new THREE.PerspectiveCamera(70, 1.6, 0.05, 100);
  camera.position.set(0, height + WAIST_DROP, 0);
  root.add(camera);
  root.updateMatrixWorld(true);
  return CombatSession.create({
    seed: seedFor(encounter),
    room: 1,
    tier: encounter.tier as EncounterTier,
    tablePose: pose,
    seatDistance: seat,
    bodies,
    root,
    camera,
    sockets,
    actions: new ActionBus(),
    end: () => {},
    actorOf: (body) => actors.get(body) ?? null,
    syncLabels: false,
    models: null,
    ...(deck ? { options: { deck } } : {}),
  });
}

/** The seated Quest 3 eye (IWER: 90 degree vertical fov, half of a 1600 x 900 canvas), level. */
function seatEye(seat: number, eye: number, pitch = 0): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(90, 800 / 900, 0.05, 100);
  camera.position.set(eye, tableHeightFor() + WAIST_DROP, 0);
  camera.rotation.set(pitch, 0, 0, 'YXZ');
  void seat;
  camera.updateMatrixWorld(true);
  return camera;
}

/** The player's desktop view as main.ts frames it, the eye at the seat. */
function desktopView(session: CombatSession): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(70, 1.6, 0.05, 100);
  camera.position.set(0, tableHeightFor() + WAIST_DROP, 0);
  const { must, want, floor } = session.framingPoints();
  const fit = fitCombatFraming({
    eye: camera.position,
    headingDeg: 0,
    aspect: 1.6,
    baseFov: 70,
    must,
    want,
    floor,
  });
  camera.fov = fit.fov;
  camera.updateProjectionMatrix();
  camera.rotation.set(fit.pitch, 0, 0, 'YXZ');
  camera.updateMatrixWorld(true);
  return camera;
}

const SEATS = [0.5, 0.65, 0.85, 0.95, 1.0, 1.1, 1.2, 1.3] as const;
const SPREADS = [1, 0.75, 0.5, 0.25] as const;
const BEYOND = [2, 2.5, 3] as const;
/** The in-game readout: a 0.85 m wide, 640 x 260 canvas (combat-session.ts). */
const READOUT = { width: 0.85, height: (0.85 * 260) / 640 } as const;
const ENCOUNTER_LIST: readonly Encounter[] = [
  ...ENCOUNTERS.regular,
  ...ENCOUNTERS.elite,
  ...ENCOUNTERS.guardian,
];

describe('HUD panels stay clear of each other from the seat', () => {
  /** Desktop layouts where a panel sits behind the framed camera (not shown at all). */
  const behindDesktop: string[] = [];
  beforeAll(() => stubCanvas2d());
  afterAll(() => {
    vi.restoreAllMocks();
    if (behindDesktop.length)
      console.warn(`panels behind the desktop camera:\n${behindDesktop.join('\n')}`);
  });

  for (const encounter of ENCOUNTER_LIST) {
    it(`${encounter.id} (${encounter.tier}, ${encounter.enemies.length} enemies), XR and desktop`, async () => {
      const failures: string[] = [];
      let checked = 0;
      const spreads = encounter.enemies.length > 1 ? SPREADS : [1];
      for (const seat of SEATS)
        for (const spread of spreads)
          for (const beyond of BEYOND) {
            const layout = { encounter, seat, spread, beyond };
            let session: CombatSession;
            try {
              session = await open(layout, seat !== 0.65);
            } catch (e) {
              if (String(e).includes('no layout')) continue;
              throw e;
            }
            const names = panels(session).map((p) => p.name);
            expect(names).toContain('status');
            expect(names.filter((n) => n.startsWith('readout:')).length).toBe(
              encounter.enemies.length,
            );
            const where = `seat ${seat} m, spread ${spread}, ${beyond} m beyond`;
            session.resetHud();
            for (const eye of [-0.032, 0.032])
              for (const pitch of [0, -15 * DEG]) {
                const hits = overlaps(seatEye(seat, eye, pitch), session);
                if (hits.length)
                  failures.push(`XR ${where}, eye ${eye}, pitch ${pitch}: ${hits.join(', ')}`);
              }
            const desk = desktopView(session);
            session.fitHudToView(desk);
            const hidden: string[] = [];
            const hits = overlaps(desk, session, hidden);
            if (hits.length) failures.push(`desktop ${where}: ${hits.join(', ')}`);
            if (hidden.length) behindDesktop.push(`${encounter.id} ${where}: ${hidden.join(', ')}`);
            session.dispose();
            checked++;
          }
      expect(checked).toBeGreaterThan(0);
      expect(failures).toEqual([]);
    }, 120_000);
  }
});

/**
 * The floor content has no three-enemy encounter (`ENCOUNTERS` stops at two, and the session plays
 * only as many bodies as its encounter has enemies), but the placement supports three. The session's
 * own status panel and the same clearance (`readoutHeightsClear`) over three shipped kinds' readouts.
 */
describe('three-enemy layouts', () => {
  beforeAll(() => stubCanvas2d());
  afterAll(() => vi.restoreAllMocks());

  it('keeps the status panel and three readouts apart from the seat', async () => {
    const failures: string[] = [];
    let checked = 0;
    for (const kinds of [
      ['spring-hound', 'spring-hound', 'spring-hound'],
      ['spring-hound', 'cog-sentry', 'spring-hound'],
      ['cog-sentry', 'cog-sentry', 'cog-sentry'],
      ['bellows-golem', 'spring-hound', 'cog-sentry'],
    ])
      for (const seat of SEATS)
        for (const spread of SPREADS)
          for (const beyond of BEYOND) {
            const one = ENCOUNTERS.regular[0] as Encounter;
            const session = await open({ encounter: one, seat, spread: 1, beyond }, true);
            session.resetHud();
            const status = session.hudPoints().find((e) => e.name === 'status')?.points ?? [];
            session.dispose();
            const height = tableHeightFor();
            const pose: TablePose = { x: 0, z: -seat, yaw: 0, height };
            const placed = placeEnemies(pose, 3, OPEN_ROOM, {
              tableDistance: seat,
              spacing: 1.2 * spread,
              preferred: beyond,
            });
            if (!placed.ok) continue;
            const eye = new THREE.Vector3(0, height + WAIST_DROP, 0);
            const readouts = placed.placements.map((p, i) => {
              const m = manifest(kinds[i] as string);
              const crown = crownBounds(m.bounds, m.sockets['socket-eye']?.position);
              const body = new THREE.Object3D();
              body.position.set(p.x, 0, p.z);
              body.rotation.y = -p.yaw * DEG;
              body.updateMatrixWorld(true);
              const box = new THREE.Box3(
                new THREE.Vector3(...crown.min),
                new THREE.Vector3(...crown.max),
              ).applyMatrix4(body.matrixWorld);
              const y = readoutCentreY(eye, body.position, box, READOUT.height, {
                margin: READOUT_MARGIN,
              });
              return { centre: { x: p.x, y, z: p.z }, ...READOUT };
            });
            const forward = [0, -1] as const;
            const eyes = [-0.032, 0.032].map((x) => ({ x, y: eye.y, z: 0 }));
            const ys = readoutHeightsClear({ eyes, forward }, [status], readouts);
            const corners = readouts.map((r, i) =>
              readoutCorners({ ...r, centre: { ...r.centre, y: ys[i] as number } }, forward).map(
                (c) => new THREE.Vector3(c.x, c.y, c.z),
              ),
            );
            const named = [
              { name: 'status', points: status },
              ...corners.map((points, i) => ({ name: `readout:${i}`, points })),
            ];
            for (const x of [-0.032, 0.032]) {
              const camera = seatEye(seat, x);
              const rects = named.map((p) => ({ name: p.name, rect: rectOf(camera, p.points) }));
              rects.forEach((a, i) => {
                for (const b of rects.slice(i + 1))
                  if (overlap(a.rect, b.rect))
                    failures.push(
                      `${kinds} seat ${seat} spread ${spread} ${beyond} m: ${a.name} x ${b.name}`,
                    );
              });
            }
            checked++;
          }
    expect(checked).toBeGreaterThan(100);
    expect(failures).toEqual([]);
  }, 120_000);
});

/** Playtest 2026-11-17: "effects on cards need a laser point explanation of what they do". */
describe('card keyword tip', () => {
  beforeAll(() => stubCanvas2d());
  afterAll(() => vi.restoreAllMocks());

  it('shows the keywords of the hand card the pointer is on', async () => {
    const deck = [
      'release-valve',
      'release-valve',
      'release-valve',
      'release-valve',
      'release-valve',
    ];
    const layout = {
      encounter: ENCOUNTERS.regular[0] as Encounter,
      seat: 1.1,
      spread: 1,
      beyond: 2.5,
    };
    const session = await open(layout, true, deck);
    session.update(1 / 60);
    expect(session.fan.count).toBeGreaterThan(0);
    expect(session.cardTipShown).toBeNull();
    session.fan.hover(0);
    session.update(1 / 60);
    expect(session.cardTipShown).toEqual({
      id: 'release-valve',
      titles: ['Steam', 'Draw', 'Exhaust'],
    });
    const group = (session as unknown as { group: THREE.Group }).group;
    const tip = group.getObjectByName('card-tip');
    expect(tip?.visible).toBe(true);
    session.fan.hover(null);
    session.update(1 / 60);
    expect(session.cardTipShown).toBeNull();
    expect(tip?.visible).toBe(false);
    session.dispose();
  }, 60_000);
});
