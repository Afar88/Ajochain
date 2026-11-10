# Our Ajo: Classic circle recovery report

Read-only investigation, 2026-11-10, Bitcoin Cash **Chipnet** only. Data came from two independent Fulcrum servers, `chipnet.imaginary.cash:50002` and `chipnet.bch.ninja:50002`, which returned identical results. Chain tip at check time: block 331772.

## Verified on chain

| Item | Value |
|---|---|
| Circle | Our Ajo · 3 members · 100,000 sats each · max fee 10,000 sats |
| State category | `e575fcf06b319ba5749967814315a24fc1e22d8601b231e5b3bf2a539999f732` |
| Category-source tx (`e575…f732`) | 3 inputs, 1 output: 1,927,394 sats to member 1 (`bchtest:qqhp25…qtjs`). No tokens. Under CashTokens rules, the category is the txid of the outpoint the genesis spends at vout 0. |
| Token genesis tx | `b3aa279efd6db1ba88c7d6c30de1cf80824dcce8c59e481b6588df9b80b122c7` (block 331631). Spends `e575…f732:0`. |
| Genesis output 0 | 1,000 sats + mutable NFT, category `e575…f732`, commitment `00`, to the covenant |
| Genesis output 1 | 1,925,934 sats change to member 1 |
| Covenant address | `bchtest:pvhnq9rw2lzqzmsh3xld2ldq8nj4fej6uwmck6t0entjwwp9qyyswq0vev256` (token-aware: `bchtest:rvhnq9…jusc4td3`) |
| Locking bytecode | `aa202f30146e57c4016e1789bed57da03ce554e65ae3b78b696fccd727382501090787` (P2SH32) |
| Address derivation | Rebuilt from the invite parameters with `contracts/AjoCircle.cash` (cashc 0.14.0). It matches the on-chain covenant exactly. A freshly compiled artifact's bytecode is byte-identical to the committed `AjoCircle.json`. |
| Current UTXOs at covenant | **One**: `b3aa27…22c7:0`, 1,000 sats, state NFT, commitment `00` |
| Covenant history | Only the genesis tx. No contributions, no payouts, no cancel. |
| Balance | 1,000 sats confirmed (the state NFT's dust), 0 sats in contributions |
| Current round | 0 (member 1's turn). The state NFT is unspent. |

## Recovery assessment

- **No pooled funds exist to recover or migrate.** The only value at the covenant is the 1,000-sat dust carrying the state NFT.
- **The circle is intact and still usable on its original contract.** Each member can send 100,000 sats to the covenant address. Once 300,000 sats are there, anyone can trigger `payout()`, which pays member 1 at least 290,000 sats and moves the NFT to round 1.
- **Scheduled payout right now:** not possible. The shortfall is 300,000 sats.
- **Unanimous cancel:** possible in principle. It needs a pubkey and signature from all three members, in member order (`m0`, `m1`, `m2`). Slots 3 and 4 are ignored. Note: `cancel()` places no rule on outputs, so whoever builds the cancel transaction decides where everything goes. Every member must review the outputs before signing.
- **Migration into V2:** not recommended and not needed. V2 member credits cannot be backed by V1's pooled UTXOs, and the only movable value is 1,000 sats of dust. Members who want V2 should start a fresh V2 circle. "Our Ajo" stays on Classic, with its history and member rights unchanged.

## What the app now does

- The original invite link still opens Our Ajo on the Classic (V1) contract (`#/c/…`).
- The circle page shows an on-chain verification panel (`src/lib/recovery.ts`). It covers the state NFT outpoint with an explorer link, the round, the pot, and clear warnings for a missing, duplicate or immutable state NFT, a wrong-category token, an invalid commitment, or an invalid balance.
- No recovery or migration transaction is built or sent. Any move of Classic funds still needs every affected member to sign.
