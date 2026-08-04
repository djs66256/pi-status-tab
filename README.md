# pi-status-tab

> Show pi's running state in your terminal tab — even when you're looking at another tab.

```
π my-project                       ← idle
⏳ π my-project · turn 3           ← working
🔄 π my-project · subagents 1/3    ← waiting on subagents
✓ π my-project                     ← done
✗ π my-project                     ← error
```

When pi is running in a tab you're not watching, you usually can't tell whether it's still working, waiting on subagents, or finished. `pi-status-tab` writes the current state to the tab title so the next glance tells you exactly where things stand.

The same information also shows in the in-TUI status bar at the bottom of pi.

## Features

- **Tab title** — animated braille spinner while working, icon-prefixed states for idle / working / subagents / done / error.
- **Subagent-aware** — correctly stays in the "subagents" state until *all* sync and async subagents finish, even after `agent_settled`.
- **Configurable** — pick a custom title format, toggle the spinner, switch between `setTitle()` and direct OSC 2 writes.
- **No external deps** — uses only `pi-coding-agent` and the Node standard library.

## Installation

The extension is a standard pi package. From this directory:

```bash
pi install .
```

Or install it user-wide (replace the path with wherever you keep the repo):

```bash
pi install /Users/bytedance/Documents/github/pi-status-tab
```

For quick iteration during development, point pi at the source file directly:

```bash
pi -e ./src/index.ts
```

Once installed, the next `pi` (or `/reload`) picks it up.

## Usage

It's on by default. Run a prompt in pi and watch the tab title change as the agent starts, iterates, waits on subagents, and finishes.

### Commands

```
/status-tab                  Show current state and configuration
/status-tab on|off           Enable or disable updates
/status-tab title on|off     Toggle tab title updates
/status-tab osc on|off       Toggle direct OSC writes to stderr
/status-tab status on|off    Toggle in-TUI status bar
/status-tab spinner on|off   Toggle braille spinner animation
/status-tab async on|off     Toggle pi-subagents async tracking
/status-tab format <string>  Set a custom title format
/status-tab reset            Restore all defaults
```

### Title format tokens

| Token        | Replaced with                                              |
| ------------ | ---------------------------------------------------------- |
| `{icon}`     | State icon — empty, `⏳`, `🔄`, `✓`, `✗`                  |
| `{symbol}`   | `π` (or whatever you customize it to)                      |
| `{project}`  | Project name (cwd basename)                                |
| `{session}`  | ` · <name>` when a session name is set                     |
| `{turn}`     | ` · turn N` while the agent is iterating                   |
| `{progress}` | Subagent progress, e.g. ` · subagents 1/3 (+2 async)`      |

The status-bar template additionally understands `{label}` (e.g. `working`, `done`, `error`) and `{detail}` (a short qualifier).

Example — a Claude-Code-style tab:

```
/status-tab format "{icon} {project} · {progress}"
```

## Configuration

Settings are persisted to:

```
~/.pi/agent/extensions/pi-status-tab.json
```

```json
{
  "enabled": true,
  "updateTitle": true,
  "useOsc": false,
  "updateStatusBar": true,
  "trackSubagents": true,
  "trackAsyncSubagents": true,
  "animateSpinner": true,
  "spinnerIntervalMs": 120,
  "completedDurationMs": 3000,
  "errorDurationMs": 5000,
  "titleFormat": "{icon} {symbol} {project}{session}{progress}",
  "statusFormat": "{icon} {label}{detail}",
  "showSessionName": true
}
```

Edit the file directly, or use the `/status-tab` command for the common toggles.

### `updateTitle` vs `useOsc`

- `updateTitle` (default on) calls `ctx.ui.setTitle()`. This is the recommended path — in TUI mode it routes through pi's terminal interface and the title reaches the host tab correctly.
- `useOsc` (default off) writes an OSC 2 sequence directly to `stderr`. Useful for non-TUI invocations (e.g. an RPC wrapper) where `setTitle()` is a no-op. Leave it off in normal interactive TUI sessions.

## Compatibility

- **Terminals** that respect OSC 2 (Set Window Title): iTerm2, Zed, kitty, WezTerm, Alacritty, GNOME Terminal, Windows Terminal, Ghostty, Hyper, tmux, screen, Warp, Apple Terminal, VS Code integrated terminal, …
- **Async subagent tracking** requires any extension that emits `subagent:async-started` / `subagent:async-complete` on the `pi.events` bus (such as [pi-subagents](https://github.com/i-am-bee/pi-subagents)).
- **Sync subagent tracking** matches any tool registered with the name `subagent` (case-sensitive).

## Project layout

```
src/
  index.ts      Extension entry — wires events to the state machine
  state.ts      Status state machine
  title.ts      Title and status-bar formatting
  osc.ts        OSC escape sequence writer
  config.ts     Persistent configuration
test/
  smoke.test.ts        Unit tests
  integration.test.ts  Spawns pi to verify the extension loads
```

## Contributing / development

See [`AGENTS.md`](./AGENTS.md) for the developer guide — state-machine spec, event wiring, how to add a new title token or a new subagent source, test conventions, and the pi internals you'll need to know.

## License

[MIT](./LICENSE)
