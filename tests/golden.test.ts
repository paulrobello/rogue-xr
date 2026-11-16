// @vitest-environment node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { diffGolden, GOLDEN_SCRIPTS, runGoldenScript, serializeGolden } from './golden/scripts.ts';

const GOLDEN_DIR = join(process.cwd(), 'tests', 'golden');
const UPDATING = process.env.UPDATE_GOLDEN === '1';
const REGENERATE = 'UPDATE_GOLDEN=1 bunx vitest run tests/golden.test.ts';

describe('golden combat logs', () => {
  if (UPDATING) {
    console.warn(`UPDATE_GOLDEN=1: rewriting golden logs in ${GOLDEN_DIR}`);
    mkdirSync(GOLDEN_DIR, { recursive: true });
  }

  for (const script of GOLDEN_SCRIPTS) {
    const file = join(GOLDEN_DIR, `${script.enemy}.jsonl`);

    const title = UPDATING
      ? `${script.enemy}: UPDATE_GOLDEN=1, rewriting tests/golden/${script.enemy}.jsonl`
      : `${script.enemy} matches tests/golden/${script.enemy}.jsonl`;
    it(title, () => {
      const actual = serializeGolden(runGoldenScript(script));
      if (UPDATING) {
        writeFileSync(file, actual);
        return;
      }
      if (!existsSync(file)) {
        expect.fail(`Missing golden file ${file}. Generate it with: ${REGENERATE}`);
      }
      const diff = diffGolden(readFileSync(file, 'utf8'), actual);
      if (diff !== null) {
        expect.fail(
          `${script.enemy} log changed (${diff}). If the change is intended, regenerate with: ${REGENERATE}`,
        );
      }
    });

    it(`${script.enemy} script is deterministic and ends decided`, () => {
      const first = serializeGolden(runGoldenScript(script));
      expect(serializeGolden(runGoldenScript(script))).toBe(first);
      const log = runGoldenScript(script);
      expect(['won', 'lost']).toContain(log.final.outcome);
      expect(first).not.toMatch(/NaN|undefined/);
      expect(first.endsWith('}\n')).toBe(true);
    });
  }

  it('diffGolden reports a perturbed log', () => {
    const script = GOLDEN_SCRIPTS[0];
    if (script === undefined) throw new Error('no golden scripts');
    const golden = serializeGolden(runGoldenScript(script));
    expect(diffGolden(golden, golden)).toBeNull();
    expect(diffGolden(golden, golden.replace('"combat-started"', '"combat-startled"'))).toMatch(
      /first difference at line \d+/,
    );
    expect(diffGolden(golden, golden.trimEnd())).not.toBeNull();
    expect(diffGolden(golden, `${golden}\n`)).not.toBeNull();
  });
});
