/**
 * Smoke tests for pi-status-tab. Run with:
 *   npx tsx test/smoke.test.ts
 * or compile + node.
 */

import { StatusStateMachine, type StatusSnapshot } from "../src/state.ts";
import {
	DEFAULT_THEME,
	DEFAULT_TITLE_FORMAT,
	renderStatusBar,
	renderTitle,
	type TitleTheme,
} from "../src/title.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createBufferedOscWriter, OSC } from "../src/osc.ts";

const cases: Array<{ name: string; run: () => void | Promise<void> }> = [];

function test(name: string, run: () => void | Promise<void>) {
	cases.push({ name, run });
}

function eq(a: unknown, b: unknown, msg: string) {
	const aJ = JSON.stringify(a);
	const bJ = JSON.stringify(b);
	if (aJ !== bJ) {
		throw new Error(`${msg}\n  expected: ${bJ}\n  actual:   ${aJ}`);
	}
}

test("state machine starts idle and is not executing", () => {
	const sm = new StatusStateMachine();
	const snap = sm.snapshot();
	eq(snap.kind, "idle", "initial kind");
	eq(snap.executing, false, "initial executing");
	eq(snap.subagents.currentRunTotal, 0, "initial total");
});

test("agent_start -> working; subagent start -> subagents", () => {
	const sm = new StatusStateMachine();
	sm.onAgentStart();
	let snap = sm.snapshot();
	eq(snap.kind, "working", "after agent_start");
	eq(snap.executing, true, "executing after agent_start");
	sm.onSubagentStart();
	snap = sm.snapshot();
	eq(snap.kind, "subagents", "after subagent start");
	eq(snap.subagents.currentRunTotal, 1, "subagent total");
});

test("multiple parallel subagents tracked correctly", () => {
	const sm = new StatusStateMachine();
	sm.onAgentStart();
	sm.onSubagentStart();
	sm.onSubagentStart();
	sm.onSubagentStart();
	let snap = sm.snapshot();
	eq(snap.subagents.currentRunTotal, 3, "3 subagents started");
	eq(snap.subagents.currentRunCompleted, 0, "0 completed");
	sm.onSubagentEnd();
	snap = sm.snapshot();
	eq(snap.subagents.currentRunCompleted, 1, "1 completed");
	eq(snap.kind, "subagents", "still subagents while 2 left");
	sm.onSubagentEnd();
	sm.onSubagentEnd();
	snap = sm.snapshot();
	eq(snap.subagents.currentRunCompleted, 3, "all completed");
	eq(snap.kind, "working", "back to working");
});

test("agent_end records the outcome but stays working until agent_settled", () => {
	const sm = new StatusStateMachine();
	sm.onAgentStart();
	sm.onAgentEnd("completed");
	let snap = sm.snapshot();
	eq(snap.kind, "working", "agent_end is not the final settlement boundary");
	eq(snap.executing, true, "the run remains active between agent_end and agent_settled");
	sm.onAgentSettled(false);
	snap = sm.snapshot();
	eq(snap.kind, "completed", "completion is shown only after agent_settled");
	eq(snap.executing, false, "the main run is no longer executing after settlement");
	sm.reset();
});

test("retryable errors do not decay to idle before agent_settled", () => {
	const sm = new StatusStateMachine();
	sm.onAgentStart();
	sm.onAgentEnd("error", "429 rate limit");
	const snap = sm.snapshot();
	eq(snap.kind, "working", "a low-level error remains active while Pi may retry");
	eq(snap.executing, true, "retry backoff still belongs to the active run");
	sm.reset();
});

test("aborted settlement returns to idle instead of reporting an error", () => {
	const sm = new StatusStateMachine();
	sm.onAgentStart();
	sm.onAgentEnd("aborted", "User cancelled");
	sm.onAgentSettled(true);
	const snap = sm.snapshot();
	eq(snap.kind, "idle", "user cancellation is not a failed task");
	eq(snap.executing, false, "aborted runs settle fully");
});

