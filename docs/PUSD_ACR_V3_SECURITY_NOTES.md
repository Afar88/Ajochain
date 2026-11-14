# PUSD ACR v3 security notes

Status: Chipnet prototype only. This design is not independently audited and is not enabled for mainnet.

## Asset accounting model

PUSD ACR v3 uses:
- one minting circle-state NFT;
- one immutable receipt NFT per registered member;
- one fungible PUSD pool UTXO at the circle covenant;
- a separate token-free BCH fee-reserve UTXO.

Each receipt commits to a member index and that member's PUSD credit. A member deposit is accepted only when the token inputs are funded by that member's registered P2PKH locking script. The covenant increases that member's receipt credit and increases the PUSD pool amount by exactly the same token amount.

The pool is pooled at the UTXO level, but it is not an unaccounted pooled pot: the covenant reconciles the pool's token amount to the sum of every member receipt before payout. Every member must independently hold at least one full contribution. At payout, each receipt is debited by one contribution, the winner's receipt is additionally credited with the retained amount, and the pool retains exactly that amount. The recipient receives gross pot minus retention.

## ACR calculation

For N members, contribution C and agreed retention r basis points:

- gross payout = N × C;
- retained = floor(gross payout × r / 10,000);
- recipient token amount = gross payout − retained;
- winner credit after payout = old credit − C + retained;
- every other member credit after payout = old credit − C.

PUSD token backing satoshis are split between the recipient's token output and the rollover pool output. The covenant requires the combined token-output BCH backing to equal the previous pool backing. Miner fees are paid only from the separate token-free BCH reserve.

## Deposit restrictions

- The registered member must fund the PUSD inputs and a separate token-free BCH input. Each successful deposit adds exactly the configured `maxFee` amount to the circle's BCH fee reserve; any remaining BCH from that input is returned to the member, less the actual miner fee.
- The PUSD input amount must exactly match the credit being added. The current planner supports multiple inputs only when their sum is exact; if the wallet cannot produce an exact sum, the member must consolidate token UTXOs first.
- The first deposit creates the PUSD pool and flips the state commitment's pool-initialized flag.
- Later deposits must spend the existing pool UTXO and update its amount and BCH backing.
- Duplicate pool UTXOs, unexpected token categories, missing receipts, mixed member funding, or receipt/pool mismatches block the app's planner or covenant transition.

## Explicit limitations

- Cancellation and member refunds are not implemented in this version. Do not promise a refund path or create a cancel button.
- No member replacement or default-resolution workflow is implemented.
- The current Chipnet PUSD category is not configured because the previously examined candidate was not verified. Therefore the PUSD ACR creation and invite routes remain blocked until an independently verified Chipnet PUSD category is configured.
- This version must not be used on mainnet or with real PUSD.

## Required release gates

1. Independent review of both CashScript source files and generated artifacts.
2. Test first deposit, subsequent deposit, multiple PUSD funding inputs, payout, rollover, fee reserve exhaustion, malformed receipts, wrong member, wrong category, pool mismatch, insufficient credit, overflow, and reorg/indexer handling.
3. Independent-wallet end-to-end testing on Chipnet with Selene.
4. Verify every raw transaction's PUSD token category, token amount, token backing, BCH reserve, NFT commitments, and output order.
5. Only then consider a separate deployment decision. Existing legacy PUSD circles must never be silently migrated.
