-- Additive V1/V2 registry and wallet-recovery schema.
-- PostgreSQL stores metadata and observations only. BCH chain state is authoritative.

ALTER TABLE circles
  ADD COLUMN IF NOT EXISTS constructor_params JSONB,
  ADD COLUMN IF NOT EXISTS state_category TEXT,
  ADD COLUMN IF NOT EXISTS source_creation_txid TEXT,
  ADD COLUMN IF NOT EXISTS source_creation_vout INTEGER,
  ADD COLUMN IF NOT EXISTS metadata_source TEXT NOT NULL DEFAULT 'legacy_import',
  ADD COLUMN IF NOT EXISTS verification_status TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_observed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS verification_error TEXT;

ALTER TABLE circles
  ADD CONSTRAINT circles_source_creation_vout_check_v2
    CHECK (source_creation_vout IS NULL OR source_creation_vout >= 0),
  ADD CONSTRAINT circles_metadata_source_check_v2
    CHECK (metadata_source IN ('new_creation', 'legacy_import', 'admin_reconciliation')),
  ADD CONSTRAINT circles_verification_status_check_v2
    CHECK (verification_status IN ('pending', 'verified', 'stale', 'invalid', 'not_recoverable')),
  ADD CONSTRAINT circles_state_category_hex_check_v2
    CHECK (state_category IS NULL OR state_category ~ '^[0-9a-fA-F]{64}$');

CREATE INDEX IF NOT EXISTS circles_registry_lookup
  ON circles (network, contract_version, verification_status);

CREATE INDEX IF NOT EXISTS circles_state_category_lookup
  ON circles (network, state_category)
  WHERE state_category IS NOT NULL;

ALTER TABLE members
  ADD COLUMN IF NOT EXISTS receipt_category TEXT,
  ADD COLUMN IF NOT EXISTS receipt_commitment TEXT;

ALTER TABLE members
  ADD CONSTRAINT members_receipt_commitment_format_check_v2
    CHECK (receipt_commitment IS NULL OR receipt_commitment ~ '^52(00|01|02|03|04)[0-9a-fA-F]{16}$');

CREATE INDEX IF NOT EXISTS members_wallet_circle_lookup
  ON members (wallet_address, circle_id)
  WHERE wallet_address IS NOT NULL AND invite_state <> 'revoked';

ALTER TABLE auth_challenges
  ADD COLUMN IF NOT EXISTS origin TEXT,
  ADD COLUMN IF NOT EXISTS audience TEXT,
  ADD COLUMN IF NOT EXISTS network TEXT,
  ADD COLUMN IF NOT EXISTS message_hash TEXT,
  ADD COLUMN IF NOT EXISTS signature_scheme TEXT;

ALTER TABLE auth_challenges
  DROP CONSTRAINT IF EXISTS auth_challenges_purpose_check;

ALTER TABLE auth_challenges
  ADD CONSTRAINT auth_challenges_purpose_check
  CHECK (purpose IN ('login', 'invite_acceptance', 'circle_action', 'circle_recovery'));

ALTER TABLE auth_challenges
  ADD CONSTRAINT auth_challenges_recovery_binding_check
  CHECK (
    purpose <> 'circle_recovery' OR (
      NULLIF(BTRIM(origin), '') IS NOT NULL AND
      NULLIF(BTRIM(audience), '') IS NOT NULL AND
      network IN ('chipnet', 'mainnet') AND
      NULLIF(BTRIM(message_hash), '') IS NOT NULL AND
      NULLIF(BTRIM(signature_scheme), '') IS NOT NULL
    )
  );

CREATE INDEX IF NOT EXISTS auth_challenges_recovery_expiry
  ON auth_challenges (purpose, expires_at)
  WHERE purpose = 'circle_recovery' AND consumed_at IS NULL;
