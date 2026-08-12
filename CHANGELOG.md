# Changelog

All notable changes to `pi-status-tab` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-08-12

### Added

- New `workflow` state kind that surfaces runs of the `workflow` tool registered by [`@quintinshaw/pi-dynamic-workflows`](https://www.npmjs.com/package/@quintinshaw/pi-dynamic-workflows). While a workflow is executing the tab title shows `⚙ π <project> · N workflows running` and the in-TUI status bar shows `workflow · N running`.
  - The state machine gets two new counters, `workflowRunning` and `workflowTotal`, parallel to the existing `asyncRunning` / `asyncTotal` pattern. The decay-guard logic in `enterDecay()` checks `workflowRunning === 0` so a workflow that fires during the 3 s / 5 s decay window keeps the tab in the `workflow` state instead of flipping to `idle`.
  - Synthesis order: `async/inFlight` wins over `workflowRunning` wins over `agentRunning` — the "most in-flight work" signal wins the title.
  - New theme icon `workflowIcon` (default `⚙` U+2699 GEAR).
  - New format token `{workflows}` showing `· N workflow(s) running` (active) or `· N workflow(s) completed` (all done, in the brief completed window).
- New config flag `trackWorkflows` (default `true`). Set it to `false` to opt out without disabling the rest of the extension. Toggle at runtime with `/status-tab workflow on|off`.
- 15 new smoke tests covering state-machine transitions (`onWorkflowStart` / `onWorkflowEnd`), the decay guard during a workflow fire, the synthesis priority order, render output for the gear icon and `{workflows}` token, and singular/plural formatting.

### Documentation

- `README.md` documents the new `⚙` state, the `{workflows}` format token, the `/status-tab workflow on|off` command, and a feature bullet pointing at `trackWorkflows`.
- `AGENTS.md` adds a "Track a new tool as a workflow-class execution" extension point and a new event-wiring row in §4.

### Known limitation

- pi-dynamic-workflows does not emit on `pi.events` — its `WorkflowManager` is a private `Node.js EventEmitter` inside `extensions/workflow.ts`. The only observable surface for an external extension is the standard pi `tool_execution_start` / `tool_execution_end` events for tool name `workflow`. This means the `workflow` state reflects **top-level tool invocations only**; per-phase and per-agent events within a workflow run are not visible. A future upstream change to emit on `pi.events` would enable full tracking.

## [0.1.5] - 2026-08-04

### Fixed

- Add the `repository` field to `package.json` (and `bugs` + `homepage` while at it). npm's OIDC provenance verification requires the `repository.url` in the published `package.json` to match the GitHub repo URL; without it, the release workflow's `npm publish` step fails with `E422 "repository.url is '', expected to match ... from provenance"`.
- Withdraw the `v0.1.4` tag and GitHub release (never published to npm) and ship the same changes as `v0.1.5`. Treat `0.1.5` as the first successful release of the GitHub Actions workflow.

## [0.1.4] - 2026-08-04

> **Note on versioning.** The `v0.1.3` tag was cut and the release workflow
> ran, but the publish step never completed — the workflow shipped an
> LLM-dependent integration test that couldn't run in CI. The tag and
> GitHub release were withdrawn before any `0.1.3` artifact was published
> to npm. The changes that were intended for `0.1.3` ship here as `0.1.4`,
> along with the test fix. If you are tracking this repo, treat `0.1.4`
> as the first release of the GitHub Actions workflow.

### Added

- GitHub Actions CI workflow (`.github/workflows/ci.yml`): runs `check` + `test` on every push to `main` and on every PR, on Node 22.
- GitHub Actions release workflow (`.github/workflows/release.yml`): on `release: published`, runs the same checks and then `npm publish --provenance --access public` using **npm Trusted Publishing** (OIDC) — no long-lived `NPM_TOKEN` secret to rotate. Needs `id-token: write` for the OIDC exchange and the package must have a GitHub Actions Trusted Publisher configured on npmjs.com pointing at `release.yml`.
- `prepublishOnly` npm script (`npm run check && npm test`) as a local safety net for manual `npm publish`.
- `.nvmrc` pinning Node 22 to keep local dev and CI in sync.

### Changed

- Bump `engines.node` from `>=20` to `>=22.19.0` to match the latest `@earendil-works/pi-coding-agent`.

### Documentation

- `AGENTS.md` §6 lists the CI workflow alongside the existing test layers and explains why there is no spawn-`pi` integration test.
- `AGENTS.md` §7 documents the Node-version coupling between this package and `pi`.
- `AGENTS.md` §10 rewritten as a "Release process" walkthrough covering the GitHub workflow setup, the npm Trusted Publisher configuration, the `prepublishOnly` fallback, and a TL;DR checklist.

### Fixed

- Remove the spawn-`pi` end-to-end test that was in `test/integration.test.ts`. It required an LLM API key to satisfy pi's startup auth check and therefore could not run in CI. The file is renamed to `test/osc.test.ts` and now only covers the OSC writer (TTY mode, non-TTY, accumulation, long titles). The smoke tests still cover the extension's state machine, formatters, and event wiring.

## [0.1.2] - 2026-08-04

### Changed

- README / README.zh: lead with `pi install npm:pi-status-tab` now that the
  package is published; local-clone and `-e ./src/index.ts` are listed as
  development alternatives.
- README / README.zh: replace the hard-coded local install path with a
  generic `/path/to/pi-status-tab` placeholder.

## [0.1.1] - 2026-08-04

### Changed

- Ignore `.pi/` (project-local pi settings) so per-developer package paths
  (e.g. `".."`) stay out of version control.

## [0.1.0] - 2026-08-04

### Added

- Initial release.
- Status state machine that tracks `agent_start` / `agent_end` / `agent_settled` and the `subagent` tool lifecycle.
- Async subagent tracking via `pi.events.on("subagent:async-started" | "subagent:async-complete")` — the tab stays in the "subagents" state until async work finishes.
- Title updates via `ctx.ui.setTitle()` and optional direct OSC 2 writes to `stderr`.
- In-TUI status-bar line via `ctx.ui.setStatus()`.
- Braille spinner animation while the agent is working.
- `/status-tab` command with subcommands: `on`, `off`, `title`, `osc`, `status`, `spinner`, `async`, `format`, `reset`.
- Persistent configuration at `~/.pi/agent/extensions/pi-status-tab.json`.
- Unit and integration tests (15 cases) covering state transitions, format rendering, OSC sequences, and end-to-end loading.
