# AjoChain backend foundation

Status: Neon is connected to the Vercel AjoChain project. The metadata-only migration is in `db/migrations/0001_backend_foundation.sql`. Runtime API integration and migration execution remain pending.

## Trust boundary

- Covenant state and validated chain observations remain authoritative for funds and payouts.
- PostgreSQL stores discovery metadata and operational observations only.
- Do not add a mutable member balance as financial truth.
- Invitation tokens and authentication nonces must be generated with a cryptographically secure random source; store only their hashes.
- Never store seed phrases, private keys, wallet secrets, or raw bearer invite tokens.
- Do not enable mainnet membership or PUSD accounting from this schema.

## Neon setup gate

1. Neon is connected to the AjoChain Vercel project; credentials are managed by Vercel.
2. Use only the server-side `DATABASE_URL` (never a `VITE_` variable).
3. Apply `db/migrations/0001_backend_foundation.sql` to a fresh Chipnet development database.
4. Verify constraints and indexes with integration tests.
5. Add server-side API routes using a serverless-compatible PostgreSQL client.
6. Review Neon Auth settings before any authentication implementation; wallet identity must be proven by a wallet signature.
7. Keep production migration and mainnet activation behind explicit review.

This foundation does not implement wallet authentication, invitation acceptance, chain indexing, notifications, or member-level balances. Those require separate verified code and tests.
