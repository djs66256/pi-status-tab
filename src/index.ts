/**
 * pi-status-tab
 *
 * Display pi's running state in the terminal tab title (iTerm2, Zed, etc.)
 * and the in-TUI status bar, with awareness of pi-subagents and other
 * subagent tools.
 *
 * What it shows
 * ─────────────
 *   • `π my-project`                       — ready / idle
 *   • `⏳ π my-project · turn 3`           — main agent working
 *   • `🔄 π my-project · subagents 1/3`    — subagents running
 *   • `✓ π my-project`                     — done (briefly)
 *   • `✗ π my-project`                     — error (briefly)
 *
 * How it tracks subagents
 * ───────────────────────
 *   • Sync subagent calls: detected via `tool_execution_start` / `_end`
 *     for `toolName === "subagent"`. Works for any subagent tool with
 *     that name (the example subagent extension and pi-subagents both
 *     register under this name).
 *
 *   • Async subagents (pi-subagents `async: true`): detected via the
 *     inter-extension event bus (`pi.events.on("subagent:async-started"
 *     | "subagent:async-complete")`). These continue after the main
 *     agent run has settled, and the tab stays in the "subagents" state
 *     until they finish.
 *
 * Why a dedicated extension (and not just a keybinding)
 * ─────────────────────────────────────────────────────
 *   pi is typically used in another tab; an animated tab title is the
 *   only ambient signal that works without keeping pi in focus. The
 *   extension also surfaces a short status line at the bottom of the
 *   TUI for in-app feedback.
 *
 * Commands
 * ────────
 *   /status-tab                  — show current state and config
 *   /status-tab on|off           — enable / disable updates
 *   /status-tab title on|off     — toggle tab title updates
 *   /status-tab osc on|off       — toggle direct OSC writes to stderr
 *   /status-tab status on|off    — toggle in-TUI status bar
 *   /status-tab spinner on|off   — toggle spinner animation while working
 *   /status-tab async on|off     — toggle pi-subagents async tracking
 *   /status-tab format <string>  — set custom title format
 *   /status-tab reset            — restore defaults
 */

import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_CONFIG,
	type StatusTabConfig,
	loadConfig,
	saveConfig,
	updateConfig,
} from "./config.ts";
import { createOscWriter, detectTabCapableTerminal, isOscAvailable, type OscWriter } from "./osc.ts";
import { StatusStateMachine, type StatusSnapshot } from "./state.ts";
import { DEFAULT_THEME, DEFAULT_TITLE_FORMAT, renderStatusBar, renderTitle, type TitleTheme } from "./title.ts";

/** Default working-icon spinner frames (braille, slow + smooth). */
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Names of tools we treat as "subagents" for status tracking purposes. */
const SUBAGENT_TOOL_NAMES = new Set(["subagent"]);

/** Event names emitted by pi-subagents. */
const SUBAGENT_ASYNC_STARTED_EVENT = "subagent:async-started";
const SUBAGENT_ASYNC_COMPLETE_EVENT = "subagent:async-complete";

/**
 * Note: pi-dynamic-workflows does NOT emit to pi.events.
 * The WorkflowManager is a private EventEmitter inside extensions/workflow.ts.
 * The only observable surface is tool_execution_start/end for tool name "workflow".
 * This means the "workflow" state reflects top-level tool invocations only —
 * per-agent events within a workflow run are not visible from this extension.
 */
const WORKFLOW_TOOL_NAME = "workflow";

const STATUS_KEY = "pi-status-tab";

