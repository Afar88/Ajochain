# PUSD member-credit v2 and cancellation security design

Status: implementation specification and source-level security review. This document is not an independent audit and does not authorize mainnet use.

## Immediate containment shipped on this branch

The legacy `AjoCirclePUSD.cancel` entry point is disabled. The old pooled model did not bind pooled PUSD inputs to member identities, and its former cancellation method checked consent signatures but did not constrain the transaction's outputs. It therefore could not prove member-specific refunds. Do not use the legacy cancellation entry point.

Existing v1 circles remain on their existing contract addresses. Do not migrate or reinterpret their pooled balances as member-owned credit.

## PUSD v2 state model

A PUSD v2 circle must be a separate contract version and a new circle. Use two distinct CashToken categories:

- Circle category: one minting state NFT and one immutable receipt NFT per member.
- PUSD category: the configured PUSD fungible token category. It must never equal the circle category.

For each member i, maintain a covenant-controlled receipt NFT commitment containing a version byte, member index, and bounded little-endian PUSD base-unit credit. Also maintain a distinct PUSD-bearing escrow UTXO for that same member at the covenant address. The receipt credit and escrow token amount must match exactly. The receipt NFT is the ownership/accounting record; the fungible PUSD UTXO is the actual asset backing it. A receipt without its matching token escrow is invalid.

Every PUSD deposit must:
1. Spend the current state NFT and exactly the selected member receipt and that member's PUSD escrow (or an explicitly defined empty-genesis state).
2. Include only PUSD funding inputs whose locking bytecode is the registered member's token-aware P2PKH address, plus a separately identified token-free BCH fee input.
3. Verify each PUSD input's category, amount, NFT absence, locking bytecode, and BCH satoshi value.
4. Return PUSD change only to that same registered member.
5. Increase the member receipt commitment and that member's escrow token amount by exactly the credited amount.
6. Preserve the BCH backing of all PUSD-bearing inputs; only a dedicated token-free BCH fee reserve may pay miner fees.
7. Reject extra inputs/outputs, duplicate or missing member state, wrong categories, wrong NFT capability, mismatched receipt/escrow amounts, and overflow.

A member's credit is derived from the chain receipt and matched escrow, never from a local-storage value or database row.

## PUSD payout transition

Payout is atomic and permissionless only when every member's own receipt and matching escrow contains at least one full contribution.

- Inputs must include the state NFT, every receipt NFT in member-index order, every matching member PUSD escrow in member-index order, and the explicitly designated token-free fee reserve.
- Outputs must update the state NFT, debit exactly one contribution from every member receipt and escrow, preserve each member's surplus in that member's own receipt and escrow, and pay exactly one contribution per member to the configured round recipient.
- PUSD category and amount must be exact on every token output.
- The BCH backing of all PUSD inputs must be preserved in the corresponding token outputs; miner fees may consume only the separately designated BCH reserve.
- Exact input/output counts and indexes are part of the covenant. No arbitrary token change, alternate destination, or extra output is permitted.
- The state round advances cyclically. A completed circle cannot be paid again.

Do not use an aggregate PUSD pot: it cannot prove which member owns excess credit or which member should receive a refund.

## Cancellation and refund state machine

Cancellation must be a covenant-enforced transaction, not merely a UI action or an off-chain agreement.

1. **Before any contribution:** the initiator may cancel. The state NFT and all empty receipts/escrows must be consumed, with outputs constrained to the pre-registered destinations.
2. **After contributions but before the first payout:** the initiator may cancel without collecting member signatures only when the covenant can prove each member's exact refundable balance from member-specific receipts and escrow. Refund each member's own credit and its BCH token backing to that member's immutable registered address. No aggregate/pro-rata refund and no organiser-selected destination are permitted. If a legacy version cannot prove member attribution, cancellation is unavailable once funds have entered it.
3. **After the first payout:** cancellation is permanently disabled. The remaining rounds continue under the original payout order. This lock must be committed in the state NFT and enforced by the covenant.
4. **Fee funding:** refund transaction fees must come from an explicit token-free reserve with a fixed maximum. Never reduce PUSD token amounts or token backing to pay miner fees.
5. **Terminal state:** consume the state NFT and every receipt/escrow exactly once; no state or receipt may remain spendable. If the chain cannot guarantee atomic consumption and exact refunds in one transaction within practical transaction limits, cancellation must be unavailable rather than partially executed.

