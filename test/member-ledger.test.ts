import { describe, expect, it } from 'vitest';
import {
  replayMemberLedger, summarizeMemberLedger, validateVerifiedContribution,
  type MemberLedgerEvent, type VerifiedContribution,
} from '../src/lib/member-ledger.js';

const memberA = 'bchtest:qmemberA';
const memberB = 'bchtest:qmemberB';
const txid = 'ab'.repeat(32);
const blockHash = 'cd'.repeat(32);
const bch = { kind: 'BCH' } as const;
function receipt(overrides: Partial<VerifiedContribution> = {}): VerifiedContribution {
  return {
    type: 'contribution_confirmed', network: 'chipnet', circleId: 'circle-1',
    txid, outputIndex: 1, memberAddress: memberA, fundingAddresses: [memberA],
    asset: bch, amount: 150n, blockHash, confirmedAt: 1_800_000_000, ...overrides,
  };
}
const summary = (events: MemberLedgerEvent[], completedRounds = 1) =>
  summarizeMemberLedger(events, {
    network: 'chipnet', circleId: 'circle-1', memberAddress: memberA,
    asset: bch, contributionPerRound: 100n, completedRounds,
  });

describe('member contribution ledger', () => {
  it('validates a receipt for one registered funding address', () => {
    expect(() => validateVerifiedContribution(receipt(), [memberA, memberB])).not.toThrow();
  });
  it('rejects an unregistered member', () => {
    expect(() => validateVerifiedContribution(receipt({ memberAddress: memberB }), [memberA])).toThrow(/not a registered/);
  });
  it('rejects mixed-input funding', () => {
    expect(() => validateVerifiedContribution(receipt({ fundingAddresses: [memberA, memberB] }), [memberA, memberB])).toThrow(/Mixed or ambiguous/);
  });
  it('rejects funding from a different address', () => {
    expect(() => validateVerifiedContribution(receipt({ fundingAddresses: [memberB] }), [memberA, memberB])).toThrow(/must match/);
  });
  it('deduplicates the same transaction output', () => {
    const events = [receipt(), receipt()];
    expect(replayMemberLedger(events).size).toBe(1);
    expect(summary(events).paidIn).toBe(150n);
  });
  it('fails closed on conflicting duplicate observations', () => {
    expect(() => replayMemberLedger([receipt(), receipt({ amount: 200n })])).toThrow(/Conflicting receipt/);
  });
  it('credits excess from the same member toward the next round', () => {
    const result = summary([receipt({ amount: 250n })], 1);
    expect(result.paidIn).toBe(250n);
    expect(result.allocatedToCompletedRounds).toBe(100n);
    expect(result.carryForwardCredit).toBe(150n);
    expect(result.dueForCurrentRound).toBe(0n);
  });
  it('shows the remaining amount due for a partial carry-forward', () => {
    const result = summary([receipt({ amount: 160n })], 1);
    expect(result.carryForwardCredit).toBe(60n);
    expect(result.dueForCurrentRound).toBe(40n);
  });
  it('keeps underpayment from completed rounds visible as arrears', () => {
    const result = summary([receipt({ amount: 60n })], 1);
    expect(result.outstandingFromCompletedRounds).toBe(40n);
    expect(result.carryForwardCredit).toBe(0n);
    expect(result.dueForCurrentRound).toBe(100n);
  });
  it('does not mix BCH and PUSD accounting', () => {
    const pusd = receipt({ txid: 'ef'.repeat(32), asset: { kind: 'PUSD', category: '12'.repeat(32) }, amount: 900n });
    expect(summary([receipt({ amount: 250n }), pusd]).paidIn).toBe(250n);
  });
  it('removes a receipt after a reorg reversal event', () => {
    const events: MemberLedgerEvent[] = [receipt(), {
      type: 'contribution_reversed', network: 'chipnet', circleId: 'circle-1',
      txid, outputIndex: 1, reason: 'reorg', reversedAt: 1_800_000_100,
    }];
    expect(replayMemberLedger(events).size).toBe(0);
    expect(summary(events).paidIn).toBe(0n);
  });
  it('rejects reversing an unknown receipt', () => {
    expect(() => replayMemberLedger([{
      type: 'contribution_reversed', network: 'chipnet', circleId: 'circle-1',
      txid, outputIndex: 1, reason: 'reorg', reversedAt: 1_800_000_100,
    }])).toThrow(/unknown contribution/);
  });
});
