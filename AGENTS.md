# AGENTS.md

> Developer guide for working on `pi-status-tab`.
> This file is for AI coding agents (and humans) who need to understand, modify, or extend the project. The user-facing overview lives in [`README.md`](./README.md).

## 1. What this project is

A [pi](https://github.com/badlogic/pi) extension that surfaces pi's run state to the host terminal tab title (and to pi's in-TUI status bar) so the user can tell at a glance whether pi is idle, working, waiting on subagents, done, or errored — even when looking at a different tab.

The reason this needs a dedicated extension (rather than a one-liner with a spinner timer) is **async subagent tracking**. With [pi-subagents](https://github.com/i-am-bee/pi-subagents) running in `async: true` mode, the main agent can hand control back to the user while background work continues. A naive `agent_start` / `agent_end` listener would report "done" during that window. This extension:

- Tracks one Pi run from `agent_start` through `agent_settled`. Treat `agent_end` only as its latest low-level outcome because retry, compaction, queued work, and `agent_before_settle` continuation may follow.
- Tracks ordinary tools and sync subagents through `tool_execution_start` / `tool_execution_end`.
- Tracks blocking extension UI with `ui_prompt_start` / `ui_prompt_end`.
- Tracks async subagents via `pi.events.on("subagent:async-started" | "subagent:async-complete")`; background work may remain visible after the main run settles.

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
- Wires session, agent, settlement, prompt, and tool lifecycle events to the state machine. `agent_settled` is the main-run completion boundary; preserve that invariant when changing event wiring.
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
| `working`   | Main agent is in an active run without a higher-priority state. |
| `tool`      | An ordinary tool is running; the most recently started one is shown. |
| `waiting`   | Pi is blocked on a user-facing extension prompt.           |
| `subagents` | At least one sync or async subagent is still running.       |
| `workflow`  | At least one workflow invocation (from pi-dynamic-workflows) is running. |
| `completed` | Run finished OK; held briefly before decaying to `idle`.    |
| `error`     | Run failed; held briefly before decaying to `idle`.          |

**Stored outcome vs synthesized display.** The stored `kind` owns settled completion/error decay. `snapshot()` synthesizes the live display with this priority: `waiting > subagents > workflow > tool > working > settled kind`. Preserve this ordering so a blocking prompt or active work cannot be hidden by a stale result.

Mutation methods:

| Method                       | What it does                                                                                  |
| ---------------------------- | --------------------------------------------------------------------------------------------- |
| `onAgentStart()`             | Clears any decay timer; resets run counters; `kind → working`; `agentRunning = true`.        |
| `onTurnStart(turnIndex)`     | Records the turn index for display. Does not change `kind`.                                   |
| `onSubagentStart()`          | `currentRunTotal++`.                                                                         |
| `onSubagentEnd()`            | `currentRunCompleted++` (clamped to `currentRunTotal`).                                      |
| `onAgentEnd(outcome, error?)` | Records the latest low-level result while the Pi run remains active. |
| `onAgentSettled(aborted)`    | Ends the main run and shows completed/error, or idle for cancellation. Background work still takes rendering priority. |
| `onToolStart/End(name)`      | Tracks ordinary tools so the current tool name can be rendered. |
| `onPromptStart/End(kind)`    | Tracks nested blocking prompts; waiting has highest rendering priority. |
| `onAsyncSubagentStart/Complete()` | Maintains background async counters, including work after main-run settlement. |
| `reset()`                    | Wipes everything to `INITIAL_STATE`. Called on `session_start` and `session_shutdown`.        |

**Decay timers.** `enterDecay()` uses `completedDurationMs` / `errorDurationMs` from `StatusTabConfig`. New activity cancels decay. The callback re-checks the synthesized executing state before returning to idle.

### `src/title.ts` — formatting

Two public functions: `renderTitle(snapshot, theme, format, workingIconOverride?)` and `renderStatusBar(snapshot, theme, format, workingIconOverride?)`. Both apply a small template-substitution language: `{token}` is replaced with the token's value; missing or empty tokens collapse to the empty string (no dangling separators).

**Tokens** the title understands: `{icon}`, `{symbol}`, `{project}`, `{session}`, `{turn}`, `{progress}`. The status bar also understands `{label}` and `{detail}`.

`renderProgress(snapshot)` returns the tool, prompt, turn, or subagent qualifier for the title. `renderStatusDetail(snapshot)` returns the `label` + `detail` pair used by the status bar. Both are pure functions of the snapshot.

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
| `agent_end`                              | Records the latest assistant outcome without claiming completion. | `onAgentEnd(outcome, error?)` |
| `agent_settled`                          | Final boundary after retry/recovery/continuation. | `onAgentSettled(aborted)` |
| `ui_prompt_start` / `ui_prompt_end`      | Tracks user-blocking extension UI. | `onPromptStart/End(kind)` |
| `tool_execution_start` (ordinary)        | Displays the active tool name. | `onToolStart(name)` |
| `tool_execution_start` (subagent)        | Increments in-flight count. | `onSubagentStart()` |
| `tool_execution_start` (`"workflow"`) | `src/index.ts` | `onWorkflowStart()` |
| `tool_execution_end` (`"workflow"`)   | `src/index.ts` | `onWorkflowEnd()` |
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

### Track a new tool as a workflow-class execution

`pi-dynamic-workflows` registers the `"workflow"` tool. Because its `WorkflowManager` is a private EventEmitter (not wired to `pi.events`), the only observable surface is `tool_execution_start` / `tool_execution_end`. To add another tool as a workflow-class tracker:

1. Add the tool name to `WORKFLOW_TOOL_NAME` (or make it a `Set<string>` if you need multiple).
2. Add an `else if` branch in the `tool_execution_start` / `tool_execution_end` handler in `src/index.ts`, mirroring the `"workflow"` branch exactly.
3. The state machine methods (`onWorkflowStart` / `onWorkflowEnd`) and counters are shared — no per-tool state needed. All workflow-class tools increment the same `workflowRunning` / `workflowTotal` counters.
4. Add a test in `test/smoke.test.ts` covering the tool name match and the start/end bookkeeping.

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
| `test/smoke.test.ts`          | State machine, formatters, and extension-event wiring with a mock Pi API. | `npx tsx test/smoke.test.ts`        |
| `test/osc.test.ts`            | OSC writer behavior in TTY and non-TTY mode: sequence shape, accumulation, long titles. | `npx tsx test/osc.test.ts`          |
| `.github/workflows/ci.yml`    | Runs `check` + `test` on every push to `main` and on every PR. Node 22 only (matches `engines.node`). | GitHub Actions UI                  |

The `npm test` script runs both `smoke.test.ts` and `osc.test.ts` in order. The `npm run check` script runs only `tsc`. Both run in CI on Node 22.

There is **no** spawn-`pi` integration test. The earlier one that ran `pi -e ./src/index.ts -p` was removed because it required an LLM API key (pi's startup auth check fails without one) and therefore could not run in CI. The smoke tests already exercise the extension's state machine, formatters, and event wiring; the only remaining end-to-end check is a manual one — open pi with the extension loaded and watch the tab title change through a real run.

**Test style.** Both test files roll their own minimal runner (`test()`, `eq()`, `pass/fail` counters). Don't pull in a test framework just for this — the in-tree style is intentional and zero-dep. The smoke test uses `npx tsx` (no compile step); tsx is in `devDependencies`.

**Coverage expectations** when adding code:

- Any new state-machine method → a transition test (start state, call, end state, counters).
- Any new format token → a render test asserting the exact output.
- Any new OSC behavior → a buffered-writer test asserting the bytes written.
- Any new lifecycle event handler → a state-machine transition test plus an extension-wiring assertion when missing the handler would change user-visible state.

## 7. Build / typecheck

This project is a **pi extension**, not a published npm package. There is no `tsc` build step — pi loads `.ts` files via jiti at runtime. The only compile-time check is `npx tsc --noEmit`, which the `check` npm script wraps.

The package *is* published to npm (so users can `pi install npm:pi-status-tab`), but the published tarball contains the same `.ts` source files that live in this repo — there is no compiled JS. The `files` field in `package.json` whitelists `src/`, the two READMEs, and `CHANGELOG.md`.

If you ever want to ship pre-compiled JS (e.g. for a non-pi Node host), add a `build` script that emits to `dist/` and update `package.json#exports` and `pi.extensions`. Don't introduce this without a concrete consumer — the source-of-truth `.ts` files are part of the user-visible contract.

**Host dependency.** Keep `@earendil-works/pi-coding-agent` in `peerDependencies`; Pi supplies it at runtime. Pin the minimum qualified Pi version in `devDependencies` for types and tests. Moving it to `dependencies` installs a duplicate host runtime. Raise the peer minimum only after typecheck plus startup/runtime verification on that exact version.

**Node version.** `engines.node` in `package.json` pins the minimum Node to the version that the qualified Pi development dependency requires. Today that's `>=22.19.0`. Bump `engines.node` and `.nvmrc` together when that minimum moves.

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
- *Spinner never animates.* `animateSpinner: false`, or the state is not `working`, `subagents`, or `workflow`. Tool and waiting states use fixed icons.
- *Subagent counter looks wrong.* Make sure only one extension is registering the `subagent` tool. If pi-subagents and the bundled example extension are both loaded, the counter will double.
- *Async subagents don't keep the tab in the working state.* pi-subagents isn't loaded, or `trackAsyncSubagents: false` in the config. Confirm with `pi.events.on("subagent:async-started", () => console.log("hi"))` in a temporary test extension.
- *Configuration edits don't take effect.* The config is read on `session_start`. Run `/reload` (or restart pi) after editing the JSON.

## 9. Pi internals reference

Things to know if you're touching the wiring:

- The `ExtensionAPI` and `ExtensionContext` types come from `@earendil-works/pi-coding-agent`. `pi.events` is a small pub/sub bus shared across extensions; `pi.events.on(name, handler)` returns an unsubscribe function. `pi.on(name, handler)` is the built-in lifecycle-event API.
- `ctx.ui.setTitle(title)` routes through pi's terminal interface in TUI mode and is a no-op in RPC / JSON / print modes. That's why `useOsc` exists as a fallback.
- `ctx.ui.setStatus(key, text)` registers a footer status entry. Multiple extensions share the footer; pick a stable `key` (`pi-status-tab` in this project) so `/status-tab` can address its own entry.
- `pi.getSessionName()` returns the current session name (set by `/name`); the extension re-renders on `session_info_changed` to pick it up.
- `agent_start` / `agent_end` / `agent_settled` come from the agent runner, not from an individual turn. `agent_end` closes one low-level agent run. Only `agent_settled` means retries, recovery, compaction, queued work, and boundary continuations are exhausted.
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
