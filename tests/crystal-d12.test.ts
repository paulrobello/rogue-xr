// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CombatController } from '../src/combat-view/controller.ts';
import { CRYSTAL_D12 } from '../src/content/dice.ts';
import { Stream } from '../src/core/rng.ts';
import { type DiceManifest, parseDice, parseDiceManifest } from '../src/dice/dice-asset.ts';
import { dieVertices, faceNormals, numberingOffset } from '../src/dice/faces.ts';
import { DicePresenter } from '../src/dice/presenter.ts';
import { rotateVec } from '../src/dice/quat.ts';
import { AUTHORED_TRAY_HALF } from '../src/dice/world.ts';
import { rollDie } from '../src/rules/dice.ts';

const loadDie = (id: string): { manifest: DiceManifest; glb: ArrayBuffer } => {
  const root = new URL(`../public/assets/dice/${id}/`, import.meta.url);
  const manifest = parseDiceManifest(
    JSON.parse(readFileSync(new URL(`${id}.manifest.json`, root), 'utf8')),
  );
  const bytes = readFileSync(new URL(manifest.glb, root));
  return { manifest, glb: Uint8Array.from(bytes).buffer };
};

function fight(deck: readonly string[], bonusDice = 0) {
  return new CombatController({
    seed: 'TEST0001',
    deck,
    bonusDice,
    setups: [
      {
        id: 'dummy',
        name: 'Dummy',
        hp: 90,
        moves: [{ id: 'wait', intent: 'unknown', effects: [] }],
      },
    ],
  });
}

function select(combat: CombatController, id: string) {
  const card = combat.state.piles.hand.find((entry) => entry.def.id === id);
  if (!card) throw Error(`Missing ${id}`);
  expect(combat.select(card.uid).ok).toBe(true);
}

function sequence(state: CombatController['state'], count: number) {
  let rng = state.rng;
  const values: number[] = [];
  for (let i = 0; i < count; i++) {
    const result = rollDie(rng, CRYSTAL_D12);
    rng = result.rng;
    values.push(result.roll.value);
  }
  return { rng, values };
}

describe('crystal d12', () => {
  it('maps all 144 ordered face pairs without moving any vertex outside its original hull', () => {
    const normals = faceNormals('d12');
    const hull = dieVertices('d12');
    expect(normals).toHaveLength(12);
    expect(hull).toHaveLength(20);
    for (const [a, from] of normals.entries()) {
      const opposite = normals[11 - a];
      expect(
        Math.hypot(opposite.x + from.x, opposite.y + from.y, opposite.z + from.z),
      ).toBeLessThan(1e-8);
      for (const [b, to] of normals.entries()) {
        const rotation = numberingOffset('d12', a, b);
        const normal = rotateVec(rotation, from);
        expect(Math.hypot(normal.x - to.x, normal.y - to.y, normal.z - to.z)).toBeLessThan(1e-8);
        for (const vertex of hull) {
          const point = rotateVec(rotation, vertex);
          expect(
            hull.some((v) => Math.hypot(v.x - point.x, v.y - point.y, v.z - point.z) < 1e-8),
          ).toBe(true);
        }
      }
    }
  });

  it('loads the released mesh and shows every seeded face in the real tray', async () => {
    const brass = loadDie('brass-d6');
    const glass = loadDie('glass-d8');
    const crystal = loadDie('crystal-d12');
    const asset = await parseDice(
      { d6: brass.glb, d8: glass.glb, d12: crystal.glb },
      { d6: brass.manifest, d8: glass.manifest, d12: crystal.manifest },
    );
    const presenter = await DicePresenter.create(Stream.fromKey('d12-all-faces'), {
      ...AUTHORED_TRAY_HALF,
      models: asset,
    });
    try {
      for (let value = 1; value <= 12; value++) {
        let settled: number | null = null;
        const off = presenter.onSettled((roll) => {
          settled = roll.value;
        });
        const id = presenter.throw('d12', value - 1, value);
        for (let i = 0; i < 500 && settled === null; i++) presenter.update(1 / 60);
        off();
        expect(settled).toBe(value);
        expect(presenter.upFace(id)).toBe(value - 1);
        expect(presenter.mesh(id)?.userData.authored).toBe(true);
        expect(presenter.mesh(id)?.geometry).toBe(asset.spawn('d12').geometry);
      }
    } finally {
      presenter.dispose();
      asset.dispose();
    }
  }, 15000);
});

describe('Crystal Gambit', () => {
  it.each([
    ['crystal-gambit', 0],
    ['crystal-gambit+', 4],
  ] as const)('commits %s as two independent seeded results and one flat bonus', (id, bonus) => {
    const combat = fight([id, 'strike', 'defend']);
    const expected = sequence(combat.state, 2);
    select(combat, id);
    expect(combat.target('dummy').ok).toBe(true);
    const sum = expected.values.reduce((a, b) => a + b, 0);
    expect(combat.lastDice).toMatchObject({
      keptRolls: expected.values,
      rolls: expected.values,
      value: sum,
    });
    expect(combat.state.player.steam).toBe(0);
    expect(combat.state.enemies[0].hp).toBe(90 - sum - bonus);
    expect(combat.state.rng.dice).toEqual(expected.rng.dice);
  });

  it('cannot start a roll with only two Steam remaining', () => {
    const combat = fight(['crystal-gambit', 'strike']);
    select(combat, 'strike');
    expect(combat.target('dummy').ok).toBe(true);
    expect(combat.state.player.steam).toBe(2);
    const next = combat.state.piles.hand.find((entry) => entry.def.id === 'crystal-gambit');
    if (!next) throw Error('Missing Crystal Gambit');
    expect(combat.select(next.uid).ok).toBe(false);
    expect(combat.lastDice).toBeNull();
  });

  it('replaces only the first keeper after Loaded and Spare Die and does the full revised sum once', () => {
    const combat = fight(['crystal-gambit+', 'loaded-die', 'reroll-lever', 'strike', 'defend'], 1);
    for (const id of ['loaded-die', 'reroll-lever']) {
      select(combat, id);
      expect(combat.table().ok).toBe(true);
    }
    combat.drainEvents();
    const state = combat.state;
    const { rng, values } = sequence(state, 5);
    const first = Math.max(...values.slice(0, 3));
    const [second, rerolled] = values.slice(3);
    select(combat, 'crystal-gambit+');
    expect(combat.target('dummy').ok).toBe(true);
    expect(combat.state).toBe(state);
    expect(combat.lastDice).toMatchObject({
      keptRolls: [first, second],
      rolls: values.slice(0, 4),
      value: first + second,
    });
    expect(combat.rerollDice()).toBe(true);
    expect(combat.rerollDice()).toBe(false);
    expect(combat.state).toBe(state);
    expect(combat.lastDice).toMatchObject({
      keptRolls: [rerolled, second],
      rolls: values,
      value: rerolled + second,
      rerolledFrom: first,
    });
    expect(combat.confirmDice()).toBe(true);
    expect(combat.confirmDice()).toBe(false);
    expect(combat.state.enemies[0].hp).toBe(90 - rerolled - second - 4);
    expect(combat.state.rng.dice).toEqual(rng.dice);
    expect(combat.drainEvents().filter((event) => event.type === 'damage-dealt')).toHaveLength(1);
  });
});
