# AjoChain UI/UX Redesign — Google Stitch Brief

## Objective
Create a polished, trustworthy, mobile-first redesign of AjoChain, a rotating savings-circle (ajo/esusu) application powered by Bitcoin Cash covenants. This is a visual and usability redesign of the existing product, not a product rewrite.

## Product context
- AjoChain lets people create and participate in rotating savings circles.
- The current web client is a Vite + TypeScript single-page application in `web/`.
- The current UI is rendered from `web/src/main.ts` and styled in `web/src/style.css` (with accessibility overrides in `web/src/audit.css`).
- The current visual identity uses warm cream, clay/terracotta, gold and green, with subtle West African textile inspiration.
- Wallet connectivity uses WizardConnect and Selene-compatible BCH wallets.
- Chipnet is the default test network. Mainnet is real-value and must remain clearly distinguished.
- The product includes classic circles, V2 Chipnet circles, My Circles, contribution, payout, circle sharing, wallet connection/reconnection and transaction status flows.

## Design direction
Design a mature, credible fintech product with a distinctive African savings identity:
- Warm ivory / off-white canvas, deep forest or near-black typography, restrained terracotta and gold accents.
- Preserve a subtle African craft influence; avoid cliché patterns, loud gradients, generic crypto neon, or excessive decorative elements.
- Strong typographic hierarchy, generous whitespace, crisp cards, clear progress and status indicators.
- Mobile-first layouts that also work well on desktop.
- Accessible contrast, visible focus states, large touch targets, clear labels and plain-language explanations.
- Make it feel safe and understandable to people who are not crypto-native.

## Screens to design
1. **Home / landing dashboard** — explain AjoChain in plain language, show the primary actions (create a circle, join/open a circle, view my circles), explain how rotating savings works, and show a clear Chipnet/testnet indicator.
2. **Create circle** — simple step-by-step form for circle name, contribution amount, frequency, member count and payout order; explain each field and show a clear review step before wallet approval.
3. **Join / circle details** — circle summary, contribution terms, member slots, payout order, funding/status and a prominent join action.
4. **My circles** — clear cards/list for circles the user created or joined, next contribution due, current status and next payout information.
5. **Circle activity / contribution** — progress timeline, member contribution states, transaction status, next payout and helpful recovery/error states.
6. **Wallet connection** — explain connecting through WizardConnect, opening the pairing link in the wallet app, QR fallback, reconnecting and safe wallet handling.
7. **Payout / completion** — transparent payout status, transaction confirmation and next steps.

## Interaction and content principles
- Use plain language: explain Chipnet as a test network and Mainnet as real BCH.
- Clearly distinguish connected, connecting, reconnecting, disconnected, pending, confirmed, failed and action-required states.
- Never imply that AjoChain holds users' private keys or custody of funds.
- Never invent yields, guarantees, insurance, audits, or financial protections.
- Before any wallet signature or broadcast, make the amount, network, recipient/action and fee understandable.
- Use realistic sample content only as clearly labelled sample data.
- Include empty, loading, error, disabled and success states for important screens.
- Navigation should remain obvious on small phones; do not rely on hover.

## Critical implementation constraints
The design must map onto the existing application and its current routes and behavior. Do not invent backend features or remove existing functionality. Preserve all existing contract interactions, BCH/CashTokens handling, WizardConnect pairing and signing, transaction verification/broadcast, circle recovery, network switching, and safety confirmations. Do not redesign the transaction logic.

Deliver:
- High-fidelity responsive web screens for the seven areas above.
- A connected clickable prototype covering create → wallet connect → circle view → contribution/status.
- A reusable design system with colors, typography, spacing, radii, buttons, form fields, cards, badges, navigation and status components.
- Exportable frontend code and a `DESIGN.md` handoff describing tokens and component rules.
- Desktop and mobile variants, with mobile treated as the primary experience.

## Primary Google Stitch generation prompt
Redesign AjoChain, a real rotating savings-circle (ajo/esusu) web app on Bitcoin Cash, as a mature, trustworthy, mobile-first fintech experience. Keep its African savings identity through a restrained warm ivory, deep forest, terracotta and muted-gold palette with subtle craft-inspired details. Make the interface exceptionally clear to non-crypto users. Design a responsive home dashboard, create-circle wizard, join/circle details, My Circles, contribution/activity timeline, WizardConnect wallet pairing/reconnection modal, and payout confirmation. Use plain language, excellent typography, accessible contrast, large touch targets, clear progress, calm status colors, helpful empty/loading/error states, and explicit Chipnet versus Mainnet labeling. Show realistic sample data only as examples. Make the main journey clickable from creating a circle through wallet connection to circle status. Do not use crypto clichés, neon gradients, speculative financial claims, or custodial language. This is a visual redesign only: do not invent new product capabilities or alter the underlying transaction, contract, wallet, or safety behavior. Produce a cohesive reusable design system and exportable frontend handoff.

## Review checklist before implementation
- [ ] All seven screen areas are represented.
- [ ] Mobile layouts are usable at narrow phone widths.
- [ ] Create/join/contribute/payout actions are understandable.
- [ ] Chipnet and Mainnet are unmistakable.
- [ ] Wallet pairing and reconnect states are represented accurately.
- [ ] Transaction review and safety messaging are prominent.
- [ ] No unsupported product promises or invented features.
- [ ] Design tokens and component rules are included in `DESIGN.md`.
