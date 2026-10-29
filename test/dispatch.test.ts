/** Dispatch tool tests: gather mode with a fake tool context (whitelist,
 *  error steps), judge mode with a fake registry, enforce gate. */

import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import test from "node:test";
import { DEFAULT_CONFIG, type LoadedConfig } from "../src/config.ts";
import { createDispatchTool } from "../src/dispatch.ts";
import { OutputStore } from "../src/compress.ts";

function loadedConfig(overrides: Record<string, unknown> = {}): LoadedConfig {
	const config = { ...DEFAULT_CONFIG, ...(overrides as object) } as typeof DEFAULT_CONFIG;
	return {
		config,
		globalPath: "/dev/null/global.json",
		projectPath: "/dev/null/project.json",
		errors: [],
	};
}

interface FakeToolCtx {
	cwd: string;
	executeToolCalls: Array<{ name: string; args: unknown }>;
	executeTool: (name: string, args: unknown) => Promise<unknown>;
	modelRegistry: {
		getAvailable: () => unknown[];
		find: (provider: string, id: string) => unknown;
		complete: (model: unknown, context: unknown, options?: unknown) => Promise<unknown>;
	};
	sessionManager: { getBranch: () => unknown[] };
}

function fakeCtx(overrides: Partial<FakeToolCtx> = {}): FakeToolCtx {
	const ctx: FakeToolCtx = {
		cwd: process.cwd(),
		executeToolCalls: [],
		executeTool: async (name, args) => {
			ctx.executeToolCalls.push({ name, args });
			return { isError: false, result: { content: [{ type: "text", text: `${name} ok` }] } };
		},
		modelRegistry: {
			getAvailable: () => [],
			find: () => undefined,
			complete: async () => {
				throw new Error("complete not configured");
			},
		},
		sessionManager: { getBranch: () => [] },
		...overrides,
	};
	return ctx;
}

function fakePi() {
	const entries: Array<{ customType: string; data: unknown }> = [];
	return {
		entries,
		appendEntry: (customType: string, data: unknown) => {
			entries.push({ customType, data });
		},
		on: () => () => {},
		registerTool: () => {},
		registerCommand: () => {},
		registerVirtualModel: () => {},
	};
}

async function runDispatch(tool: ReturnType<typeof createDispatchTool>, params: Record<string, unknown>, ctx: FakeToolCtx) {
	return tool.execute("t1", params as never, undefined, undefined, ctx as never) as Promise<{
		content: { type: string; text: string }[];
		details: unknown;
		isError?: boolean;
	}>;
}

test("gather: whitelisted steps run, write tools rejected, summary per step", async () => {
	const pi = fakePi();
	const tool = createDispatchTool({ config: () => loadedConfig(), store: new OutputStore(tmpdir()), pi: pi as never });
	const ctx = fakeCtx();
	const result = await runDispatch(tool, {
		mode: "gather",
		description: "find auth code",
		steps: [
			{ tool: "read", args: { path: "/tmp/auth.ts" } },
			{ tool: "write", args: { path: "/tmp/x", content: "evil" } },
		],
	}, ctx);
	assert.equal(ctx.executeToolCalls.length, 1); // write never ran
	assert.equal(ctx.executeToolCalls[0].name, "read");
	assert.ok(result.content[0].text.includes("✓ read"));
	assert.ok(result.content[0].text.includes("✗ write"));
	assert.ok(result.content[0].text.includes("not a read-only tool"));
	// ledger recorded
	const ledger = pi.entries.find((entry) => entry.customType === "switchman:ledger");
	assert.ok(ledger);
	assert.equal((ledger!.data as { mode: string }).mode, "gather");
});

test("gather: failing steps mark the result as error without throwing", async () => {
	const pi = fakePi();
	const tool = createDispatchTool({ config: () => loadedConfig(), store: new OutputStore(tmpdir()), pi: pi as never });
	const ctx = fakeCtx({
		executeTool: async (name) => ({ isError: true, result: { content: [{ type: "text", text: "boom" }] } }),
	});
	const result = await runDispatch(tool, { mode: "gather", steps: [{ tool: "read", args: { path: "/x" } }] }, ctx);
	assert.equal(result.isError, true);
	assert.ok(result.content[0].text.includes("✗ read"));
});

