import { describe, expect, it } from 'vitest';
import pkg from '../package.json' with { type: 'json' };

describe('toolchain pins', () => {
  it('pins three to the xr-workspace peer version', () => {
    expect(pkg.dependencies.three).toBe('0.186.1');
  });
});
