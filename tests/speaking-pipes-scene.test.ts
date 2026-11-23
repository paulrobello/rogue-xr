// @vitest-environment node
import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { expect, it } from 'vitest';
import { floorSeedFor } from '../src/rules/run.ts';
import { pipeTarget } from '../src/rules/speaking-pipes.ts';
import { mountFloorView } from '../src/world/floor-view.ts';
import { DOOR_HEIGHT } from '../src/world/floor-world.ts';
import { nodeGeometryLoader } from './helpers/gltf-node.ts';

it.each(['authored parts', 'fallback fixtures'])(
  'opens the cast-iron grille through separate stations with %s',
  async (parts) => {
    const seed = 'MAPTEST2';
    let art: THREE.Object3D | undefined;
    if (parts === 'authored parts') {
      const bytes = Uint8Array.from(
        await readFile('public/assets/props/puzzle-instruments/puzzle-instruments.glb'),
      );
      art = (await nodeGeometryLoader().parseAsync(bytes.buffer, '')).scene;
    }
    const floor = mountFloorView(new THREE.Scene(), new THREE.Group(), floorSeedFor(seed, 2), {
      floorNumber: 2,
    });
    floor.dressSpeakingPipes(art, seed, false);
    const station = floor.speakingPipes;
    const layout = floor.world.plan.speakingPipes;
    if (!station || !layout) throw Error('Missing Speaking Pipes scene');
    const find = (name: string) => {
      const node = floor.world.group.getObjectByName(name);
      if (!node) throw Error(`Missing scene node ${name}`);
      return node;
    };
    const pick = (anchor: string, name: string) => {
      const target = find(name).getWorldPosition(new THREE.Vector3());
      const eye = find(anchor).localToWorld(new THREE.Vector3(0, 1.56, 1.05));
      return station.pick(eye, target.sub(eye).normalize());
    };
    const channel = pipeTarget(seed);
    const select = `speaking-pipes-select-${channel}`;
    const sender = 'speaking-pipes-sender';
    const receiver = 'speaking-pipes-receiver';
    const needle = find('speaking-pipes-gauge-needle');
    const gate = find('speaking-pipes-door-gate');
    const replay = 'speaking-pipes-replay';
    const send = 'speaking-pipes-send';
    expect(find('cistern-service-basin')).toBeTruthy();
    expect(find('cistern-service-label').userData.labelText).toContain('Service Cistern');
    expect(find('speaking-pipes-transmitter-label').userData.labelText).toContain('Press Send');
    expect(find('cistern-water-sheen')).toBeTruthy();
    expect(find('cistern-plumbing')).toBeTruthy();
    expect(needle.visible).toBe(false);
    expect(gate.visible).toBe(true);
    const closed = new THREE.Box3().setFromObject(gate);
    expect(closed.min.y).toBeCloseTo(0, 6);
    expect(closed.max.y).toBeCloseTo(DOOR_HEIGHT, 6);
    floor.world.current = layout.source.room;
    expect(pick(sender, send)).toMatchObject({ action: 'send' });
    floor.world.current = layout.receiverRoom;
    expect(pick(receiver, replay)).toBeNull();
    expect(pick(receiver, select)).toBeNull();
    station.sync('primed');
    expect(needle.visible).toBe(true);
    expect(needle.position.x).toBeCloseTo(find(select).position.x);
    expect(pick(receiver, replay)).toMatchObject({ action: 'replay' });
    expect(pick(receiver, select)).toMatchObject({ action: 'select', channel });
    expect(station.near(find(select).getWorldPosition(new THREE.Vector3()), 0.1)).toMatchObject({
      action: 'select',
      channel,
    });
    const next = ((channel + 1) % 3) as 0 | 1 | 2;
    station.reject(next);
    expect(find(`speaking-pipes-reject-${next}`).visible).toBe(true);
    expect(needle.position.x).toBeCloseTo(find(select).position.x);
    station.sync('open');
    expect(find('speaking-pipes-released-label').visible).toBe(true);
    expect(find('speaking-pipes-receiver-label').visible).toBe(false);
    expect(find(`speaking-pipes-reject-${next}`).visible).toBe(false);
    floor.world.setPuzzleGateOpen('cistern', true);
    expect(pick(receiver, replay)).toBeNull();
    expect(pick(receiver, select)).toBeNull();
    for (let i = 0; i < 60; i++) station.update(1 / 60);
    expect(gate.visible).toBe(false);
    expect(new THREE.Box3().setFromObject(gate).max.y).toBeLessThan(0);
    floor.dispose();
  },
);
