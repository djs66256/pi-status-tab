/**
 * OSC escape sequence writer for direct terminal title updates.
 *
 * Useful when the extension wants to set the tab title even in modes where
 * `ctx.ui.setTitle()` is not appropriate (e.g. RPC, json, or when the host
 * terminal is detected but pi's TUI is not in focus).
 *
 * OSC 2 (Set Window Title) is supported by iTerm2, Zed, kitty, wezterm,
 * Alacritty, GNOME Terminal, Windows Terminal, and most modern terminals.
 * OSC 7 (cwd reporting) is a separate concern and not used here.
 *
 * We write to fd 2 (stderr) by default because:
 *   - pi's TUI captures stdout, so writing OSC to stdout would either be
 *     swallowed or interfere with the renderer.
 *   - stderr is the conventional channel for terminal control sequences.
 *
 * TTY detection avoids writing escape sequences into pipes or files.
 */

const OSC_SET_WINDOW_TITLE = "\x1b]2;";
const OSC_END = "\x07";

export interface OscWriter {
	/** Write the title to the terminal. No-op if not a TTY. */
	setTitle(title: string): void;
	/** Whether the writer can write to a real terminal. */
	isAvailable(): boolean;
}

export function createOscWriter(stream: NodeJS.WriteStream = process.stderr): OscWriter {
	// Lazily resolve the isTTY flag (it can change after extension load if
	// pi redirects streams, e.g. for logging).
	const isTty = (): boolean => Boolean(stream.isTTY);

	return {
		setTitle(title) {
			if (!isTty()) return;
			// Strip control characters that could break the escape sequence.
			const safe = title.replace(/[\x00-\x1f\x7f]/g, " ");
			try {
				stream.write(OSC_SET_WINDOW_TITLE + safe + OSC_END);
			} catch {
				// Ignore: some streams may be closed mid-write.
			}
		},
		isAvailable: isTty,
	};
}

/** Detect whether the parent terminal is one of the known tab-aware terminals. */
export function detectTabCapableTerminal(env: NodeJS.ProcessEnv = process.env): boolean {
	const program = (env.TERM_PROGRAM ?? "").toLowerCase();
	if (program.includes("iterm")) return true;
	if (program.includes("apple_terminal")) return true;
	if (program.includes("zed")) return true;
	if (program.includes("vscode")) return true;
	if (program.includes("warp")) return true;
	if (program.includes("kitty")) return true;
	if (program.includes("wezterm")) return true;
	if (program.includes("alacritty")) return true;
	if (program.includes("ghostty")) return true;
	if (program.includes("hyper")) return true;
	if (program.includes("tmux") || program.includes("screen")) return true; // multiplexer
	const term = (env.TERM ?? "").toLowerCase();
	if (term.includes("xterm") || term.includes("screen") || term.includes("tmux")) return true;
	// Best-effort fallback: any TTY is presumed to support OSC 2.
	return Boolean(process.stderr.isTTY);
}

/** Best-effort check whether the OSC writer would actually emit anything. */
export function isOscAvailable(stream: NodeJS.WriteStream = process.stderr): boolean {
	return Boolean(stream.isTTY) && stream.writable !== false;
}

/** Sanity helper for tests: read back what was written to a buffer. */
export function createBufferedOscWriter(forceTty = true): OscWriter & { buffer: string } {
	const buffered = { value: "" };
	const fakeStream = {
		isTTY: forceTty,
		writable: true,
		write(chunk: string): boolean {
			buffered.value += chunk;
			return true;
		},
	} as unknown as NodeJS.WriteStream;
	const writer = createOscWriter(fakeStream);
	// Return writer plus a live `buffer` reference. We attach the getter
	// via defineProperty because Object.assign invokes getters and copies
	// the value, which would freeze the buffer at the empty string.
	const result = writer as OscWriter & { buffer: string };
	Object.defineProperty(result, "buffer", {
		get() {
			return buffered.value;
		},
		enumerable: true,
		configurable: true,
	});
	return result;
}

// Re-export for completeness in case consumers want raw sequences.
export const OSC = {
	setWindowTitle(title: string): string {
		const safe = title.replace(/[\x00-\x1f\x7f]/g, " ");
		return OSC_SET_WINDOW_TITLE + safe + OSC_END;
	},
};
