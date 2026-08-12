/**
 * Title and status-bar formatting.
 *
 * Renders a status snapshot into:
 *   - A terminal title (set via ctx.ui.setTitle or direct OSC write).
 *   - A short status-bar line (set via ctx.ui.setStatus).
 *
 * The title is kept compact to fit in tabs; the status bar can show more detail.
 */

import type { StatusSnapshot } from "./state.ts";

export interface TitleTheme {
	/** Symbol used for pi (e.g. "π"). */
	appSymbol: string;
	/** Icon shown when the agent is idle. */
	idleIcon: string;
	/** Icon shown while the main agent is working (animated by caller). */
	workingIcon: string;
	/** Icon shown while subagents are running. */
	subagentsIcon: string;
	/** Icon shown while a workflow is running. */
	workflowIcon: string;
	/** Icon shown briefly after successful completion. */
	completedIcon: string;
	/** Icon shown briefly after an error. */
	errorIcon: string;
	/** Project display name (typically the cwd basename). */
	project: string;
	/** Optional session display name. */
	session?: string;
}

export interface TitleFormat {
	/** Title template. Tokens: {icon} {symbol} {project} {session} {turn} {progress} */
	format: string;
	/** Format for the in-TUI status-bar line. */
	statusFormat: string;
}

export const DEFAULT_TITLE_FORMAT: TitleFormat = {
	// Examples:
	//   "π my-project"
	//   "⏳ π my-project  ·  turn 3"
	//   "🔄 π my-project  ·  subagents 2/4 (1 async)"
	//   "✓ π my-project"
	//   "✗ π my-project"
	format: "{icon} {symbol} {project}{session}{progress}",
	// Examples (slightly more detail, used in the footer status bar):
	//   "● working · turn 3"
	//   "● 2/3 subagents · turn 4"
	//   "✓ done · 3 subagents ran"
	statusFormat: "{icon} {label}{detail}",
};

export const DEFAULT_THEME: TitleTheme = {
	appSymbol: "π",
	idleIcon: "",
	workingIcon: "⏳",
	subagentsIcon: "🔄",
	workflowIcon: "⚙",
	completedIcon: "✓",
	errorIcon: "✗",
	project: "pi",
};

export function renderTitle(
	snapshot: StatusSnapshot,
	theme: TitleTheme,
	format: TitleFormat = DEFAULT_TITLE_FORMAT,
	/** Optional override for the working icon (e.g. animated frame). Defaults to theme.workingIcon. */
	workingIconOverride?: string,
): string {
	const progress = renderProgress(snapshot);
	const session = theme.session ? ` · ${theme.session}` : "";
	const tokens: Record<string, string> = {
		icon: iconFor(snapshot, theme, workingIconOverride),
		symbol: theme.appSymbol,
		project: theme.project,
		session,
		progress,
		turn: snapshot.turnIndex > 0 ? ` · turn ${snapshot.turnIndex}` : "",
		workflows:
			snapshot.subagents.workflowRunning > 0
				? ` · ${snapshot.subagents.workflowRunning} workflow${snapshot.subagents.workflowRunning === 1 ? "" : "s"} running`
				: snapshot.subagents.workflowTotal > 0
				  ? ` · ${snapshot.subagents.workflowTotal} workflow${snapshot.subagents.workflowTotal === 1 ? "" : "s"} completed`
				  : "",
	};
	return applyFormat(format.format, tokens).trim();
}

export function renderStatusBar(
	snapshot: StatusSnapshot,
	theme: TitleTheme,
	format: TitleFormat = DEFAULT_TITLE_FORMAT,
	workingIconOverride?: string,
): string {
	const { label, detail } = renderStatusDetail(snapshot);
	const tokens: Record<string, string> = {
		icon: iconFor(snapshot, theme, workingIconOverride),
		symbol: theme.appSymbol,
		project: theme.project,
		session: "",
		progress: "",
		turn: "",
		label,
		detail,
		workflows:
			snapshot.subagents.workflowRunning > 0
				? ` · ${snapshot.subagents.workflowRunning} workflow${snapshot.subagents.workflowRunning === 1 ? "" : "s"} running`
				: snapshot.subagents.workflowTotal > 0
				  ? ` · ${snapshot.subagents.workflowTotal} workflow${snapshot.subagents.workflowTotal === 1 ? "" : "s"} completed`
				  : "",
	};
	return applyFormat(format.statusFormat, tokens).trim();
}