test("async subagents stay visible after the main run settles", () => {
	const sm = new StatusStateMachine();
	sm.onAgentStart();
	sm.onAsyncSubagentStart();
	sm.onAsyncSubagentStart();
	sm.onAgentEnd("completed");
	sm.onAgentSettled(false);
	let snap = sm.snapshot();
	eq(snap.kind, "subagents", "async work outranks the settled main run");
	eq(snap.subagents.asyncRunning, 2, "2 async running");
	eq(snap.executing, true, "executing while async work is in flight");
	sm.onAsyncSubagentComplete();
	sm.onAsyncSubagentComplete();
	snap = sm.snapshot();
	eq(snap.kind, "completed", "the stored main-run outcome appears after async work ends");
	eq(snap.executing, false, "not executing after async work completes");
	sm.reset();
});

test("blocking prompts and ordinary tools have distinct states", () => {
	const sm = new StatusStateMachine();
	sm.onAgentStart();
	sm.onToolStart("bash");
	let snap = sm.snapshot();
	eq(snap.kind, "tool", "ordinary tools are visible");
	eq(snap.toolName, "bash", "the active tool name is exposed");
	sm.onPromptStart("confirm");
	snap = sm.snapshot();
	eq(snap.kind, "waiting", "a blocking prompt overrides tool activity");
	eq(snap.promptKind, "confirm", "the blocking prompt kind is exposed");
	sm.onPromptEnd();
	eq(sm.snapshot().kind, "tool", "tool state resumes after the prompt closes");
	sm.onToolEnd("bash");
	eq(sm.snapshot().kind, "working", "tool completion returns to working");
	sm.reset();
});

test("configured completion and error durations drive decay timers", () => {
	const realSetTimeout = globalThis.setTimeout;
	const realClearTimeout = globalThis.clearTimeout;
	const delays: number[] = [];
	let nextHandle = 1;
	globalThis.setTimeout = ((_handler: TimerHandler, timeout?: number) => {
		delays.push(timeout ?? 0);
		return nextHandle++ as unknown as ReturnType<typeof setTimeout>;
	}) as typeof setTimeout;
	globalThis.clearTimeout = (() => undefined) as typeof clearTimeout;
	try {
		const sm = new StatusStateMachine({ completedDurationMs: 1234, errorDurationMs: 5678 });
		sm.onAgentStart();
		sm.onAgentEnd("completed");
		sm.onAgentSettled(false);
		sm.reset();
		sm.onAgentStart();
		sm.onAgentEnd("error", "failed");
		sm.onAgentSettled(false);
		eq(delays, [1234, 5678], "both configured durations are passed to setTimeout");
		sm.reset();
	} finally {
		globalThis.setTimeout = realSetTimeout;
		globalThis.clearTimeout = realClearTimeout;
	}
});

test("title format renders correctly for each state", () => {
	const sm = new StatusStateMachine();
	const theme: TitleTheme = { ...DEFAULT_THEME, project: "my-app" };

	const cases: Array<{ name: string; setup: () => void; expect: string }> = [
		{
			name: "idle",
			setup: () => {},
			expect: "π my-app",
		},
		{
			name: "working",
			setup: () => sm.onAgentStart(),
			expect: "⏳ π my-app",
		},
		{
			name: "subagents 1/3",
			setup: () => {
				sm.onAgentStart();
				sm.onSubagentStart();
				sm.onSubagentStart();
				sm.onSubagentStart();
				sm.onSubagentEnd();
			},
			expect: "🔄 π my-app · subagents 1/3",
		},
	];
	for (const c of cases) {
		sm.reset();
		c.setup();
		const snap = sm.snapshot();
		const out = renderTitle(snap, theme, DEFAULT_TITLE_FORMAT);
		eq(out, c.expect, `title for ${c.name}`);
	}
});

test("status bar renders working + turn", () => {
	const sm = new StatusStateMachine();
	sm.onAgentStart();
	sm.onTurnStart(3);
	const snap = sm.snapshot();
	const out = renderStatusBar(snap, DEFAULT_THEME, DEFAULT_TITLE_FORMAT);
	eq(out, "⏳ working · turn 3", "status bar with turn");
});

