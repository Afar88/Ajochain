import { describe, expect, it } from 'vitest';
import { parseMockPusdAmount } from '../web/src/mock-pusd.js';

describe('tPUSD amount parsing', () => {
  it.each([
    ['100', 100_000_000n],
    ['25.5', 25_500_000n],
    ['0.000001', 1n],
    ['001.20', 1_200_000n],
    [' 2.75 ', 2_750_000n],
  ])('parses %s into six-decimal base units', (input, expected) => {
    expect(parseMockPusdAmount(input)).toBe(expected);
  });

  it.each(['', '0', '0.000000', '-1', '+1', '.5', '1.', '1.0000001', '1e3', 'abc'])(
    'rejects invalid or zero amount %s',
    (input) => {
      expect(() => parseMockPusdAmount(input)).toThrow();
    },
  );
});
