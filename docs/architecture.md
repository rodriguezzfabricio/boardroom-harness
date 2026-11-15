# Architecture

The controller is a Harness skill. The runtime mounts tools when a chat is created at a configured project root. `plugin.mjs` owns the host integration, and `connections.mjs` loads assigned skills and exposes evidence and references to workers.

| Area | Implementation |
| --- | --- |
| Routing and planning | `recipes.mjs` provides intent hints and common templates. `capabilities.mjs` validates the plan, outcome coverage, dependencies, write ownership, and final review. |
| Mission lifecycle | `missions.mjs` exposes the tools. `mission-engine.mjs` starts ready tasks, bounds attempts, and fences late results using the mission revision. |
| State and decisions | `mission-store.mjs` stores revisions and work in SQLite. `mission-memory.mjs` handles current and superseded decisions. `authority.mjs` checks the relevant user message for acceptance. |
| Evidence | `evidence.mjs` saves retrieved text and provenance. Reviewers can inspect source passages and full worker reports. A saved source is evidence of what was retrieved. |
| Local delivery | `workspace.mjs` manages scoped files, content hashes, and browser checks. The reviewed page must match an implementation artifact before functional verification counts. |

## Routing and bounds

Simple calculations use deterministic tools. With the official DeepSeek provider, routine workers use `deepseek-flash` with low reasoning and complex workers use `deepseek-v4-pro` with high reasoning. Other providers inherit the parent route subject to runtime limits. The controller's foreground model is configured in Harness.

The mission default is two concurrent workers and twelve child attempts. The runtime caps a mission at 24 attempts, a task at three attempts, and a worker at twelve model requests. Time budgets are four minutes per worker, fifteen minutes per background execution, and one minute per browser check. Provider requests already in flight can take longer to stop. These are execution limits. Dollar charges depend on the provider and usage.

## Persistence and permissions

The authoritative store lives under `.agents/skills/boardroom/.runtime/missions-v4/` in the project. JSON exports, source evidence, reports, and website files are stored alongside the database. On restart, the runtime can reuse compatible task results. Changes to decisions, evidence, skills, workspace content, or runtime fingerprints can invalidate results.

The runtime restricts its worker tools. Native shell commands also rely on Harness's configured execution policy. Use a project directory suitable for that policy and for the data you send to your chosen provider. A website implementation runs in a separate mission workspace, and the browser check serves that workspace over loopback. The lead can integrate inspected changes into your project when requested.

A review-ready mission has completed its required work and review. When you explicitly accept the result, the runtime checks that the presented artifacts still match. Record a standing decision separately when you want future work to follow it.
