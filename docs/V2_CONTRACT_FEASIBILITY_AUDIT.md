# AjoChain v2 contract feasibility audit

Status: source-level review of the current v1 BCH and PUSD contracts. This is not an independent security audit and does not certify either contract for mainnet.

## Scope reviewed

- `contracts/AjoCircle.cash`
- `contracts/AjoCirclePUSD.cash`
- `src/lib/ajo.ts`
- `src/lib/pusd.ts`
- `test/ajo.test.ts`
- `test/pusd.test.ts`
- `web/src/wallet.ts`

## Findings

### 1. Existing BCH circles are aggregate-only

The BCH contract accepts plain BCH contribution UTXOs at the same contract address. During payout it sums the values of the contract inputs and checks that the aggregate pot is full. It does not require a member signature for a contribution and does not store a member identifier with a contribution.

Consequences:
- A transaction to the shared contract address cannot be attributed to a specific member by this contract.
- A connected wallet, invite URL, or database record cannot repair that missing on-chain proof.
- The v1 UI must continue to describe only aggregate funding for existing BCH circles.

### 2. Existing PUSD circles are also aggregate-only

The PUSD contract sums fungible token amounts from PUSD-bearing UTXOs and pays the configured round recipient. The contract verifies the token category and aggregate token pot, but does not bind each contribution to the sender or a member index.

Consequences:
- PUSD token contributions cannot be shown as verified per-member credit under the current contract.
- The PUSD flow must remain separately labelled experimental and Chipnet-only as already enforced by the client validation.
- The database must not infer ownership from transaction origin or wallet connection.

### 3. The current wallet adapter is not a login protocol

The AjoChain wallet adapter calls WizardConnect's `signTransaction` method for CashScript transactions. The reviewed adapter does not expose a documented arbitrary-message signing method or a server-verifiable login challenge flow.

Consequences:
- Wallet connection alone is not authentication.
- Do not create a session or activate membership based only on a connected state or a locally stored flag.
- Before implementing wallet login, verify the installed wallet SDK's documented signing methods and signature serialization. If no safe message-signing method exists, evaluate an explicitly approved, non-value-moving proof transaction only if the wallet and chain support it safely.

## Required v2 design boundary

A v2 member-credit system must be a new contract/version for new circles only. It must not change v1 addresses, covenant behavior, payout rules, or historical accounting.

Before implementation, the contract design must demonstrate all of the following in CashScript tests:
1. Every credit is cryptographically bound to one registered member and one circle.
2. A member cannot create credit for another member.
3. The same transaction/outpoint cannot be credited twice.
4. Credit cannot be replayed across circles or rounds.
5. A member's top-up is calculated only from their own verified credit.
6. Payout is blocked if any member has insufficient credit.
7. Payout debits exactly one round's due from each member.
8. Surplus remains assigned to its original member.
9. Cancellation accounts for all member credit without permitting organiser redirection.
10. Existing v1 tests and behavior remain unchanged.

The current single shared-pot model does not satisfy these requirements. A candidate design may use separate covenant-controlled member credit outputs/state records, but the exact CashTokens/NFT state transitions, transaction-size limits, signature checks, and atomic payout behavior must be proven before any implementation is presented as functional.

## Backend implications

Neon/PostgreSQL may store:
- circle metadata and discovery records;
- hashed invitation tokens and lifecycle timestamps;
- wallet-auth challenges and sessions after a supported proof protocol exists;
- chain observations and transaction references;
- opt-in notification preferences and delivery records.

PostgreSQL must not be the authority for balances, membership commitments, contribution ownership, payout completion, or contract rules. Any cached chain-derived view must record its network and indexed block height/hash and be reconciled against the chain.

## Release gates

- Keep this work on a feature branch and preview deployment.
- Keep all v2 financial flows Chipnet-only until adversarial tests and independent review are complete.
- Do not merge or deploy to production without explicit approval.
- Never request, store, or log seed phrases or private keys.
