# Minimal business connections

## What is ready without signing in

The runtime includes discovery and routing across 21 capabilities in ten domains, four additional first-party skills, project-local CRM contacts/deals/notes, CSV export, and screenshot-based visual review. Existing installed skills outside the presets can be bound to real workers with `specialist-analysis`. Presets are not the complete skill library.

Each project keeps its own CRM and mission history under `.agents/skills/boardroom/.runtime/`. Account connections belong to the local user and are shared by managed projects. No hosting, cloud backup, voice service or recurring outreach is installed.

## Check state

From the workflow checkout:

```sh
npm run connect -- --status
```

Status distinguishes installed packages, configured credentials and enabled connections. Listing tools alone does not prove the intended company's data can be read. The setup command attempts a harmless account read where a known tool supports it and reports the result explicitly. Never use real payments or outgoing email as a setup test.

## Google Drive, Docs, Sheets and Gmail

1. Create a Google Cloud project and Desktop OAuth client. Enable Drive, Docs, Sheets and Gmail APIs; configure the consent screen and test user if the app is in testing.
2. Save the downloaded client file to `~/.config/gws/client_secret.json`.
3. Run `npm run connect -- google` and complete Google's sign-in window.

Boardroom can search Drive, read file metadata, read Google documents and spreadsheet ranges, search/read Gmail, and save requested email drafts. Sending, deleting and editing cloud documents are not exposed in this minimal adapter. Gmail compose consent technically grants broader permissions than drafts alone; Boardroom's fixed command wrapper only exposes draft creation.

Uses pinned `@googleworkspace/cli` 0.22.5 from the Google Workspace organization. Its repository states this is not an officially supported Google product. The removed `gws mcp` command is not used. Official remote Workspace MCP currently requires preview access, so this installation uses a fixed CLI adapter. [CLI and auth instructions](https://github.com/googleworkspace/cli), [Google remote MCP status](https://developers.google.com/workspace/guides/configure-mcp-servers).

## Stripe payments

Run `npm run connect -- stripe`. It opens OAuth for the official `https://mcp.stripe.com` endpoint through pinned `mcp-remote` 0.16.5. Select the intended account and mode.

The controller can inspect balances/records and prepare customers, products, prices, draft invoices or payment links when explicitly requested. It cannot send/finalize an invoice, create charges/refunds or delete financial records through this wrapper. A payment link lets a customer pay through Stripe's hosted checkout; creating a link does not itself collect money. No website hosting is required for a Stripe payment link.

Inspect `boardroom_service_tools` for current schemas before `boardroom_service_call`. The current Stripe server exposes `stripe_api_search`, `stripe_api_details`, `stripe_api_read` and a generic `stripe_api_write`. The adapter restricts generic writes to the six creation endpoints above, using supported HTTP path or official OpenAPI operation selectors; an unknown selector shape is blocked pending compatibility review. Reads and write availability depend on account consent and Stripe's current catalog. Verify existing records before retrying a write; this wrapper does not add an idempotency key to every upstream tool. [Official Stripe MCP documentation](https://docs.stripe.com/mcp), [official Stripe API specification](https://github.com/stripe/openapi).

## QuickBooks Online — prepared, account/app still required

Run `npm run connect -- quickbooks --setup`. This creates a private template at `~/.config/boardroom-connections/quickbooks.env`. It never overwrites existing credentials.

Create an Intuit app, put its client ID/secret in that file and select the environment. Sandbox uses a demo company with `http://localhost:8000/callback`; run `npm run connect -- quickbooks` to open sign-in. A real company requires production credentials, company realm ID and a refresh token obtained through an Intuit-approved HTTPS OAuth callback. The upstream production guide describes OAuth Playground for token acquisition. Signing into the bookkeeping website alone is insufficient. This installer does not host a callback server publicly or provision an account.

The official Intuit repository is pinned to commit `31a1dd5c3e170e368dbff651abbaf61aabde6ed9`. Dependency overrides update vulnerable URI decoding, XML parsing, underscore, UUID and schema validation. `scripts/prepare-connectors.mjs` adapts the patched ESM URI decoder to Intuit's CommonJS caller. Tests boot the actual upstream server and inspect its schemas; they do not authenticate a real company.

Bookkeeping is read-only through this minimal wrapper: customers, bills, invoices, reports and other read tools exposed upstream. It does not post ledger entries, pay bills or file taxes. [Official implementation and production setup](https://github.com/intuit/quickbooks-online-mcp-server).

## Xero — prepared, account/app still required

Run `npm run connect -- xero --setup`. Create a Xero PKCE app, register `http://localhost:48132/oauth/callback`, and put its client ID in `~/.config/boardroom-connections/xero-client.json`. Run `npm run connect -- xero` to sign in through the official remote MCP endpoint `https://api.xero.com/mcp/v1`.

Xero currently requires Developer Core or above for real organizations; Starter is restricted to the demo company. No subscription is purchased by setup. This wrapper exposes available read tools; it does not post ledger entries or payments. [Official Xero remote MCP requirements](https://developer.xero.com/faq).

## Credentials and activation

OAuth caches and bookkeeping templates stay outside the repository, under the user's private configuration directories. `BOARDROOM_CONNECTIONS_HOME` can override the bookkeeping/Stripe directory. Google uses its own CLI credential storage. Do not commit either directory or tokens. The bridge connects on demand only after a service is enabled; reconnect may open the provider's browser sign-in if consent expires.

Reload Harness and use a fresh chat after installing a runtime update. Connecting an account later does not require rebuilding Boardroom. Ask `/boardroom Show connection status, then read one record from my intended account.` A real successful read is the remaining acceptance check for each account.

## Visual review

A configured provider must report image input support and Harness must provide attachment storage. The router prefers model names containing flash/mini/haiku/small/lite; this is an economical heuristic, not a measured cost comparison. An optional runtime `visionRoute: {provider, model}` overrides that preference. No extra vision account is created.

Actual image content must be admitted into the worker context for both desktop and mobile. Entry and screenshot hashes are checked again before reuse/acceptance. This proves evidence delivery and freshness, not the subjective quality of the model's judgement. The rubric applies [WCAG reference criteria](https://www.w3.org/WAI/WCAG22/quickref/) and [usability heuristics](https://www.nngroup.com/articles/ten-usability-heuristics/); screenshots do not prove full accessibility compliance.
