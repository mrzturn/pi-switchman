/** Child process plumbing for Tier 3 dispatch: spawn `pi --mode json` with a
 *  delegated prompt, stream JSONL events, collect the final output and usage.
 *  Ported from the official subagent example, with the line parser factored
 *  out for unit testing. */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message } from "@earendil-works/pi-ai";

export interface ChildUsage {
	turns: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
}

export interface ChildResult {
	exitCode: number;
	messages: Message[];
	stderr: string;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	usage: ChildUsage;
}

/** One parsed JSONL event line, or null for blanks/garbage (never throws). */
export function parseChildLine(line: string): { kind: "message"; message: Message } | null {
	const trimmed = line.trim();
	if (trimmed === "") return null;
	let event: unknown;
	try {
		event = JSON.parse(trimmed);
	} catch {
		return null;
	}
	if (typeof event !== "object" || event === null) return null;
	const record = event as Record<string, unknown>;
	if (record.type !== "message_end" && record.type !== "tool_result_end") return null;
	const message = record.message;
	if (typeof message !== "object" || message === null) return null;
	return { kind: "message", message: message as Message };
}

/** Final assistant text of a child run (last assistant message's first text part). */
export function finalOutput(messages: readonly Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role !== "assistant") continue;
		const content = message.content;
		if (!Array.isArray(content)) continue;
		for (const part of content) {
			if (part.type === "text") return part.text;
		}
	}
	return "";
}

/** How to invoke pi from inside a pi extension (re-exec the same entry). */
export function piInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const execName = join(process.execPath).split("/").pop()?.toLowerCase() ?? "";
	if (!/^(node|bun)(\.exe)?$/.test(execName)) {
		return { command: process.execPath, args };
	}
	return { command: "pi", args };
}

export interface SpawnOptions {
	args: string[];
	cwd: string;
	systemPrompt?: string;
	task: string;
	signal?: AbortSignal;
	onMessage?: (message: Message) => void;
}

/** Spawn a pi child in JSON mode and collect its stream. Rejects only on abort;
 *  process failures resolve as exitCode != 0 with stderr populated. */
export function runPiChild(options: SpawnOptions): Promise<ChildResult> {
	return new Promise<ChildResult>((resolve, reject) => {
		const result: ChildResult = {
			exitCode: 0,
			messages: [],
			stderr: "",
			usage: { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0 },
		};
		let promptDir: string | null = null;

		const start = () => {
			const fullArgs = [...options.args];
			if (options.systemPrompt && options.systemPrompt.trim() !== "") {
				promptDir = mkdtempSync(join(tmpdir(), "pi-switchman-child-"));
				const promptPath = join(promptDir, "prompt.md");
				writeFileSync(promptPath, options.systemPrompt, "utf8");
				fullArgs.push("--append-system-prompt", promptPath);
			}
			fullArgs.push(`Task: ${options.task}`);

			const invocation = piInvocation(fullArgs);
			const proc = spawn(invocation.command, invocation.args, {
				cwd: options.cwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});

			let wasAborted = false;
			let buffer = "";
			const processLine = (line: string) => {
				const parsed = parseChildLine(line);
				if (parsed === null) return;
				result.messages.push(parsed.message);
				const message = parsed.message;
				if (message.role === "assistant") {
					result.usage.turns++;
					const usage = message.usage;
					if (usage) {
						result.usage.input += usage.input || 0;
						result.usage.output += usage.output || 0;
						result.usage.cacheRead += usage.cacheRead || 0;
						result.usage.cacheWrite += usage.cacheWrite || 0;
						result.usage.cost += (usage.cost as { total?: number } | undefined)?.total || 0;
						result.usage.contextTokens = usage.totalTokens || 0;
					}
					if (!result.model && message.model) result.model = message.model;
					if (message.stopReason) result.stopReason = message.stopReason;
					if (message.errorMessage) result.errorMessage = message.errorMessage;
				}
				options.onMessage?.(message);
			};

			proc.stdout.on("data", (data: Buffer) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});
			proc.stderr.on("data", (data: Buffer) => {
				result.stderr += data.toString();
			});
			proc.on("close", (code) => {
				if (buffer.trim() !== "") processLine(buffer);
				if (promptDir !== null) {
					try {
						rmSync(promptDir, { recursive: true, force: true });
					} catch {
						/* best effort */
					}
				}
				result.exitCode = code ?? 0;
				if (wasAborted) {
					reject(new Error("Child agent was aborted"));
					return;
				}
				resolve(result);
			});
			proc.on("error", () => {
				if (promptDir !== null) {
					try {
						rmSync(promptDir, { recursive: true, force: true });
					} catch {
						/* best effort */
					}
				}
				result.exitCode = 1;
				resolve(result);
			});

			if (options.signal) {
				const kill = () => {
					wasAborted = true;
					proc.kill("SIGTERM");
					setTimeout(() => {
						if (!proc.killed) proc.kill("SIGKILL");
					}, 5000);
				};
				if (options.signal.aborted) kill();
				else options.signal.addEventListener("abort", kill, { once: true });
			}
		};
		start();
	});
}

/** Read a file if it exists (helper for prompt-file transport in tests). */
export function readIfExists(path: string): string | null {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
}
