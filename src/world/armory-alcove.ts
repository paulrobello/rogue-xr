import * as THREE from 'three';
import { templateById } from '../content/rooms.ts';
import type { EnemyAsset } from '../enemies/enemy-asset.ts';
import { makeWakingArmor } from '../enemies/waking-armor.ts';
import { ClockInscription } from './clock-inscription.ts';
import { cogGeometry } from './cog-geometry.ts';
import type { FloorWorld } from './floor-world.ts';

const DISPLAY_YAW = { N: Math.PI, E: Math.PI / 2, S: 0, W: -Math.PI / 2 } as const;
const WIND_SECONDS = 0.76;

/** Stationary display and controls. The independent actor only becomes visible in a fight. */
export class ArmoryAlcove {
  readonly object = new THREE.Group();
  private readonly signs: Record<'dressing' | 'wind' | 'challenge' | 'cleared', ClockInscription>;
  private readonly stand: THREE.Mesh<THREE.BoxGeometry, THREE.MeshStandardMaterial>;
  private readonly ray = new THREE.Raycaster();
  private readonly point = new THREE.Vector3();
  private readonly remove: (() => void)[] = [];
  private readonly rackParts: { dispose(): void }[] = [];
  private display: THREE.Object3D | null = null;
  private empty: THREE.Object3D | null = null;
  private visor: THREE.Object3D | null = null;
  private helmet: THREE.Object3D | null = null;
  private asset: EnemyAsset | null = null;
  private awake = false;
  private cleared = false;
  private fighting = false;
  private age = WIND_SECONDS;

  constructor(
    private readonly world: FloorWorld,
    readonly room: number,
    private readonly reduced: boolean,
  ) {
    this.object.name = 'armory-alcove-display';
    const placed = world.plan.rooms[room];
    const connecting = world.plan.connections.find(([, into]) => into.room === room);
    const entrance = templateById(placed.templateId).doors.find(
      (d) => d.id === connecting?.[1].door,
    );
    if (!entrance) throw new Error('Armory entrance is missing');
    this.object.rotation.y = DISPLAY_YAW[entrance.facing];
    this.object.translateZ(-3.55);
    world.roomGroups[room].add(this.object);

    this.stand = new THREE.Mesh(
      new THREE.BoxGeometry(0.3, 1.02, 0.28),
      new THREE.MeshStandardMaterial({ color: 0x5a604e, roughness: 0.75, metalness: 0.15 }),
    );
    this.stand.name = 'armory-control-stand';
    this.stand.position.set(0.83, 0.51, 0.07);
    this.object.add(this.stand);
    this.mountGearRack();

    this.signs = {
      dressing: new ClockInscription(
        'armory-dressing',
        0.67,
        'Armory Alcove',
        'Parade harness',
        'Display only',
      ),
      wind: new ClockInscription(
        'armory-wind',
        0.67,
        'Waking Armor',
        'Select to wind',
        'Optional encounter',
      ),
      challenge: new ClockInscription(
        'armory-challenge',
        0.67,
        'Armor awake',
        'Select to challenge',
        'Optional encounter',
      ),
      cleared: new ClockInscription(
        'armory-cleared',
        0.67,
        'Armory Alcove',
        'Harness defeated',
        '',
      ),
    };
    for (const sign of Object.values(this.signs)) {
      sign.object.position.set(0.83, 1.09, 0.24);
      this.object.add(sign.object);
    }
    this.object.updateWorldMatrix(true, true);
    const armorBounds = new THREE.Box3(
      new THREE.Vector3(-0.45, 0, -0.27),
      new THREE.Vector3(0.45, 1.85, 0.28),
    ).applyMatrix4(this.object.matrixWorld);
    for (const bounds of [armorBounds, new THREE.Box3().setFromObject(this.stand)]) {
      this.remove.push(
        world.addFixtureCollider(room, { min: bounds.min.toArray(), max: bounds.max.toArray() }),
      );
    }
    this.parkBody();
    this.paint();
  }

