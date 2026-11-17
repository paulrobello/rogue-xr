// Win rates of a scripted, imperfect player over full seeded runs through the pure rules (see sim.ts
// for the policy). Each row is one level and one "hand": the multiplier the player's sigil traces
// earn on Casual. On Normal and Hard the same traces are judged at that level's tolerance, so the row
// also shows the multiplier the hand actually casts at there.
//
//   bun scripts/balance/winrate.ts [--seeds 400] [--hands 0.5,0.75,1] [--miss 0,0.15]
//        [--levels casual,normal,hard]
import { parseArgs } from 'node:util';
import { DIFFICULTIES, type Difficulty, isDifficulty } from '../../src/rules/difficulty.ts';
import { handMultiplier, spireSeeds, winRate } from './sim.ts';

const { values } = parseArgs({
  options: {
    seeds: { type: 'string', default: '400' },
    hands: { type: 'string', default: '0.5,0.75,1' },
    miss: { type: 'string', default: '0' },
    levels: { type: 'string', default: DIFFICULTIES.join(',') },
  },
});

const numbers = (text: string): number[] => text.split(',').map(Number);
const levels = values.levels.split(',').filter(isDifficulty) as Difficulty[];
const seeds = spireSeeds(Number(values.seeds));
const pct = (x: number): string => `${(x * 100).toFixed(1)} %`.padStart(7);

console.log(
  `SPIRE001..SPIRE${String(seeds.length).padStart(3, '0')}, ${seeds.length} runs per row`,
);
console.log('level   hand  cast  miss   win rate  died to regular/elite/guardian');
for (const level of levels) {
  for (const miss of numbers(values.miss)) {
    for (const hand of numbers(values.hands)) {
      const cast = handMultiplier(hand, level);
      const r = winRate(seeds, { level, sigilMultiplier: cast, missRate: miss });
      console.log(
        `${level.padEnd(7)} ${hand.toFixed(2)}  ${cast.toFixed(2)}  ${miss.toFixed(2)}  ${pct(r.rate)}  ` +
          `${r.diedTo.regular}/${r.diedTo.elite}/${r.diedTo.guardian}`,
      );
    }
  }
}
