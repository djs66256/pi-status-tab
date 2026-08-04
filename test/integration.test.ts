/**
 * End-to-end smoke test that:
 *   1. Spawns the extension under a fake TTY (using `script`).
 *   2. Runs `pi` in non-interactive print mode (the extension still loads
 *      and calls session_start; setTitle/OSC are best-effort no-ops in
 *      print mode, but we can at least verify there are no crashes).
 *   3. In a second scenario, uses our createBufferedOscWriter to verify
 *      the OSC sequence logic without actually spawning a TTY.
 *
 * Run with:  npx tsx test/integration.test.ts
 */

import { spawnSync } from "node:child_process";
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

// 1. Spawn pi with the extension in print mode and verify it exits cleanly.
{
	const result = spawnSync("pi", [
		"-e",
		"./src/index.ts",
		"-p",
		"echo ok",
		"--no-session",
	], {
		cwd: process.cwd(),
		encoding: "utf8",
		timeout: 60_000,
	});
	ok(
		"pi with -e ./src/index.ts -p exits 0",
		result.status === 0,
		`status=${result.status} stderr=${result.stderr.slice(0, 200)}`,
	);
}

// 2. Verify the OSC writer writes the expected sequence in TTY mode.
{
	const w = createBufferedOscWriter(true);
	w.setTitle("my-project");
	ok("OSC writer emits sequence in TTY mode", w.buffer === "\x1b]2;my-project\x07", `got=${JSON.stringify(w.buffer)}`);
}

// 3. Verify the OSC writer is a no-op in non-TTY mode.
{
	const w = createBufferedOscWriter(false);
	w.setTitle("my-project");
	ok("OSC writer is no-op in non-TTY mode", w.buffer === "", `got=${JSON.stringify(w.buffer)}`);
}

// 4. Verify multiple writes accumulate.
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

// 5. Verify long titles are written verbatim (no truncation by the writer).
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
