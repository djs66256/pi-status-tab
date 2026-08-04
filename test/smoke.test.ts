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
