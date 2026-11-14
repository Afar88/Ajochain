# PUSD network configuration

Status: safe configuration scaffold. PUSD transaction flows remain experimental and Chipnet-only.

## Official ParyonUSD mainnet category

`2469acc5afa4b10cb5b5c04afb89c3a3ffd61c5da9c01e26d00951cae2a02544`

This is the official ParyonUSD mainnet CashToken category. It is recorded as `PUSD_MAINNET_CATEGORY` for reference and future network-aware work. AjoChain does not enable PUSD mainnet creation, contributions, or payouts.

## Chipnet test category

Set `VITE_PUSD_CHIPNET_CATEGORY` only after independently verifying the Chipnet token's genesis transaction, category ID, issuer/metadata, and that it is the intended test asset. The value must be a 64-character hexadecimal CashToken category and must differ from the mainnet category.

The category currently supplied for investigation, `6b6cf8de5963d67594a4565d49a7bcf3e668a18a7328828de16bd393ac00dcad`, is **not configured** because the available BCMR response returned `identity: null`, no registries, and `resolution_complete: false`. That response does not establish that the category is PUSD. Do not label it PUSD or use it for AjoChain token flows until the token's genesis and issuer are verified.

## Local setup

Copy `.env.example` to `.env.local` and set:

```dotenv
VITE_PUSD_CHIPNET_CATEGORY=
```

Leave it blank until verification is complete. Rebuild the Vite app after changing the variable. Do not put private keys, seed phrases, or wallet credentials in Vite environment variables; Vite variables are public in the built client bundle.

## Safety behavior

- Missing Chipnet category: PUSD creation is disabled and helper functions throw a clear configuration error.
- Mainnet category supplied on Chipnet: rejected.
- Mainnet PUSD transaction flow: rejected by the existing Chipnet-only guard.
- Mock tests use a synthetic category that is not a real token ID.