test("title and status bar render tool and user-wait states", () => {
	const sm = new StatusStateMachine();
	const theme: TitleTheme = { ...DEFAULT_THEME, project: "my-app" };
	sm.onAgentStart();
	sm.onToolStart("bash");
	let snap = sm.snapshot();
	eq(renderTitle(snap, theme, DEFAULT_TITLE_FORMAT), "▸ π my-app · bash", "tool title");
	eq(renderStatusBar(snap, theme, DEFAULT_TITLE_FORMAT), "▸ tool · bash", "tool status");
	sm.onPromptStart("confirm");
	snap = sm.snapshot();
	eq(renderTitle(snap, theme, DEFAULT_TITLE_FORMAT), "✋ π my-app · waiting for confirm", "wait title");
	eq(renderStatusBar(snap, theme, DEFAULT_TITLE_FORMAT), "✋ waiting · confirm", "wait status");
	sm.reset();
});

test("OSC writer produces expected escape sequence", () => {
	const writer = createBufferedOscWriter(true);
	writer.setTitle("hello world");
	eq(writer.buffer, "\x1b]2;hello world\x07", "OSC sequence");
});

test("OSC.setWindowTitle escapes control chars", () => {
	const out = OSC.setWindowTitle("a\nb\x1bc");
	eq(out, "\x1b]2;a b c\x07", "control chars escaped");
});

test("custom format with missing tokens produces no extra whitespace", () => {
	const sm = new StatusStateMachine();
	sm.onAgentStart();
	const snap = sm.snapshot();
	const theme: TitleTheme = { ...DEFAULT_THEME, project: "demo" };
	const out = renderTitle(snap, theme, {
		format: "{icon} {project}",
		statusFormat: "{icon} {label}",
	});
	eq(out, "⏳ demo", "custom format without session/progress");
});

test("subagent events fire on subscribe and unsubscribe", () => {
	const sm = new StatusStateMachine();
	let calls = 0;
	const unsub = sm.subscribe(() => calls++);
	sm.onAgentStart();
	eq(calls, 1, "subscriber called on agent_start");
	unsub();
	sm.onSubagentStart();
	eq(calls, 1, "subscriber not called after unsub");
});

test("snapshot synthesizes subagents kind from counters even if stored kind is idle", () => {
	const sm = new StatusStateMachine();
	// Simulate a state where counters are non-zero but stored kind is idle.
	// This shouldn't happen in normal flow but is a defensive check.
	(sm as unknown as { state: { kind: string } }).state.kind = "idle";
	sm.onSubagentStart();
	sm.onSubagentStart();
	const snap = sm.snapshot();
	eq(snap.kind, "subagents", "synthesized kind from counters");
	eq(snap.executing, true, "executing true while in-flight");
});

// ── workflow state machine ──────────────────────────────────────────

test("workflow_start keeps state in workflow", () => {
	const sm = new StatusStateMachine();
	sm.onWorkflowStart();
	const snap = sm.snapshot();
	eq(snap.kind, "workflow", "kind should be workflow");
	eq(snap.executing, true, "executing should be true");
	eq(snap.subagents.workflowRunning, 1, "workflowRunning should be 1");
	eq(snap.subagents.workflowTotal, 1, "workflowTotal should be 1");
});

test("standalone workflow completion enters the completed state", () => {
	const sm = new StatusStateMachine();
	sm.onWorkflowStart();
	sm.onWorkflowEnd();
	const snap = sm.snapshot();
	eq(snap.kind, "completed", "standalone workflow completion is visible");
	eq(snap.subagents.workflowRunning, 0, "workflowRunning should be 0");
	sm.reset();
});

test("workflow fires during completed decay prevents decay-to-idle", () => {
	const sm = new StatusStateMachine();
	sm.onAgentStart();
	sm.onAgentEnd("completed");
	sm.onAgentSettled(false);
	// now in decay window (completed) with a timer pending
	sm.onWorkflowStart(); // fires during decay, clears timer and switches to workflow
	const snap = sm.snapshot();
	eq(snap.kind, "workflow", "kind should switch to workflow mid-decay");
	sm.reset();
});

