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

test("async subagent events keep state in subagents after agent_end", () => {
	const sm = new StatusStateMachine();
	sm.onAgentStart();
	sm.onAsyncSubagentStart();
	sm.onAsyncSubagentStart();
	sm.onAgentEnd();
	let snap = sm.snapshot();
	eq(snap.kind, "subagents", "still subagents after agent_end");
	eq(snap.subagents.asyncRunning, 2, "2 async running");
	eq(snap.executing, true, "executing while async in flight");
	sm.onAsyncSubagentComplete();
	sm.onAsyncSubagentComplete();
	// After async done, we transition to completed briefly
	snap = sm.snapshot();
	// Don't strictly check kind here because the decay timer is async,
	// but we should not be executing.
	eq(snap.executing, false, "not executing after async done");
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
	(sm as unknown as { state: { kind: string; currentRunTotal: number; currentRunCompleted: number; asyncRunning: number; agentRunning: boolean } }).state = {
		kind: "idle",
		currentRunTotal: 2,
		currentRunCompleted: 0,
		asyncRunning: 0,
		agentRunning: false,
	};
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

test("workflow_end transitions to completed immediately", () => {
	const sm = new StatusStateMachine();
	sm.onWorkflowStart();
	sm.onWorkflowEnd();
	const snap = sm.snapshot();
	eq(snap.kind, "completed", "kind should be completed immediately after end");
	eq(snap.subagents.workflowRunning, 0, "workflowRunning should be 0");
});

test("workflow fires during completed decay prevents decay-to-idle", () => {
	const sm = new StatusStateMachine();
	sm.onAgentStart();
	sm.onAgentEnd();
	// now in decay window (completed) with 3-second timer pending
	sm.onWorkflowStart(); // fires during decay, clears timer and switches to workflow
	const snap = sm.snapshot();
	eq(snap.kind, "workflow", "kind should switch to workflow mid-decay");
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
	sm.onAgentEnd();
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
	let snap = sm.snapshot();
	eq(snap.kind, "subagents", "asyncRunning > 0 takes priority over workflowRunning > 0");
	eq(snap.executing, true, "executing should be true");
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
