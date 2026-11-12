# AjoChain v2 protocol gap and security findings

Review date: 2026-11-10
Scope: repository source on `main` plus the draft BCH v2 prototype branch.
Status: findings from static source review; not a security audit.

## Release blockers found

### 1. Existing PUSD cancellation method is not a safe refund implementation

The current `AjoCirclePUSD.cancel(...)` covenant method verifies signatures from all registered members and checks the state NFT category. It does not constrain the transaction's output count, output destinations, token categories/amounts, BCH backing, or the mapping between each member and their refund.

Consequently, unanimous signatures alone do not prove that each member receives their own funds. This method must not be presented as a safe refund path or wired into a user-facing cancellation button. Treat it as an incomplete authorization primitive until the covenant enforces the complete refund transaction.

### 2. Existing PUSD contribution model is pooled, not member-attributed

The current PUSD contract and client helpers aggregate token-bearing UTXOs at the circle address and check whether the aggregate pot covers a round. There is no immutable per-member receipt or on-chain binding of each contribution to its member.

This does not meet the v2 member-credit/rollover requirement. The PUSD v2 protocol needs its own receipt state and must debit exactly one contribution from every member's receipt on payout, preserving each member's surplus.

### 3. Existing PUSD payout advances rounds only to completion

The PUSD covenant increments the round and rejects a round outside the member count. Unlike the BCH v2 prototype's cyclic round index, it does not implement repeated rotation cycles. V2 must explicitly specify whether circles are finite or repeat indefinitely and ensure UI status matches the contract.

### 4. BCH v2 genesis still needs independent transaction-level inspection

The BCH v2 client creates one minting state NFT and one receipt NFT per member. The prototype documentation itself notes that checking the address UTXO set after broadcast is not a substitute for inspecting the raw genesis transaction outputs and proving no unexpected category NFTs were created elsewhere.

### 5. Existing BCH v2 cancellation is absent

The BCH v2 contract has deposit and payout methods only. A cancellation covenant and safe transaction builder do not exist in the prototype.

## Required refund invariants

For both assets, a cancellation transaction must be covenant-enforced and must:

- consume exactly one valid state NFT and exactly one valid receipt for every registered member;
- reject missing, duplicate, unexpected, or wrong-category circle assets;
- validate the current state and all receipt commitments before calculating refunds;
- return each member's own remaining credit/token amount only to that member's immutable registered address;
- preserve PUSD token category and all required BCH backing for token outputs;
- pay miner fees only from an explicitly defined token-free fee reserve (PUSD) or a separately specified BCH fee budget;
- enforce dust and exact output counts/order;
- prevent the organiser from selecting refund destinations or redirecting another member's credit;
- define cancellation after payouts using remaining receipt credits only; completed payouts are final;
- require the published authorization threshold, with no hidden admin override;
- have replay, malformed transaction, wrong-output, and adversarial tests against serialized transaction bytes.

## Required PUSD v2 design

Do not adapt the pooled PUSD v1 payout method by adding a member label in the frontend.

A proper PUSD v2 design must specify and test:
- one covenant-controlled receipt per member;
- exact token category and integer base-unit accounting;
- member-authenticated deposits that update only that member's receipt;
- payout requiring every member's own receipt to cover the contribution;
- exact debit from every receipt and return of each member's surplus;
- recipient receives exactly memberCount × contribution tokens;
- token-output BCH backing is conserved;
- fee reserve is token-free, sufficient, and cannot be drained by token backing;
- cancellation refunds each member's own remaining token amount.

## Recommended sequence

1. Keep v1 production behavior unchanged.
2. Treat PR #15 as the BCH v2 experimental base only; do not merge it into production yet.
3. Implement BCH cancellation/refunds with full covenant output constraints and serialized transaction tests.
4. Design PUSD v2 receipts, then implement PUSD deposit, payout, rollover, and cancellation as a separate covenant path.
5. Integrate multi-party cancellation signatures using only documented wallet signing APIs; do not assume message signing or silent background signatures.
6. Add complete UI states and error handling for BCH/PUSD v2.
7. Run all CI and independent multi-wallet Chipnet tests.
8. Obtain an independent CashScript/CashTokens security review before mainnet launch.

## Release posture

The current source is not ready for a production v2 launch. PUSD cancellation must not be exposed as functional, and the current pooled PUSD flow is not member-specific. Until all release gates pass, v2 must remain a clearly labelled Chipnet beta.