export default function (pi: ExtensionAPI) {
	// Per-session mutable state. The factory may run in invocations that
	// never start a session, so we keep everything light and defer I/O
	// until session_start.
	const stateMachine = new StatusStateMachine();
	let config: StatusTabConfig = { ...DEFAULT_CONFIG };
	let spinnerTimer: ReturnType<typeof setInterval> | null = null;
	let spinnerFrame = 0;
	let currentSnapshot: StatusSnapshot = stateMachine.snapshot();
	let currentCtx: ExtensionContext | undefined;
	let osc: OscWriter | null = null;
	let currentTitle = "";
	let lastBaseTitle = "";

	// Re-render on every state change. We render even when the title is
	// unchanged to support spinner animation.
	stateMachine.subscribe(() => {
		currentSnapshot = stateMachine.snapshot();
		applyToTerminal();
	});

	// Re-render at spinner cadence while working/subagents. This makes
	// the animation frame rate independent of event traffic.
	function startSpinner() {
		stopSpinner();
		if (!config.animateSpinner) return;
		spinnerTimer = setInterval(() => {
			spinnerFrame = (spinnerFrame + 1) % SPINNER_FRAMES.length;
			applyToTerminal();
		}, Math.max(60, config.spinnerIntervalMs));
	}

	function stopSpinner() {
		if (spinnerTimer) {
			clearInterval(spinnerTimer);
			spinnerTimer = null;
		}
	}

	function getBaseTitle(): string {
		const project = path.basename(process.cwd()) || "pi";
		const session = config.showSessionName ? pi.getSessionName() : undefined;
		return session ? `${project} · ${session}` : project;
	}

	function getTheme(): TitleTheme {
		return {
			...DEFAULT_THEME,
			project: path.basename(process.cwd()) || "pi",
			session: config.showSessionName ? pi.getSessionName() ?? undefined : undefined,
		};
	}

	function getFormat(): typeof DEFAULT_TITLE_FORMAT {
		return {
			format: config.titleFormat || DEFAULT_TITLE_FORMAT.format,
			statusFormat: config.statusFormat || DEFAULT_TITLE_FORMAT.statusFormat,
		};
	}

	function workingIconOverride(): string | undefined {
		if (!config.animateSpinner) return undefined;
		if (
			currentSnapshot.kind !== "working" &&
			currentSnapshot.kind !== "subagents" &&
			currentSnapshot.kind !== "workflow"
		) {
			return undefined;
		}
		return SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length];
	}

	function applyToTerminal() {
		if (!config.enabled || !currentCtx) {
			stopSpinner();
			return;
		}
		const title = renderTitle(
			currentSnapshot,
			getTheme(),
			getFormat(),
			workingIconOverride(),
		);
		const status = renderStatusBar(
			currentSnapshot,
			getTheme(),
			getFormat(),
			workingIconOverride(),
		);

		// Avoid re-setting an identical title to keep TUI idle CPU low.
		if (config.updateTitle && title !== currentTitle) {
			currentTitle = title;
			try {
				currentCtx.ui.setTitle(title);
			} catch {
				// setTitle is a no-op in some modes; ignore.
			}
			if (config.useOsc && osc) osc.setTitle(title);
		}

		if (config.updateStatusBar) {
			try {
				currentCtx.ui.setStatus(STATUS_KEY, status);
			} catch {
				// setStatus is a no-op in some modes; ignore.
			}
		}

		// Spin the spinner only while we have something animatable.
		if (
			config.animateSpinner &&
			(currentSnapshot.kind === "working" ||
				currentSnapshot.kind === "subagents" ||
				currentSnapshot.kind === "workflow")
		) {
			startSpinner();
		} else {
			stopSpinner();
		}
	}

	// ───────────────────────────────────────────────────────────────
	// Lifecycle
	// ───────────────────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		currentCtx = ctx;
		// Reset state on every session_start so we never leak counters
		// across /new, /resume, or /reload.
		stateMachine.reset();
		config = loadConfig();
		osc = config.useOsc && isOscAvailable() ? createOscWriter() : null;

		const baseTitle = getBaseTitle();
		lastBaseTitle = baseTitle;

		if (config.enabled) {
			applyToTerminal();
		} else {
			// Still set the base title so the tab reads sensibly.
			try {
				ctx.ui.setTitle(baseTitle);
			} catch {
				// ignore
			}
		}
	});

	pi.on("session_info_changed", async () => {
		// The session name may have changed via /name; refresh the title.
		const base = getBaseTitle();
		if (base !== lastBaseTitle) {
			lastBaseTitle = base;
			applyToTerminal();
		}
	});

	pi.on("session_shutdown", async () => {
		stopSpinner();
		// Restore a clean idle title on shutdown so the tab doesn't
		// stay stuck on a working state.
		if (currentCtx) {
			try {
				currentCtx.ui.setTitle(lastBaseTitle);
			} catch {
				// ignore
			}
		}
		stateMachine.reset();
		currentCtx = undefined;
	});

	// ───────────────────────────────────────────────────────────────
	// Agent lifecycle
	// ───────────────────────────────────────────────────────────────

	pi.on("agent_start", async () => {
		stateMachine.onAgentStart();
	});

	pi.on("turn_start", async (event) => {
		const turnIndex = typeof event.turnIndex === "number" ? event.turnIndex : 0;
		stateMachine.onTurnStart(turnIndex);
	});

	pi.on("agent_end", async (event) => {
		// Try to detect errors from the last assistant message.
		let errorMessage: string | undefined;
		const messages = (event as { messages?: Array<{ role: string; stopReason?: string; errorMessage?: string }> })
			.messages;
		if (Array.isArray(messages)) {
			for (let i = messages.length - 1; i >= 0; i--) {
				const m = messages[i];
				if (m?.role === "assistant") {
					if (m.stopReason === "error" || m.stopReason === "aborted") {
						errorMessage = m.errorMessage ?? m.stopReason;
					}
					break;
				}
			}
		}
		if (errorMessage) {
			stateMachine.onAgentError(errorMessage);
		} else {
			stateMachine.onAgentEnd();
		}
	});

	// ───────────────────────────────────────────────────────────────
	// Subagent tracking
	// ───────────────────────────────────────────────────────────────

	pi.on("tool_execution_start", async (event) => {
		if (!config.trackSubagents) return;
		if (SUBAGENT_TOOL_NAMES.has(event.toolName)) {
			stateMachine.onSubagentStart();
		} else if (event.toolName === WORKFLOW_TOOL_NAME && config.trackWorkflows) {
			stateMachine.onWorkflowStart();
		}
	});

	pi.on("tool_execution_end", async (event) => {
		if (!config.trackSubagents) return;
		if (SUBAGENT_TOOL_NAMES.has(event.toolName)) {
			stateMachine.onSubagentEnd();
		} else if (event.toolName === WORKFLOW_TOOL_NAME && config.trackWorkflows) {
			stateMachine.onWorkflowEnd();
		}
	});

	// Async subagent events from pi-subagents (and any extension that
	// emits the same public event names). These continue past agent_settled
	// and keep the tab in the "subagents" state until everything is done.
	pi.events.on(SUBAGENT_ASYNC_STARTED_EVENT, () => {
		if (!config.trackAsyncSubagents) return;
		stateMachine.onAsyncSubagentStart();
	});
	pi.events.on(SUBAGENT_ASYNC_COMPLETE_EVENT, () => {
		if (!config.trackAsyncSubagents) return;
		stateMachine.onAsyncSubagentComplete();
	});

	// ───────────────────────────────────────────────────────────────
	// Command
	// ───────────────────────────────────────────────────────────────

	pi.registerCommand("status-tab", {
		description:
			"Configure pi-status-tab (on/off, title, osc, status, spinner, async, workflow, format, reset). Usage: /status-tab [option]",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			if (!trimmed) {
				showConfig(ctx);
				return;
			}
			const parts = trimmed.split(/\s+/);
			const sub = parts[0]?.toLowerCase();
			const arg = parts[1];

			switch (sub) {
				case "on":
				case "enable": {
					config = updateConfig({ enabled: true });
					osc = config.useOsc && isOscAvailable() ? createOscWriter() : null;
					applyToTerminal();
					ctx.ui.notify("pi-status-tab: enabled", "info");
					return;
				}
				case "off":
				case "disable": {
					config = updateConfig({ enabled: false });
					ctx.ui.setTitle(lastBaseTitle);
					ctx.ui.notify("pi-status-tab: disabled", "info");
					return;
				}
				case "title": {
					if (arg !== "on" && arg !== "off") {
						ctx.ui.notify("Usage: /status-tab title on|off", "error");
						return;
					}
					config = updateConfig({ updateTitle: arg === "on" });
					applyToTerminal();
					ctx.ui.notify(`title: ${arg}`, "info");
					return;
				}
				case "osc": {
					if (arg !== "on" && arg !== "off") {
						ctx.ui.notify("Usage: /status-tab osc on|off", "error");
						return;
					}
					const useOsc = arg === "on";
					config = updateConfig({ useOsc });
					osc = useOsc && isOscAvailable() ? createOscWriter() : null;
					if (useOsc && !isOscAvailable()) {
						ctx.ui.notify(
							"OSC requested but stderr is not a TTY; writes will be no-ops.",
							"warning",
						);
					}
					applyToTerminal();
					ctx.ui.notify(`osc: ${arg}`, "info");
					return;
				}
				case "status": {
					if (arg !== "on" && arg !== "off") {
						ctx.ui.notify("Usage: /status-tab status on|off", "error");
						return;
					}
					config = updateConfig({ updateStatusBar: arg === "on" });
					applyToTerminal();
					ctx.ui.notify(`status bar: ${arg}`, "info");
					return;
				}
				case "spinner": {
					if (arg !== "on" && arg !== "off") {
						ctx.ui.notify("Usage: /status-tab spinner on|off", "error");
						return;
					}
					config = updateConfig({ animateSpinner: arg === "on" });
					applyToTerminal();
					ctx.ui.notify(`spinner: ${arg}`, "info");
					return;
				}
				case "async": {
					if (arg !== "on" && arg !== "off") {
						ctx.ui.notify("Usage: /status-tab async on|off", "error");
						return;
					}
					config = updateConfig({ trackAsyncSubagents: arg === "on" });
					ctx.ui.notify(`async subagents: ${arg}`, "info");
					return;
				}
				case "workflow": {
					if (arg !== "on" && arg !== "off") {
						ctx.ui.notify("Usage: /status-tab workflow on|off", "error");
						return;
					}
					config = updateConfig({ trackWorkflows: arg === "on" });
					ctx.ui.notify(`workflows: ${arg}`, "info");
					return;
				}
				case "format": {
					if (!arg) {
						ctx.ui.notify(
							"Usage: /status-tab format <template>\nTokens: {icon} {symbol} {project} {session} {turn} {progress} {workflows}",
							"info",
						);
						return;
					}
					config = updateConfig({ titleFormat: trimmed.slice("format".length).trim() });
					applyToTerminal();
					ctx.ui.notify(`title format updated`, "info");
					return;
				}
				case "reset": {
					config = { ...DEFAULT_CONFIG };
					saveConfig(config);
					osc = config.useOsc && isOscAvailable() ? createOscWriter() : null;
					applyToTerminal();
					ctx.ui.notify("pi-status-tab: reset to defaults", "info");
					return;
				}
				default: {
					ctx.ui.notify(
						"Usage: /status-tab [on|off|title|osc|status|spinner|async|format|reset]",
						"error",
					);
				}
			}
		},
	});

	function showConfig(ctx: ExtensionContext) {
		const ttyInfo = detectTabCapableTerminal()
			? "tab-capable terminal detected"
			: "no tab-capable terminal detected";
		const oscInfo = isOscAvailable() ? "OSC available" : "OSC unavailable (not a TTY)";
		const lines = [
			`pi-status-tab ${config.enabled ? "enabled" : "disabled"}`,
			`title=${config.updateTitle}  status=${config.updateStatusBar}  osc=${config.useOsc} (${oscInfo})`,
		`spinner=${config.animateSpinner}  async=${config.trackAsyncSubagents}  sync=${config.trackSubagents}  workflow=${config.trackWorkflows}`,
			`format: ${config.titleFormat}`,
			ttyInfo,
			`state: ${currentSnapshot.kind}` +
				(currentSnapshot.kind === "subagents"
					? ` ${currentSnapshot.subagents.currentRunCompleted}/${currentSnapshot.subagents.currentRunTotal}` +
						(currentSnapshot.subagents.asyncRunning > 0
							? ` (+${currentSnapshot.subagents.asyncRunning} async)`
							: "")
					: ""),
		];
		ctx.ui.notify(lines.join("\n"), "info");
	}
}

// Re-export types for consumers / tests.
export type { StatusTabConfig } from "./config.ts";
export { StatusStateMachine } from "./state.ts";
export { renderTitle, renderStatusBar, DEFAULT_TITLE_FORMAT, DEFAULT_THEME } from "./title.ts";
export { createOscWriter, detectTabCapableTerminal, isOscAvailable } from "./osc.ts";
export { loadConfig, saveConfig, configPath, DEFAULT_CONFIG } from "./config.ts";
export type { StatusSnapshot } from "./state.ts";
