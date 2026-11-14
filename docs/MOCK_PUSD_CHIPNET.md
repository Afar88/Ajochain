# AjoChain tPUSD — Chipnet test token

## Purpose and warning

tPUSD is a locally issued, test-only CashToken for exercising AjoChain's PUSD ACR v3 flow on Bitcoin Cash Chipnet.

- It is **not official PUSD**.
- It is not backed by USD, PUSD, or any reserve.
- It has no redemption value and must never be represented as a stablecoin.
- It is for testing only. Do not use Mainnet BCH or real PUSD.
- The test supply is fixed at **1,000 tPUSD**, represented as 1,000,000,000 base units with 6 display decimals.
- The genesis output contains no minting NFT. Fungible CashToken supply cannot be increased after genesis.

## Create the token

1. Switch AjoChain to **Chipnet**.
2. Connect a Selene wallet with Chipnet BCH. The wallet needs enough BCH for two transactions and miner fees.
3. Open **Test Token Tools** at #/tools/mock-pusd.
4. Select **Create tPUSD on Chipnet**.
5. Approve the first transaction. It creates a normal BCH output at index 0, which acts as the CashToken genesis anchor.
6. Approve the second transaction. It spends that anchor and creates the fixed tPUSD supply.
7. AjoChain checks the token output on Chipnet and stores its category ID in this browser. Share that category ID with the other test participants.

CashToken categories are derived from an eligible output-zero outpoint spent by the token genesis transaction. The app deliberately uses a separate anchor transaction before issuing tPUSD.

## Use it with ACR v3

Each additional tester should open Test Token Tools, paste the issuer's exact 64-character category ID into **Import a tester category from the issuer**, and select **Use existing tPUSD category**. This sets the same category locally; it does not mint tokens or verify that the issuer is trustworthy.

After the category is configured in each browser:

1. Open **PUSD ACR v3**.
2. Create a Chipnet circle using the configured tPUSD category.
3. Send tPUSD to each member's Selene wallet using a token-aware Chipnet address.
4. Each member deposits the exact contribution into their own on-chain credit.
5. Once every member has enough credit, test payout, the default 20% retention, and rollover.

The token supply is initially held by the issuer wallet. Transfer test units to member wallets using a CashTokens-compatible wallet. The token issuer should share enough units with each member before the circle starts. The app does not provide a hosted faucet or custody user tokens.

## Category configuration and isolation

- The local category is stored under ajo-mock-pusd-category in browser storage.
- A build-time VITE_PUSD_CHIPNET_CATEGORY value takes precedence over the local mock category.
- The official PUSD Mainnet category is never used for Chipnet transactions.
- PUSD ACR v3 invite links are accepted only when their category matches the category configured in the receiving browser.
- Clearing browser storage removes the local mock category setting; it does not destroy the on-chain token.
- The issuer wallet and all token holders remain responsible for their own keys and test-token UTXOs.

## Operational limitations

- The token is issued on-chain, but no BCMR identity metadata or wallet logo is published by this tool. Wallets may display the category ID instead of the tPUSD ticker.
- The fixed supply cannot be replenished. If it is lost or exhausted, create a new test category and coordinate that category with all testers.
- Creating a new category changes the configured local category and makes older invite links fail the current-category check in that browser.
- This tool does not deploy or enable Mainnet PUSD.
- The ACR v3 contract remains experimental and unaudited. A successful token issuance does not constitute a security review.
