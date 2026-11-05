# AjoChain v2: member contribution credit and rollover

Status: design specification for the new-circle flow. This is not deployed code and must not be treated as an audited contract.

## Goal

For new BCH circles, account for contributions per registered member so that the app can show:

- confirmed credit owned by each member;
- the member's remaining amount due for the current round;
- credit carried forward after a round;
- the circle's aggregate funding status.

Existing circles remain on the current AjoCircle contract. They cannot be migrated into member-level accounting because historical deposits to the shared address do not prove which member owns each payment.

## Required accounting rule

For member i:

- `credit_i` is the member's confirmed, on-chain contribution credit.
- `due_i` is the configured contribution for the current round.
- `top_up_i = max(0, due_i - credit_i)`.
- When a round is paid, debit exactly `due_i` from every member's credit.
- Any remaining credit stays assigned to that same member for the next round.

A round is eligible for payout only when **every member** has at least the configured contribution credit. Do not allow one member's surplus to silently cover another member's shortfall. This is the safest interpretation of individual rollover and top-up.

Example: five members owe 100,000 sats each. If one member has 150,000 sats credit, their top-up is zero and 50,000 sats carries forward. A member with 60,000 sats credit still owes 40,000 sats. The round is not ready until every member has reached 100,000 sats.

## On-chain attribution requirement

A plain BCH payment to the current shared contract address cannot prove which member sent it. Do not infer ownership from transaction history, wallet connection state, QR scans, or a user-entered member number.

Every credited deposit must be authenticated by the registered member's BCH signature and represented by a covenant-enforced on-chain record. The contract design must bind that record to:

- the circle identifier/state category;
- the registered member index or member public-key hash;
- the amount credited;
- the applicable round/credit state.

The implementation must prevent forged member attribution, duplicate crediting, replay across circles, and spending or redirecting another member's credit. The payout transition must atomically debit one contribution from each member and preserve all remaining member credits.

## Contract design gate

Before implementation, prove the accounting transition in CashScript tests and verify it against the CashTokens transaction model. In particular, validate how member signatures authenticate deposits, how member credit state is represented and updated, and how a payout atomically updates all member credits while preserving the state NFT and fee constraints.

Do not ship a UI-only ledger or an off-chain database as the source of truth for balances. The UI must derive balances from validated on-chain state. If the required atomic state transition cannot be implemented safely within the current contract architecture, stop and present the limitation rather than weakening the ownership guarantees.

## Required tests before a PR can be considered complete

1. A member can add credit only with their registered signing key.
2. A member cannot credit another member's account.
3. A contribution cannot be replayed or counted twice.
4. A credit record cannot be moved to another circle or member.
5. Partial contributions show the exact remaining top-up.
6. Overpayment remains credited to the same member.
7. Payout is blocked if any member is below their due amount.
8. Payout debits exactly one round's due from each member.
9. Surplus credit remains assigned to its owner after payout.
10. Repeated rounds preserve correct balances and payout order.
11. Emergency cancellation accounts for every member's remaining credit.
12. Existing v1 circles and their payout behavior remain unchanged.

## Release constraints

- New circles only; keep v1 links and contracts readable and spendable.
- Mainnet stays disabled for this feature until contract tests, security review, and an explicit deployment decision are complete.
- Test on Chipnet with multiple independent wallets and inspect every transaction's inputs, outputs, token category, and NFT commitments.
- Do not merge or deploy automatically.
