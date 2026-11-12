-- Versioned V1/V2 circle registry and wallet-recovery challenge foundation.
-- This migration is additive: do not edit the already-applied 0001 migration.
-- Metadata is an index only; BCH chain state remains authoritative.

ALTER TABLE circles
  ADD COLUMN IF NOT EXISTS constructor_params JSONB,
  ADD COLUMN IF NOT EXISTS state_category TEXT,
  ADD COLUMN IF NOT EXISTS source_creation_txid TEXT,
  ADD COLUMN IF NOT EXISTS source_creation_vout INTEGER
    CHECK (source_creation_vout IS NULL OR source_creation_vout >= 0),
  ADD COLUMN IF NOT EXISTS metadata_source TEXT NOT NULL DEFAULT 'legacy_import'
    CHECK (metadata_source IN ('new_creation', 'legacy_import', 'admin_reconciliation')),
  ADD COLUMN IF NOT EXISTS verification_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (verification_status IN ('pending', 'verified', 'stale', 'invalid', 'not_recoverable')),
  ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_observed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS verification_error TEXT;

-- V1/V2 constructor inputs are preserved exactly as submitted and independently
-- re-derived by the verifier. The ordered members table remains the canonical order.
CREATE INDEX IF NOT EXISTS circles_registry_lookup
  ON circles (network, contract_version, verification_status);

CREATE INDEX IF NOT EXISTS circles_state_category_lookup
  ON circles (network, state_category)
  WHERE state_category IS NOT NULL;

-- V2 receipt metadata is keyed by the same stable member_index as the ordered
-- constructor member list. Current receipt UTXOs are always read from chain.
ALTER TABLE members
  ADD COLUMN IF NOT EXISTS receipt_category TEXT,
  ADD COLUMN IF NOT EXISTS receipt_commitment TEXT;

CREATE INDEX IF NOT EXISTS members_wallet_circle_lookup
  ON members (wallet_address, circle_id)
  WHERE wallet_address IS NOT NULL AND invite_state <> 'revoked';

-- A recovery proof is a separate purpose. Bind every challenge to its exact
-- origin, audience and BCH network; store hashes, never reusable bearer secrets.
ALTER TABLE auth_challenges
  ADD COLUMN IF NOT EXISTS origin TEXT,
  ADD COLUMN IF NOT EXISTS audience TEXT,
  ADD COLUMN IF NOT EXISTS network TEXT
    CHECK (network IS NULL OR network IN ('chipnet', 'mainnet')),
  ADD COLUMN IF NOT EXISTS message_hash TEXT,
  ADD COLUMN IF NOT EXISTS signature_scheme TEXT;

ALTER TABLE auth_challenges
  DROP CONSTRAINT IF EXISTS auth_challenges_purpose_check;

ALTER TABLE auth_challenges
  ADD CONSTRAINT auth_challenges_purpose_check
  CHECK (purpose IN ('login', 'invite_acceptance', 'circle_action', 'circle_recovery'));

CREATE INDEX IF NOT EXISTS auth_challenges_recovery_expiry
  ON auth_challenges (purpose, expires_at)
  WHERE purpose = 'circle_recovery' AND consumed_at IS NULL;

-- Ensure the registry cannot accidentally represent the same circle twice.
CREATE UNIQUE INDEX IF NOT EXISTS circles_network_contract_unique
  ON circles (network, contract_address);
