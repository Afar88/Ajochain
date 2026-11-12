# Wallet message authentication extension proposal

Status: design proposal only. This document does not claim that WizardConnect or Selene currently implements message signing.

## Why this is needed

AjoChain can currently obtain public derivation keys and request transaction signatures through WizardConnect. An xpub or a connected session is not proof that the user is presently authorising a recovery request. Cross-device recovery needs an explicit, verifiable proof of control over a BCH address.

WizardConnect defines the `hdwalletv1` protocol and permits extension action names. Its handshake also supports an `extensions` map inside the `hdwalletv1` session; an extension entry can advertise wallet capability and carry extension-specific handshake data. Unknown actions must be ignored gracefully. Both wallet and dapp therefore need an agreed capability advertisement and message implementation before AjoChain can rely on this feature.

## Proposed extension

Proposed capability name: `bch_message_auth_v1`

Proposed actions:

- `sign_message_request` — dapp to wallet
- `sign_message_response` — wallet to dapp
- `sign_message_cancel` — dapp to wallet

These are proposal names, not existing WizardConnect actions. The preferred initial integration is an explicitly advertised `hdwalletv1` session extension (for example, `session["hdwalletv1"].extensions["bch_message_auth_v1"]`). AjoChain must only send these actions after the wallet advertises the capability. A separate top-level protocol identifier should be used only if WizardConnect maintainers decide that the feature warrants an independently negotiated protocol.

### Request

The request should contain:

- monotonically unique request sequence for the active session;
- exact UTF-8 message bytes (or a canonical structured payload with an unambiguous serialization);
- BCH network identifier (`chipnet` or `mainnet`);
- requested address and derivation path, where applicable;
- dapp origin and human-readable application name;
- short expiry and a one-time nonce.

The wallet UI must show the requesting app, network, address, purpose, and message. The user must explicitly approve or reject. No transaction is created or broadcast.

### Response

The response should contain:

- matching request sequence;
- selected BCH address;
- public key corresponding to that address;
- signature bytes;
- a mandatory, explicit signature-scheme identifier;
- optional error code on rejection or unsupported derivation.

The protocol specification must define the exact BCH signature digest, serialization, recovery/verification rules, and address derivation before implementation. Do not assume Ethereum `personal_sign`, EIP-191, or an arbitrary raw secp256k1 signature is interchangeable with BCH message signing.

## AjoChain recovery challenge

The backend should issue a short-lived, single-use challenge with a canonical message containing:

- a fixed AjoChain authentication statement;
- the exact HTTPS origin/audience;
- wallet address and network;
- purpose: `circle_recovery`;
- cryptographically random nonce;
- issued-at and expiry timestamps.

The server stores only a hash of the nonce. The verification endpoint must atomically consume the challenge so concurrent or repeated submissions cannot replay it. Reject wrong origin, wrong network, wrong purpose, expired challenges, mismatched address, malformed signatures, and already-consumed challenges.

After successful signature verification, the server may return only circles for which the verified address is an authorised member. A valid signature must not grant organiser rights or change circle membership.

## Data and privacy boundaries

- Never request, transmit, or store seed phrases, private keys, wallet passwords, or WizardConnect relay secrets.
- Do not store raw challenge bearer values or raw authentication signatures longer than operationally necessary.
- Do not expose a public endpoint that lists circles by address without authentication.
- Do not use xpubs as login credentials; xpubs are public derivation material and can reveal address relationships.
- Do not store balances as financial truth. The BCH covenant and independently verified chain state remain authoritative.
- Circle recovery records are discovery metadata only; restoring a circle must not move funds, change members, or alter contract state.

## Required implementation and acceptance tests

1. WizardConnect wallet and dapp implementations agree on and advertise the extension capability before using its actions.
2. The wallet shows a clear, origin-bound approval screen and supports rejection/cancellation.
3. A signature made by the wrong key, for the wrong address, network, origin, or purpose is rejected.
4. Expired, malformed, and replayed challenges are rejected; challenge consumption is atomic.
5. A member can recover only circles where their address is an authorised member.
6. A read-only recovery operation cannot create a payout, cancel a circle, change membership, or sign a transaction.
7. Tests cover address derivation and signature verification against known BCH test vectors for every supported signature scheme.
8. Until a compatible wallet release is available, the AjoChain UI must clearly label cross-device recovery as unavailable and retain local-browser recovery as a separate convenience.

## Rollout gate

Do not enable this in production or apply the metadata migration to the production database until the protocol is implemented in a compatible wallet, signature vectors pass, API integration tests pass, and a security review confirms the origin, replay, and authorisation checks.
