// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const RULES_DIR = join(ROOT, 'src', 'rules');
const RNG_FILE = join(ROOT, 'src', 'core', 'rng.ts');

const SPECIFIER_PATTERNS = [
  /\b(?:import|export)\s[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]/g,
  /\bimport\s*['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];

/** Every module specifier in `source`: static imports, re-exports, side-effect and dynamic imports. */
function importSpecifiers(source: string): string[] {
  return SPECIFIER_PATTERNS.flatMap((pattern) =>
    [...source.matchAll(pattern)].map((match) => match[1] as string),
  );
}

/** Why `specifier` imported from `file` breaks the rules boundary, or `null` when it is allowed. */
function boundaryViolation(file: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return `bare import '${specifier}'`;
  const target = resolve(dirname(file), specifier);
  const inRules = !relative(RULES_DIR, target).startsWith('..');
  return inRules || target === RNG_FILE ? null : `outside import '${specifier}'`;
}

function rulesFiles(): string[] {
  return readdirSync(RULES_DIR, { recursive: true, encoding: 'utf8' })
    .filter((name) => name.endsWith('.ts'))
    .map((name) => join(RULES_DIR, name));
}

describe('rules import boundary', () => {
  it('scans a non-empty src/rules', () => {
    expect(rulesFiles().length).toBeGreaterThanOrEqual(3);
  });

  it('src/rules imports only itself and src/core/rng.ts', () => {
    const violations = rulesFiles().flatMap((file) =>
      importSpecifiers(readFileSync(file, 'utf8')).flatMap((specifier) => {
        const problem = boundaryViolation(file, specifier);
        return problem ? [`${relative(ROOT, file)}: ${problem}`] : [];
      }),
    );
    expect(violations).toEqual([]);
  });

  it('finds the multi-line imports of the real engine file', () => {
    const specifiers = importSpecifiers(readFileSync(join(RULES_DIR, 'engine.ts'), 'utf8'));
    expect(new Set(specifiers)).toEqual(new Set(['../core/rng.ts', './statuses.ts', './types.ts']));
  });

  it('the scanner flags three.js, the toolkit, packages and outside paths', () => {
    const file = join(RULES_DIR, 'engine.ts');
    const source = [
      "import * as T from 'three';",
      "import { Vector3 } from 'three/webgpu';",
      "import type { Workspace } from '@par/xr-workspace';",
      "export { x } from '../core/state.ts';",
      "import '../xr/session.ts';",
      "const m = await import('node:fs');",
      "import { Stream } from '../core/rng.ts';",
      "import type { Effect } from './types.ts';",
      'import {\n  Mesh,\n  Group,\n} from "three/addons/x.js";',
    ].join('\n');
    const verdicts = Object.fromEntries(
      importSpecifiers(source).map((s) => [s, boundaryViolation(file, s) === null]),
    );
    expect(verdicts).toEqual({
      three: false,
      'three/webgpu': false,
      '@par/xr-workspace': false,
      '../core/state.ts': false,
      '../xr/session.ts': false,
      'node:fs': false,
      '../core/rng.ts': true,
      './types.ts': true,
      'three/addons/x.js': false,
    });
  });
});
