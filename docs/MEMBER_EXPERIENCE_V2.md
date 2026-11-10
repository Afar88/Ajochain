# AjoChain member experience v2 — implementation blueprint

Status: architecture and delivery plan. This document is not implemented or audited code.

## Product outcomes

This work covers six connected improvements for new circles:

1. Invitation acceptance and wallet-verified membership.
2. A member dashboard that discovers circles across browsers/devices.
3. Per-member contribution receipts, due amounts, and rollover credit.
4. Contribution/payout history and opt-in notifications.
5. Organiser controls for membership, invitations, payout order, and circle rules.
6. Clear network, fee, cancellation, contract-verification, and safety information.

Existing BCH and PUSD circles remain readable and spendable through their existing v1 flows. They must not be silently upgraded or have historical payments re-attributed.

## Non-negotiable trust boundaries

- The blockchain and validated covenant state are authoritative for funds, payment status, round number, payout, and member credit.
- The database is an index and coordination layer only. It may store circle discovery metadata, invitations, preferences, notification subscriptions, and cached chain observations. It must never mint a balance or mark an unconfirmed payment as paid.
- Wallet connection is not membership proof. A member must prove control of the exact registered address/key using a cryptographic flow supported by the wallet.
- Opening an invite URL is not acceptance and does not grant membership.
- A contribution to a shared BCH address cannot be reliably attributed to a person from the transaction alone.
- Never request, store, transmit, or log seed phrases or private keys.
- Existing v1 circles retain group-balance semantics. Do not display per-member credit for them.
- PUSD remains separately labelled experimental and Chipnet-only until its deployment and contract are verified.
- Mainnet must remain disabled for new v2 member-credit contracts until contract tests, independent review, and explicit release approval.

## Architecture

### 1. Static client and API

Keep the Vite/TypeScript frontend. Add same-origin Vercel serverless API routes for:
- circle metadata and discovery;
- invitation creation, lookup, revocation, and acceptance state;
- wallet-auth challenge issuance and verification;
- organiser-authorised membership/rule changes;
- notification preferences and delivery registration;
- chain-event indexing status and health.

All API writes require schema validation, rate limits, replay protection, and authenticated authorisation. The server must not sign or broadcast user transactions on their behalf.

### 2. Persistent database

Use PostgreSQL (Neon or an equivalent provisioned PostgreSQL service) through a server-only connection string. No database credentials may be exposed to Vite/client bundles.

Suggested logical tables:

- `circles`: immutable circle identifier, chain/network, asset, contract address, contract version, organiser address, display metadata, created time, lifecycle state.
- `members`: circle id, member index, registered address/public-key identity, role, invitation state, joined time. Unique constraints on (circle_id, member_index) and (circle_id, address).
- `invitations`: circle id, invite token hash, intended member index/address when known, creator, expiry, revoked/accepted timestamps. Store only a hash of bearer tokens.
- `auth_challenges`: address, nonce hash, purpose, expiry, consumed timestamp. Nonces are single-use and short-lived.
- `chain_events`: network, txid, output index, contract/circle id, event type, block height/hash, confirmation state, raw event reference. Unique chain outpoint/event constraints prevent duplicate indexing.
- `notification_preferences`: member id, channel, event categories, opt-in timestamp.
- `notification_deliveries`: event id, member id, channel, provider id, delivery status, attempt metadata.

Do not add a mutable `member_balance` column as a source of truth. If balances are cached for performance, they must be reproducible from validated on-chain state and labelled with the chain tip/block height used.

### 3. Wallet identity and membership

The current WizardConnect adapter exposes transaction signing but does not expose a documented message-signing method. Before building login, verify the installed wallet SDK's supported signing capabilities and signature format.

Required flow:
1. API issues a random, single-use challenge bound to address, purpose, origin, and expiry.
2. Wallet proves control of the registered address using a supported standard signature.
3. Server verifies the signature locally, consumes the nonce, and issues a short-lived session.
4. The organiser's authority and the circle's on-chain member commitment are checked before membership is activated.
5. A member joining an invitation sees the exact circle, network, asset, contribution, payout order, fees, and cancellation rules before accepting.

If WizardConnect cannot safely sign a message, do not emulate it with an insecure local flag. Evaluate a transaction-based proof only if it can be verified without moving user funds and is supported by the relevant chain/wallet standard.

### 4. Invitation lifecycle

States: `pending`, `accepted_pending_chain`, `active`, `expired`, `revoked`.

- Invite URL contains an unguessable random token; server stores only its hash.
- Invite page displays a read-only preview before wallet connection.
- Acceptance requires verified wallet ownership and a free/valid member slot.
- For contract-bound membership, activation waits until the corresponding on-chain registration/state is confirmed.
- Organisers can revoke pending invitations and resend a new token.
- Never treat a localStorage entry or a URL open as acceptance.

### 5. On-chain accounting and contribution history

The current BCH covenant pools plain BCH UTXOs and checks only aggregate funds. It cannot prove which member funded an input. The existing PUSD flow is also a separate token covenant and must be analysed independently.

The v2 contract design must bind every credited contribution to:
- the exact circle identifier/state category;
- a registered member index/key;
- the amount credited;
- a unique transaction/outpoint or nonce;
- the relevant round/credit state.

