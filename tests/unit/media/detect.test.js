import { describe, it, expect } from 'vitest';
import { detectMedia } from '../../../src/media/detect.js';

describe('detectMedia', () => {
  it('returns hasMedia=false for a plain text body', () => {
    expect(detectMedia({ Body: 'hi' })).toEqual({ hasMedia: false, count: 0 });
  });

  it('parses Media as a JSON array', () => {
    const body = { Media: JSON.stringify([{ Sid: 'MEabc' }]) };
    expect(detectMedia(body)).toEqual({ hasMedia: true, count: 1 });
  });
});
