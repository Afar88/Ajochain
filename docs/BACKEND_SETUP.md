# AjoChain backend foundation

Status: Neon is connected to the Vercel AjoChain project. Runtime API integration and applying the application migrations to the live/default Neon branch remain pending.

## Trust boundary

- Covenant state and validated chain observations remain authoritative for funds and payouts.
- PostgreSQL stores discovery metadata and operational observations only.
- Do not add a mutable member balance as financial truth.
- Invitation tokens and authentication nonces must be generated with a cryptographically secure random source; store only their hashes.
- Never store seed phrases, private keys, wallet secrets, or raw bearer invite tokens.
- Do not enable mainnet membership or PUSD accounting from this schema.
- Wallet connection, a public address, or an xpub is not proof of address ownership.
- Circle recovery must be read-only and must not confer organiser or payout privileges.

## Neon setup gate

1. Neon is connected to the AjoChain Vercel project; credentials are managed by Vercel.
2. Use only the server-side `DATABASE_URL` (never a `VITE_` variable).
3. Apply `db/migrations/0001_backend_foundation.sql` to a fresh Chipnet development database.
4. Apply `db/migrations/0002_versioned_circle_registry.sql` after 0001. It adds versioned V1/V2 constructor metadata, source creation details, verification lifecycle, V2 receipt metadata, and bound `circle_recovery` challenges.
5. Verify constraints and indexes with integration tests before connecting any API route.
6. Add server-side API routes using a serverless-compatible PostgreSQL client. Never expose the database connection string to browser code.
7. Review Neon Auth settings before any authentication implementation; wallet identity must be proven by a BCH-native wallet signature with an explicitly negotiated wallet capability.
8. Keep production migration and mainnet activation behind explicit review.

## Recovery implementation gates

- Registry metadata is an index, not financial truth. Recompute the contract address from complete parameters and verify the expected version-specific CashTokens set on-chain.
- V1 verification uses the classic mutable state NFT and classic covenant parameters.
- V2 verification checks the genesis-derived category, exactly one valid state NFT, and one correctly indexed receipt NFT for every ordered member. Reject missing, duplicate, malformed, or unexpected category UTXOs.
- A recovery challenge must bind exact origin, audience, address, network, purpose, expiry, and nonce. Consume it atomically and reject replay.
- Return only circles where the verified address is a registered member. Every member can discover the same circle metadata, but discovery does not change role or permissions.
- If the wallet does not explicitly advertise and implement the agreed BCH message-signing extension, keep automatic wallet recovery unavailable. Do not fall back to Ethereum personal-sign or xpub possession.

This foundation does not implement wallet authentication, invitation acceptance, chain indexing, notifications, or member-level balances. Those require separate verified code and tests.
