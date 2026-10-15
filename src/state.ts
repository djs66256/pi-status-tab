/**
 * Status state machine.
 *
 * The main Pi run stays active from `agent_start` until `agent_settled`.
 * `agent_end` only records the latest low-level outcome because retries,
 * compaction, queued work, or `agent_before_settle` continuation may follow.
 */

export type StatusKind =
	| "idle"
	| "working"
	| "tool"
	| "waiting"
	| "subagents"
	| "workflow"
	| "completed"
	| "error";

export type AgentOutcome = "completed" | "error" | "aborted";

export interface StatusDurations {
	completedDurationMs: number;
	errorDurationMs: number;
}

export interface SubagentProgress {
	/** Subagents started in the current low-level agent run. */
	currentRunTotal: number;
	/** Subagents that have completed in the current low-level agent run. */
	currentRunCompleted: number;
	/** Async subagents still running in the background (from pi.events). */
	asyncRunning: number;
	/** Async subagents ever started in this session. */
	asyncTotal: number;
	/** Workflow invocations currently running. */
	workflowRunning: number;
	/** Workflow invocations ever started in this session. */
	workflowTotal: number;
}

export interface StatusSnapshot {
	kind: StatusKind;
	/** Whether the main run, a tool, a prompt, or background work is active. */
	executing: boolean;
	/** Subagent and workflow progress counters. */
	subagents: SubagentProgress;
	/** Current turn index (0 when not in a run). */
	turnIndex: number;
	/** Most recently started ordinary tool that is still running. */
	toolName?: string;
	/** Innermost blocking UI prompt kind. */
	promptKind?: string;
	/** Last final error message (only populated for kind === "error"). */
	errorMessage?: string;
	/** Unix ms timestamp when the snapshot entered completed/error state. */
	decayAt?: number;
}

interface MutableState {
	kind: StatusKind;
	agentRunning: boolean;
	pendingOutcome?: AgentOutcome;
	currentRunTotal: number;
	currentRunCompleted: number;
	asyncRunning: number;
	asyncTotal: number;
	workflowRunning: number;
	workflowTotal: number;
	activeTools: string[];
	promptKinds: string[];
	turnIndex: number;
	errorMessage?: string;
	decayTimer?: ReturnType<typeof setTimeout>;
	decayAt?: number;
}

const DEFAULT_DURATIONS: StatusDurations = {
	completedDurationMs: 3000,
	errorDurationMs: 5000,
};

