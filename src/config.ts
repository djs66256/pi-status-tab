/**
 * Configuration for pi-status-tab.
 *
 * Settings are read from a JSON file at the user config directory and
 * overridable per-invocation. The settings file is the same one
 * `~/.pi/agent/settings.json` may reference; we keep our own file to avoid
 * stepping on the user's general settings.
 *
 * File location: <getAgentDir()>/extensions/pi-status-tab.json
 *
 * (Falls back to the global config dir if the helper is not available.)
 */

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";

export interface StatusTabConfig {
	/** Master switch. */
	enabled: boolean;
	/** Whether to update the terminal tab title (via setTitle + optional OSC). */
	updateTitle: boolean;
	/** Whether to write OSC escape sequences directly to stderr. */
	useOsc: boolean;
	/** Whether to update the in-TUI status bar. */
	updateStatusBar: boolean;
	/** Whether to track subagent tool calls (synchronous). */
	trackSubagents: boolean;
	/** Whether to track async subagents via pi.events (requires pi-subagents). */
	trackAsyncSubagents: boolean;
	/** Whether to animate the working icon with a spinner. */
	animateSpinner: boolean;
	/** Spinner animation interval in milliseconds. */
	spinnerIntervalMs: number;
	/** How long to display the "completed" state before fading to idle. */
	completedDurationMs: number;
	/** How long to display the "error" state before fading to idle. */
	errorDurationMs: number;
	/** Custom title format (see DEFAULT_TITLE_FORMAT in title.ts). */
	titleFormat: string;
	/** Custom status-bar format. */
	statusFormat: string;
	/** Optional session name override shown after the project. */
	showSessionName: boolean;
}

export const DEFAULT_CONFIG: StatusTabConfig = {
	enabled: true,
	updateTitle: true,
	useOsc: false,
	updateStatusBar: true,
	trackSubagents: true,
	trackAsyncSubagents: true,
	animateSpinner: true,
	spinnerIntervalMs: 120,
	completedDurationMs: 3000,
	errorDurationMs: 5000,
	titleFormat: "{icon} {symbol} {project}{session}{progress}",
	statusFormat: "{icon} {label}{detail}",
	showSessionName: true,
};

export const CONFIG_FILENAME = "pi-status-tab.json";

/** Resolve the config file path under the user agent dir. */
export function configPath(): string {
	return path.join(getAgentDir(), "extensions", CONFIG_FILENAME);
}

export function loadConfig(): StatusTabConfig {
	const file = configPath();
	if (!fs.existsSync(file)) return { ...DEFAULT_CONFIG };
	try {
		const raw = fs.readFileSync(file, "utf8");
		const parsed = JSON.parse(raw) as Partial<StatusTabConfig>;
		return { ...DEFAULT_CONFIG, ...parsed };
	} catch {
		// Corrupt or unreadable config: fall back to defaults.
		return { ...DEFAULT_CONFIG };
	}
}

export function saveConfig(config: StatusTabConfig): void {
	const file = configPath();
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\n", "utf8");
}

export function updateConfig(patch: Partial<StatusTabConfig>): StatusTabConfig {
	const next = { ...loadConfig(), ...patch };
	saveConfig(next);
	return next;
}
