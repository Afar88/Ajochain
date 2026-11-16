import { describe, expect, it } from 'vitest';
import {
  calculateAcrPayout,
  calculateRetention,
  DEFAULT_RETENTION_BPS,
} from '../src/lib/retention.js';

describe('Automatic Contribution Retention (ACR)', () => {
  it('defaults to 20 percent', () => {
    expect(DEFAULT_RETENTION_BPS).toBe(2_000n);
    expect(calculateRetention(500_000n)).toBe(100_000n);
  });

  it('credits the winner and debits every member by one contribution', () => {
    const result = calculateAcrPayout([150_000n, 100_000n], 100_000n, 0);
    expect(result.grossPayout).toBe(200_000n);
    expect(result.retained).toBe(40_000n);
    expect(result.recipientAmount).toBe(160_000n);
    expect(result.nextCredits).toEqual([90_000n, 0n]);
  });

  it('retains exactly one contribution in a five-member circle at 20 percent', () => {
    const result = calculateAcrPayout(
      [100_000n, 100_000n, 100_000n, 100_000n, 100_000n],
      100_000n,
      0,
    );
    expect(result.retained).toBe(100_000n);
    expect(result.recipientAmount).toBe(400_000n);
    expect(result.nextCredits).toEqual([100_000n, 0n, 0n, 0n, 0n]);
  });

  it('carries excess credit forward over multiple rounds', () => {
    const first = calculateAcrPayout([250n, 100n], 100n, 0);
    expect(first.nextCredits).toEqual([190n, 0n]);
    const second = calculateAcrPayout(first.nextCredits.map((credit, index) => credit + (index === 1 ? 100n : 0n)), 100n, 1);
    expect(second.nextCredits).toEqual([90n, 40n]);
  });

  it('uses integer floor rounding for small PUSD base-unit amounts', () => {
    expect(calculateRetention(3n)).toBe(0n);
    expect(calculateRetention(9_999n)).toBe(1_999n);
  });

  it('supports an explicitly agreed per-circle rate', () => {
    expect(calculateAcrPayout([100n, 100n], 100n, 0, 1_500n).retained).toBe(30n);
  });

  it('rejects a payout if even one member is short', () => {
    expect(() => calculateAcrPayout([100n, 99n], 100n, 0)).toThrow(/Every member/);
  });

  it('rejects invalid rates and recipient indexes', () => {
    expect(() => calculateRetention(100n, 5_001n)).toThrow(/Retention/);
    expect(() => calculateAcrPayout([100n, 100n], 100n, 2)).toThrow(/recipient/);
  });
});
