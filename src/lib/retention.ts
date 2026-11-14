/**
 * Automatic Contribution Retention (ACR) accounting shared by BCH and PUSD.
 *
 * All amounts are bigint in the asset's smallest unit (sats for BCH, PUSD
 * base units for PUSD). This module is deterministic client-side accounting;
 * the matching covenant must enforce the same transition before funds move.
 */
export const DEFAULT_RETENTION_BPS = 2_000n;
export const MAX_RETENTION_BPS = 5_000n;
export const BASIS_POINTS = 10_000n;

export interface AcrPayout {
  grossPayout: bigint;
  retained: bigint;
  recipientAmount: bigint;
  retentionBps: bigint;
  nextCredits: bigint[];
}

/** Floor to the smallest asset unit so the contract and UI can agree exactly. */
export function calculateRetention(grossPayout: bigint, retentionBps = DEFAULT_RETENTION_BPS): bigint {
  if (grossPayout <= 0n) throw new Error('Gross payout must be positive');
  if (retentionBps < 0n || retentionBps > MAX_RETENTION_BPS) {
    throw new Error(`Retention must be between 0 and ${MAX_RETENTION_BPS} basis points`);
  }
  return grossPayout * retentionBps / BASIS_POINTS;
}

/**
 * Calculate one complete round. Every member must independently cover C.
 * The winner's receipt is debited by C and credited with the retained amount;
 * other receipts are debited by C. This is the member-level protection rule.
 */
export function calculateAcrPayout(
  credits: readonly bigint[],
  contribution: bigint,
  recipientIndex: number,
  retentionBps = DEFAULT_RETENTION_BPS,
): AcrPayout {
  if (credits.length < 2 || credits.length > 5) throw new Error('ACR circles need 2–5 members');
  if (contribution <= 0n) throw new Error('Contribution must be positive');
  if (!Number.isInteger(recipientIndex) || recipientIndex < 0 || recipientIndex >= credits.length) {
    throw new Error('Invalid payout recipient index');
  }
  if (credits.some(credit => credit < contribution)) {
    throw new Error('Every member must independently have one full contribution before payout');
  }

  const grossPayout = BigInt(credits.length) * contribution;
  const retained = calculateRetention(grossPayout, retentionBps);
  const nextCredits = credits.map((credit, index) =>
    credit - contribution + (index === recipientIndex ? retained : 0n),
  );

  return {
    grossPayout,
    retained,
    recipientAmount: grossPayout - retained,
    retentionBps,
    nextCredits,
  };
}
