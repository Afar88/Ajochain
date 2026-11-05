# AjoChain backend foundation

Status: schema and setup plan only. No live database is connected yet.

## Trust boundary

- Covenant state and validated chain observations remain authoritative for funds and payouts.
- PostgreSQL stores discovery metadata and operational observations only.
- Do not add a mutable member balance as financial truth.
- Invitation tokens and authentication nonces must be generated with a cryptographically secure random source; store only their hashes.
- Never store seed phrases, private keys, wallet secrets, or raw bearer invite tokens.
- Do not enable mainnet membership or PUSD accounting from this schema.

## Neon setup gate

1. Connect the Neon resource to the AjoChain Vercel project.
2. Confirm the server-side database URL is available to Vercel Functions. Never expose it as a VITE_ variable.
3. Run the migration against a fresh Chipnet development database.
4. Verify constraints and indexes with integration tests.
5. Add server-side API routes using a serverless-compatible PostgreSQL client.
6. Keep production migration and mainnet activation behind explicit review.

This foundation does not implement wallet authentication, invitation acceptance, chain indexing, notifications, or member-level balances. Those require separate verified code and tests.
