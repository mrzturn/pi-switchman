/**
 * Live-shaped repro for the dead-turn continuation bug.
 *
 * Mirrors the live failure: a successful first turn, then a provider abort
 * ("This operation was aborted"), retries enabled, and a context that
 * exceeds the compaction threshold so pi's post-error threshold compaction
 * runs. Asserts the [SWITCHMAN:CONTINUE] followUp lands in the session
 * branch as a user message.
 *
 * Run: bun repro/repro-dead-turn.ts
 */
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const log = (m: string) => console.log(`[repro] ${m}`);

const cwd = mkdtempSync(join(tmpdir(), "switchman-repro-"));
const agentDir = join(cwd, "agent");
mkdirSync(agentDir, { recursive: true });
// Live-like: retries enabled, but with a fast backoff so the repro is quick.
writeFileSync(
	join(agentDir, "settings.json"),
	JSON.stringify({ retry: { enabled: true, maxRetries: 1, baseDelayMs: 100 } }),
);
// Small context window so the post-error threshold compaction kicks in.
const modelsJson = join(cwd, "models.json");
writeFileSync(
	modelsJson,
	JSON.stringify({
		providers: {
			"fake-abort": {
				baseUrl: "http://127.0.0.1:9/v1",
				api: "openai-completions",
				apiKey: "none",
				models: [{ id: "aborter", input: ["text"], contextWindow: 3000, maxTokens: 512 }],
			},
		},
	}),
);

// Stateful fake wire: chat call #1 succeeds with a tiny SSE stream; chat
// call #2 aborts (the live failure shape); everything after (retries of #2,
// compaction summarize, continuation) succeeds — so the only thing that can
// kill the continuation is the plumbing, not the model.
let chatCalls = 0;
const toolCallDelta = {
	choices: [
		{
			index: 0,
			delta: {
				role: "assistant",
				tool_calls: [
					{
						index: 0,
						id: "call_repro1",
						type: "function",
						function: { name: "bash", arguments: '{"command":"echo hi","timeout":5}' },
					},
				],
			},
		},
	],
};
const sse = (deltas: string[]) =>
	new Response(
		new ReadableStream({
			start(controller) {
				const enc = new TextEncoder();
				for (const d of deltas) {
					controller.enqueue(enc.encode(`data: ${JSON.stringify(d)}\n\n`));
				}
				controller.enqueue(enc.encode("data: [DONE]\n\n"));
				controller.close();
			},
		}),
		{ status: 200, headers: { "Content-Type": "text/event-stream" } },
	);
const originalFetch = globalThis.fetch;
const origAbort = AbortController.prototype.abort;
AbortController.prototype.abort = function (this: AbortController, ...args: unknown[]) {
	const stack = new Error().stack ?? "";
	if (!stack.includes("supersedeProviderRefresh")) {
		console.log(`[repro] REAL abort from: ${stack.split("\n").slice(2, 7).join("  <-  ")}`);
	}
	return (origAbort as (...a: unknown[]) => void).apply(this, args);
};
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
	const url = String(input);
	if (url.includes("127.0.0.1:9/")) {
		chatCalls++;
		log(`chat call #${chatCalls} -> ${url}`);
		// Live shape: the post-tool-result assistant request (#2) and its one
		// retry (#3) both abort; everything later (compaction summarize,
		// continuation turns) succeeds.
		if (chatCalls === 2 || chatCalls === 3) throw new Error("This operation was aborted");
		if (chatCalls === 1)
			return sse([
				toolCallDelta,
				{ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
			]);
		return sse([
				{ choices: [{ index: 0, delta: { role: "assistant", content: "ok" } }] },
				{ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
		]);
	}
	return originalFetch(input as never, init as never);
}) as typeof fetch;

const modelRuntime = await ModelRuntime.create({ modelsPath: modelsJson, refreshOnCreate: false });
const WITH_EXTENSION = process.argv.includes("--no-ext") === false;
const resourceLoader = new DefaultResourceLoader({
	cwd,
	agentDir,
	extensionFactories: WITH_EXTENSION ? [(await import("../src/index.ts")).default] : [],
});
await resourceLoader.reload();
const model = modelRuntime.getModel("fake-abort", "aborter");
if (!model) throw new Error("fake model not registered");

const sessionManager = SessionManager.inMemory();
const { session } = await createAgentSession({ model, modelRuntime, resourceLoader, sessionManager, cwd });

session.subscribe((event: { type: string; message?: { role: string; stopReason?: string; errorMessage?: unknown; error?: unknown } }) => {
	if (event.type === "turn_end")
		log(`turn_end stopReason=${event.message?.stopReason} err=${JSON.stringify(event.message?.errorMessage ?? event.message?.error ?? null)?.slice(0, 200)}`);
	if (event.type === "agent_end") log("agent_end");
	if (event.type === "compaction") log("COMPACTION");
});

try {
	await session.prompt(`${"filler ".repeat(600)} say hi then fail`);
	log("run settled");
} catch (e) {
	log(`prompt threw: ${(e as Error).message}`);
}

// Ground truth: inspect the persisted branch for the continuation marker.
const branch = sessionManager.getBranch() as { type?: string; message?: { role?: string; content?: unknown } }[];
const sawContinue = branch.some(
	(e) =>
		e.type === "message" &&
		e.message?.role === "user" &&
		JSON.stringify(e.message.content).includes("SWITCHMAN:CONTINUE"),
);
log(
	"BRANCH:\n" +
		branch
			.map((e) => {
				if (e.type !== "message") return `  [${e.type}]`;
				const m = e.message as { role?: string; content?: unknown; stopReason?: string };
				const head = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
				return `  ${m.role} sr=${m.stopReason ?? ""} ${head.slice(0, 80)}`;
			})
			.join("\n"),
);
log(`followUp queue after run: ${JSON.stringify((session as unknown as { getFollowUpMessages?: () => string[] }).getFollowUpMessages?.() ?? [])}`);
session.dispose();
process.exit(0);
