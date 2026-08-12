/**
 * Status state machine.
 *
 * Tracks pi's running state (main agent + subagents) and produces a normalized
 * status snapshot for the title/status-bar renderer.
 *
 * State transitions:
 *
 *   idle ──(agent_start)──► working
 *   working ──(subagent start)──► subagents
 *   subagents ──(subagent end & more left)──► subagents
 *   subagents ──(last subagent end)──► working
 *   working ──(agent_end + ok)──► completed
 *   working ──(agent_end + error)──► error
 *   subagents ──(all subagents done) + agent still running ─► working
 *   completed ──(decay timeout)──► idle
 *   error ──(decay timeout)──► idle
 *
 * "executing" = agent running OR any subagent running (sync or async).
 * The "completed" state only decays to "idle" if nothing is still running.
 */

export type StatusKind = "idle" | "working" | "subagents" | "workflow" | "completed" | "error";

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
	/** Whether anything is actively executing (agent or subagents). */
	executing: boolean;
	/** Subagent progress counters. */
	subagents: SubagentProgress;
	/** Current turn index (0 when not in a run). */
	turnIndex: number;
	/** Last error message (only populated for kind === "error"). */
	errorMessage?: string;
	/** Unix ms timestamp when the snapshot entered completed/error state. */
	decayAt?: number;
}

interface MutableState {
	kind: StatusKind;
	agentRunning: boolean;
	currentRunTotal: number;
	currentRunCompleted: number;
	asyncRunning: number;
	asyncTotal: number;
	workflowRunning: number;
	workflowTotal: number;
	turnIndex: number;
	errorMessage?: string;
	decayTimer?: ReturnType<typeof setTimeout>;
	decayAt?: number;
}

const INITIAL_STATE: MutableState = {
	kind: "idle",
	agentRunning: false,
	currentRunTotal: 0,
	currentRunCompleted: 0,
	asyncRunning: 0,
	asyncTotal: 0,
	workflowRunning: 0,
	workflowTotal: 0,
	turnIndex: 0,
};

export class StatusStateMachine {
	private state: MutableState = { ...INITIAL_STATE };
	private listeners = new Set<() => void>();

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
		const inFlight = this.state.currentRunTotal - this.state.currentRunCompleted;
		const executing =
			this.state.agentRunning ||
			this.state.asyncRunning > 0 ||
			this.state.workflowRunning > 0 ||
			inFlight > 0;
		// Synthesize the displayed kind from the real counters, so that
		// any combination of in-flight work overrides the stored kind.
		// The stored kind drives the decay timer; the synthesized kind
		// drives the title.
		const kind: StatusKind = (() => {
			if (this.state.asyncRunning > 0 || inFlight > 0) {
				return "subagents";
			}
			if (this.state.workflowRunning > 0) {
				return "workflow";
			}
			if (this.state.agentRunning) {
				return "working";
			}
			return this.state.kind;
		})();
		return {
			kind,
			executing,
			subagents,
			turnIndex: this.state.turnIndex,
			errorMessage: this.state.errorMessage,
			decayAt: this.state.decayAt,
		};
	}

	onAgentStart(): void {
		this.clearDecayTimer();
		this.state.kind = "working";
		this.state.agentRunning = true;
		this.state.currentRunTotal = 0;
		this.state.currentRunCompleted = 0;
		this.state.errorMessage = undefined;
		this.notify();
	}

	onTurnStart(turnIndex: number): void {
		this.state.turnIndex = turnIndex;
		this.notify();
	}

	onSubagentStart(): void {
		this.state.currentRunTotal += 1;
		this.notify();
	}

	onSubagentEnd(): void {
		this.state.currentRunCompleted = Math.min(
			this.state.currentRunCompleted + 1,
			this.state.currentRunTotal,
		);
		this.notify();
	}

	/** Agent run ended successfully. May still have async subagents in flight. */
	onAgentEnd(): void {
		this.state.agentRunning = false;
		if (this.state.asyncRunning > 0) {
			// Don't decay — still waiting for async subagents.
			this.state.kind = "subagents";
			this.notify();
			return;
		}
		this.enterDecay("completed");
	}

	/** Agent run ended with an error. */
	onAgentError(message?: string): void {
		this.state.agentRunning = false;
		this.state.errorMessage = message;
		if (this.state.asyncRunning > 0) {
			this.state.kind = "subagents";
			this.notify();
			return;
		}
		this.enterDecay("error");
	}

	/** Reset to idle (e.g., on /reload or session change). */
	reset(): void {
		this.clearDecayTimer();
		this.state = { ...INITIAL_STATE };
		this.notify();
	}

	/** Async subagent started (from pi.events on "subagent:async-started"). */
	onAsyncSubagentStart(): void {
		this.state.asyncRunning += 1;
		this.state.asyncTotal += 1;
		// If we were in a decay state, leave it and stay in subagents.
		if (this.state.kind === "completed" || this.state.kind === "error" || this.state.kind === "idle") {
			this.clearDecayTimer();
			this.state.kind = "subagents";
		}
		this.notify();
	}

	/** Async subagent completed (from pi.events on "subagent:async-complete"). */
	onAsyncSubagentComplete(): void {
		this.state.asyncRunning = Math.max(0, this.state.asyncRunning - 1);
		if (this.state.asyncRunning === 0 && !this.state.agentRunning) {
			// Nothing left running. Show completed briefly if we were waiting on async.
			if (this.state.kind === "subagents") {
				this.enterDecay("completed");
				return;
			}
		}
		this.notify();
	}

	/** Workflow tool invocation started (tool_execution_start for "workflow"). */
	onWorkflowStart(): void {
		this.state.workflowRunning += 1;
		this.state.workflowTotal += 1;
		if (
			this.state.kind === "completed" ||
			this.state.kind === "error" ||
			this.state.kind === "idle"
		) {
			this.clearDecayTimer();
			this.state.kind = "workflow";
		}
		this.notify();
	}

	/** Workflow tool invocation ended (tool_execution_end for "workflow"). */
	onWorkflowEnd(): void {
		this.state.workflowRunning = Math.max(0, this.state.workflowRunning - 1);
		if (this.state.workflowRunning === 0 && !this.state.agentRunning) {
			if (this.state.kind === "workflow") {
				this.enterDecay("completed");
				return;
			}
		}
		this.notify();
	}

	private enterDecay(kind: "completed" | "error"): void {
		this.clearDecayTimer();
		this.state.kind = kind;
		this.state.decayAt = Date.now();
		const delayMs = DECAY_MS_BY_KIND[kind];
		this.state.decayTimer = setTimeout(() => {
			this.state.decayTimer = undefined;
			// Only decay to idle if nothing else is running.
			if (
				this.state.asyncRunning === 0 &&
				this.state.workflowRunning === 0 &&
				!this.state.agentRunning
			) {
				this.state.kind = "idle";
				this.state.decayAt = undefined;
				this.state.errorMessage = undefined;
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
		for (const l of this.listeners) l();
	}
}

const DECAY_MS_BY_KIND: Record<"completed" | "error", number> = {
	completed: 3000,
	error: 5000,
};
