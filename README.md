# AjoChain ◎

**Rotating savings circles (Ajo / Esusu) enforced by a Bitcoin Cash covenant. No treasurer holds the money.**

🔗 **Live app:** https://afar88.github.io/Ajochain/ (Chipnet by default; create and manage BCH circles, with experimental PUSD support)
🏁 Built for **BCH BLAZE 2026** (DoraHacks)

> **Ajo in one line:** a group of friends each chip in the same amount every week, and every week one of them takes home the whole pot, in a fixed order, until everyone has had a turn.

## Getting started

1. Open the [AjoChain app](https://afar88.github.io/Ajochain/).
2. Leave the network on **Chipnet** for testing. Connect a WizardConnect-enabled BCH wallet.
3. Choose **Create**, select BCH or experimental PUSD, and enter the circle details and member payout order.
4. Approve the creation transaction in your wallet. Share the generated circle link with members.
5. Members contribute to the circle address. When the pot is full, anyone can trigger the scheduled payout.
6. Open **My circles** to return to circles saved in this browser.

For Chipnet BCH, obtain test coins from a Chipnet faucet such as [tbch.googol.cash](https://tbch.googol.cash/). PUSD is experimental and remains Chipnet-only. Never enter or share a seed phrase or private key with AjoChain.

For the current limitations and rollout plan for member-level contribution receipts and carry-forward credit, see [Member contribution accounting](docs/member-contribution-accounting.md). Individual credit is not yet enforced by the deployed aggregate-pot contracts.
---


### PUSD circles (experimental)

AjoCirclePUSD is a separate CashTokens fungible-token covenant for ParyonUSD. The PUSD category is pinned to `2469acc5afa4b10cb5b5c04afb89c3a3ffd61c5da9c01e26d00951cae2a02544`. Each member contributes the configured number of PUSD base units; the round payout sends exactly `memberCount × contribution` token units to the scheduled member. Any token surplus must return to the circle. The existing mutable state NFT and unanimous-member cancellation model remain in place.

PUSD token UTXOs also carry BCH. The covenant requires at least 1,000 sats on each token-bearing payout/surplus output and on the BCH reserve change, preserves the state UTXO's BCH value and all BCH backing attached to PUSD inputs, and funds miner fees only from a separate token-free BCH reserve input. Unused reserve returns to the circle; the miner fee cannot exceed the BCH reserve input. This is a separate experimental contract from the BCH-only `AjoCircle.cash`. The experimental web flow now supports Chipnet circle creation, wallet-funded PUSD contributions, live status, and permissionless payouts. PUSD creation and contribution transactions use WizardConnect; payout uses the covenant. Tests use CashScript's MockNetworkProvider only. Cancellation still requires every member's signature and has no in-app multi-wallet signing flow. **Chipnet only; unaudited; do not use with mainnet funds.**

## The problem

Ajo (Yoruba), Esusu, Susu or *adashe* is how tens of millions of people across Nigeria and West Africa save, especially market traders, artisans and people the banks don't serve well. It works on trust, and one person, the *alajo* or treasurer, holds everyone's cash between payouts. When the treasurer disappears, gets robbed, or "borrows" the pot, the whole circle loses. Members also can't easily check the balance or whose turn it is.

## The fix

AjoChain moves the treasurer's job into a **CashScript covenant** on Bitcoin Cash:

- The members' addresses, the payout order and the contribution amount are **baked into the contract**.
- Members send their share to the circle address from **any BCH wallet** (or scan a QR code). Fees are a fraction of a cent.
- When the pot is full, **anyone** can press "Pay out". No signatures are needed: the covenant itself only lets the money go to **the member whose turn it is**, and moves the round counter forward.
- The round counter lives in a **CashTokens NFT** (mutable commitment) that the covenant keeps locked inside the contract.

## How it works

```
             contribute (plain BCH, any wallet)
 member 1 ─┐
 member 2 ─┼──────────────▶ ┌──────────────────────────────┐
   ...     │                │   AjoCircle covenant (P2SH32) │
 member N ─┘                │                              │
                            │  UTXO #0: state NFT          │
                            │    category = stateCategory  │
                            │    commitment = round r      │
                            │  UTXO #1..k: contributions   │
                            └──────────────┬───────────────┘
                                           │ payout()  (anyone, no signature)
                     ┌─────────────────────┼─────────────────────────┐
                     ▼                     ▼                         ▼
       out 0: state NFT back to     out 1: N × contribution    out 2 (optional): surplus
       the covenant, round r+1      − fee → member[r]          back to the covenant
```

### Contract: [`contracts/AjoCircle.cash`](contracts/AjoCircle.cash)

Constructor: `m0..m4` (member pubkey hashes, unused slots zero), `memberCount` (2–5), `contribution` (sats), `maxFee` (sats), `stateCategory` (the state NFT's category).

**`payout()`** (no signature; anyone can trigger it):
- *Contribution inputs* (index > 0) only check that input 0 is this circle's UTXO holding the mutable state NFT. All rules are enforced by input 0.
- *State input* (index 0):
  - holds a **mutable** NFT of the pinned `stateCategory`; `round = commitment`, and `round < memberCount`
  - **every** input is a UTXO of this circle (so the pot can't be faked with outside coins), and their sum (excluding the state UTXO) is `≥ memberCount × contribution`
  - output 0 returns the state NFT to the circle, same value, same category, still mutable, `commitment == round + 1`
  - output 1 pays `member[round]` (P2PKH), with the miner fee capped by `maxFee`, which must leave at least 1,000 sats for a dust-safe recipient output; no tokens
  - any surplus ≥ 1000 sats must go back to the circle in output 2. A surplus below 1000 sats cannot form a dust-safe change output, so it is paid to the recipient; otherwise exactly 2 outputs. No extra outputs.

**`cancel(pk0, s0, …, pk4, s4)`**: an emergency exit. **All** `memberCount` members sign, and together they decide where the funds go (no output restrictions).

**Why the category is pinned:** without it, a member could mint their own "state" NFT claiming it's their turn. CashTokens categories equal the txid of the outpoint spent at genesis (which must be output #0), so the category, and therefore the contract address, is known *before* the genesis transaction is signed. The web app does this automatically: it picks a wallet coin at output #0, derives the circle address, and then asks the wallet to sign the genesis tx that locks the state NFT (commitment `00`, 1000 sats) in the circle.

### Web app: [`web/`](web/)

Static Vite + TypeScript app, mobile-first, deployable to GitHub Pages or Vercel. No backend.

- **Landing page**: product overview with direct BCH and PUSD creation paths; the former interactive demo has been removed from the user-facing experience.
- **Create**: name, amount, 2–5 member addresses in payout order → connect a wallet via **WizardConnect** → the app builds the genesis tx and the wallet signs and broadcasts it → you get a shareable circle link (all params encoded in the URL hash; nothing stored server-side).
- **Circle page**: contract address + BIP21 QR to contribute, members, round tracker, pot balance (read from a public Fulcrum/Electrum server through `cashscript`'s `ElectrumNetworkProvider`), **Pay out this round** (keyless covenant tx broadcast straight to Electrum), and **Pay my share** via WizardConnect.
- **Network toggle**: chipnet (default) / mainnet (with a warning).

## Run it

```bash
npm install
npm run compile     # cashc contracts/AjoCircle.cash -> contracts/AjoCircle.json
npm test            # vitest + MockNetworkProvider
npm run dev         # local web app
npm run build       # static site in dist/
```

Requires Node 20+. Uses `cashscript`/`cashc` **0.14.0**, `@bitauth/libauth` 3, `@wizardconnect/core` + `@wizardconnect/dapp`.

## Tests

`npm test` runs the BCH, PUSD, and browser-demo suites (43 tests total), all on `MockNetworkProvider` with full VM validation:

- Happy path: a full 5-round circle paying each member in order, a 2-member circle, uneven contribution sizes, surplus returned to the circle (3rd output), early contributions left for the next round, payout refused before the pot is full or after the circle completes.
- Attacks rejected (each asserts the specific `require` that fires): paying the wrong member, paying an outsider, not incrementing the round, underpaying the recipient (fee > maxFee), skimming an extra output, moving the state NFT out of the circle, spending contributions without the state UTXO, a fake state NFT of another category, an immutable NFT as state, mixing in outside inputs.
- Cancel: works with all member signatures and fails with one wrong signer.
- Helpers: share-link round trip and parameter validation; the in-browser demo flow end to end.
- PUSD: five-round token payouts, wrong-category rejection, one-unit shortfall, wrong recipient, skipped round, surplus theft, state-NFT token contamination rejection, unanimous multi-input cancellation, and non-member cancellation rejection.

## Limitations (honest list)

- **Unaudited hackathon MVP.** Use chipnet. The BCH flow can switch to mainnet with a warning; PUSD is programmatically restricted to chipnet.
- **Up to 5 members**, fixed order. Bigger circles mean more constructor slots (or a merkle-root of members).
- **No enforcement of who contributed.** The covenant counts BCH, not *who* paid it. If a member doesn't pay, the pot just isn't full and the payout waits. Social pressure (as with traditional Ajo) still decides what happens with late payers. Members who already received the pot can't be forced to keep paying. That's the core trust problem of any ROSCA, and solving it needs collateral (see roadmap).
- **Fee comes from the BCH pot** (≤ `maxFee`, default 10,000 sats). The payout picks the largest contribution UTXOs first to keep the tx small; many tiny contributions could exceed `maxFee`. Any surplus below 1,000 sats is included in the recipient's payment rather than treated as miner fee.
- **Cancel** needs every member's signature, and the web UI doesn't build cancel txs yet (contract + tests only).
- **WizardConnect**: integrated with the official `@wizardconnect/core` / `@wizardconnect/dapp` packages (pairing QR, session resume, sign + broadcast for genesis and contributions). It is **not yet tested end to end against a real WizardConnect wallet**, and the dapp only uses the wallet's receive address #0. The npm metadata of `@wizardconnect/dapp` lists its license as "Proprietary" (the React package says LGPL-3.0); check this before any production use.
- **Genesis needs a wallet coin at output #0** (CashTokens rule). If your wallet has none, send yourself a small amount first. Advanced users can mint the state NFT manually from any CashTokens wallet using the "Genesis txid" option.
- Chain reads go to public Fulcrum servers over WebSocket. For chipnet the app probes `chipnet.imaginary.cash`, `chipnet.bch.ninja` and `cbch.loping.net` in parallel and uses the first that answers. If none are reachable the circle page shows an error with a Retry button. Override in the browser console with `localStorage.setItem('ajo-electrum-chipnet', 'host:port')`.

## AjoChain v2 release plan

The planned v2 release combines BCH and PUSD member-level credit, rollover, payouts, and cancellation/refunds. See [AjoChain v2 release plan](docs/AJOCHAIN_V2_RELEASE_PLAN.md). This is an implementation target, not a claim that these features are already shipped.

## Member experience v2 design

The next product phase is documented in:
- [Member experience architecture](docs/MEMBER_EXPERIENCE_V2.md) — wallet-verified invitations, shared discovery, organiser controls, event indexing, history, notifications, and safety boundaries.
- [Member credit and rollover contract gate](docs/MEMBER_CREDIT_ROLLOVER_V2.md) — on-chain attribution and per-member rollover requirements for new circles only.
- [v2 contract feasibility audit](docs/V2_CONTRACT_FEASIBILITY_AUDIT.md) — source-level findings for the current BCH/PUSD contracts and wallet-signing boundary.

These are design specifications, not shipped features. The current app remains a static, browser-local MVP; do not assume cross-device membership discovery or per-member contribution accounting until the required backend and contract work is implemented and tested.

## Roadmap

- **Stablecoin circles (PUSD / CashTokens FTs)**: experimental Chipnet UI supports creation, contributions, live status, and permissionless payouts. Real Chipnet wallet testing, cancellation signing UX, end-to-end tests against the network, and independent audit remain outstanding.
- **Collateral / late-payer penalties**: members lock a deposit that's slashed if they skip a round after being paid.
- **Per-member contribution receipts**: small NFTs per payment so the app can show *who* paid each round.
- **Timed rounds** (`tx.time`), cancel builder in the UI, more members via merkle proofs, Naira price display, WhatsApp share links.

## BCH BLAZE 2026 checklist

| Requirement | Status |
|---|---|
| GitHub repo with source code | ✅ https://github.com/Afar88/Ajochain |
| Live, clickable demo | ✅ https://afar88.github.io/Ajochain/ (GitHub Pages) |
| WizardConnect (or XO template) integration | 🟡 Integrated with the official packages; needs an end-to-end test with a WizardConnect wallet |
| At least one feature sending **mainnet** BCH transactions | 🟡 Supported (contribute / payout / genesis are network-agnostic, mainnet toggle). **A real mainnet tx has not been made yet and needs the team's own wallet and approval.** |
| Short presentation from the "Widget Factory" template | ⬜ TODO (slides) |
| CashTokens address for EMBER2026 donations | ⬜ TODO: `bitcoincash:z…` *(placeholder, add a token-aware address)* |
| A team member attended a BLAZE stream roll call | ⬜ TODO |
| Confirmed "real" in the BCH BLAZE Telegram | ⬜ TODO (https://t.me/bchblaze) |
| Registered + submitted on DoraHacks | ⬜ TODO (https://dorahacks.io/hackathon/bchblaze2026) |

## License

MIT, see [LICENSE](LICENSE).


### Backend foundation

- [Backend setup and trust boundary](docs/BACKEND_SETUP.md)
- [Metadata-only PostgreSQL migration](db/migrations/0001_backend_foundation.sql)

Neon is connected to the Vercel project. The migration is not yet applied, and the application does not yet use the database at runtime. Financial state remains chain-authoritative.
