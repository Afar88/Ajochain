# Member contribution accounting: implementation plan

## Status

This document defines the safe implementation boundary for member-level contribution history and rollover credit. It is a design foundation, not a claim that member balances are currently implemented.

The current BCH and PUSD covenants enforce an aggregate circle pot. They do not store a member's contribution total, member credit, or an individual rollover entitlement. The current frontend also accepts manual transfers to the shared circle address. Therefore, the existing on-chain pot must remain the financial source of truth, and the app must not label an off-chain estimate as a contract-enforced balance.

## Identity rule

A member is identified by the exact registered BCH address in the circle's payout order. A contribution may be attributed to that member only when its funding transaction is independently verified to have been funded from that same registered address.

The wallet-connected contribution builders currently select funding UTXOs from the connected address:

- BCH: `planContribution` selects non-token UTXOs from the supplied wallet address and pays the circle contract address.
- PUSD: `planPusdContribution` selects PUSD token UTXOs and BCH fee-reserve UTXOs from the supplied wallet address and pays the circle token contract address.

This is a useful attribution constraint, but it does not make the current covenant enforce per-member accounting. A user can still send funds manually, and the covenant only sees pooled circle UTXOs.

## Receipt verification

A future contribution receipt must be derived from chain data, not from a client-submitted amount alone. At minimum, a BCH receipt must include:

- network and circle identifier/contract address;
- transaction id and confirmation/block status;
- the exact output index and value paid to the circle;
- the transaction's input outpoints and their previous-output locking scripts;
- the registered member address that matches the verified funding inputs;
- verification timestamp and indexer/source metadata.

A PUSD receipt must additionally verify the token category and token amount, and distinguish token backing BCH from the separate BCH fee-reserve payment.

A receipt is not final merely because a wallet reports a successful broadcast. It must be re-read from the network, checked against the expected circle destination and amount, and tracked through confirmation. Reorgs, dropped transactions, replacements, duplicate processing, and partial/mixed funding must be handled idempotently.

## Attribution policy

1. Attribute automatically only when every relevant funding input can be proven to belong to one registered member address.
2. If a transaction uses inputs from multiple registered member addresses, mark it **unattributed / review required**; do not guess how to split it.
3. If an input prevout cannot be resolved, keep the receipt pending or unattributed.
4. Manual transfers to the shared address may be detected as deposits, but must not be assigned to a member solely from a wallet screenshot or a self-reported claim.
5. Never credit change returned to the member as a circle contribution.
6. Prevent duplicate credits by using a unique key based on network, txid, and output index.

## Credit and rollover model

The ledger should be append-only and event-based. It should distinguish:

- verified contribution receipts;
- allocation of contribution value to a specific round;
- payout events and the round they complete;
- member-specific excess/credit carried forward;
- corrections or reversals caused by reorgs or invalidated receipts.

For each member, the displayed accounting view can then show verified paid-in, amount allocated to completed/current rounds, and unallocated carry-forward credit. Calculations must be deterministic and replayable from the event history.

**Important:** a member credit is an accounting record against pooled funds, not a separately held or individually spendable balance. With today's aggregate covenant, the app cannot force the payout transaction to respect member-specific credits. The interface must call it a *recorded credit* or *estimated carry-forward* until a new covenant version enforces allocation rules on-chain.

## Contract implications

The existing BCH covenant checks that the aggregate circle balance covers the round pot, advances the round NFT, pays the scheduled recipient, and returns sufficiently large surplus to the circle. It does not check who supplied each contribution UTXO.

The PUSD covenant similarly checks the aggregate token pot and aggregate reserve/backing constraints. It does not preserve per-member token attribution after contributions are pooled.

Trustless enforcement of member credit requires a separately designed and tested covenant upgrade (or another on-chain accounting mechanism) that commits to member balances/allocations and validates each round's use of them. Do not retrofit this by changing the meaning of the current covenant or by silently reinterpreting old circle state. Existing circles must retain their current rules.

## Safe rollout

### Phase 1 — evidence and receipts
- Restrict the first supported attribution flow to app-generated contributions from the registered address.
- Add a chain-verification service/indexer that resolves prevouts and verifies destination, amount, token category where applicable, and confirmations.
- Store immutable receipt events with idempotent processing and reorg handling.
- Keep direct/manual deposits visible as unassigned until a safe attribution method exists.

### Phase 2 — member ledger
- Add append-only round allocation and payout events.
- Derive member totals and carry-forward credits from verified events.
- Add reconciliation that proves the ledger's total attributed/unattributed value never exceeds the observed contract holdings.
- Clearly label the ledger as informational while the old covenant remains deployed.

### Phase 3 — enforceable accounting
- Design a new covenant state format and payout validation for member-specific credits.
- Add contract tests for partial funding, excess funding, member credit, rollover, payout order, cancellation, and edge cases.
- Deploy as a new version with explicit migration/new-circle rules; never assume existing circles can be migrated safely.
- Enable enforceable member balances only after independent review and successful Chipnet end-to-end tests.

## Acceptance criteria

- A contribution cannot be credited from a client-provided claim alone.
- The funding address must match exactly one registered member.
- Duplicate tx/output observations do not duplicate credit.
- Unconfirmed, mixed-input, unresolved-prevout, and reorged transactions cannot silently become final credit.
- BCH and PUSD are accounted for separately with correct units.
- Member credit and pooled contract funds are displayed as different concepts.
- Existing circles continue to follow their deployed covenant rules.
- No production UI claims that individual credit is contract-enforced until the new covenant has passed tests and is deployed.