The covenant must prevent forged attribution, replay, duplicate credit, cross-circle transfer, cross-member transfer, and withdrawal of another member's credit. Payout must atomically debit one round's due from each member and preserve all unused credit with its owner.

For member i:
- `top_up_i = max(0, due_i - credit_i)`
- A payout is permitted only when every member has `credit_i >= due_i`.
- On payout, debit exactly `due_i`; carry the remainder forward to the same member.

If this state transition cannot be proven in CashScript tests within the CashTokens transaction model, stop and redesign the contract. Do not simulate it in JavaScript or PostgreSQL.

For v1 circles, display only aggregate pot funding and clearly state that individual payments are not attributable by the current contract.

### 6. Chain event indexer and history

A server-side indexer may observe public chain data and populate `chain_events`. It must:
- verify network, contract address, token category, covenant outputs, and state transitions;
- wait for the product's chosen confirmation policy;
- handle reorgs by rolling back orphaned observations;
- deduplicate by txid/outpoint;
- reconcile cached data against the current chain state;
- expose last indexed height and stale/error state.

The UI must link to the correct network explorer. Pending, confirmed, failed, and reorged observations must be distinct. Never call a transaction confirmed based only on a wallet callback.

### 7. Member dashboard

Sections:
- Active circles;
- Invitations awaiting acceptance;
- Completed circles;
- Activity/history.

Each circle card shows asset/network, contract status, round, payout recipient/order, aggregate pot progress, and the member's own verified due/credit only when the contract supports member attribution. Include a stale-data indicator and a direct circle link.

### 8. Organiser controls

- View registered member addresses and invitation states.
- Copy/resend/revoke pending invites.
- Show payout order exactly as committed by the contract.
- Show rules and fees before invite acceptance.
- Allow edits only where the contract permits them; otherwise explain that deployed circle rules are immutable.
- Never offer an organiser override that can redirect a covenant payout or rewrite member credit.

### 9. Notifications

Notifications are opt-in and informational:
- invitation received/revoked;
- contribution observed and confirmed;
- top-up due / round ready;
- payout confirmed;
- circle completed;
- chain indexer delayed or data stale.

A notification is not proof of payment. Each notification links back to the app and relevant explorer transaction. Do not enable push/email until a provider is configured, user consent is stored, and unsubscribe works.

### 10. Safety and transparency UI

Every circle page should make these visible:
- Chipnet testnet versus BCH Mainnet;
- BCH versus experimental PUSD;
- real-funds warning where applicable;
- contract address and explorer link;
- contract version and verification/audit status;
- contribution amount and round pot;
- miner-fee cap and who pays fees;
- payout order and cancellation requirements;
- v1 aggregate-only accounting limitation;
- confirmation and stale-indexer state.

Never display an “audited” or “verified” badge unless backed by an actual independent audit or reproducible source verification.

## Delivery sequence and acceptance criteria

### Phase 0 — foundations (current branch)
- Preserve the invite-link persistence fix and clearer v1 contribution copy.
- Document architecture, data model, trust boundaries, and rollout plan.
- Keep all changes in a feature branch; no merge/deploy.

### Phase 1 — contract feasibility gate
- Review BCH and PUSD covenant models separately.
- Prototype member-authenticated contribution state.
- Prove replay protection, member isolation, per-member due, rollover, payout debit, and cancellation.
- Add adversarial CashScript tests. If infeasible, stop before UI claims.

### Phase 2 — backend foundation
- Provision PostgreSQL and Vercel serverless configuration.
- Add migrations, API validation, rate limits, sessions, challenge verification, and audit logs.
- Confirm wallet message-signing support before enabling account sessions.
- Add tests for invite expiry/revocation, nonce replay, cross-circle access, and organiser authorisation.

### Phase 3 — chain indexing and membership
- Add verified chain-event indexing with reorg handling.
- Activate memberships only after wallet proof and required on-chain registration.
- Reconcile indexer results against contract state.

### Phase 4 — dashboard and organiser UX
- Add cross-device discovery, invitation inbox, member views, organiser controls, and history.
- Display only verified chain-derived balances.
- Keep v1 group-only views distinct from v2 member-credit views.

### Phase 5 — notifications and release hardening
- Add opt-in notification provider and unsubscribe.
- Complete mobile Chipnet testing with independent wallets.
- Run typecheck, contract compilation, tests, build, dependency/security checks, and manual end-to-end tests.
- Obtain independent contract review before any mainnet enablement.

## Required release tests

- Invite tokens are unguessable, hashed at rest, expire, and can be revoked.
- Opening an invite never activates membership.
- Wallet proof is bound to the intended address, origin, purpose, and one-time nonce.
- Replayed challenges and cross-circle access are rejected.
- Non-organisers cannot change members, invites, or circle rules.
- Chain indexer deduplicates events and handles reorgs.
- UI distinguishes pending from confirmed transactions.
- V1 circles never show fabricated per-member balances.
- V2 contract enforces member attribution, no double count, no cross-member/circle transfer, exact due debit, same-member rollover, and cancellation accounting.
- No secret material is requested, stored, or logged.
- Mainnet remains unavailable until explicit approval after review.