test("judge: lane model resolution and verdict text", async () => {
	const pi = fakePi();
	const tool = createDispatchTool({ config: () => loadedConfig(), store: new OutputStore(tmpdir()), pi: pi as never });
	const ctx = fakeCtx({
		modelRegistry: {
			getAvailable: () => [
				{ provider: "p", id: "m-heavy", name: "m", input: ["text"], reasoning: true, contextWindow: 200000, cost: { input: 30, output: 90 } },
			],
			find: (provider, id) => (provider === "p" && id === "m-heavy" ? { provider, id } : undefined),
			complete: async (_model, context) => {
				const messages = (context as { messages: Array<{ content: Array<{ type: string; text: string }> }> }).messages;
				assert.ok(messages[0].content[0].text.includes("verify the diff"));
				return { content: [{ type: "text", text: "LGTM with one nit" }], usage: { input: 10, output: 5 } };
			},
		},
	});
	const result = await runDispatch(tool, { mode: "judge", task: "verify the diff", lane: "hard" }, ctx);
	assert.ok(result.content[0].text.includes("[judge p/m-heavy]"));
	assert.ok(result.content[0].text.includes("LGTM"));
	assert.equal(result.isError, undefined);
});

test("judge: explicit out-of-lane model denied under enforce", async () => {
	const pi = fakePi();
	const config = loadedConfig({ enforce: "enforce", router: { ...DEFAULT_CONFIG.router, lanes: { ...DEFAULT_CONFIG.router.lanes, main: [{ provider: "p", model: "m-allowed" }] } } });
	const tool = createDispatchTool({ config: () => config, store: new OutputStore(tmpdir()), pi: pi as never });
	const ctx = fakeCtx();
	const result = await runDispatch(tool, { mode: "judge", task: "x", model: "p/m-forbidden" }, ctx);
	assert.equal(result.isError, true);
	assert.ok(result.content[0].text.includes("enforce"));
});

test("judge: advice mode warns but proceeds when the model resolves", async () => {
	const pi = fakePi();
	const config = loadedConfig({ enforce: "advice", router: { ...DEFAULT_CONFIG.router, lanes: { ...DEFAULT_CONFIG.router.lanes, main: [{ provider: "p", model: "m-allowed" }] } } });
	const tool = createDispatchTool({ config: () => config, store: new OutputStore(tmpdir()), pi: pi as never });
	const ctx = fakeCtx({
		modelRegistry: {
			getAvailable: () => [],
			find: (provider, id) => (provider === "p" ? { provider, id } : undefined),
			complete: async () => ({ content: [{ type: "text", text: "verdict" }] }),
		},
	});
	const result = await runDispatch(tool, { mode: "judge", task: "x", model: "p/m-other" }, ctx);
	assert.equal(result.isError, undefined);
	assert.ok(result.content[0].text.includes("[judge p/m-other]"));
});

test("run: unknown agent fails cleanly", async () => {
	const pi = fakePi();
	const tool = createDispatchTool({ config: () => loadedConfig(), store: new OutputStore(tmpdir()), pi: pi as never });
	const ctx = fakeCtx();
	const result = await runDispatch(tool, { mode: "run", agent: "nope", task: "x" }, ctx);
	assert.equal(result.isError, true);
	assert.ok(result.content[0].text.includes('unknown agent "nope"'));
});

test("parallel: mixed tasks capped, per-task sections", async () => {
	const pi = fakePi();
	const tool = createDispatchTool({ config: () => loadedConfig(), store: new OutputStore(tmpdir()), pi: pi as never });
	const ctx = fakeCtx();
	const result = await runDispatch(tool, {
		mode: "parallel",
		tasks: [
			{ mode: "gather", description: "one", steps: [{ tool: "read", args: { path: "/tmp/a" } }] },
			{ mode: "gather", description: "two", steps: [{ tool: "read", args: { path: "/tmp/b" } }] },
		],
	}, ctx);
	assert.ok(result.content[0].text.includes("== one ✓"));
	assert.ok(result.content[0].text.includes("== two ✓"));
	// too many tasks
	const tooMany = await runDispatch(tool, {
		mode: "parallel",
		tasks: Array.from({ length: 9 }, (_, i) => ({ mode: "gather", steps: [{ tool: "read" }], description: `t${i}` })),
	}, ctx);
	assert.equal(tooMany.isError, true);
	assert.ok(tooMany.content[0].text.includes("at most 8"));
});
