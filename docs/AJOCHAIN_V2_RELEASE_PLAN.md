# AjoChain v2 release plan: BCH, PUSD, cancellation and refunds

Status: active implementation plan. This document is a release specification, not evidence that the features are implemented or safe for mainnet.

## Release objective

Ship a new, versioned circle protocol for new circles with:

- BCH member-specific credit and carry-forward;
- PUSD member-specific token credit and carry-forward;
- permissionless round payouts only when every member has sufficient credit;
- member-protected cancellation and refunds;
- a mobile-friendly interface that clearly distinguishes legacy v1 circles from v2 circles.

Existing v1 circle links, addresses, contracts, and funds remain supported. Do not migrate v1 circles: their historical shared-pot contributions cannot be attributed reliably to individual members.

## Current baseline (verified from repository source)

- The existing BCH contract is an aggregate shared-pot covenant; it does not prove which member funded a contribution.
- The existing PUSD contract is a separate aggregate token-pot covenant. It is marked experimental and Chipnet-only in the application.
- The existing PUSD contract has a unanimous-member cancellation covenant method, but the current app does not provide a complete multi-wallet cancellation builder/signing flow.
- The BCH v2 prototype on `feat/chipnet-member-credit-v2-prototype` has member receipt NFTs and BCH credit/debit planners, but it is not the release branch and is not a production-ready implementation.
- The prototype does not implement PUSD receipts, v2 cancellation/refunds, or independent real-wallet Chipnet verification.

## Target protocol architecture

### Circle identity and versioning

- New v2 circles use an explicit versioned invite format and a distinct contract artifact/address.
- The state NFT and all member receipts belong to one pinned CashTokens category and the same covenant address.
- Member order, member count, contribution amount, asset, fee ceiling, and protocol version are immutable circle parameters.
- BCH and PUSD circles are separate asset instances; no implicit conversion or cross-subsidy is allowed.
- All token category and NFT capability/commitment checks must be enforced on-chain and independently checked by the client before constructing a spend.

### Member credit model

For every member i, maintain a covenant-controlled receipt that is bound to the circle and member index.

- BCH receipt credit is denominated in satoshis.
- PUSD receipt credit is denominated in the exact PUSD token base units; do not use floating-point display amounts in contract arithmetic.
- A deposit can increase only the receipt belonging to the registered member whose signature/funding input is verified by the covenant.
- The receipt cannot be replayed, duplicated, transferred to another member, or moved to another circle.
- Payout is allowed only when every member receipt covers one full contribution.
- Each payout debits exactly one contribution from every member receipt. Remaining credit stays with its original member.
- A member's surplus must never satisfy another member's shortfall.
- UI balances are read from validated on-chain receipts. Database/indexer data may cache observations but is never the financial source of truth.

### PUSD-specific accounting and BCH backing

The PUSD v2 flow must be designed as a first-class token protocol, not a BCH contract with a token label.

- Pin the intended PUSD category and reject every other token category.
- Represent each member's PUSD credit in a receipt UTXO that carries the member receipt NFT and the corresponding fungible PUSD amount, or prove an equally strong covenant-enforced representation.
- On deposit, require the registered member's signature and increase only that member's receipt token amount.
- On payout, atomically debit one contribution's worth of PUSD from every member receipt and pay exactly memberCount × contribution PUSD to the scheduled recipient.
- Return all PUSD surplus to the same member receipts; preserve member ownership.
- Preserve BCH backing attached to token-bearing outputs. Fund miner fees from a separate token-free BCH reserve and enforce dust on every token output and reserve change.
- Reject mixed categories, unexpected token-bearing UTXOs, duplicate/missing receipts, token amount inflation, altered NFT capabilities, and unexpected outputs.
- PUSD remains Chipnet-only until the token category, issuer/asset assumptions, contract behavior, and wallet flow have been independently verified. Do not imply a stablecoin peg or redemption guarantee.

### Cancellation and refunds

Cancellation must be an on-chain state transition, not merely a UI status.

