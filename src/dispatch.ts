/** [B] The dispatch tool: the tiered execution matrix (DESIGN §4.2).
 *
 *  - gather  (Tier 0): ordered read-only tool steps inside this tool call via
 *    ctx.executeTool — the process never enters the transcript, only the
 *    distilled summary does. Write tools are rejected: audit and rollback
 *    need writes on the transcript.
 *  - judge   (Tier 2): one-shot verdict from a lane model via
 *    modelRegistry.complete — a single tool result carries the whole verdict.
 *  - run     (Tier 3): isolated `pi --mode json` child with an agent
 *    definition; final output returns capped, full output goes to the store.
 *  - parallel: up to 8 gather/judge/run tasks, 4 concurrent.
 *
 *  Every dispatch lands in the ledger (appendEntry) after completion. */

import { Type, StringEnum, uuidv7 } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import type { LaneName, LoadedConfig, ModelRef, SwitchmanConfig } from "./config.ts";
import { LANE_NAMES } from "./config.ts";
import { laneCandidates } from "./capability.ts";
import { currentPhysicalModel, LEDGER_TYPE } from "./ledger.ts";
import { finalOutput, runPiChild } from "./child.ts";
import { findAgent, type AgentScope } from "./agents.ts";
import type { OutputStore } from "./compress.ts";

/** Read-only tools a gather step may name. */
const GATHER_WHITELIST = new Set(["read", "grep", "glob", "find", "ls"]);

const MAX_PARALLEL_TASKS = 8;
const PARALLEL_CONCURRENCY = 4;
const RUN_OUTPUT_CAP = 50 * 1024;
const PARALLEL_TASK_CAP = 8 * 1024;
const STEP_SNIPPET = 320;

export interface DispatchDeps {
	config: () => LoadedConfig;
	store: OutputStore;
	pi: ExtensionAPI;
}

function textBlocks(content: unknown): string {
	if (!Array.isArray(content)) return "";
	let text = "";
	for (const block of content) {
		if (typeof block === "object" && block !== null && (block as { type?: string }).type === "text") {
			text += (text === "" ? "" : "\n") + String((block as { text?: string }).text ?? "");
		}
	}
	return text;
}

function snippet(text: string, cap = STEP_SNIPPET): string {
	const flat = text.replace(/\s+\n/g, "\n").trim();
	return flat.length <= cap ? flat : `${flat.slice(0, cap)}…`;
}

function parseModelSpec(spec: string): ModelRef | null {
	const trimmed = spec.trim();
	const slash = trimmed.lastIndexOf("/");
	if (slash <= 0 || slash === trimmed.length - 1) return null;
	return { provider: trimmed.slice(0, slash), model: trimmed.slice(slash + 1) };
}

/** Every model reference configured in lanes + anchors (enforce gate universe). */
export function configuredUniverse(config: SwitchmanConfig): ModelRef[] {
	const refs: ModelRef[] = [];
	const seen = new Set<string>();
	const push = (ref: ModelRef) => {
		const key = `${ref.provider}/${ref.model}`;
		if (!seen.has(key)) {
			seen.add(key);
			refs.push(ref);
		}
	};
	for (const lane of LANE_NAMES) {
		const list = config.router.lanes[lane];
		if (list === null) continue;
		for (const ref of list) push(ref);
	}
	for (const anchor of config.anchors) push(anchor);
	return refs;
}

/** advice: prepend a warning; enforce: deny (isError result). */
function gateModel(config: SwitchmanConfig, spec: string): { ok: true } | { ok: false; deny: string } | { ok: true; warning: string } {
	const ref = parseModelSpec(spec);
	if (ref === null) {
		return { ok: false, deny: `model must be "provider/model", got "${spec}"` };
	}
	const universe = configuredUniverse(config);
	if (universe.length === 0) return { ok: true };
	const known = universe.some((entry) => entry.provider === ref.provider && entry.model === ref.model);
	if (known) return { ok: true };
	if (config.enforce === "enforce") {
		return {
			ok: false,
			deny: `[switchman] enforce: "${spec}" is outside every configured lane and anchor. Pick a lane model or omit "model".`,
		};
	}
	return {
		ok: true,
		warning: `[switchman] advice: "${spec}" is outside every configured lane and anchor.`,
	};
}

function availableFacts(ctx: ExtensionToolContext) {
	try {
		return ctx.modelRegistry.getAvailable();
	} catch {
		return [];
	}
}

