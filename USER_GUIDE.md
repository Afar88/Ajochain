# AjoChain User Guide

A simple guide to using AjoChain on Chipnet.

> **Important:** AjoChain's PUSD flow is experimental and intended for Chipnet testing. Do not use mainnet funds or real money. Never share your seed phrase or private key.

## 1. What is AjoChain?

AjoChain brings the traditional ajo/rotating savings-circle idea on-chain. Members contribute to a shared circle, and the protocol keeps track of the circle state and payout round.

AjoChain currently supports:

- **BCH circles** — savings circles using Bitcoin Cash.
- **PUSD circles** — experimental CashToken-based circles using the AjoChain PUSD token.

## 2. Open the app

Open the AjoChain web app:

**https://afar88.github.io/Ajochain/**

Make sure your wallet is connected to **Chipnet** when testing.

## 3. Connect your wallet

1. Open AjoChain.
2. Choose **Connect Wallet**.
3. Approve the connection in your compatible BCH wallet.
4. Confirm that the wallet is using Chipnet/testnet.

Keep some Chipnet BCH available for transaction fees.

## 4. Create a circle

### BCH circle

1. Select the BCH circle/create option.
2. Enter the member wallet addresses.
3. Set the contribution amount.
4. Review the circle details.
5. Approve the transaction in your wallet.
6. Wait for the transaction to confirm.

### PUSD circle

1. Open the **PUSD** section.
2. Choose **Create Circle**.
3. Add the participating member addresses.
4. Set the contribution amount.
5. Review the members and amount carefully.
6. Approve the transaction in your wallet.
7. Save/share the circle information with the other members.

PUSD uses an on-chain state NFT to track the circle round and a PUSD token to represent the contributed value.

## 5. Make a contribution

1. Open the circle.
2. Confirm the circle address and contribution amount.
3. Make sure you have enough Chipnet BCH for fees.
4. For a PUSD circle, make sure you also have the required PUSD tokens.
5. Submit the contribution transaction from your wallet.
6. Wait for confirmation before making another transaction.

Always verify the destination and amount in your wallet before signing.

## 6. Check circle status

The circle status can show information such as:

- Current round
- Number of members
- Contribution amount
- PUSD/BCH balance
- Available payout information
- Circle contract state

Use the transaction explorer link when you need to independently verify an on-chain transaction.

## 7. PUSD payouts

When the circle is ready for a payout:

1. Open the PUSD circle.
2. Review the current round and payout member.
3. Enter or select the recipient address.
4. Review the PUSD amount and fee/reserve information.
5. Build and review the payout transaction.
6. Sign and broadcast the transaction.
7. Verify the transaction on the Chipnet explorer.

The payout advances the circle to the next round when the contract conditions are satisfied.

## 8. Fees and reserves

AjoChain keeps a BCH reserve for transaction fees. The reserve is separate from the PUSD backing so that miner fees do not accidentally reduce the value represented by the PUSD tokens.

Always leave enough Chipnet BCH available for transaction fees.

## 9. Sharing a circle

When the app provides a share/link option, send the circle link or circle details to the participating members through a trusted channel.

Before contributing, every member should independently check:

- Circle members
- Contribution amount
- Network
- Contract/circle address
- Expected payout order

## 10. Troubleshooting

### Wallet will not connect

- Make sure your wallet supports the required BCH/Chipnet flow.
- Check that the wallet is unlocked.
- Switch to Chipnet.
- Reload the page and reconnect.

### Transaction fails

- Check that you have enough Chipnet BCH for fees.
- For PUSD, check that you have enough PUSD tokens.
- Confirm that you are using the correct circle and network.
- Wait for pending transactions to confirm before trying again.

### The app still shows old information

Hard-refresh the page or clear the browser cache. GitHub Pages can take a short time to publish a new build after changes are merged.

## 11. Safety checklist

Before signing any transaction:

- Confirm **Chipnet**, not mainnet.
- Confirm the recipient/address.
- Confirm the token and amount.
- Confirm the transaction fee.
- Never share your seed phrase/private key.
- Do not use real funds with the experimental PUSD implementation.

## 12. Testing status

AjoChain's automated CI covers the project tests, CashScript compilation, TypeScript checking and web build. Real wallet transactions on Chipnet are separate from automated tests and should be verified with test funds before treating the flow as production-ready.

## 13. Useful links

- **AjoChain app:** https://afar88.github.io/Ajochain/
- **GitHub repository:** https://github.com/Afar88/Ajochain
- **GitHub Actions:** https://github.com/Afar88/Ajochain/actions

If you encounter a reproducible bug, record the transaction ID/error message and the exact steps that produced it. Never include your seed phrase or private key.