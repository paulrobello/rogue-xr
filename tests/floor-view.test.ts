import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { mountFloorView } from '../src/world/floor-view.ts';

function step(view: ReturnType<typeof mountFloorView>, head: THREE.Object3D, seconds: number) {
  for (let t = 0; t < seconds; t += 1 / 60) {
    head.updateMatrixWorld(true);
    view.update(head, 1 / 60);
  }
}

describe('floor view encounters', () => {
  it('freezes, locks and unfolds the table near an automaton, then releases on a win', () => {
    const scene = new THREE.Scene();
    const rig = new THREE.Group();
    const view = mountFloorView(scene, rig, 'SPIRE001');
    const [room, bodies] = [...view.world.enemies].find(([, b]) => b.length > 0) ?? [];
    expect(room).toBeDefined();
    const target = new THREE.Vector3();
    bodies?.[0]?.getWorldPosition(target);

    const head = new THREE.Object3D();
    scene.add(head);
    // Stand 1 m south of the automaton, eyes at 1.2 m, looking north at it.
    head.position.set(target.x, 1.2, target.z + 1);
    view.world.update(head.position.x, head.position.z);
    expect(view.world.current).toBe(room);

    step(view, head, 1 / 60);
    expect(view.encounter.phase).toBe('unfolding');
    expect(view.encounter.frozen).toBe(true);
    expect(view.locked).toBe(true);

    step(view, head, 1.2);
    expect(view.encounter.phase).toBe('active');
    const table = view.encounter.tablePose;
    expect(table).not.toBeNull();
    // The table sits in front of the player, toward the automaton (north is -Z).
    expect(table?.z ?? 0).toBeLessThan(head.position.z);

    view.encounter.end('win');
    step(view, head, 1.2);
    expect(view.encounter.phase).toBe('idle');
    expect(view.locked).toBe(false);
    expect(view.encounter.isCleared(room as number)).toBe(true);
    // A cleared room does not trigger again.
    step(view, head, 2);
    expect(view.encounter.phase).toBe('idle');
  });
});
