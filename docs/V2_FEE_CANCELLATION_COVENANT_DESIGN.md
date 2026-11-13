# V2 BCH fee and pre-payout cancellation covenant design

Status: implementation and verification record for the isolated V2 branch. The separate `contracts/AjoCircleV2Fee.cash` covenant is wired into `web/src/ajo-v2-fee-chain.ts` and a separate V2 fee-circle UI flow. It uses the `0x54 | round | hasPaid` state, enforces the 1% BCH treasury output, and supports initiator-only cancellation before the first payout with exact member-credit refunds. The last successful recovery-preview build, commit `08935505709c525fce2285b69e657b3bc60c4b8c`, compiled the CashScript contracts, passed TypeScript checking, passed all 104 tests across 9 files, and completed the Vite build. An additional 5-test integration suite was added afterward in commit `d7113cd05dec8ed79ab44ab414e833cbc1db08ba`; that newer test file has not yet run because Vercel has enforced its daily deployment API limit. This remains an experimental, unaudited Chipnet prototype and is not approved for real funds or production. The original `AjoCircleV2.cash` and all V1 circles remain unchanged.

## Why a new covenant version is required

The current V2 covenant has a two-byte state commitment (`0x53 | round`) and a payout layout with one recipient output. It does not enforce a project fee, identify an initiator, or permanently record whether a payout has occurred. Adding constructor arguments or changing commitment parsing in place would change the covenant locking bytecode and could make previously created V2 prototype circles unspendable by clients that only know the old artifact.

Fee and cancellation rules are implemented in the separately named/versioned `AjoCircleV2Fee` covenant and artifact. Existing V1 circles and circles created with the original V2 artifact retain their current decoding and spending path.

## Fee policy

For each successful payout:

- Gross round amount: `G = memberCount * contribution`.
- Project fee: `T = floor(G / 100)` satoshis (1% of gross, rounded down).
- Miner fee: the actual transaction fee, independently bounded by the circle's configured `maxFee`.
- Recipient amount: `R = G - T - minerFee`.

The covenant must enforce a fixed output to the immutable treasury P2PKH hash for exactly `T`. It must enforce the current recipient's registered P2PKH output and require its value to be in the inclusive range `G - T - maxFee` through `G - T`. The transaction must have an exact input/output layout so no additional output can divert value. BCH input/output conservation then makes the residual miner fee explicit and bounded. The treasury output must be token-free and dust-safe.

Treasury destination is a constructor commitment, not a mutable UI setting. A future treasury change applies only to circles created with the newer configuration; it never rewrites an existing circle's destination. The currently approved Chipnet BCH treasury is provisional and must be validated for the target network before new genesis. It is not a PUSD destination.

## Permanent first-payout state

Use a new state commitment with explicit fields:

- Prefix: `0x54` (distinct from the prototype's `0x53`).
- Round: one byte, constrained to `0..memberCount-1`.
- Has-paid flag: one byte, exactly `0x00` before the first payout and `0x01` afterward.

Genesis creates `0x54 | 0x00 | 0x00`. Every deposit preserves both state fields. Every successful payout advances the round cyclically and sets the flag to `0x01`; all later payouts preserve `0x01`. The covenant must reject malformed lengths, invalid round values, and flag values other than 0 or 1. The flag must never reset when the round cycles back to member zero.

## Cancellation policy and accounting

Cancellation is permitted only while the permanent has-paid flag is zero. It must be initiated by the configured initiator, whose P2PKH identity is committed in the covenant constructor. The transaction must consume the state NFT and every member receipt atomically; the state NFT must not survive cancellation.

For each member, refund the exact BCH credit encoded in that member's receipt to that member's registered P2PKH address. Never calculate a refund from the pooled state value or from a pro-rata share. Preserve the member-specific receipt-to-address mapping and reject missing, duplicate, reordered, malformed, or extra category NFTs. The contract must also account for the BCH dust value attached to each receipt and the state reserve without reducing any member's credited principal.

Cancellation miner fees must be funded by a separate, token-free initiator fee input/reserve, not deducted from member credit or any PUSD backing. The current source layout consumes the state NFT, all receipts in member order, and one token-free initiator P2PKH input. It refunds each member's encoded credit plus that receipt's attached BCH value, then returns token-free change to the initiator. The contract enforces `stateValue = sum(memberCredits) + 1,000` and constrains the residual miner fee to `maxFee`; if the fee input cannot leave dust-safe change within that ceiling, cancellation fails atomically. This preliminary layout must still be validated against real transaction bytes and CashScript compiler behavior. All refunds and token burns happen atomically in one transaction.

After any successful payout, cancellation must be impossible at covenant level, even if the round counter has wrapped back to zero. No UI toggle or database status can override this rule.

## Required tests before implementation is considered complete

- Treasury hash/network validation; reject wrong network, non-P2PKH, malformed, and changed treasury outputs.
- Exact 1% floor rounding, including values not divisible by 100.
- Treasury output exactly equals the fee; reject underpayment, overpayment, wrong destination, token-bearing output, and extra outputs.
- Recipient output plus actual miner fee conserves exactly the gross amount after treasury fee; reject miner fee above `maxFee`.
- Repeated deposits preserve state commitment and member attribution.
- Cancellation before any payout refunds every member's exact receipt credit to the registered address, including zero-credit members.
- Reject cancellation by a non-initiator, with missing/duplicate/swapped receipts, wrong refund address, altered credit, unexpected token UTXO, or insufficient fee funding.
- First payout sets the permanent flag; cancellation remains rejected after one payout and after a full rotation cycle.
- Repeated payouts preserve the flag and continue cyclic recipient order.
- Replay/transaction-byte tests and independent-wallet Chipnet tests before any production consideration.

## PUSD remains separate

Do not reuse BCH fee outputs, BCH treasury addresses, or BCH satoshi accounting for PUSD. PUSD V2 requires a separately verified Chipnet token category, issuer-authenticated decimals, token-aware treasury destination, and member-specific token escrow/receipt design. Until those inputs are verified, PUSD creation and spending remain fail-closed.