function resolveLaneModel(ctx: ExtensionToolContext, config: SwitchmanConfig, lane: LaneName): { ref: ModelRef; model: unknown } | null {
	const candidates = laneCandidates(lane, config, availableFacts(ctx));
	for (const ref of candidates) {
		const model = ctx.modelRegistry.find(ref.provider, ref.model);
		if (model !== undefined) return { ref, model };
	}
	return null;
}

// ---- mode implementations -----------------------------------------------------

interface StepOutcome {
	tool: string;
	ok: boolean;
	text: string;
}

async function runGather(ctx: ExtensionToolContext, steps: Array<{ tool: string; args?: Record<string, unknown> }>, signal: AbortSignal): Promise<StepOutcome[]> {
	const outcomes: StepOutcome[] = [];
	for (const step of steps) {
		if (!GATHER_WHITELIST.has(step.tool)) {
			outcomes.push({ tool: step.tool, ok: false, text: `not a read-only tool (allowed: ${[...GATHER_WHITELIST].join(", ")})` });
			continue;
		}
		try {
			const outcome = await ctx.executeTool(step.tool, step.args ?? {}, { signal });
			outcomes.push({
				tool: step.tool,
				ok: !outcome.isError,
				text: snippet(textBlocks((outcome.result as { content?: unknown } | undefined)?.content) || ""),
			});
		} catch (error) {
			outcomes.push({ tool: step.tool, ok: false, text: snippet(String((error as Error)?.message ?? error)) });
		}
	}
	return outcomes;
}

async function runJudge(
	ctx: ExtensionToolContext,
	config: SwitchmanConfig,
	params: { task: string; lane?: string; model?: string; system?: string },
	signal: AbortSignal,
): Promise<{ ok: true; verdict: string; model: string; usage?: unknown } | { ok: false; error: string }> {
	let model: unknown;
	let modelLabel: string;
	if (params.model !== undefined && params.model !== "") {
		const gate = gateModel(config, params.model);
		if (!gate.ok) return { ok: false, error: gate.deny };
		const ref = parseModelSpec(params.model) as ModelRef;
		model = ctx.modelRegistry.find(ref.provider, ref.model);
		if (model === undefined) return { ok: false, error: `model not found: ${params.model}` };
		modelLabel = params.model;
	} else {
		const lane = (params.lane as LaneName | undefined) ?? "main";
		const resolved = resolveLaneModel(ctx, config, lane);
		if (resolved === null) return { ok: false, error: `no available model for lane "${lane}"` };
		model = resolved.model;
		modelLabel = `${resolved.ref.provider}/${resolved.ref.model}`;
	}
	try {
		const response = await ctx.modelRegistry.complete(model as never, {
			systemPrompt: params.system ?? "You are a precise technical judge. Answer the task directly and concisely.",
			messages: [
				{
					role: "user" as const,
					content: [{ type: "text" as const, text: params.task }],
					timestamp: Date.now(),
				},
			],
		}, { signal } as never);
		const verdict = textBlocks((response as { content?: unknown }).content);
		return {
			ok: true,
			verdict: verdict === "" ? "(empty verdict)" : verdict,
			model: modelLabel,
			usage: (response as { usage?: unknown }).usage,
		};
	} catch (error) {
		return { ok: false, error: String((error as Error)?.message ?? error) };
	}
}

