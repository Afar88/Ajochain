# Registry API contract (design)

Status: design only. These routes are not implemented or enabled. Do not advertise automatic recovery until the wallet-signing dependency and server-side verifier are live.

## Trust boundaries

- The browser is an untrusted client. Never accept a browser-supplied `verified` flag, contract address, organiser role, current round, balance, or receipt set as authoritative.
- PostgreSQL stores circle metadata and the latest verification observation. BCH chain state is authoritative for contract identity, NFT state, credits, and payouts.
- Do not expose a public address-to-circle search. The only member lookup is the authenticated `mine` operation after a valid BCH-native ownership proof.
- A successful read-only recovery response never grants organiser privileges or enables signing, membership edits, contributions, or payouts.
- Keep V2 Chipnet-only. PUSD is outside this V1/V2 recovery API.

## Proposed routes

### `POST /api/registry/register`

Registers metadata after creation or a legacy import. Accept only a bounded, versioned payload:

- `contractVersion`: exactly `V1` or `V2`
- `network`, `asset`, `displayName`
- complete constructor parameters, including ordered BCH member addresses, contribution and max fee
- `creationTxid` and the exact source outpoint/category required by that version
- `metadataSource`: `new_creation` or `legacy_import`

Server requirements:

1. Validate types, lengths, amount bounds, BCH address network and uniqueness of member PKHs. Preserve member order exactly.
2. Recompute the contract address independently from the complete parameters using the matching version's artifact. Never trust a client-provided derived address.
3. Fetch the creation transaction and current contract UTXOs from the correct BCH network. Validate the genesis/category/outpoint relationship and every expected CashToken output.
4. V1 uses the classic V1 covenant and mutable state NFT rules. V2 uses the V2 artifact and Chipnet-only rules: one valid minting state NFT plus exactly one non-fungible receipt for each ordered member, with the correct index and commitment; reject any missing, duplicate, malformed or unexpected category UTXO.
5. Only after all checks pass, persist the circle and ordered members in one database transaction with `verification_status='verified'`. Otherwise return a specific validation error and do not create a verified record.
6. Make retries idempotent on `(network, contract_address)`. A conflicting parameter set for an existing address is a hard conflict, not an overwrite.
7. Rate-limit registration and cap payload size. Registration never creates organiser authority by itself.

For a newly created circle, the UI must retain the creation transaction ID and show a retryable registration error if the API is unavailable. Never say automatic recovery is active until registration succeeds.

### `POST /api/recovery/challenge`

Request: exact BCH address, network and requested origin/audience context.

- Validate the origin against the configured AjoChain origin allowlist; do not accept arbitrary origins supplied by the browser.
- Generate a cryptographically secure random nonce and short expiry on the server.
- Persist only a hash of the nonce and the canonical message hash, with purpose `circle_recovery`, exact address, network, origin, audience and the agreed signature-scheme identifier.
- Return the canonical message bytes and expiry for wallet approval.
- Do not return a reusable bearer token or expose database IDs as authorization.

### `POST /api/recovery/verify`

Request: challenge identifier, exact address/network, signature bytes, and the scheme-specific wallet response.

1. Load the unconsumed, unexpired challenge and verify exact origin, audience, address, network, purpose and canonical message bytes.
2. Verify the signature using only the explicitly negotiated BCH-native message-signing scheme. The verifier must have published test vectors for digest construction, serialization, signature validation and address recovery.
3. Atomically consume the challenge with a conditional update requiring `consumed_at IS NULL` and `expires_at > now()`. Concurrent replay attempts must result in exactly one successful consume.
4. Resolve the authenticated address to member rows only. Never infer membership from xpub possession, an unsigned address, an invite URL alone, or a wallet session.
5. Return the matching V1/V2 metadata and fresh version-specific chain observations. Do not return other members' unrelated circles or expose an address-search endpoint.
6. If signature capability or scheme is unsupported, fail closed with a clear unavailable response. Never fall back to Ethereum personal-sign/EIP-191.

### `POST /api/recovery/mine`

This may be combined with `verify` if the implementation uses a single atomic operation. It must require a short-lived server-issued authenticated session or the just-verified challenge result. The request cannot select another address. Return only circles linked to the authenticated BCH address.

## Response shape

Each circle result should include:

- `contractVersion`, `network`, `asset`, `displayName`, `contractAddress`
- ordered `members` with stable `memberIndex`; no inferred names
- `contribution`, `maxFee`, and the verified constructor parameters needed to reopen the existing contract
- `verificationStatus`, `verifiedAt`, `lastObservedAt`, and a safe status/error code
- the version-specific state outpoint/category needed for the client to re-read chain state

Do not use cached database values for current financial balances. The V2 detail screen must read live credits from the chain and validate the complete receipt set again before enabling an action.

## Data consistency and operations

- Persist a circle and its ordered member rows in one transaction. Use the existing `members.member_index` as the canonical order.
- Keep V2 receipt category and commitment mapped to the same member index. Treat current receipt UTXOs as chain data, not a database balance.
- Record observation timestamps and reorg/spent-state transitions. If the state NFT disappears or the token set becomes invalid, downgrade the observation from verified/stale as appropriate and stop presenting actionable status.
- Keep API database credentials server-side only. A browser bundle must never contain `DATABASE_URL`.
- Add integration tests for duplicate registration, conflicting metadata, wrong network, malformed addresses, V1/V2 derivation mismatch, incomplete V2 receipt sets, replay races, expired challenges, origin/audience mismatch, and non-member lookups.

## Implementation prerequisites

1. Add a serverless-compatible Neon PostgreSQL client and update both `package.json` and `package-lock.json` through a reproducible npm install.
2. Implement V1 and V2 server-side chain verifiers with test fixtures before exposing registration.
3. Implement the challenge API only after a BCH-compatible wallet message-signing extension is explicitly advertised and validated. PR #24 is a proposal, not runtime support.
4. Apply migrations to a dedicated development database first. Do not apply them to the live/default branch without explicit review.
5. Keep the My circles UI labelled as local saved circles until authenticated registry lookup is actually available.
