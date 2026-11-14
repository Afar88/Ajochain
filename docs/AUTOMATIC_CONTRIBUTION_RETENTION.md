# Automatic Contribution Retention (ACR)

Status: implementation work in progress. This specification defines the shared accounting rule for new BCH and PUSD circles. It does not alter existing circles, deploy a covenant, or authorize mainnet use.

## Product rule

New ACR-enabled circles default to **20% retention (2,000 basis points)**. The rate is agreed by every member at circle creation and committed to the circle's immutable contract parameters. A circle may choose another rate from 0% to 50%; the chosen rate cannot change after creation.

ACR is asset-unit agnostic:
- BCH uses satoshis.
- PUSD uses the token's integer base units.

All calculations use integer arithmetic and round the retained amount down to the nearest smallest asset unit.

## Payout transition

For N members, per-member contribution C, recipient index w, and retention rate r basis points:

- Gross payout: P = N × C.
- Retained amount: T = floor(P × r / 10,000).
- Net recipient amount before miner fee: P − T.
- Every member i must independently have credit_i ≥ C.
- Every member's new credit is credit_i − C.
- The recipient's new credit is additionally increased by T.

Therefore:
- Winner: credit_w' = credit_w − C + T.
- Other member i: credit_i' = credit_i − C.

The retained asset remains inside the circle covenant. It is not a second deposit and must never be counted twice. It is earmarked as the winner's future contribution credit. Any excess remains in that same member's credit and rolls forward.

## Conservation invariant

Sum(new member credits) = sum(old member credits) − (N × C) + T.

The actual asset held by the circle after paying the recipient must equal the sum of all member credits, subject only to explicitly accounted BCH fee reserves and token backing. A payout must fail if any member is short, even if another member has excess credit.

## BCH implementation

Use a new covenant version for ACR-enabled circles. Do not modify the bytecode/address semantics of existing V1 or V2 circles. The new BCH covenant must commit to retention basis points, update the winner's receipt commitment by T, preserve all other member receipt rules, and retain T satoshis in the covenant. The payout builder and UI must calculate exactly the same outputs.

## PUSD implementation

Use a separate new PUSD member-credit covenant version. The legacy pooled PUSD contract cannot safely attribute retained funds to the winning member. PUSD v3 must maintain a member receipt for every participant and a PUSD token pool whose token amount is reconciled to the sum of receipt credits. Deposits must prove the registered member's token-aware funding address. Payout must debit one contribution from every receipt, add T to the winner's receipt, pay P − T PUSD to the recipient, and leave exactly T PUSD backing the new member-credit total in the pool. The PUSD BCH backing must be preserved; only the separately designated token-free BCH reserve may pay miner fees.

## UX

Every circle summary and payout preview must show:
- gross payout;
- agreed retention percentage and retained amount;
- net payout before network fee;
- the winner's updated next-contribution credit;
- each other member's remaining credit and any shortfall.

Do not label an off-chain estimate as contract-enforced. Display the ACR protection as active only when the matching ACR covenant version is deployed and its state has been verified from chain data.

## Rollout and safety gates

1. Implement and test the BCH ACR covenant and planner.
2. Implement the separate PUSD ACR covenant, receipt/pool reconciliation, and planner.
3. Add adversarial tests for wrong member, wrong asset category, receipt mismatch, pool mismatch, shortfall, overflow, rounding, output redirection, excess rollover, and replay.
4. Compile artifacts and run unit tests, typecheck, and web build.
5. Test both flows with multiple independent Selene wallets on Chipnet, including raw transaction inspection.
6. Obtain an independent covenant security review.

No merge, deployment, or mainnet activation is included in this work.
