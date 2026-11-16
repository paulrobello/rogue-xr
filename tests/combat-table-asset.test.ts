// @vitest-environment node
import { existsSync, readFileSync } from 'node:fs';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  leafQuaternion,
  parseTableAssetManifest,
  TABLE_ASSET_NODES,
  type TableAssetManifest,
} from '../src/combat/table-asset-proof.ts';

const base = new URL('../public/assets/props/combat-table/', import.meta.url);
const raw = JSON.parse(readFileSync(new URL('combat-table.manifest.json', base), 'utf8'));
const manifest: TableAssetManifest = parseTableAssetManifest(raw);

interface GltfNode {
  name: string;
  children?: number[];
  mesh?: number;
  translation?: number[];
  rotation?: number[];
}
interface Gltf {
  nodes: GltfNode[];
  materials: { name: string }[];
  meshes: { primitives: { attributes: Record<string, number>; material: number }[] }[];
  images?: unknown[];
}

/** The JSON chunk of a GLB (header, then a length-prefixed JSON chunk). */
function readGlbJson(file: URL): Gltf {
  const bytes = readFileSync(file);
  expect(bytes.readUInt32LE(0)).toBe(0x46546c67);
  const length = bytes.readUInt32LE(12);
  return JSON.parse(bytes.subarray(20, 20 + length).toString('utf8'));
}

const gltf = readGlbJson(new URL(manifest.glb, base));

describe('combat table asset manifest', () => {
  it('names every runtime node, with sockets riding the node they sit on', () => {
    expect(Object.keys(manifest.nodes).sort()).toEqual([...TABLE_ASSET_NODES].sort());
    expect(manifest.nodes['combat-table']?.parent).toBeNull();
    expect(manifest.nodes['socket-draw']?.parent).toBe('leaf-left');
    expect(manifest.nodes['socket-discard']?.parent).toBe('leaf-right');
    expect(manifest.nodes['socket-dice-tray']?.parent).toBe('combat-table');
    expect(manifest.nodes['socket-sigil-plate']?.parent).toBe('combat-table');
  });

  it('rests folded and unfolds to identity: +90 deg about Z for leaf-left, -90 for leaf-right', () => {
    const down = new THREE.Vector3();
    for (const [leaf, sign] of [
      ['leaf-left', 1],
      ['leaf-right', -1],
    ] as const) {
      const folded = leafQuaternion(manifest, leaf, 0);
      const angle = 2 * Math.acos(Math.min(1, Math.abs(folded.w)));
      expect(angle).toBeCloseTo(Math.PI / 2, 5);
      expect(Math.sign(folded.z)).toBe(sign);
      // The leaf's outward direction (-X for leaf-left) hangs straight down when folded.
      down.set(-sign, 0, 0).applyQuaternion(folded);
      expect(down.y).toBeCloseTo(-1, 5);
      expect(leafQuaternion(manifest, leaf, 1).angleTo(new THREE.Quaternion())).toBeCloseTo(0, 6);
    }
  });

  it('puts the player-side features at +Z and the sigil plate above the table, toward -Z', () => {
    const tray = manifest.nodes['socket-dice-tray']?.translation ?? [];
    expect(tray[2]).toBeGreaterThan(0);
    const sigil = manifest.nodes['socket-sigil-plate']?.translation ?? [];
    expect(sigil[1]).toBeGreaterThan(manifest.authoredTopHeight + 0.1);
    expect(sigil[2]).toBeLessThanOrEqual(0);
    expect(manifest.authoredTopHeight).toBeCloseTo(0.75, 3);
  });

  it('binds only to shared sets that exist, and ships its AO map', () => {
    const sets = JSON.parse(
      readFileSync(new URL('../public/assets/materials/materials.json', import.meta.url), 'utf8'),
    );
    for (const [name, slot] of Object.entries(manifest.materialSlots)) {
      if (slot.set === null) expect(slot.factorOnly).toBe(true);
      else expect(sets[slot.set], name).toBeDefined();
    }
    expect(existsSync(new URL(manifest.ao.png, base))).toBe(true);
    if (manifest.ao.ktx2) expect(existsSync(new URL(manifest.ao.ktx2, base))).toBe(true);
    expect(manifest.ao.channel).toBe(1);
  });
});

describe('combat table GLB agrees with its manifest', () => {
  it('has the same node names, parents and transforms', () => {
    const names = gltf.nodes.map((n) => n.name);
    expect([...names].sort()).toEqual([...TABLE_ASSET_NODES].sort());
    const parentOf = new Map<string, string>();
    for (const node of gltf.nodes) {
      for (const child of node.children ?? []) parentOf.set(names[child] ?? '', node.name);
    }
    for (const node of gltf.nodes) {
      const entry = manifest.nodes[node.name];
      expect(entry?.parent ?? null, node.name).toBe(parentOf.get(node.name) ?? null);
      const t = node.translation ?? [0, 0, 0];
      const r = node.rotation ?? [0, 0, 0, 1];
      for (const [i, v] of (entry?.translation ?? []).entries()) {
        expect(t[i], node.name).toBeCloseTo(v, 5);
      }
      for (const [i, v] of (entry?.rotation ?? []).entries()) {
        expect(r[i], node.name).toBeCloseTo(v, 5);
      }
    }
  });

  it('is image-free, with material names equal to the manifest slots and two UV sets', () => {
    expect(gltf.images ?? []).toHaveLength(0);
    expect(gltf.materials.map((m) => m.name).sort()).toEqual(
      Object.keys(manifest.materialSlots).sort(),
    );
    expect(gltf.materials.length).toBeLessThanOrEqual(4);
    for (const mesh of gltf.meshes) {
      for (const prim of mesh.primitives) {
        expect(prim.attributes.TEXCOORD_0).toBeDefined();
        expect(prim.attributes.TEXCOORD_1).toBeDefined();
      }
    }
  });
});
