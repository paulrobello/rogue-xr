// @vitest-environment node
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  type EnemyActor,
  parseEnemyAsset,
  parseEnemyManifest,
} from '../src/enemies/enemy-asset.ts';
import {
  applyGlowLook,
  GLOW_HOT,
  GLOW_ISLAND_ATTRIBUTE,
  writeGlowIslands,
} from '../src/enemies/glow.ts';

/** D11: the automaton glow skips AgX and draws a hot-to-rim amber ramp per glow island. */
const IDS = [
  'cog-sentry',
  'spring-hound',
  'bellows-golem',
  'orrery-warden',
  'grand-escapement',
] as const;

async function load(id: string) {
  const dir = new URL(`../public/assets/enemies/${id}/`, import.meta.url);
  const manifest = parseEnemyManifest(
    JSON.parse(readFileSync(new URL(`${id}.manifest.json`, dir), 'utf8')),
    id,
  );
  const bytes = readFileSync(new URL(manifest.glb, dir));
  const glb = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return parseEnemyAsset(glb as ArrayBuffer, manifest, null);
}

function glowOf(actor: EnemyActor): THREE.MeshStandardMaterial {
  let found: THREE.MeshStandardMaterial | undefined;
  actor.object.traverse((o) => {
    if (o instanceof THREE.Mesh && o.material.name === actor.asset.manifest.emissive.material)
      found = o.material;
  });
  if (!found) throw new Error(`${actor.kind}: no glow material`);
  return found;
}

describe('glow islands', () => {
  it('gives each connected island its centroid and radius, welding seam-split vertices', () => {
    // Two triangles sharing an edge by position only (split vertices), plus a separate triangle.
    const p = [0, 0, 0, 2, 0, 0, 0, 2, 0, 2, 0, 0, 0, 2, 0, 2, 2, 0, 10, 0, 0, 11, 0, 0, 10, 1, 0];
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
    expect(writeGlowIslands(g)).toBe(2);
    const a = g.getAttribute(GLOW_ISLAND_ATTRIBUTE);
    expect(a.itemSize).toBe(4);
    for (let i = 0; i < 6; i++) {
      expect(a.getX(i)).toBeCloseTo(1);
      expect(a.getY(i)).toBeCloseTo(1);
      expect(a.getW(i)).toBeCloseTo(Math.SQRT2);
    }
    expect(a.getX(6)).toBeCloseTo(31 / 3);
    expect(a.getY(8)).toBeCloseTo(1 / 3);
  });
});

describe('automaton glow look', () => {
  it.each(IDS)(
    '%s: glow islands written, glow material untonemapped, others unchanged',
    async (id) => {
      const asset = await load(id);
      let islands = 0;
      asset.template.traverse((o) => {
        if (o instanceof THREE.Mesh && o.material.name === asset.manifest.emissive.material)
          islands += o.geometry.getAttribute(GLOW_ISLAND_ATTRIBUTE) ? 1 : 0;
      });
      expect(islands).toBeGreaterThan(0);
      const actor = asset.spawn();
      const glow = glowOf(actor);
      expect(glow.toneMapped).toBe(false);
      expect(glow.color.getHex()).toBe(0x000000);
      expect(glow.emissive.getHex()).toBe(0xffffff);
      expect(glow.customProgramCacheKey()).toBe('automaton-glow');
      actor.object.traverse((o) => {
        if (o instanceof THREE.Mesh && o.material !== glow)
          expect(o.material.toneMapped).toBe(true);
      });
      actor.dispose();
      asset.dispose();
    },
  );

  it('keeps the freeze dim and the hit flash on emissiveIntensity', async () => {
    const asset = await load('bellows-golem');
    const actor = asset.spawn();
    const glow = glowOf(actor);
    const idle = glow.emissiveIntensity;
    actor.freeze();
    expect(glow.emissiveIntensity).toBeCloseTo(idle * 0.3);
    actor.unfreeze();
    expect(glow.emissiveIntensity).toBeCloseTo(idle);
    actor.hit();
    actor.update(0.01);
    expect(glow.emissiveIntensity).toBeGreaterThan(idle * 2);
    actor.update(1);
    expect(glow.emissiveIntensity).toBeCloseTo(idle);
    actor.dispose();
    asset.dispose();
  });

  it('patches every shader hook it relies on in the pinned three.js', () => {
    const material = new THREE.MeshStandardMaterial();
    applyGlowLook(material, '#F08C2C');
    const shader = {
      uniforms: THREE.UniformsUtils.clone(THREE.ShaderLib.standard.uniforms),
      vertexShader: THREE.ShaderLib.standard.vertexShader,
      fragmentShader: THREE.ShaderLib.standard.fragmentShader,
    };
    material.onBeforeCompile(shader as THREE.WebGLProgramParametersWithUniforms, {} as never);
    expect(shader.vertexShader).toContain(`attribute vec4 ${GLOW_ISLAND_ATTRIBUTE};`);
    expect(shader.vertexShader).toContain('vGlowOffset = ( transformed - glowCentre )');
    expect(shader.fragmentShader).toContain('uniform vec3 glowHot;');
    expect(shader.fragmentShader).toContain('totalEmissiveRadiance = mix( glowRim, glowHot');
    expect(shader.fragmentShader).toContain('vec3 outgoingLight = totalEmissiveRadiance;');
    expect((shader.uniforms.glowHot as { value: THREE.Color }).value.getHexString()).toBe(
      new THREE.Color(GLOW_HOT).getHexString(),
    );
  });
});
