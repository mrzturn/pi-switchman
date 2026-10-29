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
	try {
		appendFileSync("/tmp/switchman-tmux-debug.log", `[${new Date().toISOString()}] pid=${process.pid} ${binary} ${args.map((a) => JSON.stringify(a)).join(" ")} -> status=${run.status} out=${JSON.stringify(run.stdout?.slice(0, 120))} err=${JSON.stringify(run.stderr?.slice(0, 120))}\n`);
	} catch {
		/* debug trace never breaks the watch */
	}
	return { status: run.status, stdout: run.stdout ?? "", stderr: run.stderr ?? "" };
};

/** In-window live watch: the pi pane stays put on the left; a right column
 *  shows at most `maxDisplayed` agents stacked evenly (split -h then -v).
 *  Extra agents run in the background (logs keep writing); when a displayed
 *  agent finishes, the next background agent respawns into its pane — no
 *  layout churn. Killing the last pane restores the main pane to full width
 *  automatically. Every tmux command targets the MAIN WINDOW explicitly —
 *  tmux commands spawned without an attached client have no reliable
 *  "current" context (panes land on phantom windows otherwise). All tmux
 *  interaction fails open. */
export class TmuxWatch {
	private readonly tmux: string | null;
	private readonly runner: TmuxRunner;
	private readonly lingerMs: number;
	private readonly maxDisplayed: number;
	private readonly tmuxPane: string;
	private mainPane: string | null = null;
	private target: string | null = null; // explicit <window-id> for every command
	private nextKey = 0;
	/** Displayed slots: paneId per slot, and which agent key it shows. */
	private readonly slots: Array<{ paneId: string; key: string } | null> = [];
	/** Background agent keys (FIFO — first queued takes the first freed slot). */
	private readonly queue: string[] = [];
	private readonly logPaths = new Map<string, string>();

	constructor(
		tmuxEnv?: string,
		tmuxBinary = "tmux",
		runner: TmuxRunner = spawnRunner,
		lingerMs = 4000,
		maxDisplayed = 2,
		tmuxPaneEnv?: string,
	) {
		const env = tmuxEnv !== undefined ? tmuxEnv : process.env.TMUX;
		this.tmux = env ? tmuxBinary : null;
		this.tmuxPane = tmuxPaneEnv !== undefined ? tmuxPaneEnv : (process.env.TMUX_PANE ?? "");
		this.runner = runner;
		this.lingerMs = lingerMs;
		this.maxDisplayed = Math.max(1, maxDisplayed);
		for (let i = 0; i < this.maxDisplayed; i++) this.slots.push(null);
	}

	get active(): boolean {
		return this.tmux !== null;
	}

	private tailCommand(logPath: string): string {
		return `tail -n +1 -f ${JSON.stringify(logPath)}; echo "[switchman] agent stream ended"`;
	}

	/** Register an agent; returns its key (pass to detach), or null when not
	 *  in tmux / tmux broken. Displayed when a slot is free, else background. */
	attach(logPath: string): string | null {
		if (this.tmux === null) return null;
		try {
			if (this.mainPane === null) {
				// tmux injects TMUX_PANE into every pane process — it IS our pane,
				// no resolution required. (client_name is the outer terminal's tty,
				// not the pane tty; `tty` fails because pi's stdin is not the pane.)
				this.mainPane = this.tmuxPane;
				if (this.mainPane === "") return null;
				this.target = this.out("display-message", "-p", "-t", this.mainPane, "#{window_id}");
				if (this.target === "") return null;
			}
			const key = `sw-${++this.nextKey}`;
			this.logPaths.set(key, logPath);
			const slot = this.slots.indexOf(null);
			if (slot !== -1) this.openSlot(slot, key);
			else this.queue.push(key);
			return key;
		} catch {
			return null;
		}
	}

	private openSlot(slot: number, key: string): void {
		const logPath = this.logPaths.get(key);
			if (logPath === undefined) return;
		const occupied = this.slots.filter((s): s is { paneId: string; key: string } => s !== null);
		let paneId: string;
		if (occupied.length === 0) {
			// Right column: split the MAIN pane horizontally — pi keeps its left.
			paneId = this.out(
				"split-window",
				"-h",
				"-d",
				"-t",
				this.mainPane as string,
				"-p",
				"50",
				"-P",
				"-F",
				"#{pane_id}",
				"bash",
				"-c",
				this.tailCommand(logPath),
			);
		} else {
			// Further slots stack the right column vertically (evenly).
			paneId = this.out(
				"split-window",
				"-v",
				"-d",
				"-t",
				occupied[0].paneId,
				"-P",
				"-F",
				"#{pane_id}",
				"bash",
				"-c",
				this.tailCommand(logPath),
			);
		}
		if (paneId === "") return;
		// Verify the pane really exists in OUR window before tracking it —
		// tmux occasionally reports phantom panes when the spawning context
		// has no attached client.
		if (!this.paneExists(paneId)) return;
		this.slots[slot] = { paneId, key };
	}

	/** An agent finished. Displayed slot: hand off to the next background
	 *  agent (seamless respawn, same pane) or linger then close. Background:
	 *  just leaves the queue. When the last pane closes, the main pane
	 *  returns to full width automatically. */
	detach(key: string | null): void {
		if (key === null || this.tmux === null || !this.logPaths.has(key)) return;
		this.logPaths.delete(key);
		const slot = this.slots.findIndex((s) => s?.key === key);
		if (slot === -1) {
			const queued = this.queue.indexOf(key);
			if (queued !== -1) this.queue.splice(queued, 1);
			return;
		}
		const paneId = this.slots[slot]?.paneId;
		if (paneId === undefined) return;
		const next = this.queue.shift();
		if (next !== undefined) {
			// Seamless handoff: the slot respawns tailing the next agent's log.
			const nextLog = this.logPaths.get(next);
			if (nextLog !== undefined) {
				this.slots[slot] = { paneId, key: next };
				this.try("respawn-pane", "-k", "-t", paneId, "bash", "-c", this.tailCommand(nextLog));
				return;
			}
		}
		// Last agent in this slot: linger so the exit line is readable, then
		// close — with the final pane gone, tmux restores the main pane width.
		this.slots[slot] = null;
		const kill = () => {
			this.try("kill-pane", "-t", paneId);
		};
		if (this.lingerMs <= 0) kill();
		else
			setTimeout(() => {
				try {
					kill();
				} catch {
					/* pane may already be gone */
				}
			}, this.lingerMs).unref?.();
	}

	private out(...args: string[]): string {
		const run = this.runner(this.tmux as string, args);
		if (run.status !== 0) throw new Error(run.stderr.trim() || `tmux ${args[0]} failed`);
		return run.stdout.trim();
	}

	/** Verifies a pane id exists in our tracked window (phantom guard). */
	private paneExists(paneId: string): boolean {
		try {
			const ids = this.out("list-panes", "-t", this.target ?? this.mainPane ?? "", "-F", "#{pane_id}");
			return ids.split("\n").includes(paneId);
		} catch {
			return false;
		}
	}

	private try(...args: string[]): void {
		try {
			this.runner(this.tmux as string, args);
		} catch {
			/* best effort */
		}
	}
}
