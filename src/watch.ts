/** Agent work visibility: every run/parallel subagent gets a human-readable
 *  log file under the switchman store. Inside tmux, each agent opens a pane
 *  tailing its log in a dedicated `switchman-agents` window — the window is
 *  SELECTED on first attach so the user actually sees the split live, and
 *  focus returns to the origin window when the last pane closes. Finished
 *  panes linger briefly so the exit line is readable. All tmux interaction
 *  fails open — a broken tmux never breaks a dispatch. */

import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Message } from "@earendil-works/pi-agent-core";

const TMUX_WINDOW = "switchman-agents";
const SNIPPET = 200;
const DETACH_LINGER_MS = 4000;

/** One human-readable line for a child stream message (pure). */
export function formatChildMessage(message: Message): string | null {
	const content = (message as { content?: unknown }).content;
	if (message.role === "assistant" && Array.isArray(content)) {
		for (const part of content) {
			if (part.type === "text") {
				const text = (part as { text?: string }).text ?? "";
				if (text.trim() !== "") return `▶ ${text.slice(0, SNIPPET).replace(/\n+/g, " ")}`;
			}
		}
		for (const part of content) {
			if (part.type === "toolCall") {
				const call = part as { name?: string; arguments?: unknown };
				return `⚙ ${call.name ?? "tool"}(${JSON.stringify(call.arguments ?? {})?.slice(0, SNIPPET)})`;
			}
		}
	}
	if (message.role === "toolResult" && Array.isArray(content)) {
		for (const part of content) {
			if (part.type === "text") {
				const text = (part as { text?: string }).text ?? "";
				return `${message.stopReason === "error" ? "✗" : "·"} ${text.slice(0, SNIPPET).replace(/\n+/g, " ")}`;
			}
		}
	}
	return null;
}

/** Appendable per-agent log. */
export interface AgentLog {
	path: string;
	write: (line: string) => void;
}

/** Create the log file (store dir base, agents/ subdir). Never throws. */
export function startAgentLog(storeDir: string, label: string, task: string): AgentLog | null {
	try {
		const dir = join(storeDir, "agents");
		mkdirSync(dir, { recursive: true });
		const stamp = new Date().toISOString().replace(/[:.]/g, "-");
		const safe = label.replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 40) || "agent";
		const path = join(dir, `${stamp}-${safe}.log`);
		appendFileSync(path, `# agent: ${label}\n# task: ${task.slice(0, 300)}\n# started: ${new Date().toISOString()}\n`);
		return { path, write: (line) => appendFileSync(path, `${line}\n`) };
	} catch {
		return null;
	}
}

/** Tail the last `lines` lines of an agent log (never throws). */
export function tailAgentLog(path: string, lines = 60): string {
	try {
		if (!existsSync(path)) return "(log file missing)";
		const all = readFileSync(path, "utf8").split("\n");
		const tail = all.slice(Math.max(0, all.length - lines)).join("\n");
		return tail === "" ? "(empty log)" : tail;
	} catch {
		return "(unreadable log)";
	}
}

/** Injectable tmux runner (tests capture sequences; default spawnSync). */
export type TmuxRunner = (binary: string, args: string[]) => { status: number | null; stdout: string; stderr: string };

const spawnRunner: TmuxRunner = (binary, args) => {
	const run = spawnSync(binary, args, { encoding: "utf8", timeout: 5000 });
	return { status: run.status, stdout: run.stdout ?? "", stderr: run.stderr ?? "" };
};

/** Live tmux panes watching agent logs. One window, tiled panes, focused. */
export class TmuxWatch {
	private readonly tmux: string | null;
	private readonly runner: TmuxRunner;
	private readonly lingerMs: number;
	private paneCount = 0;
	private windowId: string | null = null;
	private originWindow: string | null = null;

	constructor(tmuxEnv?: string, tmuxBinary = "tmux", runner: TmuxRunner = spawnRunner, lingerMs = DETACH_LINGER_MS) {
		const env = tmuxEnv !== undefined ? tmuxEnv : process.env.TMUX;
		this.tmux = env ? tmuxBinary : null;
		this.runner = runner;
		this.lingerMs = lingerMs;
	}

	get active(): boolean {
		return this.tmux !== null;
	}

	/** Open a pane tailing the log; null when not in tmux or tmux failed.
	 *  The window is selected on first attach so the split is actually
	 *  visible (creating a background window nobody looks at is useless). */
	attach(logPath: string): string | null {
		if (this.tmux === null) return null;
		const command = `tail -n +1 -f ${JSON.stringify(logPath)}; echo "[switchman] agent stream ended"`;
		try {
			if (this.originWindow === null) {
				this.originWindow = this.out("display-message", "-p", "#{window_id}") || null;
			}
			let paneId: string;
			if (this.paneCount === 0) {
				this.windowId = this.out(
					"new-window",
					"-d",
					"-n",
					TMUX_WINDOW,
					"-P",
					"-F",
					"#{window_id}",
					"bash",
					"-c",
					command,
				);
				if (this.windowId === "") {
					this.windowId = null;
					return null;
				}
				// Show the split instead of leaving it in a background tab.
				this.try("select-window", "-t", this.windowId);
				// -P -F "#{window_id}" returned the WINDOW id; panes inside it are
				// addressed by index — pane 0 is the one we just created.
				paneId = `${this.windowId}.0`;
			} else {
				paneId = this.out(
					"split-window",
					"-d",
					"-t",
					this.windowId ?? TMUX_WINDOW,
					"-P",
					"-F",
					"#{pane_id}",
					"bash",
					"-c",
					command,
				);
				if (paneId === "") return null;
				this.try("select-layout", "-t", this.windowId ?? TMUX_WINDOW, "tiled");
			}
			this.paneCount++;
			return paneId;
		} catch {
			return null;
		}
	}

	/** Close one agent's pane after a short linger (the exit line stays
	 *  readable); the window dies with its last pane and focus returns to
	 *  the window the user came from. */
	detach(paneId: string | null): void {
		if (paneId === null || this.tmux === null) return;
		const kill = () => {
			this.try("kill-pane", "-t", paneId);
			this.paneCount = Math.max(0, this.paneCount - 1);
			if (this.paneCount === 0) {
				if (this.originWindow !== null) this.try("select-window", "-t", this.originWindow);
				if (this.windowId !== null) this.try("kill-window", "-t", this.windowId);
				this.windowId = null;
			}
		};
		if (this.lingerMs <= 0) kill();
		else setTimeout(() => {
			try {
				kill();
			} catch {
				/* pane/window may already be gone */
			}
		}, this.lingerMs).unref?.();
	}

	private out(...args: string[]): string {
		const run = this.runner(this.tmux as string, args);
		if (run.status !== 0) throw new Error(run.stderr.trim() || `tmux ${args[0]} failed`);
		return run.stdout.trim();
	}

	private try(...args: string[]): void {
		try {
			this.runner(this.tmux as string, args);
		} catch {
			/* best effort */
		}
	}
}
