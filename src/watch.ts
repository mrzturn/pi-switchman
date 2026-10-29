/** Agent work visibility: every run/parallel subagent gets a human-readable
 *  log file under the switchman store. Inside tmux, each agent opens a split
 *  pane tailing its log (tiled window `switchman-agents`); outside tmux the
 *  `/switchman-agents` command lists and tails the same files. All tmux
 *  interaction fails open — a broken tmux never breaks a dispatch. */

import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Message } from "@earendil-works/pi-agent-core";

const TMUX_WINDOW = "switchman-agents";
const SNIPPET = 200;

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

/** Live tmux pane watching. One `switchman-agents` window, tiled panes. */
export class TmuxWatch {
	private paneCount = 0;
	private readonly tmux: string | null;

	constructor(tmuxEnv?: string, tmuxBinary = "tmux") {
		const env = tmuxEnv !== undefined ? tmuxEnv : process.env.TMUX;
		this.tmux = env ? tmuxBinary : null;
	}

	get active(): boolean {
		return this.tmux !== null;
	}

	/** Open a pane tailing the log; null when not in tmux or tmux failed. */
	attach(logPath: string): string | null {
		if (this.tmux === null) return null;
		const command = `tail -f ${JSON.stringify(logPath)}; echo "[switchman] agent stream ended"`;
		try {
			let paneId: string;
			if (this.paneCount === 0) {
				paneId = this.tmuxOut(
					"new-window",
					"-d",
					"-n",
					TMUX_WINDOW,
					"-P",
					"-F",
					"#{pane_id}",
					"bash",
					"-c",
					command,
				);
			} else {
				paneId = this.tmuxOut(
					"split-window",
					"-d",
					"-t",
					TMUX_WINDOW,
					"-P",
					"-F",
					"#{pane_id}",
					"bash",
					"-c",
					command,
				);
				this.tmuxTry("select-layout", "-t", TMUX_WINDOW, "tiled");
			}
			if (paneId === "") return null;
			this.paneCount++;
			return paneId;
		} catch {
			return null;
		}
	}

	/** Close one agent's pane; the window dies with its last pane. */
	detach(paneId: string | null): void {
		if (paneId === null || this.tmux === null) return;
		try {
			this.tmuxTry("kill-pane", "-t", paneId);
		} catch {
			/* pane may already be gone */
		}
		this.paneCount = Math.max(0, this.paneCount - 1);
		if (this.paneCount === 0) {
			try {
				this.tmuxTry("kill-window", "-t", TMUX_WINDOW);
			} catch {
				/* window may already be gone */
			}
		}
	}

	private tmuxOut(...args: string[]): string {
		const run = spawnSync(this.tmux, args, { encoding: "utf8", timeout: 5000 });
		if (run.status !== 0) throw new Error(run.stderr?.trim() || `tmux ${args[0]} failed`);
		return (run.stdout ?? "").trim();
	}

	private tmuxTry(...args: string[]): void {
		spawnSync(this.tmux, args, { encoding: "utf8", timeout: 5000 });
	}
}
