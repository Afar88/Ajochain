-- AjoChain backend metadata foundation.
-- PostgreSQL stores metadata and chain observations, never authoritative balances.
-- Apply only to a fresh Chipnet development database during this phase.

CREATE TABLE IF NOT EXISTS circles (
  id UUID PRIMARY KEY,
  network TEXT NOT NULL CHECK (network IN ('chipnet', 'mainnet')),
  asset TEXT NOT NULL CHECK (asset IN ('BCH', 'PUSD')),
  contract_address TEXT NOT NULL,
  contract_version TEXT NOT NULL,
  organiser_address TEXT NOT NULL,
  display_name TEXT NOT NULL,
  lifecycle TEXT NOT NULL DEFAULT 'active'
    CHECK (lifecycle IN ('active', 'completed', 'cancelled', 'paused')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (network, contract_address)
);

CREATE TABLE IF NOT EXISTS members (
  id UUID PRIMARY KEY,
  circle_id UUID NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
  member_index SMALLINT NOT NULL CHECK (member_index >= 0),
  wallet_address TEXT,
  public_key TEXT,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('organiser', 'member')),
  invite_state TEXT NOT NULL DEFAULT 'invited'
    CHECK (invite_state IN ('invited', 'accepted', 'revoked')),
  joined_at TIMESTAMPTZ,
  UNIQUE (circle_id, member_index),
  UNIQUE (circle_id, wallet_address)
);

CREATE TABLE IF NOT EXISTS invitations (
  id UUID PRIMARY KEY,
  circle_id UUID NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
  member_id UUID NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  accepted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS auth_challenges (
  id UUID PRIMARY KEY,
  wallet_address TEXT NOT NULL,
  nonce_hash TEXT NOT NULL UNIQUE,
  purpose TEXT NOT NULL CHECK (purpose IN ('login', 'invite_acceptance', 'circle_action')),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS chain_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  network TEXT NOT NULL CHECK (network IN ('chipnet', 'mainnet')),
  circle_id UUID REFERENCES circles(id) ON DELETE SET NULL,
  txid TEXT NOT NULL,
  output_index INTEGER CHECK (output_index IS NULL OR output_index >= 0),
  event_type TEXT NOT NULL,
  block_height BIGINT CHECK (block_height IS NULL OR block_height >= 0),
  block_hash TEXT,
  confirmation_state TEXT NOT NULL DEFAULT 'mempool'
    CHECK (confirmation_state IN ('mempool', 'confirmed', 'reorged')),
  observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (network, txid, output_index, event_type)
);

CREATE TABLE IF NOT EXISTS notification_preferences (
  member_id UUID PRIMARY KEY REFERENCES members(id) ON DELETE CASCADE,
  channel TEXT NOT NULL CHECK (channel IN ('email', 'web_push')),
  event_categories TEXT[] NOT NULL DEFAULT '{}',
  opted_in BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS notification_deliveries (
  id UUID PRIMARY KEY,
  member_id UUID NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  chain_event_id BIGINT REFERENCES chain_events(id) ON DELETE SET NULL,
  channel TEXT NOT NULL CHECK (channel IN ('email', 'web_push')),
  provider_id TEXT,
  delivery_status TEXT NOT NULL DEFAULT 'queued'
    CHECK (delivery_status IN ('queued', 'sent', 'failed', 'skipped')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS members_wallet_lookup
  ON members (wallet_address) WHERE wallet_address IS NOT NULL;
CREATE INDEX IF NOT EXISTS invitations_circle_expiry
  ON invitations (circle_id, expires_at);
CREATE INDEX IF NOT EXISTS auth_challenges_wallet_expiry
  ON auth_challenges (wallet_address, expires_at);
CREATE INDEX IF NOT EXISTS chain_events_circle_height
  ON chain_events (circle_id, block_height DESC);
CREATE INDEX IF NOT EXISTS notification_deliveries_member_created
  ON notification_deliveries (member_id, created_at DESC);
