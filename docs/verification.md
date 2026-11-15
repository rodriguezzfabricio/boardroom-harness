# Verification

1. Run `npm ci` and `npm run browser:install`.
2. Run `npm run doctor` to check the local prerequisites.
3. Run `npm test` to exercise the runtime without model credentials.

The suite checks plan coverage and dependency order, correction and recovery behavior, current decisions, stale result rejection, and the Harness tool registry. Its Chromium tests include working desktop and mobile interactions and a deliberately broken control. An offline worker result is a fixture. These tests check the runtime's behavior around it.

For live verification, run the [synthetic finance and sales mission](../examples/first-mission.md). Compare the numbers, inspect the worker reports, correct the fixed cost, and open a fresh chat to recover the mission. This uses your provider and may incur charges. Browser results apply to the declared local journeys. Product quality, conversion, and provider cost savings need separate measurements.


## Version 4.1 checks

The local suite passed 127 checks on Node 24. It covers natural-language discovery, LLC and sales-tax routing, custom installed-skill bindings, CRM persistence/isolation and stale-write rejection, fixed Google commands, draft-only email, private connector templates, the actual QuickBooks MCP server's schemas, current Stripe tool filtering, image-capable routing, real Chromium screenshots admitted through Harness attachment storage, and invalidation after screenshot or CSS changes.

An optional paid synthetic run also exercised the real foreground controller. It selected separate corporate-legal and tax-preparation workers, both loaded their complete skills and wrote artifacts, and a separate reviewer inspected the outputs. It reached review-ready in 338 seconds. This proves that delegation occurred on that fixture; it is not a benchmark of legal advice or real account integrations. Run `node scripts/live-specialists-smoke.mjs` only when you intend to use a configured paid model.

`npm run check:projects -- /path/to/first /path/to/second` verifies fresh actual Harness registries and all required skill bindings without paid inference or account access. A missing company/state/decision file is an installation error; reconcile existing business notes rather than resetting the business stage.

Google, Stripe, QuickBooks and Xero account operations remain unverified until the owner configures/signs into those services and a real read succeeds. Screenshot delivery is tested; subjective design judgement across providers is not benchmarked. No hosting, cloud backup or real money movement is tested or enabled by these checks.
