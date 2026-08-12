import { describe, it, expect } from 'vitest';
import { mintHandoffId } from '../../../src/elevenlabs/handoff-id.js';

describe('mintHandoffId', () => {
  it('formats handoff_<sid>_<epoch>', () => {
    expect(mintHandoffId('CHabc', 1700000000000)).toBe('handoff_CHabc_1700000000000');
  });
});
