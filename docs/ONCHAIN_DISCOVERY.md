# Blockchain-first circle discovery

## Source of truth

AjoChain discovery is sourced directly from Bitcoin Cash. It does not require a database registry, Neon, a server-side index, or a cached balance.

When a supported circle is created, its genesis transaction publishes:

1. A compact `AJO` OP_RETURN manifest containing the circle's version, network, asset, name, ordered member addresses, contribution, fee cap, retention rate, and (for PUSD) exact token category.
2. One ordinary, spendable 546-satoshi P2PKH marker output to each declared member address.

The marker is a discovery pointer, not an ownership credential and not a deposit into the circle. The recipient can spend it. The transaction remains in address history after it is spent, so it can still be used to locate the manifest.

## Wallet discovery flow

1. The connected wallet supplies the public receive address for the selected network.
2. AjoChain derives its P2PKH locking script and Electrum script hash, then reads the address's confirmed transaction history from a Chipnet or Mainnet Fulcrum server.
3. AjoChain fetches candidate raw transactions and looks for a valid `AJO` OP_RETURN manifest plus exactly one 546-satoshi marker for every manifest member.
4. The first input's source outpoint must use `vout = 0`. AjoChain fetches that previous transaction, verifies its txid, and confirms output 0 exists, has positive BCH value, and contains no CashTokens. The category is derived from that input's previous transaction hash, not copied from browser storage.
5. AjoChain reconstructs the matching V1, V2, or V3 covenant from the manifest and derives the expected contract address.
6. The genesis transaction must contain the expected state NFT and, for V2/V3, every correctly indexed member receipt at the reconstructed covenant address.
7. The current covenant UTXOs are fetched again from Electrum. V1 state, V2/V3 receipt sets, member credits, and PUSD pool/receipt reconciliation are validated against live chain data.
8. Only candidates that pass these checks appear under **Discovered from Bitcoin Cash** in **My circles**.

Unconfirmed transactions are not shown as verified. Missing or malformed history entries, invalid manifests, incorrect genesis outputs, missing state/receipt NFTs, and invalid live state all fail closed.

## Manifest format

The current binary payload is version 1:

| Field | Encoding |
|---|---|
| Magic | `41 4a 4f` (`AJO`) |
| Manifest format | 1 byte |
| Contract version | 1 byte (`1`, `2`, or `3`) |
| Network | 1 byte (`0` Chipnet, `1` Mainnet) |
| Asset | 1 byte (`0` BCH, `1` PUSD) |
| Member count | 1 byte (2–5) |
| Name length | 1 byte (1–60 UTF-8 bytes) |
| Name | UTF-8 |
| Members | Ordered 20-byte P2PKH hashes |
| Contribution | Unsigned 64-bit little-endian |
| Maximum fee | Unsigned 64-bit little-endian |
| Retention | Unsigned 16-bit little-endian basis points |
| PUSD category | 32 bytes; all zeroes for BCH |

The circle state category is intentionally omitted: it is derived from the source transaction hash in input 0, and that input must spend output 0. This prevents the browser from supplying an unrelated category.

## Cost and compatibility

The marker costs 546 sats per member, or 1,092–2,730 sats for a 2–5 member circle, plus the transaction's miner fee. Markers are ordinary member-owned BCH outputs and are not locked by the AjoChain contract.

This format is added to new V1 BCH, legacy PUSD V1, V2 BCH, BCH ACR V3, and PUSD ACR V3 genesis transactions. It does not rewrite or migrate an existing contract.

**Older circles:** circles created before this marker/manifest format do not contain the discovery record. They remain usable through their original invite URLs or locally saved links. A one-time on-chain backfill announcement is a future compatibility path; it must be verified against the original circle before it is trusted.

## Security boundaries

- A public wallet address is used only to locate public chain history. This read-only scan does not prove ownership, grant organiser status, or authorize contributions, cancellations, or payouts.
- A manifest is an untrusted discovery hint. The reconstructed contract address, genesis NFT outputs, and current on-chain state must all verify before a circle is shown as discovered.
- Current balances, rounds, receipt credits, and payout readiness are always read from live covenant UTXOs. The manifest and local storage never provide financial truth.
- A database or browser cache may be added later only as a performance optimization. It must be disposable and must never override a blockchain observation.
- This feature does not make the experimental contracts audited or Mainnet-ready. Continue to use Chipnet test funds for V2/V3 and PUSD testing.