The initiator's cancellation signature must be bound to the exact spending transaction and must not be replayable for another circle, another cancellation, or altered refund outputs. Review CashScript introspection and BCH sighash semantics before implementation; do not assume arbitrary-message signing exists in the wallet.

## BCH v2 security review findings

### Critical / release-blocking
- **Genesis raw transaction is not independently inspected before broadcast.** Post-broadcast address UTXO checks do not prove that the transaction did not mint unexpected NFTs of the circle category to other addresses. Parse and validate the signed raw transaction before broadcast, including every input and output, token category, NFT capability/commitment, locking bytecode, satoshi value, and change destination.
- **No end-to-end independent-wallet Chipnet evidence.** Mock-provider tests do not prove Selene wallet signing, token serialization, transaction relay, confirmation, or real chain behavior.
- **No independent contract audit.** Automated tests and this source review are not a security certification.

### High
- **PUSD v1 cancellation was unsafe.** Signature checks alone did not constrain outputs, token categories, amounts, member refund destinations, or BCH backing. This branch disables the legacy method.
- **PUSD v1 is aggregate-only.** It cannot safely implement member-specific rollover or refunds. Do not infer member attribution from wallet connection, local state, or transaction sender metadata.
- **PUSD v1 round/payout model differs from BCH v2.** It increments linearly and does not implement cyclic multi-cycle rotation.
- **Genesis token category is anchored to an output-0 txid.** This must be validated against the exact serialized transaction and all category outputs, not only a later UTXO query.

### Medium
- **Fee estimates are heuristic.** Confirm actual serialized transaction size and miner fee with real wallet signatures; reject underfunded change and dust outputs.
- **Client-side UTXO validation is not a consensus rule.** The contract must enforce every financial invariant. UI checks are defense-in-depth only.
- **Wallet connection is not identity authentication.** Member ownership must be proven by a signature-valid spend from the registered funding address.
- **Indexing and reorg handling need chain evidence.** Any future cache/indexer must track network, block height/hash, confirmations, and rollback/reconfirmation; it must not become the balance authority.

## Required adversarial test matrix

- Forged member index; wrong member funding address; token input from an unregistered address.
- Wrong PUSD category, wrong circle category, fungible tokens attached to state/receipt NFTs, mutable receipt, duplicate receipt, missing receipt, duplicate escrow, missing escrow.
- Receipt amount differs from escrow amount; wrong member order; wrong member recipient; wrong round; replayed deposit; replayed cancellation.
- PUSD change redirected to another member; token backing reduced; BCH reserve contaminated with tokens; fee greater than reserve; dust below consensus policy.
- Extra input/output; missing state/receipt output; output index shifted; unexpected category NFT minted to an external address.
- Member shortfall blocks payout; one member's surplus cannot cover another; overpayment survives payout; cyclic rounds preserve each member's balance.
- Cancellation without every required signature; wrong signature/member; altered destination; altered amount; missing refund output; extra token output; backing shortfall; fee drain; partial cancellation; cancellation after completion.
- Regression suite for v1 BCH and PUSD, plus BCH v2 deposit/payout tests.

## Release policy

Chipnet only. No real BCH or real PUSD. Keep the new PUSD v2 contract and UI isolated from v1 and from the BCH-only v2 route. Do not merge or enable financial flows until CashScript compilation, adversarial tests, raw transaction inspection, multiple independent Selene-wallet tests, and an independent security review all pass.


## Current implementation gate (2026-11-13)

The current AjoChain integration has a network/category mismatch that must be resolved before enabling PUSD transactions:

