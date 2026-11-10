/**
 * Deterministic, append-only member contribution ledger primitives.
 *
 * IMPORTANT: This module does not verify blockchain transactions. Only a trusted
 * chain verifier may emit these events after checking the destination output,
 * token category/amount, confirmations, and every funding input's previous output.
 * The existing circle covenants still enforce an aggregate pot, not these balances.
 */
export type LedgerNetwork = 'chipnet' | 'mainnet';
export type LedgerAsset = { kind: 'BCH' } | { kind: 'PUSD'; category: string };

export interface VerifiedContribution {
  type: 'contribution_confirmed';
  network: LedgerNetwork;
  circleId: string;
  txid: string;
  outputIndex: number;
  memberAddress: string;
  fundingAddresses: string[];
  asset: LedgerAsset;
  amount: bigint;
  blockHash: string;
  confirmedAt: number;
}
export interface ContributionReversal {
  type: 'contribution_reversed';
  network: LedgerNetwork;
  circleId: string;
  txid: string;
  outputIndex: number;
  reason: 'reorg' | 'invalidated';
  reversedAt: number;
}
export type MemberLedgerEvent = VerifiedContribution | ContributionReversal;
export interface MemberLedgerSummary {
  memberAddress: string;
  asset: LedgerAsset;
  paidIn: bigint;
  allocatedToCompletedRounds: bigint;
  carryForwardCredit: bigint;
  outstandingFromCompletedRounds: bigint;
  dueForCurrentRound: bigint;
}

const isHex = (value: string, bytes: number) =>
  new RegExp('^[0-9a-fA-F]{' + (bytes * 2) + '}$').test(value);

export function receiptKey(event: Pick<MemberLedgerEvent, 'network' | 'circleId' | 'txid' | 'outputIndex'>): string {
  return event.network + ':' + event.circleId.toLowerCase() + ':' + event.txid.toLowerCase() + ':' + event.outputIndex;
}
function sameAsset(a: LedgerAsset, b: LedgerAsset): boolean {
  if (a.kind !== b.kind) return false;
  return a.kind === 'BCH' || (b.kind === 'PUSD' && a.category.toLowerCase() === b.category.toLowerCase());
}
function sameFundingEvidence(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((address, index) => address === right[index]);
}

/** Validate the evidence envelope, not the underlying blockchain proof. */
export function validateVerifiedContribution(receipt: VerifiedContribution, registeredMemberAddresses: readonly string[]): void {
  if (!receipt.circleId.trim()) throw new Error('Circle id is required');
  if (!isHex(receipt.txid, 32)) throw new Error('Transaction id must be 32-byte hex');
  if (!Number.isSafeInteger(receipt.outputIndex) || receipt.outputIndex < 0) throw new Error('Output index must be a non-negative integer');
  if (receipt.amount <= 0n) throw new Error('Contribution amount must be positive');
  if (!Number.isSafeInteger(receipt.confirmedAt) || receipt.confirmedAt <= 0) throw new Error('A valid confirmation timestamp is required');
  if (!isHex(receipt.blockHash, 32)) throw new Error('Block hash must be 32-byte hex');
  if (receipt.asset.kind === 'PUSD' && !isHex(receipt.asset.category, 32)) throw new Error('PUSD category must be 32-byte hex');
  if (!registeredMemberAddresses.includes(receipt.memberAddress)) throw new Error('Funding address is not a registered circle member');
  if (receipt.fundingAddresses.length === 0) throw new Error('Funding input addresses are required');
  const uniqueFundingAddresses = [...new Set(receipt.fundingAddresses)];
  if (uniqueFundingAddresses.length !== 1) throw new Error('Mixed or ambiguous funding addresses cannot be attributed automatically');
  if (uniqueFundingAddresses[0] !== receipt.memberAddress) throw new Error('Funding address must match the registered member address');
}

/**
 * Replay events in order. Duplicate observations are idempotent; conflicts fail
 * closed. A reversal removes the active receipt at that point in the event log,
 * allowing a later independently verified confirmation after a chain reorg.
 */
export function replayMemberLedger(events: readonly MemberLedgerEvent[]): Map<string, VerifiedContribution> {
  const receipts = new Map<string, VerifiedContribution>();
  for (const event of events) {
    const key = receiptKey(event);
    if (event.type === 'contribution_confirmed') {
      const existing = receipts.get(key);
      if (existing) {
        const identical = existing.memberAddress === event.memberAddress
          && existing.amount === event.amount
          && sameAsset(existing.asset, event.asset)
          && existing.blockHash.toLowerCase() === event.blockHash.toLowerCase()
          && existing.confirmedAt === event.confirmedAt
          && sameFundingEvidence(existing.fundingAddresses, event.fundingAddresses);
        if (!identical) throw new Error('Conflicting receipt observed for ' + key);
        continue;
      }
      receipts.set(key, event);
    } else {
      if (!receipts.has(key)) throw new Error('Cannot reverse unknown contribution receipt ' + key);
      receipts.delete(key);
    }
  }
  return receipts;
}

/**
 * Derive one member's position for one asset. completedRounds is the confirmed
 * contract round index. Positive net is same-member carry-forward; negative net
 * is arrears. Informational accounting only, not an enforceable pooled-fund claim.
 */
export function summarizeMemberLedger(
  events: readonly MemberLedgerEvent[],
  options: {
    network: LedgerNetwork;
    circleId: string;
    memberAddress: string;
    asset: LedgerAsset;
    contributionPerRound: bigint;
    completedRounds: number;
  },
): MemberLedgerSummary {
  if (options.contributionPerRound <= 0n) throw new Error('Contribution per round must be positive');
  if (!Number.isSafeInteger(options.completedRounds) || options.completedRounds < 0) throw new Error('Completed rounds must be a non-negative integer');
  const receipts = replayMemberLedger(events);
  let paidIn = 0n;
  for (const receipt of receipts.values()) {
    if (receipt.network !== options.network
      || receipt.circleId.toLowerCase() !== options.circleId.toLowerCase()
      || receipt.memberAddress !== options.memberAddress
      || !sameAsset(receipt.asset, options.asset)) continue;
    paidIn += receipt.amount;
  }
  const allocatedToCompletedRounds = options.contributionPerRound * BigInt(options.completedRounds);
  const net = paidIn - allocatedToCompletedRounds;
  const carryForwardCredit = net > 0n ? net : 0n;
  const outstandingFromCompletedRounds = net < 0n ? -net : 0n;
  const dueForCurrentRound = options.contributionPerRound > carryForwardCredit
    ? options.contributionPerRound - carryForwardCredit : 0n;
  return {
    memberAddress: options.memberAddress, asset: options.asset, paidIn,
    allocatedToCompletedRounds, carryForwardCredit, outstandingFromCompletedRounds,
    dueForCurrentRound,
  };
}
