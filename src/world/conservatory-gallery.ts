import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { FloorWorld } from './floor-world.ts';
import type { InteriorPlacement } from './interior-furnishings.ts';
import { findPuzzleMount, kitPart } from './puzzle-placement.ts';

export class ConservatoryGallery {
  readonly portraitGroups: THREE.Group[] = [];
  readonly roomIds: number[] = [];
  private readonly materials: THREE.Material[] = [];
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly brooms: THREE.Object3D[] = [];
  private readonly figures: THREE.Object3D[] = [];
  private readonly anchors: THREE.Object3D[] = [];
  private readonly local = new THREE.Vector3();
  private time = 0;

  private constructor(private readonly reducedMotion: boolean) {}
  static mount(
    world: FloorWorld,
    art: THREE.Object3D,
    textures: readonly THREE.Texture[],
    reducedMotion = false,
    rooms: readonly number[] = [0, 1, 2, 3, 4],
    props: readonly InteriorPlacement[] = [],
  ): ConservatoryGallery | null {
    const gallery = new ConservatoryGallery(reducedMotion);
    for (const [i, tex] of textures.slice(0, 2).entries()) {
      const site = findPuzzleMount(
        world,
        rooms.filter((room) => !gallery.roomIds.includes(room)),
        props,
        'wizard-portrait-' + i,
        0.59,
        0.72,
      );
      if (!site) {
        gallery.dispose();
        return null;
      }
      const frame = gallery.painting(tex, textures[2], i, site.center.distanceTo(site.wallSurface));
      frame.position.copy(site.center);
      frame.rotation.y = site.yaw;
      world.roomGroups[site.room].add(frame);
      gallery.roomIds.push(site.room);
      const broomMount = findPuzzleMount(world, [site.room], props, 'caretaker-' + i, 0.65, 0.82);
      if (!broomMount) continue;
      const base = new THREE.Group();
      base.position.copy(broomMount.center);
      base.position.y = 0;
      base.rotation.y = broomMount.yaw;
      base.translateZ(0.52);
      const broom = kitPart(art, 'MechanicalBroom').clone(true);
      base.add(broom);
      const light = new THREE.PointLight(i ? 0xadccff : 0xffc77f, 3.3, 3.7, 2);
      light.position.set(0.2, 1.7, 0.32);
      frame.add(light);
      world.roomGroups[broomMount.room].add(base);
      gallery.anchors.push(base);
      gallery.brooms.push(broom);
    }
    return gallery;
  }
  private painting(
    tex: THREE.Texture,
    back: THREE.Texture,
    i: number,
    wallDepth: number,
  ): THREE.Group {
    const frame = new THREE.Group();
    frame.name = 'conservatory-portrait-' + i;
    const image = tex.image as { width: number; height: number };
    const h = 1.12,
      w = (h * image.width) / image.height;
    const gold = new THREE.MeshStandardMaterial({
      color: 0xb08b47,
      emissive: 0x50391d,
      metalness: 0.67,
      roughness: 0.31,
      toneMapped: false,
    });
    const wood = new THREE.MeshStandardMaterial({
      color: 0x544032,
      emissive: 0x38291f,
      metalness: 0.18,
      roughness: 0.5,
      toneMapped: false,
    });
    this.materials.push(gold, wood);
    const rail = (
      outerW: number,
      outerH: number,
      t: number,
      z: number,
      depth: number,
      mat: THREE.Material,
    ) => {
      const shape = new THREE.Shape();
      shape.moveTo(-outerW / 2, -outerH / 2);
      shape.lineTo(outerW / 2, -outerH / 2);
      shape.lineTo(outerW / 2, outerH / 2);
      shape.lineTo(-outerW / 2, outerH / 2);
      shape.closePath();
      const x = outerW / 2 - t,
        y = outerH / 2 - t;
      const hole = new THREE.Path();
      hole.moveTo(-x, -y);
      hole.lineTo(-x, y);
      hole.lineTo(x, y);
      hole.lineTo(x, -y);
      hole.closePath();
      shape.holes.push(hole);
      const geom = new THREE.ExtrudeGeometry(shape, {
        depth,
        bevelEnabled: true,
        bevelSegments: 2,
        bevelThickness: 0.006,
        bevelSize: 0.007,
        steps: 1,
      });
      this.geometries.push(geom);
      const mesh = new THREE.Mesh(geom, mat);
      mesh.position.z = z;
      frame.add(mesh);
      return mesh;
    };
    const panel = (width: number, height: number, texture: THREE.Texture, front: boolean) => {
      const geom = new THREE.PlaneGeometry(width, height);
      const mat = new THREE.MeshBasicMaterial({
        map: texture,
        transparent: front,
        alphaTest: front ? 0.04 : 0,
        toneMapped: false,
      });
      this.geometries.push(geom);
      this.materials.push(mat);
      const mesh = new THREE.Mesh(geom, mat);
      frame.add(mesh);
      return mesh;
    };
    rail(w + 0.22, h + 0.22, 0.073, 0, 0.14, wood).name = `portrait-case-${i}`;
    // A recessed hanging block bridges the uneven wall behind the clear, square edge of the case.
    const blockDepth = wallDepth + 0.015;
    const block = new THREE.BoxGeometry(w - 0.25, h - 0.25, blockDepth).translate(
      0,
      0,
      -blockDepth / 2,
    );
    const cap = new THREE.BoxGeometry(w + 0.219, h + 0.219, 0.01);
    const backing = mergeGeometries([cap, block]);
    cap.dispose();
    block.dispose();
    this.geometries.push(backing);
    const board = new THREE.Mesh(backing, wood);
    board.name = `portrait-backing-${i}`;
    frame.add(board);
    const backdrop = panel(w + 0.12, h + 0.12, back, false);
    backdrop.position.z = 0.008;
    backdrop.name = 'observatory-background-' + i;
    const wizard = panel(w * 1.14, h * 1.14, tex, true);
    wizard.position.set(0, -0.019, 0.085);
    wizard.name = 'wizard-portrait-' + i;
    this.figures.push(wizard);
    rail(w + 0.18, h + 0.18, 0.02, 0.142, 0.012, gold);
    rail(w + 0.109, h + 0.109, 0.021, 0.144, 0.014, gold);
    this.portraitGroups.push(frame);
    return frame;
  }
  update(dt: number, eye: THREE.Vector3): void {
    if (this.reducedMotion) return;
    this.time += dt;
    for (const [i, frame] of this.portraitGroups.entries()) {
      if (!frame.parent?.visible) continue;
      frame.worldToLocal(this.local.copy(eye));
      const yaw = THREE.MathUtils.clamp(
        Math.atan2(this.local.x, Math.max(0.1, this.local.z)) * 0.33,
        -0.065,
        0.065,
      );
      const wizard = this.figures[i];
      wizard.rotation.y = THREE.MathUtils.damp(wizard.rotation.y, yaw, 6, dt);
    }
    for (const [i, broom] of this.brooms.entries()) {
      if (!broom.parent?.parent?.visible) continue;
      broom.position.x = 0.27 * Math.sin(this.time * 0.65 + i);
      broom.rotation.z = 0.22 * Math.sin(this.time * 2.3 + i);
    }
  }
  dispose() {
    for (const o of [...this.portraitGroups, ...this.anchors]) o.removeFromParent();
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
  }
}
