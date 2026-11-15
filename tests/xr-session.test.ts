import { describe, expect, it } from 'vitest';
import { XR_SESSION_OPTIONS } from '../src/xr/session.ts';

describe('XR session options', () => {
  it('requests medium foveation and a floor-relative space', () => {
    expect(XR_SESSION_OPTIONS.foveation).toBe('medium');
    expect(XR_SESSION_OPTIONS.referenceSpaces[0]).toBe('local-floor');
  });
});
