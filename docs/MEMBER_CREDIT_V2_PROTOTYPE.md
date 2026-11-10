# AjoChain v2 BCH member-credit prototype

Status: experimental Chipnet-only contract prototype. The covenant, client transaction planners, and isolated `#/v2/` Chipnet UI are an experimental prototype, not a production release. It is not audited and has not been validated end-to-end with independent Selene wallets on Chipnet. Existing v1 circles remain unchanged.

## Why this design changed

The v1 contract accepts plain BCH UTXOs into one shared address and only checks the aggregate pot. It cannot prove which member funded those UTXOs. The v2 prototype instead uses one NFT receipt UTXO per member, held at the circle covenant address.

This follows CashScript's documented receipt-NFT and modular covenant patterns. The member receipt is state carried in a CashTokens NFT commitment, not a PostgreSQL balance.

## Token and UTXO layout

One circle uses one CashTokens category:

- State NFT: minting capability, commitment `0x53 | round`.
- Member receipt NFT for member i: immutable capability, commitment `0x52 | memberIndex | creditSats(8 bytes)`.
- All these UTXOs use the v2 covenant locking bytecode.
- Genesis must create exactly one state NFT and exactly one zero-credit receipt for every registered member. The genesis transaction must be inspected output-by-output because the minting NFT can create additional tokens of its category.

The receipt UTXOs are contract-controlled, so payout does not require all members to be online to sign their receipt inputs. Member ownership is bound at deposit time by requiring the funding input's P2PKH locking bytecode to match the registered member address. BCH consensus verifies that funding input's unlocking signature.

## Deposit transaction

Fixed layout:

- Inputs: state NFT (0), member receipt NFT (1), member's registered P2PKH funding input (2).
- Outputs: updated state NFT (0), updated member receipt NFT (1), change to the same funding address (2).

The covenant checks that the treasury's BCH value increases by exactly the credited amount and the selected member receipt commitment increases by the same amount. The member's P2PKH input must match the configured member address; a different member cannot write credit to this receipt. Fee is bounded by `maxFee`.

## Payout transaction

Fixed layout:

- Inputs: state NFT (0), one receipt per member in member-index order (1..N).
- Outputs: updated state NFT (0), updated receipts in the same order (1..N), current round recipient (N+1).

The covenant checks every member's own receipt is at least one contribution, debits exactly one contribution from every receipt, advances the recipient index cyclically (`0..N-1`, then back to `0`), reduces the pooled BCH value by exactly N contributions, and pays the round recipient with a fee bounded by `maxFee`. This permits repeated rotation cycles instead of stopping after the first cycle. Any member's shortfall blocks payout; another member's surplus cannot cover it. Remaining credit stays in that member's receipt.

## Critical implementation gates still open

1. The contract must compile under the pinned CashScript compiler.
2. Mock-provider tests currently cover correct/incorrect funding address, repeated deposits, member-specific rollover, two-cycle rotation, insufficient credit, swapped receipt order, and the payout fee cap. Still required: real genesis receipt creation, altered commitments, missing/duplicate receipts, extra outputs, wrong token capabilities/categories, and replay attempts.
3. The client planners and isolated v2 UI now build genesis, member deposits, and payouts. They still require transaction-layout inspection and end-to-end validation with independent Selene wallets on Chipnet.
4. The genesis transaction must be verified output-by-output and must not mint unexpected NFTs of the system category.
5. Cancellation must refund each member's remaining credit safely. It is intentionally not implemented in this prototype.
6. PUSD needs a separate token-sidecar design and separate tests; this BCH contract does not support PUSD.
7. V2 invite links and local dashboard entries use an explicit `version: 2` marker and a separate `#/v2/` route; they are not decoded as v1 circles. Chipnet tests with multiple independent Selene wallets and an independent security review are still required before any mainnet consideration.

## Explicit non-goals

- This prototype does not change existing v1 circles or their addresses.
- It does not read or write live balances in the web UI.
- It does not integrate Neon or create an indexer.
- It does not claim mainnet safety or production readiness.
