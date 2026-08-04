# AGENTS.md

> Developer guide for working on `pi-status-tab`.
> This file is for AI coding agents (and humans) who need to understand, modify, or extend the project. The user-facing overview lives in [`README.md`](./README.md).

## 1. What this project is

A [pi](https://github.com/badlogic/pi) extension that surfaces pi's run state to the host terminal tab title (and to pi's in-TUI status bar) so the user can tell at a glance whether pi is idle, working, waiting on subagents, done, or errored — even when looking at a different tab.

The reason this needs a dedicated extension (rather than a one-liner with a spinner timer) is **async subagent tracking**. With [pi-subagents](https://github.com/i-am-bee/pi-subagents) running in `async: true` mode, the main agent can hand control back to the user while background work continues. A naive `agent_start` / `agent_end` listener would report "done" during that window. This extension:

- Tracks the main agent through `agent_start` / `turn_start` / `agent_end` / `agent_settled`.
- Tracks sync subagent calls via `tool_execution_start` / `tool_execution_end` when `toolName === "subagent"`.
- Tracks async subagents via `pi.events.on("subagent:async-started" | "subagent:async-complete")` and keeps the "subagents" state active until they finish — even after `agent_settled`.

## 2. Architecture

```
            ┌────────────────────────────────────────────────────────┐
            │  pi runtime                                            │
            │                                                        │
            │  events ──► index.ts (event handlers)                  │
            │   ▲           │                                        │
            │   │           ▼                                        │
            │   │     StatusStateMachine (state.ts)                  │
            │   │           │                                        │
            │   │           ▼  snapshot                              │
            │   │     renderTitle / renderStatusBar  (title.ts)      │
            │   │           │                                        │
            │   │           ├─► ctx.ui.setTitle()  ──► terminal tab  │
            │   │           ├─► ctx.ui.setStatus() ──► TUI footer    │
            │   │           └─► OscWriter           ──► stderr OSC 2 │
            │   │                  (osc.ts)                          │
            │   │                                                    │
            │   └──── config: StatusTabConfig (config.ts)            │
            │                persisted at ~/.pi/agent/extensions/    │
            │                pi-status-tab.json                      │
            └────────────────────────────────────────────────────────┘
```

The state machine is the single source of truth. Every event mutates state; every state change triggers a re-render via the `subscribe()` listener; the renderer reads a **synthesized** `kind` from the counters (not the stored `kind`) so out-of-order or late events still display correctly.

## 3. File-by-file guide

### `src/index.ts` — extension entry

The default export is the pi extension factory. Responsibilities:

- Holds the per-session mutable state (state machine, config, current `ExtensionContext`, OSC writer, spinner timer).
- Wires every pi event (`session_start` / `session_info_changed` / `session_shutdown` / `agent_start` / `turn_start` / `agent_end` / `tool_execution_start` / `tool_execution_end`) to the right state-machine call.
- Wires `pi.events.on(SUBAGENT_ASYNC_STARTED_EVENT, ...)` and `…COMPLETE_EVENT, ...)` to async subagent calls.
- Registers the `/status-tab` command and the `showConfig(ctx)` helper used by it.
- Re-renders the title and status bar on every state change. Skips `setTitle` when the title is unchanged (keeps TUI idle CPU low). The spinner ticks force a re-render by calling `applyToTerminal()` from `setInterval`.
- Stops the spinner on disable (`applyToTerminal` early-returns and calls `stopSpinner`) and on `session_shutdown`.

**Module-level constants** worth knowing about:

- `SPINNER_FRAMES` — braille spinner characters used for the animated working icon.
- `SUBAGENT_TOOL_NAMES` — `Set<string>` of tool names treated as subagents. Default: just `"subagent"`. To track other tools, add them here.
- `SUBAGENT_ASYNC_STARTED_EVENT` / `SUBAGENT_ASYNC_COMPLETE_EVENT` — the public event names emitted by pi-subagents. Treat these as a contract; renaming them would break async tracking for every pi-subagents user.
- `STATUS_KEY` — the `setStatus` key. Don't change without also updating tests that grep for it.

**Closure state** (declared inside the factory):

| Variable         | Purpose                                                          |
| ---------------- | ---------------------------------------------------------------- |
| `stateMachine`   | `StatusStateMachine` instance — single source of truth.          |
| `config`         | Current resolved `StatusTabConfig`. Reloaded on `session_start`. |
| `spinnerTimer`   | `setInterval` handle, or `null` when not running.                |
| `spinnerFrame`   | Current frame index into `SPINNER_FRAMES`.                       |
| `currentSnapshot`| Cached `StatusSnapshot` so renderers don't re-snapshot.          |
| `currentCtx`     | The latest `ExtensionContext`, captured in `session_start`.      |
| `osc`            | `OscWriter` if `useOsc && isOscAvailable()`, else `null`.        |
| `currentTitle`   | Last title passed to `setTitle`, used to avoid redundant calls.  |
| `lastBaseTitle`  | Cached `project · session` for use on disable / shutdown.        |

The factory closes over all of these; never put per-session state at module scope.

### `src/state.ts` — the state machine

`StatusStateMachine` exposes a tiny event-style API. Each method mutates the stored state and calls `notify()`. The single public read path is `snapshot()`, which returns a value-typed `StatusSnapshot`.

States (the displayed kind, which the renderer uses):

| Kind        | When                                                         |
| ----------- | ------------------------------------------------------------ |
| `idle`      | No work in flight. Default state.                            |
| `working`   | Main agent is in an active run; no subagents in flight.     |
| `subagents` | At least one sync or async subagent is still running.       |
| `completed` | Run finished OK; held briefly before decaying to `idle`.    |
| `error`     | Run failed; held briefly before decaying to `idle`.          |

**The two-kind design.** The state machine stores an internal `kind` (drives the decay timer) and `snapshot()` **synthesizes** the displayed kind from the counters (`asyncRunning > 0 || inFlight > 0 ⇒ subagents`, `agentRunning ⇒ working`, else stored kind). This is why a stale stored `kind` cannot leak into the title — see the `snapshot synthesizes subagents kind from counters even if stored kind is idle` test in `test/smoke.test.ts`.

Mutation methods:

| Method                       | What it does                                                                                  |
| ---------------------------- | --------------------------------------------------------------------------------------------- |
| `onAgentStart()`             | Clears any decay timer; resets run counters; `kind → working`; `agentRunning = true`.        |
| `onTurnStart(turnIndex)`     | Records the turn index for display. Does not change `kind`.                                   |
| `onSubagentStart()`          | `currentRunTotal++`.                                                                         |
| `onSubagentEnd()`            | `currentRunCompleted++` (clamped to `currentRunTotal`).                                      |
| `onAgentEnd()`               | `agentRunning = false`. If async still running → `subagents` and skip decay. Else → decay to `completed`. |
| `onAgentError(message?)`     | Same as `onAgentEnd()` but records `errorMessage` and decays to `error`.                      |
| `onAsyncSubagentStart()`     | `asyncRunning++`, `asyncTotal++`. If currently in `idle`/`completed`/`error`, leave decay and switch to `subagents`. |
| `onAsyncSubagentComplete()`  | `asyncRunning--` (clamped ≥ 0). If it hits 0 and we were waiting on async, decay to `completed`. |
| `reset()`                    | Wipes everything to `INITIAL_STATE`. Called on `session_start` and `session_shutdown`.        |

**Decay timers.** `enterDecay()` schedules a `setTimeout` that transitions `completed` / `error` back to `idle`. The timer is cancelled if a new run starts or another subagent event fires. Default delays are 3 s for `completed`, 5 s for `error`. The decay handler re-checks `agentRunning` and `asyncRunning` before flipping to `idle`, so a subagent that fires during the decay window keeps the state in `subagents`.

### `src/title.ts` — formatting

Two public functions: `renderTitle(snapshot, theme, format, workingIconOverride?)` and `renderStatusBar(snapshot, theme, format, workingIconOverride?)`. Both apply a small template-substitution language: `{token}` is replaced with the token's value; missing or empty tokens collapse to the empty string (no dangling separators).

**Tokens** the title understands: `{icon}`, `{symbol}`, `{project}`, `{session}`, `{turn}`, `{progress}`. The status bar also understands `{label}` and `{detail}`.

`renderProgress(snapshot)` returns the small ` · subagents 1/3 (+2 async)` qualifier for the title, and `renderStatusDetail(snapshot)` returns the `label` + `detail` pair used by the status bar. Both are pure functions of the snapshot — easy to unit-test.

`iconFor(snapshot, theme, workingIconOverride?)` selects the state icon. The override is the spinner frame when the spinner is animating; the caller in `index.ts` supplies it.

### `src/osc.ts` — OSC escape sequence writer

`createOscWriter(stream?)` returns a tiny object with `setTitle(title)` and `isAvailable()`. By default it writes to `process.stderr` because pi's TUI captures stdout; stderr is the conventional channel for terminal control sequences.

OSC 2 (`ESC ] 2 ; <text> BEL`) sets the window/tab title. Supported by every modern terminal. The writer strips control characters (`\x00`-`\x1f`, `\x7f`) to prevent escape-sequence injection. TTY detection makes the writer a no-op when stderr is piped (e.g. `pi -p > out.log`).

Helpers:

- `detectTabCapableTerminal(env?)` — heuristic on `TERM_PROGRAM` / `TERM` for the `/status-tab` info display.
- `isOscAvailable(stream?)` — does the writer have somewhere to write?
- `createBufferedOscWriter(forceTty?)` — test double with a `.buffer` getter that returns everything written. **Note**: the getter is attached via `Object.defineProperty`, not `Object.assign`, because the latter invokes getters and copies the value (which would freeze the buffer).
- `OSC.setWindowTitle(title)` — pure function returning the escaped sequence (used by tests).

### `src/config.ts` — configuration

A single `StatusTabConfig` interface, a `DEFAULT_CONFIG` constant, and three I/O helpers: `loadConfig()`, `saveConfig(config)`, `updateConfig(patch)`. The config file is at `getAgentDir() + "/extensions/pi-status-tab.json"` (typically `~/.pi/agent/extensions/pi-status-tab.json`).

`loadConfig()` returns defaults if the file is missing, unreadable, or contains invalid JSON — never throws to the user. `updateConfig(patch)` is a shallow merge over `loadConfig()` and is what every `/status-tab <sub>` handler calls before re-rendering.

## 4. Event wiring

| Event (from `pi`)                        | Handler in `index.ts` | State-machine call |
| ---------------------------------------- | --------------------- | ------------------ |
| `session_start`                          | Resets, loads config, captures ctx. | `reset()` |
| `session_info_changed`                   | Refresh title (project / session may have changed). | — |
| `session_shutdown`                       | Stops spinner, restores base title. | `reset()` |
| `agent_start`                            | Marks run start. | `onAgentStart()` |
| `turn_start`                             | Records turn index. | `onTurnStart(turnIndex)` |
| `agent_end`                              | Inspects messages for `stopReason` of `error` / `aborted`. | `onAgentError(msg?)` or `onAgentEnd()` |
| `tool_execution_start` (subagent)        | Increments in-flight count. | `onSubagentStart()` |
| `tool_execution_end` (subagent)          | Decrements in-flight count. | `onSubagentEnd()` |
| `pi.events("subagent:async-started")`    | Increments async counter. | `onAsyncSubagentStart()` |
| `pi.events("subagent:async-complete")`   | Decrements async counter. | `onAsyncSubagentComplete()` |

Subagent tool name detection uses a `Set` (`SUBAGENT_TOOL_NAMES`) so adding new tool names is a one-line change. The async event names are hardcoded to match what pi-subagents emits — change them only in lockstep with that extension.

## 5. Extension points

### Add a new subagent tool source

If a new extension registers a tool that should also count as a "subagent" for the tab indicator:

1. Add the tool name to `SUBAGENT_TOOL_NAMES` in `src/index.ts`.
2. Add a unit test in `test/smoke.test.ts` covering the start/end bookkeeping.

The async event bus is the alternative path: any extension can emit `pi.events.emit("subagent:async-started" | "subagent:async-complete", payload)` to participate, and the title will track those counters automatically.

### Add a new title format token

1. In `src/title.ts`, add the token to the `tokens` map inside `renderTitle()` and `renderStatusBar()`.
2. Add a case to `renderProgress()` (or wherever the new value comes from) if it isn't a static value.
3. Update the docs in `README.md` and the help text inside the `/status-tab format` command (in `src/index.ts`).
4. Add a test in `test/smoke.test.ts`.

### Add a new state

1. Add the literal to the `StatusKind` union in `src/state.ts`.
2. Extend the `snapshot()` synthesis logic if the new state should be derived from counters, or store it directly and decay it via `enterDecay()`.
3. Add a case to `iconFor()` in `src/title.ts` and a case to `renderStatusDetail()`.
4. Add a new icon to `TitleTheme` and `DEFAULT_THEME`.
5. Add a test in `test/smoke.test.ts` covering every transition into and out of the new state.

### Add a new configuration flag

1. Add the field to `StatusTabConfig` in `src/config.ts`. Make it required (don't use `?`) so all default-merge paths stay correct.
2. Add a default value to `DEFAULT_CONFIG`.
3. Use it from `src/index.ts` near the other `config.*` reads.
4. Add a `/status-tab <flag> on|off` branch in the command handler if it should be runtime-toggleable.
5. Add a test in `test/smoke.test.ts` that exercises both the default and an explicit override.

## 6. Testing

Three layers:

| File                          | What it covers                                  | How to run                          |
| ----------------------------- | ----------------------------------------------- | ----------------------------------- |
| `test/smoke.test.ts`          | Pure unit tests of the state machine, formatters, OSC writer. | `npx tsx test/smoke.test.ts`        |
| `test/osc.test.ts`            | OSC writer behavior in TTY and non-TTY mode: sequence shape, accumulation, long titles. | `npx tsx test/osc.test.ts`          |
| `.github/workflows/ci.yml`    | Runs `check` + `test` on every push to `main` and on every PR. Node 22 only (matches `engines.node`). | GitHub Actions UI                  |

The `npm test` script runs both `smoke.test.ts` and `osc.test.ts` in order. The `npm run check` script runs only `tsc`. Both run in CI on Node 22.

There is **no** spawn-`pi` integration test. The earlier one that ran `pi -e ./src/index.ts -p` was removed because it required an LLM API key (pi's startup auth check fails without one) and therefore could not run in CI. The smoke tests already exercise the extension's state machine, formatters, and event wiring; the only remaining end-to-end check is a manual one — open pi with the extension loaded and watch the tab title change through a real run.

**Test style.** Both test files roll their own minimal runner (`test()`, `eq()`, `pass/fail` counters). Don't pull in a test framework just for this — the in-tree style is intentional and zero-dep. The smoke test uses `npx tsx` (no compile step); tsx is in `devDependencies`.

**Coverage expectations** when adding code:

- Any new state-machine method → a transition test (start state, call, end state, counters).
- Any new format token → a render test asserting the exact output.
- Any new OSC behavior → a buffered-writer test asserting the bytes written.
- Any new event handler → a smoke test that calls the state machine method directly (since wiring is trivial).

## 7. Build / typecheck

This project is a **pi extension**, not a published npm package. There is no `tsc` build step — pi loads `.ts` files via jiti at runtime. The only compile-time check is `npx tsc --noEmit`, which the `check` npm script wraps.

The package *is* published to npm (so users can `pi install npm:pi-status-tab`), but the published tarball contains the same `.ts` source files that live in this repo — there is no compiled JS. The `files` field in `package.json` whitelists `src/`, the two READMEs, and `CHANGELOG.md`.

If you ever want to ship pre-compiled JS (e.g. for a non-pi Node host), add a `build` script that emits to `dist/` and update `package.json#exports` and `pi.extensions`. Don't introduce this without a concrete consumer — the source-of-truth `.ts` files are part of the user-visible contract.

**Node version.** `engines.node` in `package.json` pins the minimum Node to the version that the latest `@earendil-works/pi-coding-agent` requires. Today that's `>=22.19.0`. Bump `engines.node` and `.nvmrc` together whenever you bump the `pi` dep — otherwise `npm ci` in CI will warn (or fail under `--engine-strict`).

**tsconfig notes:**

- `module: NodeNext` + `moduleResolution: NodeNext` — relative imports must use the `.ts` extension.
- `allowImportingTsExtensions: true` — required for the `.ts` imports above.
- `noUncheckedIndexedAccess: true` — array index reads return `T | undefined`. Be explicit when you index; the existing code does this with ternaries and `?.`.
- `strict: true` + `noImplicitOverride: true` — keep the code free of `any` and unsafe casts.

## 8. Debugging

Quick checks before going deeper:

```bash
# Confirm the extension loads at all.
pi -e ./src/index.ts --list-models

# Confirm config is being read/written.
cat ~/.pi/agent/extensions/pi-status-tab.json

# Watch the OSC sequence pi actually writes to the terminal.
script -q /tmp/pi.log pi -e ./src/index.ts -p "say test"
od -c /tmp/pi.log | grep -E '033   \]   2'
```

To confirm the state machine is in the state you expect, run `pi` interactively and use `/status-tab` (no arguments) — it prints the current `kind` plus a counter summary, the resolved config, the terminal-detection heuristic, and whether OSC is available.

**Common pitfalls:**

- *Title doesn't update.* Check `~/.pi/agent/extensions/pi-status-tab.json` — if `enabled: false` or `updateTitle: false`, that's why. Also confirm your terminal actually surfaces the OSC 2 (some emulators need an opt-in).
- *Spinner never animates.* `animateSpinner: false`, or the state is not `working` / `subagents` (idle / completed / error don't spin).
- *Subagent counter looks wrong.* Make sure only one extension is registering the `subagent` tool. If pi-subagents and the bundled example extension are both loaded, the counter will double.
- *Async subagents don't keep the tab in the working state.* pi-subagents isn't loaded, or `trackAsyncSubagents: false` in the config. Confirm with `pi.events.on("subagent:async-started", () => console.log("hi"))` in a temporary test extension.
- *Configuration edits don't take effect.* The config is read on `session_start`. Run `/reload` (or restart pi) after editing the JSON.

## 9. Pi internals reference

Things to know if you're touching the wiring:

- The `ExtensionAPI` and `ExtensionContext` types come from `@earendil-works/pi-coding-agent`. `pi.events` is a small pub/sub bus shared across extensions; `pi.events.on(name, handler)` returns an unsubscribe function. `pi.on(name, handler)` is the built-in lifecycle-event API.
- `ctx.ui.setTitle(title)` routes through pi's terminal interface in TUI mode and is a no-op in RPC / JSON / print modes. That's why `useOsc` exists as a fallback.
- `ctx.ui.setStatus(key, text)` registers a footer status entry. Multiple extensions share the footer; pick a stable `key` (`pi-status-tab` in this project) so `/status-tab` can address its own entry.
- `pi.getSessionName()` returns the current session name (set by `/name`); the extension re-renders on `session_info_changed` to pick it up.
- `agent_start` / `agent_end` / `agent_settled` come from the agent runner, not from any individual turn. `agent_settled` is the right hook if you only want to react to "all retries / compactions / follow-ups done", but the current code does not use it because the subagent counters already cover that ground.
- The `subagent:async-started` / `subagent:async-complete` event names are a contract with pi-subagents. They are not part of pi itself. If pi-subagents renames them, this extension must follow.

## 10. Release process

Releases are automated. Bump the version, push the tag, publish the GitHub release — the rest runs itself.

```bash
npm run check && npm test
npm version patch   # or minor / major
# update CHANGELOG.md
git push origin main --follow-tags
```

Then on GitHub: **Releases → Draft a new release → pick the new tag → Publish**. The `release.yml` workflow runs `check` + `test` and publishes via npm Trusted Publishing (OIDC) — no long-lived `NPM_TOKEN` secret.

Local fallback (GitHub down, etc.): `npm login && npm publish --provenance --access public`. The `prepublishOnly` script ensures `check` + `test` run before either path.

The Trusted Publisher is bound to this repo + `release.yml`; one-time setup details live in the workflow file's comments and the package's npmjs.com settings page.