test("multiple workflow starts increment counter", () => {
	const sm = new StatusStateMachine();
	sm.onWorkflowStart();
	sm.onWorkflowStart();
	sm.onWorkflowStart();
	const snap = sm.snapshot();
	eq(snap.kind, "workflow", "kind should be workflow");
	eq(snap.subagents.workflowRunning, 3, "workflowRunning should be 3");
	eq(snap.subagents.workflowTotal, 3, "workflowTotal should be 3");
});

test("workflow end clamps at zero", () => {
	const sm = new StatusStateMachine();
	sm.onWorkflowEnd(); // nothing running
	const snap = sm.snapshot();
	eq(snap.subagents.workflowRunning, 0, "workflowRunning should stay 0");
	eq(snap.subagents.workflowTotal, 0, "workflowTotal should stay 0");
});

// ── render ──────────────────────────────────────────────────────────

test("renderTitle returns gear icon for workflow state", () => {
	const sm = new StatusStateMachine();
	sm.onWorkflowStart();
	const snap = sm.snapshot();
	const theme = { ...DEFAULT_THEME, workflowIcon: "⚙", project: "myproject" };
	const title = renderTitle(snap, theme, DEFAULT_TITLE_FORMAT);
	eq(title.includes("⚙"), true, "title should contain gear icon");
});

test("renderTitle {workflows} token shows running count", () => {
	const sm = new StatusStateMachine();
	sm.onWorkflowStart();
	sm.onWorkflowStart();
	const snap = sm.snapshot();
	const theme = { ...DEFAULT_THEME, project: "p" };
	const title = renderTitle(snap, theme, { format: "{workflows}", statusFormat: "" });
	eq(title.includes("2 workflows running"), true, "workflows token should show running count");
});

test("renderStatusBar returns workflow label for workflow state", () => {
	const sm = new StatusStateMachine();
	sm.onWorkflowStart();
	const snap = sm.snapshot();
	const theme = { ...DEFAULT_THEME, project: "p" };
	const bar = renderStatusBar(snap, theme, { format: "", statusFormat: "{label}" });
	eq(bar, "workflow", "status bar label should be 'workflow'");
});

test("{workflows} token is empty when no workflows have been tracked", () => {
	const sm = new StatusStateMachine();
	sm.onAgentStart();
	sm.onAgentEnd("completed");
	sm.onAgentSettled(false);
	const snap = sm.snapshot();
	eq(snap.subagents.workflowRunning, 0, "workflowRunning should be 0");
	eq(snap.subagents.workflowTotal, 0, "workflowTotal should be 0");
	const theme = { ...DEFAULT_THEME, project: "p" };
	const title = renderTitle(snap, theme, { format: "{workflows}", statusFormat: "" });
	eq(title, "", "{workflows} token should be empty when no workflows tracked");
});

test("executing is true while a workflow is running", () => {
	const sm = new StatusStateMachine();
	sm.onWorkflowStart();
	const snap = sm.snapshot();
	eq(snap.executing, true, "executing should be true during workflow");
	eq(snap.kind, "workflow", "kind should be workflow");
});

test("workflow and agent concurrent: synthesis shows workflow (workflowRunning checked before agentRunning)", () => {
	const sm = new StatusStateMachine();
	sm.onAgentStart();
	sm.onWorkflowStart();
	const snap = sm.snapshot();
	eq(snap.kind, "workflow", "kind should be workflow when both agent and workflow running");
	eq(snap.executing, true, "executing should be true");
});

test("{workflows} token shows singular '1 workflow running' and plural '2 workflows running'", () => {
	const sm = new StatusStateMachine();
	sm.onWorkflowStart();
	let snap = sm.snapshot();
	const theme = { ...DEFAULT_THEME, project: "p" };
	let title = renderTitle(snap, theme, { format: "{workflows}", statusFormat: "" });
	eq(title.includes("1 workflow running"), true, "singular form for 1 workflow");

	sm.onWorkflowStart();
	snap = sm.snapshot();
	title = renderTitle(snap, theme, { format: "{workflows}", statusFormat: "" });
	eq(title.includes("2 workflows running"), true, "plural form for 2 workflows");
});

