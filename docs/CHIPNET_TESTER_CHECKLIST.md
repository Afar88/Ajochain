# Chipnet tPUSD tester checklist

This is a manual acceptance checklist for the experimental PUSD ACR v3 path. Use only Chipnet wallets and test BCH. tPUSD is unbacked test data, not official PUSD and not redeemable.

## Before testing

- [ ] Open the AjoChain preview or GitHub Pages app and confirm the network is **Chipnet**.
- [ ] Use a dedicated Selene test wallet. Never enter a seed phrase or private key into AjoChain or send it to anyone.
- [ ] Fund the issuer and each member wallet with enough Chipnet BCH for token transfers, deposits, and miner fees.
- [ ] Confirm the issuer has not already issued a tPUSD category in this browser.

## Issuer setup

- [ ] Open **Test Token Tools**.
- [ ] Select **Create tPUSD on Chipnet** and approve the genesis-anchor transaction in Selene.
- [ ] Approve the fixed-supply issuance transaction.
- [ ] Wait for the page to verify the token output and display the 64-character category ID.
- [ ] Confirm the issuer page now shows the configured category and the issuance button cannot be used again.
- [ ] Copy the category ID and share only that public identifier with testers.

## Distribute and import

- [ ] Connect the issuer wallet and send a small tPUSD amount to a tester's Chipnet address.
- [ ] Test whole and decimal amounts (for example, 100 and 25.5); confirm invalid values and values with more than six decimal places are rejected before wallet approval.
- [ ] Confirm Selene shows a Chipnet transaction for the transfer.
- [ ] In the tester's browser, open **Test Token Tools**, import the exact category ID, and confirm it is displayed as the configured local category.
- [ ] Confirm the tester can see their tPUSD in a CashTokens-compatible wallet. Wallet ticker/logo metadata may be absent; verify by category ID.

## Two-member PUSD ACR v3 acceptance run

- [ ] Configure the same tPUSD category in both member browsers.
- [ ] Create a two-member circle with a contribution of 100 tPUSD (100,000,000 base units) and 20% retention.
- [ ] Share the invite link and open it in the second member's browser.
- [ ] Each member deposits 100 tPUSD from their own registered wallet and approves the transaction in Selene.
- [ ] Refresh the circle and confirm each member receipt shows 100,000,000 base units and the pool reconciles to 200,000,000.
- [ ] Trigger payout and confirm the scheduled member receives 160 tPUSD while 40 tPUSD remains in the pool and is credited to that member's receipt.
- [ ] In the next round, confirm the first member needs only 60 tPUSD more to reach a 100 tPUSD credit, while the second member needs a full 100 tPUSD.
- [ ] Confirm payout remains locked if either member is below one full contribution.
- [ ] Record transaction IDs, category ID, wallet/network, browser/device, and any confusing messages. Do not record seed phrases or private keys.

## Stop conditions

Stop the test and do not invite more members if the category ID differs between browsers, a transaction is not indexed, member credits do not match deposits, the pool does not reconcile with receipt credits, or payout outputs differ from the expected accounting. Share the transaction IDs and screenshots for investigation; never share wallet secrets.

## Limitations

PUSD ACR v3 is experimental and unaudited. This checklist does not establish security or production readiness. The test token has a fixed 1,000 tPUSD supply and no redemption value. The flow does not support cancellation/refunds or member replacement.
