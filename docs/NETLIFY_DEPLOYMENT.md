# Netlify deployment

AjoChain is a static Vite + TypeScript application. Netlify builds the repository and publishes the generated `dist/` directory.

## Site configuration

When creating the Netlify site from GitHub, use:

- Repository: `Afar88/Ajochain`
- Branch for the initial preview: `chore/netlify-preview-migration`
- Base directory: repository root
- Build command: `npm run compile && npm run typecheck && npm test && npm run build`
- Publish directory: `dist`
- Node.js: `22`

These settings are also recorded in the repository's `netlify.toml`; Netlify should detect them automatically.

## Environment variables

No environment variables are required for the default Chipnet experience.

The optional `VITE_PUSD_CHIPNET_CATEGORY` build variable must only be set after the intended Chipnet test-token category has been independently verified. Do not set it to a mainnet category. Never add private keys, seed phrases, wallet credentials, API secrets, or other server secrets to `VITE_*` variables: Vite embeds those values in public browser assets.

## Preview-first rollout

1. Create the Netlify site and connect the GitHub repository.
2. Deploy the migration branch as a preview.
3. Check the deployed URL on desktop and mobile.
4. Verify the app loads on Chipnet, wallet connection works, and the tPUSD test tools are visible.
5. Exercise the issuer and transfer flows only with Chipnet test funds and an approved test wallet.
6. Keep the existing GitHub Pages and Vercel deployments unchanged until the preview has passed testing and a separate production cutover is approved.

The application uses hash-based routes (for example, `#/tools/mock-pusd`), so a catch-all history fallback rewrite is not required.

## Safety

AjoChain is an unaudited prototype. Use Chipnet only. The test tPUSD is unbacked, has no redemption value, and is not official PUSD. Never use mainnet funds for testing.
