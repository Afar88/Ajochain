# AjoChain ◎

**Rotating savings circles (Ajo / Esusu) enforced by a Bitcoin Cash covenant. No treasurer holds the money.**

🔗 **Live demo:** https://afar88.github.io/Ajochain/ (chipnet by default; the landing page runs a prefilled demo circle in your browser)
🏁 Built for **BCH BLAZE 2026** (DoraHacks)

> **Ajo in one line:** a group of friends each chip in the same amount every week, and every week one of them takes home the whole pot, in a fixed order, until everyone has had a turn.

---

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
  - output 1 pays `member[round]` (P2PKH) at least `pot − maxFee`; no tokens
  - any surplus ≥ 1000 sats must go back to the circle in output 2; otherwise exactly 2 outputs. No extra outputs.

**`cancel(pk0, s0, …, pk4, s4)`**: an emergency exit. **All** `memberCount` members sign, and together they decide where the funds go (no output restrictions).

**Why the category is pinned:** without it, a member could mint their own "state" NFT claiming it's their turn. CashTokens categories equal the txid of the outpoint spent at genesis (which must be output #0), so the category, and therefore the contract address, is known *before* the genesis transaction is signed. The web app does this automatically: it picks a wallet coin at output #0, derives the circle address, and then asks the wallet to sign the genesis tx that locks the state NFT (commitment `00`, 1000 sats) in the circle.

### Web app: [`web/`](web/)

Static Vite + TypeScript app, mobile-first, deployable to GitHub Pages. No backend.

- **Landing = demo circle**: "Mama Nkechi's Market Circle", 5 members, 3 already paid in. Tap to pay in, then **Pay out**. This runs the **real compiled covenant** in your browser against CashScript's `MockNetworkProvider`, which evaluates every transaction in the BCH VM. **Try to cheat** sends the pot to the wrong member and shows the contract rejecting it.
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

`npm test` gives **24 passing tests** (`test/ajo.test.ts`, `test/demo.test.ts`), all on `MockNetworkProvider` with full VM validation:

- Happy path: a full 5-round circle paying each member in order, a 2-member circle, uneven contribution sizes, surplus returned to the circle (3rd output), early contributions left for the next round, payout refused before the pot is full or after the circle completes.
- Attacks rejected (each asserts the specific `require` that fires): paying the wrong member, paying an outsider, not incrementing the round, underpaying the recipient (fee > maxFee), skimming an extra output, moving the state NFT out of the circle, spending contributions without the state UTXO, a fake state NFT of another category, an immutable NFT as state, mixing in outside inputs.
- Cancel: works with all member signatures and fails with one wrong signer.
- Helpers: share-link round trip and parameter validation; the in-browser demo flow end to end.

## Limitations (honest list)

- **Unaudited hackathon MVP.** Use chipnet. Mainnet is switchable but not recommended.
- **Up to 5 members**, fixed order. Bigger circles mean more constructor slots (or a merkle-root of members).
- **No enforcement of who contributed.** The covenant counts BCH, not *who* paid it. If a member doesn't pay, the pot just isn't full and the payout waits. Social pressure (as with traditional Ajo) still decides what happens with late payers. Members who already received the pot can't be forced to keep paying. That's the core trust problem of any ROSCA, and solving it needs collateral (see roadmap).
- **Fee comes from the pot** (≤ `maxFee`, default 10,000 sats). The payout picks the largest contribution UTXOs first to keep the tx small; many tiny contributions could exceed `maxFee`.
- **Cancel** needs every member's signature, and the web UI doesn't build cancel txs yet (contract + tests only).
- **WizardConnect**: integrated with the official `@wizardconnect/core` / `@wizardconnect/dapp` packages (pairing QR, session resume, sign + broadcast for genesis and contributions). It is **not yet tested end to end against a real WizardConnect wallet**, and the dapp only uses the wallet's receive address #0. The npm metadata of `@wizardconnect/dapp` lists its license as "Proprietary" (the React package says LGPL-3.0); check this before any production use.
- **Genesis needs a wallet coin at output #0** (CashTokens rule). If your wallet has none, send yourself a small amount first. Advanced users can mint the state NFT manually from any CashTokens wallet using the "Genesis txid" option.
- Electrum reads use CashScript's default public servers (`chipnet.bch.ninja` for chipnet). Override in the browser console with `localStorage.setItem('ajo-electrum-chipnet', 'chipnet.imaginary.cash')`.

## Roadmap

- **Stablecoin circles (PUSD / CashTokens FTs)**: contributions in a fungible token so savings don't swing with BCH price. The covenant change is small (sum `tokenAmount` of a pinned FT category instead of `value`). Not done in this MVP.
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
