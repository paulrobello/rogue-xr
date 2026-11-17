// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { canFlee } from '../src/rules/index.ts';

describe('canFlee', () => {
  it('lets the player flee a regular fight only', () => {
    expect(canFlee('regular')).toBe(true);
    expect(canFlee('elite')).toBe(false);
    expect(canFlee('guardian')).toBe(false);
  });
});