async function runAgent(
	ctx: ExtensionToolContext,
	config: SwitchmanConfig,
	deps: DispatchDeps,
	params: { agent: string; task: string; model?: string; thinking?: string; cwd?: string },
	signal: AbortSignal,
	onLine?: (line: string) => void,
): Promise<{ ok: boolean; text: string; reportPath?: string; model?: string; usage?: unknown }> {
	const scope: AgentScope = "user";
	const agent = findAgent(params.cwd ?? ctx.cwd, scope, params.agent);
	if (agent === undefined) {
		return { ok: false, text: `unknown agent "${params.agent}" in scope "${scope}"` };
	}

	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	let modelLabel: string | undefined;
	let warning = "";
	if (params.model !== undefined && params.model !== "") {
		const gate = gateModel(config, params.model);
		if (!gate.ok) return { ok: false, text: gate.deny };
		if ("warning" in gate && gate.warning !== "") warning = `${gate.warning}\n`;
		args.push("--model", params.model);
		modelLabel = params.model;
	} else if (agent.model !== undefined) {
		args.push("--model", agent.model);
		modelLabel = agent.model;
	} else {
		// Inherit the dispatching session's PHYSICAL model (virtual->physical).
		const inherited = currentPhysicalModel(ctx.sessionManager.getBranch());
		if (inherited !== null) {
			args.push("--model", `${inherited.provider}/${inherited.model}`);
			modelLabel = `${inherited.provider}/${inherited.model}`;
		}
	}
	if (params.thinking !== undefined && params.thinking !== "") args.push("--thinking", params.thinking);
	if (agent.tools !== undefined && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));

	const result = await runPiChild({
		args,
		cwd: params.cwd ?? ctx.cwd,
		systemPrompt: agent.systemPrompt,
		task: params.task,
		signal,
		onMessage: (message) => {
			if (message.role === "assistant" && onLine) onLine(snippet(textBlocks((message as { content?: unknown }).content), 160));
		},
	});

	const failed = result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
	const output = failed
		? result.errorMessage || result.stderr || finalOutput(result.messages) || "(no output)"
		: finalOutput(result.messages) || "(no output)";
	const full = `${warning}[switchman] agent=${agent.name} model=${result.model ?? modelLabel ?? "?"} exit=${result.exitCode}\n\n${output}`;
	const reportPath = deps.store.add(`run-${agent.name}`, full);
	return {
		ok: !failed,
		text: full.length > RUN_OUTPUT_CAP ? `${full.slice(0, RUN_OUTPUT_CAP)}\n[switchman] output truncated — full report: ${reportPath}` : full,
		reportPath,
		model: modelLabel,
		usage: result.usage,
	};
}