function renderProgress(snapshot: StatusSnapshot): string {
	const { currentRunTotal, currentRunCompleted, asyncRunning } = snapshot.subagents;
	if (snapshot.kind === "subagents") {
		const inFlight = currentRunTotal - currentRunCompleted;
		const parts: string[] = [];
		if (inFlight > 0 || currentRunTotal > 0) {
			parts.push(`subagents ${currentRunCompleted}/${currentRunTotal}`);
		}
		if (asyncRunning > 0) {
			parts.push(`${asyncRunning} async`);
		}
		return parts.length > 0 ? ` · ${parts.join(" · ")}` : "";
	}
	if (snapshot.kind === "working" && snapshot.turnIndex > 0) {
		return ` · turn ${snapshot.turnIndex}`;
	}
	if (snapshot.kind === "completed" && currentRunTotal > 0) {
		return ` · ${currentRunTotal} subagent${currentRunTotal === 1 ? "" : "s"}`;
	}
	return "";
}

function renderStatusDetail(snapshot: StatusSnapshot): { label: string; detail: string } {
	switch (snapshot.kind) {
		case "idle":
			return { label: "ready", detail: "" };
		case "working":
			return {
				label: "working",
				detail: snapshot.turnIndex > 0 ? ` · turn ${snapshot.turnIndex}` : "",
			};
		case "subagents": {
			const { currentRunTotal, currentRunCompleted, asyncRunning } = snapshot.subagents;
			const inFlight = currentRunTotal - currentRunCompleted;
			const parts: string[] = [];
			if (inFlight > 0) parts.push(`${inFlight} subagent${inFlight === 1 ? "" : "s"} running`);
			if (currentRunTotal > 0 && inFlight === 0) {
				parts.push(`subagents ${currentRunCompleted}/${currentRunTotal}`);
			}
			if (asyncRunning > 0) parts.push(`${asyncRunning} async`);
			return { label: "subagents", detail: parts.length > 0 ? ` · ${parts.join(" · ")}` : "" };
		}
		case "workflow": {
			const { workflowRunning, workflowTotal } = snapshot.subagents;
			return {
				label: "workflow",
				detail:
					workflowRunning > 0
						? ` · ${workflowRunning} running`
						: ` · ${workflowTotal} completed`,
			};
		}
		case "completed": {
			const { currentRunTotal, asyncTotal } = snapshot.subagents;
			const parts: string[] = [];
			if (currentRunTotal > 0) parts.push(`${currentRunTotal} subagent${currentRunTotal === 1 ? "" : "s"} ran`);
			if (asyncTotal > 0) parts.push(`${asyncTotal} async total`);
			return { label: "done", detail: parts.length > 0 ? ` · ${parts.join(" · ")}` : "" };
		}
		case "error":
			return { label: "error", detail: snapshot.errorMessage ? ` · ${snapshot.errorMessage}` : "" };
	}
}

function iconFor(
	snapshot: StatusSnapshot,
	theme: TitleTheme,
	workingIconOverride?: string,
): string {
	switch (snapshot.kind) {
		case "idle":
			return theme.idleIcon;
		case "working":
			return workingIconOverride ?? theme.workingIcon;
		case "subagents":
			return theme.subagentsIcon;
		case "workflow":
			return workingIconOverride ?? theme.workflowIcon;
		case "completed":
			return theme.completedIcon;
		case "error":
			return theme.errorIcon;
	}
}

function applyFormat(template: string, tokens: Record<string, string>): string {
	return template.replace(/\{(\w+)\}/g, (match, key: string) => {
		const value = tokens[key];
		return value === undefined || value === "" ? "" : value;
	});
}
