# Changelog

All notable changes to `pi-status-tab` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
