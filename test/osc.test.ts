/**
 * OSC escape sequence writer tests.
 *
 * Pure unit tests for `createBufferedOscWriter`. They don't need a TTY,
 * a real terminal, or pi to be installed — the writer is exercised
 * directly against a string buffer, which is what the TUI talks to.
 *
 * Note: the earlier `pi -e ./src/index.ts -p` end-to-end test that lived
 * here was removed because it required an LLM API key to satisfy pi's
 * startup auth check, so it could not run in CI. The smoke tests already
 * cover the extension's state machine, formatters, and event wiring; the
 * real integration check is a manual one — open pi with the extension
 * loaded and watch the tab title change through a real run.
 *
 * Run with:  npx tsx test/osc.test.ts
 */

import { createBufferedOscWriter } from "../src/osc.ts";

let pass = 0;
let fail = 0;
const failures: string[] = [];

function ok(name: string, cond: boolean, detail = "") {
	if (cond) {
		pass++;
		console.log(`  ✓ ${name}`);
	} else {
		fail++;
		failures.push(`${name}: ${detail}`);
		console.log(`  ✗ ${name}${detail ? "\n    " + detail : ""}`);
	}
}

// 1. Verify the OSC writer writes the expected sequence in TTY mode.
{
	const w = createBufferedOscWriter(true);
	w.setTitle("my-project");
	ok("OSC writer emits sequence in TTY mode", w.buffer === "\x1b]2;my-project\x07", `got=${JSON.stringify(w.buffer)}`);
}

// 2. Verify the OSC writer is a no-op in non-TTY mode.
{
	const w = createBufferedOscWriter(false);
	w.setTitle("my-project");
	ok("OSC writer is no-op in non-TTY mode", w.buffer === "", `got=${JSON.stringify(w.buffer)}`);
}

// 3. Verify multiple writes accumulate.
{
	const w = createBufferedOscWriter(true);
	w.setTitle("a");
	w.setTitle("b");
	ok(
		"OSC writer accumulates writes",
		w.buffer === "\x1b]2;a\x07\x1b]2;b\x07",
		`got=${JSON.stringify(w.buffer)}`,
	);
}

// 4. Verify long titles are written verbatim (no truncation by the writer).
{
	const w = createBufferedOscWriter(true);
	const long = "x".repeat(256);
	w.setTitle(long);
	ok(
		"OSC writer preserves long titles",
		w.buffer === `\x1b]2;${long}\x07`,
		`length=${w.buffer.length}`,
	);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
	for (const f of failures) console.error("  - " + f);
	process.exit(1);
}