async function mapWithConcurrency<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = Array.from({ length: limit }, async () => {
		for (;;) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

// ---- tool definition -----------------------------------------------------------

const GatherStep = Type.Object({
	tool: Type.String({ description: "Read-only tool name: read, grep, glob, find, ls" }),
	args: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Tool arguments" })),
});

const ParallelTask = Type.Object({
	mode: StringEnum(["gather", "judge", "run"], { description: "Task mode" }),
	description: Type.Optional(Type.String({ description: "Short label for the result line" })),
	steps: Type.Optional(Type.Array(GatherStep, { description: "gather: ordered read-only steps" })),
	task: Type.Optional(Type.String({ description: "judge/run: the task text" })),
	lane: Type.Optional(StringEnum([...LANE_NAMES], { description: "judge: model lane" })),
	model: Type.Optional(Type.String({ description: 'Explicit "provider/model" override' })),
	system: Type.Optional(Type.String({ description: "judge: system prompt override" })),
	agent: Type.Optional(Type.String({ description: "run: agent name" })),
	thinking: Type.Optional(Type.String({ description: "run: thinking level" })),
	cwd: Type.Optional(Type.String({ description: "run: working directory" })),
});

export function createDispatchTool(deps: DispatchDeps) {
	return defineTool({
		name: "dispatch",
		label: "dispatch",
		description: [
			"Tiered execution: pick the cheapest sufficient executor.",
			'gather: ordered read-only steps (read/grep/glob/find/ls) run inside this call — only the summary enters context.',
			"judge: one-shot verdict from a lane model (review/verify/classify).",
			"run: isolated subagent (multi-step work needing its own agent loop).",
			"parallel: several gather/judge/run tasks at once (max 8).",
		].join(" "),
		parameters: Type.Object({
			mode: StringEnum(["gather", "judge", "run", "parallel"], { description: "Execution mode" }),
			description: Type.Optional(Type.String({ description: "Short label (ledger + rendering)" })),
			steps: Type.Optional(Type.Array(GatherStep, { description: "gather: ordered read-only steps" })),
			task: Type.Optional(Type.String({ description: "judge/run: the task text" })),
			lane: Type.Optional(StringEnum([...LANE_NAMES], { description: "judge: model lane (default main)" })),
			model: Type.Optional(Type.String({ description: 'Explicit "provider/model" override (validated against lanes)' })),
			system: Type.Optional(Type.String({ description: "judge: system prompt override" })),
			agent: Type.Optional(Type.String({ description: "run: agent name" })),
			thinking: Type.Optional(Type.String({ description: "run: thinking level" })),
			cwd: Type.Optional(Type.String({ description: "run: working directory" })),
			tasks: Type.Optional(Type.Array(ParallelTask, { description: "parallel: task list" })),
		}),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const loaded = deps.config();
			const config = loaded.config;
			const description = params.description ?? params.task ?? params.agent ?? params.mode;
			const record = {
				id: uuidv7(),
				mode: params.mode as "gather" | "judge" | "run" | "parallel",
				description: snippet(description, 80),
				ts: Date.now(),
			};
			const finish = (status: "done" | "error", extra: Partial<typeof record> = {}) => {
				try {
					deps.pi.appendEntry(LEDGER_TYPE, { ...record, status, ...extra });
				} catch {
					/* ledger is advisory */
				}
			};

			try {
				if (config.disabled) {
					finish("error");
					return { content: [{ type: "text" as const, text: "[switchman] disabled by configuration" }], details: undefined, isError: true };
				}

				// ---- single-task runner (shared by run + parallel) ----
				const runOne = async (
					task: { mode: string; steps?: Array<{ tool: string; args?: Record<string, unknown> }>; task?: string; lane?: string; model?: string; system?: string; agent?: string; thinking?: string; cwd?: string },
				): Promise<{ ok: boolean; text: string; reportPath?: string; model?: string }> => {
					if (task.mode === "gather") {
						if (!Array.isArray(task.steps) || task.steps.length === 0) {
							return { ok: false, text: "gather requires steps" };
						}
						const outcomes = await runGather(ctx, task.steps, signal);
						const ok = outcomes.every((outcome) => outcome.ok);
						const lines = outcomes.map((outcome) => `${outcome.ok ? "✓" : "✗"} ${outcome.tool}: ${outcome.text}`);
						return { ok, text: lines.join("\n") };
					}
					if (task.mode === "judge") {
						if (!task.task || task.task === "") return { ok: false, text: "judge requires task" };
						const judged = await runJudge(ctx, config, { task: task.task, lane: task.lane, model: task.model, system: task.system }, signal);
						if (!judged.ok) return { ok: false, text: judged.error };
						return { ok: true, text: `[judge ${judged.model}]\n${judged.verdict}`, model: judged.model };
					}
					if (task.mode === "run") {
						if (!task.agent || !task.task) return { ok: false, text: "run requires agent + task" };
						return await runAgent(ctx, config, deps, { agent: task.agent, task: task.task, model: task.model, thinking: task.thinking, cwd: task.cwd }, signal);
					}
					return { ok: false, text: `unknown mode "${task.mode}"` };
				};

				let text: string;
				let isError = false;
				let extra: { reportPath?: string; lane?: string; model?: string } = {};

				if (params.mode === "parallel") {
					const tasks = params.tasks ?? [];
					if (tasks.length === 0) {
						finish("error");
						return { content: [{ type: "text" as const, text: "parallel requires tasks" }], details: undefined, isError: true };
					}
					if (tasks.length > MAX_PARALLEL_TASKS) {
						finish("error");
						return { content: [{ type: "text" as const, text: `parallel supports at most ${MAX_PARALLEL_TASKS} tasks` }], details: undefined, isError: true };
					}
					const outcomes = await mapWithConcurrency(tasks, PARALLEL_CONCURRENCY, async (task, index) => {
						const outcome = await runOne(task);
						if (onUpdate) onUpdate({ content: [{ type: "text", text: `[${index + 1}/${tasks.length}] ${task.mode}: ${outcome.ok ? "done" : "failed"}` }], details: undefined });
						return outcome;
					});
					isError = outcomes.some((outcome) => !outcome.ok);
					text = outcomes
						.map((outcome, index) => {
							const label = tasks[index].description ?? tasks[index].mode;
							const body = outcome.text.length > PARALLEL_TASK_CAP ? `${outcome.text.slice(0, PARALLEL_TASK_CAP)}…` : outcome.text;
							return `== ${label} ${outcome.ok ? "✓" : "✗"} ==\n${body}`;
						})
						.join("\n\n");
				} else {
					const outcome = await runOne(params);
					isError = !outcome.ok;
					text = outcome.text;
					extra = { reportPath: outcome.reportPath, model: outcome.model, lane: params.lane };
				}

				finish(isError ? "error" : "done", extra);
				return { content: [{ type: "text" as const, text }], details: { ...record, ...extra }, isError: isError || undefined };
			} catch (error) {
				const message = String((error as Error)?.message ?? error);
				finish("error");
				return { content: [{ type: "text" as const, text: `[switchman] dispatch failed: ${message}` }], details: undefined, isError: true };
			}
		},
	});
}