- `src/lib/pusd.ts` contains the published ParyonUSD category `2469acc5afa4b10cb5b5c04afb89c3a3ffd61c5da9c01e26d00951cae2a02544`. ParyonUSD's own public token page identifies this as its Bitcoin Cash **mainnet** token category.
- The current PUSD UI and transaction planners are Chipnet-only. No independently verified ParyonUSD Chipnet category is configured in this repository.
- `PUSD_CHIPNET_CATEGORY` therefore remains `null`. The create/deposit planners and UI payout action fail closed; existing circle links may still be inspected, but the UI does not offer PUSD transactions.
- Do not infer a Chipnet category from the ticker or copy the mainnet category into Chipnet. Verify the category against an actual Chipnet PUSD UTXO and its authenticated token metadata before configuring it.

### Minimum amount and token precision

CashTokens fungible amounts are integer base units; decimal display precision is metadata, not a property encoded in the token category itself. The BCMR schema supports a token `decimals` field. A third-party asset listing reports two decimals for mainnet ParyonUSD, which would make 0.01 PUSD equal one base unit, but that is not sufficient evidence to configure a Chipnet minimum. Confirm the authenticated ParyonUSD BCMR identity and the exact Chipnet category first. Until then, do not translate the requested 0.02 PUSD into an integer or enable PUSD deposits/payouts.

### Current code status

- BCH V1/V2: new-circle creation guards require 200,000 sats (0.002 BCH); existing V1 circle decoding remains permissive for compatibility.
- PUSD V1: transaction planning is paused until a verified Chipnet category is configured. Existing pooled accounting remains experimental and is not a safe basis for member-level credit.
- PUSD V2: not yet implemented. The next implementation unit is the member escrow sidecar plus the state/receipt covenant, with atomic deposit and payout transitions. Do not expose a PUSD V2 route until those contracts, planners, raw-transaction checks, and adversarial tests are complete.


## Approved product rules (2026-11-13)

The user approved these target settings for new circles:

- BCH minimum contribution: **0.002 BCH per member per round (200,000 satoshis)** for both BCH V1 and BCH V2 creation.
- PUSD minimum contribution: **0.02 PUSD per member per round**. Do not convert this to base units or enable Chipnet transactions until the actual Chipnet PUSD category and authenticated decimal precision are verified. The published mainnet category must not be reused on Chipnet.
- Project fee: **1% of each round's gross payout**, deducted from the recipient's payout at the moment that member receives the pot. The transaction must pay the fee to a fixed treasury address encoded in the circle contract at creation. The fee must be disclosed before members join, must not be taken from member escrow balances or PUSD BCH backing, and must not be available to the initiator to redirect. Integer rounding and minimum/dust handling must be specified and tested before implementation.
- Cancellation: the initiator may cancel before the first payout, including after deposits only when the contract can prove each member's exact refund entitlement. Once the first payout transition occurs, cancellation is permanently disabled. The state NFT must record/commit to the irreversible first-payout transition.

### Compatibility and implementation constraints

- Existing deployed V1 contract addresses and bytecode cannot be retroactively changed. Keep legacy readers and payout paths compatible; do not pretend old circles have the new cancellation or treasury-fee guarantees.
- New V1 circles need a versioned covenant path if they are to support member-attributed refunds and a treasury output. Legacy pooled V1 accounting cannot safely refund deposits to individual members after money has entered the pool.
- V2 BCH must enforce the cancellation lock and treasury output in the covenant and planner. PUSD V1 pooled circles remain cancellation-disabled after funds enter; a safe new V1 PUSD version requires member-specific attribution. PUSD V2 must implement cancellation and fee logic alongside member escrow.
- Never ship a UI-only cancellation restriction or fee calculation. Contract checks must bind the exact treasury destination, fee amount, recipient, state progression, input/output counts, and refund destinations.
- The approved 1% is a product fee, separate from the miner fee. The miner fee must remain separately capped/funded; do not silently combine the two.