Target rules:

1. Before any contributions: organiser may request cancellation; the contract must prevent the organiser from taking member funds.
2. After contributions but before any payout: cancellation requires the consent rule encoded in the circle terms (initial release target: all registered members authorize one cancellation transaction). The transaction refunds each member's own verified remaining credit to that member's registered address.
3. After one or more payouts: cancellation refunds only each member's remaining on-chain credit. Completed payouts are final and cannot be clawed back by the cancellation flow. The UI must show completed rounds and outstanding obligations before requesting signatures.
4. Cancellation must consume the state and every member receipt in the exact expected order, reject missing/duplicate/unexpected circle assets, and prevent organiser-selected refund destinations.
5. For PUSD, refund each member's remaining PUSD token amount to their registered address while preserving token-output BCH backing; BCH fee reserve handling must be explicit.
6. If unanimous signing cannot be completed, funds remain locked under the published covenant rules. Do not silently weaken the consent threshold or offer an admin override.

The exact CashScript signature layout and cancellation state transition must be proven in tests before the feature is exposed in the UI.

## Implementation workstreams

### A. Protocol and contracts
- Stabilize BCH v2 genesis, deposit, payout, and complete UTXO-set validation.
- Design and implement PUSD v2 receipt/deposit/payout covenants.
- Implement cancellation/refund covenants for both assets.
- Add strict integer, dust, fee, token-category, NFT-capability, commitment, input-order, and output-layout constraints.
- Document irreversible states and transaction fee responsibility.

### B. Client and wallet integration
- Build and inspect genesis transactions output by output before wallet signing.
- Add BCH and PUSD member deposit planners and transaction inspection.
- Add payout planners that refuse incomplete, malformed, or unexpected UTXO sets.
- Add cancellation transaction builder and a safe multi-wallet signature collection flow supported by the actual WizardConnect API. Do not assume arbitrary message signing.
- Display member credits, top-ups, carry-forward, payout readiness, completed rounds, and refund destinations from validated chain state.
- Clearly label network, asset, protocol version, and experimental status.

### C. Verification
- Unit and covenant VM tests for all valid transitions and adversarial cases.
- Transaction serialization tests using actual raw transaction bytes.
- Test genesis category derivation and exact output indexes.
- Independent Selene/WizardConnect wallet tests on Chipnet with multiple member wallets.
- Test repeated rounds, overpayments, partial credits, cancellation before and after payouts, fee edge cases, dust, reorg/reconfirmation, replay, and malformed UTXO sets.
- Verify v1 regression tests and existing v1 links remain unchanged.
- Obtain an independent CashTokens/CashScript security review before mainnet.

### D. Release and operations
- Keep development on this release branch and use Vercel Preview for review.
- Keep all v2 financial features Chipnet-only while any release gate is open.
- Publish migration/compatibility notes: v1 circles remain v1; only newly created circles use v2.
- Deploy to production only after all gates pass and the production configuration is verified.
- Mainnet enablement requires an explicit release decision after independent review. A green CI run or Vercel Ready status is not a security audit.

## Release gates (all required)

- [ ] BCH v2 genesis output layout independently inspected.
- [ ] BCH deposit, rollover, payout, and cancellation/refund contracts implemented.
- [ ] PUSD v2 receipt, deposit, rollover, payout, and cancellation/refund contracts implemented.
- [ ] No cross-member credit substitution or cross-asset subsidy.
- [ ] All transaction planners validate exact token UTXO sets and exact output layouts.
- [ ] Full adversarial contract and client test suites pass.
- [ ] Typecheck, build, and CashScript compilation pass.
- [ ] Real multi-wallet Chipnet testing completed and transaction IDs reviewed.
- [ ] Independent security review completed and findings resolved.
- [ ] V1 regression and backward-compatibility checks pass.
- [ ] Production deployment configuration and rollback plan verified.

Until every applicable gate is complete, the release is a Chipnet beta/preview, not a mainnet launch.
