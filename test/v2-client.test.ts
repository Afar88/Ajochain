import { describe, it, expect } from 'vitest';
import { v2ReceiptCommitment, v2CreditFromCommitment } from '../web/src/ajo-v2-chain.js';

describe('AjoChain v2 client receipt encoding', () => {
  it('round-trips zero, normal and large satoshi credits', () => {
    for (const amount of [0n, 1n, 100_000n, 0x7fffffffffffffffn]) {
      const encoded = v2ReceiptCommitment(3, amount);
      expect(v2CreditFromCommitment(encoded)).toBe(amount);
      expect(encoded.slice(0, 4)).toBe('5203');
    }
  });

  it('keeps member index in the receipt commitment', () => {
    expect(v2ReceiptCommitment(0, 5n)).not.toBe(v2ReceiptCommitment(1, 5n));
    expect(v2CreditFromCommitment(v2ReceiptCommitment(1, 5n))).toBe(5n);
  });

  it('rejects malformed commitments and out-of-range values', () => {
    expect(() => v2CreditFromCommitment('5300')).toThrow();
    expect(() => v2ReceiptCommitment(5, 1n)).toThrow();
    expect(() => v2ReceiptCommitment(0, -1n)).toThrow();
    expect(() => v2ReceiptCommitment(0, 0x8000000000000000n)).toThrow();
    expect(() => v2CreditFromCommitment('52000000000000000080')).toThrow();
  });
});