test("status bar detail shows workflow running count", () => {
	const sm = new StatusStateMachine();
	sm.onWorkflowStart();
	sm.onWorkflowStart();
	const snap = sm.snapshot();
	const theme = { ...DEFAULT_THEME, project: "p" };
	// {workflows} token must be present in statusFormat to be rendered
	const bar = renderStatusBar(snap, theme, { format: "", statusFormat: "{label}{detail}{workflows}" });
	eq(bar.includes("workflow"), true, "label should be 'workflow'");
	eq(bar.includes("2 running"), true, "detail should show '2 running'");
});

test("workflows token shows completed count in status bar after all workflows end", () => {
	const sm = new StatusStateMachine({ completedDurationMs: 10000 });
	sm.onWorkflowStart();
	sm.onWorkflowEnd();
	sm.onWorkflowStart();
	sm.onWorkflowEnd();
	const snap = sm.snapshot();
	eq(snap.kind, "completed", "kind should be completed after all workflows end");
	const theme = { ...DEFAULT_THEME, project: "p" };
	// {workflows} is appended separately from {detail}; {detail} covers subagents/async, {workflows} covers workflows
	const bar = renderStatusBar(snap, theme, { format: "", statusFormat: "{label}{detail}{workflows}" });
	eq(bar.includes("done"), true, "label should be 'done'");
	eq(bar.includes("2 workflows completed"), true, "{workflows} token should show 2 workflows completed");
});

test("async and workflow concurrent: synthesis returns 'subagents' (async/inFlight checked before workflowRunning)", () => {
	const sm = new StatusStateMachine();
	sm.onAsyncSubagentStart();
	sm.onWorkflowStart();
	const snap = sm.snapshot();
	eq(snap.kind, "subagents", "asyncRunning > 0 takes priority over workflowRunning > 0");
	eq(snap.executing, true, "executing should be true");
});

test("extension wiring waits for agent_settled and exposes prompt/tool states", async () => {
	const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-status-tab-test-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		const extension = await import("../src/index.ts");
		const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
		const titles: string[] = [];
		const statuses: Array<string | undefined> = [];
		const pi = {
			on(name: string, handler: (event: any, ctx: any) => unknown) {
				const current = handlers.get(name) ?? [];
				current.push(handler);
				handlers.set(name, current);
			},
			events: { on() {} },
			getSessionName: () => "test session",
			registerCommand() {},
		};
		const ctx = {
			mode: "tui",
			ui: {
				setTitle: (title: string) => titles.push(title),
				setStatus: (_key: string, status: string | undefined) => statuses.push(status),
				notify() {},
			},
		};
		const fire = async (name: string, event: Record<string, unknown> = {}) => {
			for (const handler of handlers.get(name) ?? []) await handler({ type: name, ...event }, ctx);
		};
		extension.default(pi as never);
		eq(handlers.has("agent_settled"), true, "agent_settled is wired");
		eq(handlers.has("ui_prompt_start"), true, "ui_prompt_start is wired");
		eq(handlers.has("ui_prompt_end"), true, "ui_prompt_end is wired");
		await fire("session_start", { reason: "startup" });
		await fire("agent_start");
		await fire("tool_execution_start", { toolName: "bash" });
		eq(titles.at(-1)?.includes("bash"), true, "ordinary tool title is rendered");
		await fire("ui_prompt_start", { kind: "confirm" });
		eq(statuses.at(-1)?.includes("waiting"), true, "blocking prompt status is rendered");
		await fire("ui_prompt_end", { kind: "confirm" });
		await fire("tool_execution_end", { toolName: "bash" });
		await fire("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] });
		eq(titles.at(-1)?.startsWith("✓"), false, "agent_end does not claim completion");
		await fire("agent_settled", { aborted: false });
		eq(titles.at(-1)?.startsWith("✓"), true, "agent_settled shows completion");
		await fire("session_shutdown", { reason: "quit" });
		eq(statuses.at(-1), undefined, "shutdown clears the footer status");
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		fs.rmSync(agentDir, { recursive: true, force: true });
	}
});

// Minimal test runner
let pass = 0;
let fail = 0;
for (const c of cases) {
	try {
		await c.run();
		pass++;
		console.log(`  ✓ ${c.name}`);
	} catch (err) {
		fail++;
		console.error(`  ✗ ${c.name}`);
		console.error(err);
	}
}
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
