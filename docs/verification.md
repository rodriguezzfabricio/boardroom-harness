# Verification

1. Run `npm ci` and `npm run browser:install`.
2. Run `npm run doctor` to check the local prerequisites.
3. Run `npm test` to exercise the runtime without model credentials.

The suite checks plan coverage and dependency order, correction and recovery behavior, current decisions, stale result rejection, and the Harness tool registry. Its Chromium tests include working desktop and mobile interactions and a deliberately broken control. An offline worker result is a fixture. These tests check the runtime's behavior around it.

For live verification, run the [synthetic finance and sales mission](../examples/first-mission.md). Compare the numbers, inspect the worker reports, correct the fixed cost, and open a fresh chat to recover the mission. This uses your provider and may incur charges. Browser results apply to the declared local journeys. Product quality, conversion, and provider cost savings need separate measurements.