  private mountGearRack(): void {
    const rack = new THREE.Group();
    rack.name = 'armory-gear-rack';
    rack.position.set(-1.35, 1.44, -1.3);
    const timber = new THREE.BoxGeometry(1.04, 0.55, 0.105);
    const wood = new THREE.MeshStandardMaterial({ color: 0x573b29, roughness: 0.62 });
    const brass = new THREE.MeshStandardMaterial({
      color: 0xb78d55,
      metalness: 0.65,
      roughness: 0.47,
    });
    rack.add(new THREE.Mesh(timber, wood));
    this.rackParts.push(timber, wood, brass);
    for (const [x, radius, angle] of [
      [-0.31, 0.136, 0.05],
      [0, 0.103, 0.28],
      [0.28, 0.159, 0.18],
    ]) {
      const geometry = cogGeometry(radius);
      const cog = new THREE.Mesh(geometry, brass);
      cog.position.set(x, -0.02, 0.093);
      cog.rotation.z = angle;
      this.rackParts.push(geometry);
      rack.add(cog);
    }
    this.object.add(rack);
  }

  private parkBody(): void {
    const body = this.body();
    if (!body?.parent) return;
    body.position.x = this.object.position.x;
    body.position.z = this.object.position.z;
    body.rotation.y = this.object.rotation.y + Math.PI;
    body.visible = false;
  }

  private body(): THREE.Object3D | undefined {
    return this.world.enemies.get(this.room)?.[0];
  }

  dress(art: THREE.Object3D): EnemyAsset | null {
    if (this.display) return this.asset;
    this.display = art.clone(true);
    this.object.add(this.display);
    this.visor = this.display.getObjectByName('ClockworkArmor_Visor') ?? null;
    this.helmet = this.display.getObjectByName('ClockworkArmor_Head') ?? null;
    if (this.body()) {
      const { asset, stand } = makeWakingArmor(art);
      this.asset = asset;
      this.empty = stand;
      this.object.add(stand);
    }
    this.paint();
    return this.asset;
  }

  sync(awake: boolean, cleared: boolean): void {
    this.awake = awake || cleared;
    this.cleared = cleared;
    this.paint();
  }

  wind(): void {
    this.age = 0;
    this.paint();
  }

  update(dt: number): void {
    if (this.age >= WIND_SECONDS) return;
    this.age = Math.min(WIND_SECONDS, this.age + dt);
    this.paint();
  }

  showFight(fighting: boolean): void {
    if (fighting === this.fighting) return;
    this.fighting = fighting;
    if (!fighting && !this.cleared) this.parkBody();
    this.paint();
  }

  private candidate(): THREE.Mesh | null {
    if (
      this.world.current !== this.room ||
      !this.body()?.parent ||
      this.fighting ||
      this.cleared ||
      this.age < WIND_SECONDS
    )
      return null;
    return this.signs[this.awake ? 'challenge' : 'wind'].object;
  }

  get canChallenge(): boolean {
    return this.awake && this.candidate() !== null;
  }

  pick(origin: THREE.Vector3, direction: THREE.Vector3): { distance: number } | null {
    const control = this.candidate();
    if (!control) return null;
    this.ray.set(origin, direction);
    this.ray.far = 3.8;
    control.updateWorldMatrix(true, false);
    const [hit] = this.ray.intersectObject(control, false);
    return hit ? { distance: hit.distance } : null;
  }

  near(position: THREE.Vector3, reach: number): boolean {
    const control = this.candidate();
    return (
      !!control && control.getWorldPosition(this.point).distanceToSquared(position) <= reach * reach
    );
  }

  windPosition(out: THREE.Vector3): THREE.Vector3 {
    return this.object.localToWorld(out.set(0, 1.48, 0.17));
  }

  private paint(): void {
    const body = this.body();
    if (body) body.visible = this.fighting && !this.cleared;
    if (this.display) this.display.visible = !this.fighting && !this.cleared;
    if (this.empty) this.empty.visible = this.fighting || this.cleared;
    this.signs.dressing.object.visible = !body && !this.cleared;
    this.signs.wind.object.visible = !!body && !this.awake && !this.fighting;
    this.signs.challenge.object.visible =
      !!body && this.awake && !this.cleared && !this.fighting && this.age >= WIND_SECONDS;
    this.signs.cleared.object.visible = this.cleared;
    const progress = this.awake ? THREE.MathUtils.smoothstep(this.age, 0.12, WIND_SECONDS) : 0;
    if (this.visor) this.visor.rotation.x = -0.5 * progress;
    if (this.helmet)
      this.helmet.rotation.y = this.reduced ? 0 : 0.22 * Math.sin(Math.PI * progress);
  }

  dispose(): void {
    this.object.removeFromParent();
    for (const remove of this.remove) remove();
    for (const sign of Object.values(this.signs)) sign.dispose();
    for (const resource of this.rackParts) resource.dispose();
    this.stand.geometry.dispose();
    this.stand.material.dispose();
    this.asset?.dispose();
  }
}