function validDuration(value: number | undefined, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

export class StatusStateMachine {
	private state: MutableState = this.freshState();
	private listeners = new Set<() => void>();
	private durations: StatusDurations;

	constructor(durations: Partial<StatusDurations> = {}) {
		this.durations = this.resolveDurations(durations);
	}

	/** Update persisted display durations when a session loads its configuration. */
	setDurations(durations: Partial<StatusDurations>): void {
		this.durations = this.resolveDurations(durations);
	}

	/** Subscribe to state changes. Returns an unsubscribe function. */
	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	snapshot(): StatusSnapshot {
		const subagents: SubagentProgress = {
			currentRunTotal: this.state.currentRunTotal,
			currentRunCompleted: this.state.currentRunCompleted,
			asyncRunning: this.state.asyncRunning,
			asyncTotal: this.state.asyncTotal,
			workflowRunning: this.state.workflowRunning,
			workflowTotal: this.state.workflowTotal,
		};
		const syncSubagentsRunning = this.state.currentRunTotal - this.state.currentRunCompleted;
		const executing =
			this.state.agentRunning ||
			this.state.activeTools.length > 0 ||
			this.state.promptKinds.length > 0 ||
			this.state.asyncRunning > 0 ||
			this.state.workflowRunning > 0 ||
			syncSubagentsRunning > 0;

		// Synthesis priority puts user-blocking prompts first, then specialized
		// background work, ordinary tools, the main run, and finally settled state.
		const kind: StatusKind = (() => {
			if (this.state.promptKinds.length > 0) return "waiting";
			if (this.state.asyncRunning > 0 || syncSubagentsRunning > 0) return "subagents";
			if (this.state.workflowRunning > 0) return "workflow";
			if (this.state.activeTools.length > 0) return "tool";
			if (this.state.agentRunning) return "working";
			return this.state.kind;
		})();

		return {
			kind,
			executing,
			subagents,
			turnIndex: this.state.turnIndex,
			toolName: this.state.activeTools.at(-1),
			promptKind: this.state.promptKinds.at(-1),
			errorMessage: kind === "error" ? this.state.errorMessage : undefined,
			decayAt: this.state.decayAt,
		};
	}

	onAgentStart(): void {
		this.clearDecayTimer();
		this.state.kind = "working";
		this.state.agentRunning = true;
		this.state.pendingOutcome = undefined;
		this.state.currentRunTotal = 0;
		this.state.currentRunCompleted = 0;
		this.state.activeTools = [];
		this.state.promptKinds = [];
		this.state.errorMessage = undefined;
		this.state.decayAt = undefined;
		this.notify();
	}

	onTurnStart(turnIndex: number): void {
		this.state.turnIndex = turnIndex;
		this.notify();
	}

	/** Record one low-level run outcome without claiming the whole Pi run settled. */
	onAgentEnd(outcome: AgentOutcome = "completed", errorMessage?: string): void {
		this.state.pendingOutcome = outcome;
		this.state.errorMessage = outcome === "error" ? errorMessage : undefined;
		this.state.kind = "working";
		this.notify();
	}

	/** Final boundary after retry, compaction, queued work, and continuations are exhausted. */
	onAgentSettled(aborted: boolean): void {
		this.state.agentRunning = false;
		this.state.activeTools = [];
		this.state.promptKinds = [];
		this.state.pendingOutcome = aborted ? "aborted" : (this.state.pendingOutcome ?? "completed");
		if (this.hasBackgroundWork()) {
			this.state.kind = this.kindForOutcome(this.state.pendingOutcome);
			this.notify();
			return;
		}
		this.finishSettledOutcome();
	}

	onToolStart(toolName: string): void {
		this.clearDecayTimer();
		this.state.activeTools.push(toolName);
		this.notify();
	}

	onToolEnd(toolName: string): void {
		const index = this.state.activeTools.lastIndexOf(toolName);
		if (index >= 0) this.state.activeTools.splice(index, 1);
		this.finishBackgroundActivityIfIdle();
	}

	onPromptStart(promptKind: string): void {
		this.clearDecayTimer();
		this.state.promptKinds.push(promptKind);
		this.notify();
	}

	onPromptEnd(promptKind?: string): void {
		const index = promptKind === undefined
			? this.state.promptKinds.length - 1
			: this.state.promptKinds.lastIndexOf(promptKind);
		if (index >= 0) this.state.promptKinds.splice(index, 1);
		if (this.state.promptKinds.length > 0 || this.state.agentRunning ||
			this.hasBackgroundWork() || this.state.activeTools.length > 0) {
			this.notify();
			return;
		}
		if (this.state.pendingOutcome) {
			this.finishSettledOutcome();
			return;
		}
		this.state.kind = "idle";
		this.notify();
	}

	onSubagentStart(): void {
		this.clearDecayTimer();
		this.state.currentRunTotal += 1;
		this.notify();
	}

	onSubagentEnd(): void {
		this.state.currentRunCompleted = Math.min(
			this.state.currentRunCompleted + 1,
			this.state.currentRunTotal,
		);
		this.finishBackgroundActivityIfIdle();
	}

	/** Reset to idle (e.g., on /reload or session change). */
	reset(): void {
		this.clearDecayTimer();
		this.state = this.freshState();
		this.notify();
	}

	/** Async subagent started (from pi.events on "subagent:async-started"). */
	onAsyncSubagentStart(): void {
		this.clearDecayTimer();
		this.state.asyncRunning += 1;
		this.state.asyncTotal += 1;
		this.notify();
	}

	/** Async subagent completed (from pi.events on "subagent:async-complete"). */
	onAsyncSubagentComplete(): void {
		this.state.asyncRunning = Math.max(0, this.state.asyncRunning - 1);
		this.finishBackgroundActivityIfIdle();
	}

	/** Workflow tool invocation started (tool_execution_start for "workflow"). */
	onWorkflowStart(): void {
		this.clearDecayTimer();
		this.state.workflowRunning += 1;
		this.state.workflowTotal += 1;
		this.notify();
	}

	/** Workflow tool invocation ended (tool_execution_end for "workflow"). */
	onWorkflowEnd(): void {
		this.state.workflowRunning = Math.max(0, this.state.workflowRunning - 1);
		this.finishBackgroundActivityIfIdle();
	}

	private finishBackgroundActivityIfIdle(): void {
		if (this.state.agentRunning || this.hasBackgroundWork() || this.state.activeTools.length > 0) {
			this.notify();
			return;
		}
		if (this.state.pendingOutcome) {
			this.finishSettledOutcome();
			return;
		}
		// A standalone async subagent/workflow/tool can finish without a main run.
		this.enterDecay("completed");
	}

	private finishSettledOutcome(): void {
		const outcome = this.state.pendingOutcome ?? "completed";
		if (outcome === "aborted") {
			this.clearDecayTimer();
			this.state.kind = "idle";
			this.state.errorMessage = undefined;
			this.state.decayAt = undefined;
			this.notify();
			return;
		}
		this.enterDecay(outcome);
	}

	private kindForOutcome(outcome: AgentOutcome): StatusKind {
		if (outcome === "error") return "error";
		if (outcome === "aborted") return "idle";
		return "completed";
	}

	private hasBackgroundWork(): boolean {
		return this.state.asyncRunning > 0 ||
			this.state.workflowRunning > 0 ||
			this.state.currentRunTotal > this.state.currentRunCompleted;
	}

	private enterDecay(kind: "completed" | "error"): void {
		this.clearDecayTimer();
		this.state.kind = kind;
		this.state.decayAt = Date.now();
		const delayMs = kind === "completed"
			? this.durations.completedDurationMs
			: this.durations.errorDurationMs;
		this.state.decayTimer = setTimeout(() => {
			this.state.decayTimer = undefined;
			if (!this.snapshot().executing && this.state.kind === kind) {
				this.state.kind = "idle";
				this.state.decayAt = undefined;
				this.state.errorMessage = undefined;
				this.state.pendingOutcome = undefined;
				this.notify();
			}
		}, delayMs);
		this.notify();
	}

	private clearDecayTimer(): void {
		if (this.state.decayTimer) {
			clearTimeout(this.state.decayTimer);
			this.state.decayTimer = undefined;
		}
	}

	private notify(): void {
		for (const listener of this.listeners) listener();
	}

	private freshState(): MutableState {
		return {
			kind: "idle",
			agentRunning: false,
			currentRunTotal: 0,
			currentRunCompleted: 0,
			asyncRunning: 0,
			asyncTotal: 0,
			workflowRunning: 0,
			workflowTotal: 0,
			activeTools: [],
			promptKinds: [],
			turnIndex: 0,
		};
	}

	private resolveDurations(durations: Partial<StatusDurations>): StatusDurations {
		return {
			completedDurationMs: validDuration(
				durations.completedDurationMs,
				DEFAULT_DURATIONS.completedDurationMs,
			),
			errorDurationMs: validDuration(
				durations.errorDurationMs,
				DEFAULT_DURATIONS.errorDurationMs,
			),
		};
	}
}
