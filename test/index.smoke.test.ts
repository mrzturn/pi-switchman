/** Mock-mount smoke test: drive the extension factory end-to-end with a fake
 *  ExtensionAPI — protocol section stability, compression pipeline, expand,
 *  status command. This is the "mock 挂载冒烟" layer of DESIGN.md §9. */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import factory from "../src/index.ts";
import { writeRawConfig } from "../src/config.ts";

interface Recorded {
	events: Map<string, Array<(event: unknown, ctx: unknown) => unknown>>;
	tools: unknown[];
	commands: Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>;
}

function fakePi(): { pi: unknown; recorded: Recorded } {
	const recorded: Recorded = { events: new Map(), tools: [], commands: new Map() };
	const pi = {
		on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
			const list = recorded.events.get(event) ?? [];
			list.push(handler);
			recorded.events.set(event, list);
			return () => {};
		},
		registerTool(tool: unknown) {
			recorded.tools.push(tool);
		},
		registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) {
			recorded.commands.set(name, options);
		},
	};
	return { pi, recorded };
}

function ctxIn(dir: string): { cwd: string; ui: { notifications: string[]; notify(text: string): void } } {
	return { cwd: dir, ui: { notifications: [], notify(text: string) { this.notifications.push(text); } } };
}

async function fire(recorded: Recorded, event: string, payload: unknown, ctx: unknown): Promise<unknown[]> {
	const results: unknown[] = [];
	for (const handler of recorded.events.get(event) ?? []) {
		results.push(await handler(payload, ctx));
	}
	return results;
}

test("M0+M1 wiring smoke: section, compression, expand, status", async () => {
	const dir = mkdtempSync(join(tmpdir(), "sw-smoke-"));
	try {
		const { pi, recorded } = fakePi();
		factory(pi as never);

		// M0: /switchman-status + /switchman-config registered; expand + dispatch tools
		assert.ok(recorded.commands.has("switchman-status"));
		assert.ok(recorded.commands.has("switchman-config"));
		assert.equal(recorded.tools.length, 2);
		const expand = recorded.tools.find((tool: { name: string }) => tool.name === "expand") as { name: string; execute: (id: string, params: Record<string, unknown>) => Promise<unknown> };
		assert.equal(expand.name, "expand");

		// M0: protocol section byte-stable across two runs
		const sections1: Record<string, string> = {};
		const sections2: Record<string, string> = {};
		await fire(recorded, "before_agent_start", { systemPromptOptions: { cwd: dir, sections: sections1 } }, ctxIn(dir));
		await fire(recorded, "before_agent_start", { systemPromptOptions: { cwd: dir, sections: sections2 } }, ctxIn(dir));
		assert.ok(sections1.switchman?.includes("[SWITCHMAN:DOCTRINE]"));
		assert.equal(sections1.switchman, sections2.switchman);
		// annotate section: on by default, byte-stable across runs, and its
		// bytes live in their own key so toggling never perturbs the doctrine
		// section's cache prefix
		assert.ok(sections1["switchman-annotate"]?.includes("[SWITCHMAN:ANNOTATE]"));
		assert.ok(sections1["switchman-annotate"]?.includes("[<YYYY-MM-DD>]-[<what changed and why>]-[<what it aligns with or satisfies>]"));
		assert.equal(sections1["switchman-annotate"], sections2["switchman-annotate"]);

		// M1: oversized result distilled, footer names a readable store path
		const big = Array.from({ length: 500 }, (_, i) => `row ${i + 1} ${"payload ".repeat(20)}`).join("\n");
		const results = (await fire(
			recorded,
			"tool_result",
			{ toolName: "bash", isError: false, parentToolCallId: undefined, input: {}, content: [{ type: "text", text: big }], structuredContent: { output: big, exit_code: 0 } },
			ctxIn(dir),
		)) as Array<{ content: { type: string; text: string }[]; structuredContent?: Record<string, unknown> } | undefined>;
		const replaced = results.find((r) => r !== undefined);
		assert.ok(replaced, "expected a replacement result");
		const text = (replaced as { content: { text: string }[] }).content[0].text;
		assert.ok(text.includes("lines omitted"));
		const pathMatch = text.match(/saved to: (\S+)/);
		assert.ok(pathMatch, "footer names the store path");
		assert.ok(text.length < big.length * 0.5);
		assert.equal((replaced.structuredContent as { output: string }).output, text);

		// M1: expand reads a span of the stored full output
		const expanded = (await expand.execute("t1", { path: pathMatch![1], offset: 10, limit: 5 })) as {
			content: { text: string }[];
		};
		assert.ok(expanded.content[0].text.includes("row 10"));
		assert.ok(expanded.content[0].text.includes("row 14"));
		assert.ok(expanded.content[0].text.includes("lines 10-14"));

		// M1: small and error results pass through untouched
		const untouched = await fire(
			recorded,
			"tool_result",
			{ toolName: "read", isError: false, parentToolCallId: undefined, input: {}, content: [{ type: "text", text: "tiny" }], structuredContent: undefined },
			ctxIn(dir),
		);
		assert.equal(untouched[0], undefined);
		const errored = await fire(
			recorded,
			"tool_result",
			{ toolName: "bash", isError: true, parentToolCallId: undefined, input: {}, content: [{ type: "text", text: big }], structuredContent: undefined },
			ctxIn(dir),
		);
		assert.equal(errored[0], undefined);

		// M0: status command runs and reports the compression
		const statusCtx = ctxIn(dir);
		await recorded.commands.get("switchman-status")!.handler("", statusCtx);
		assert.equal(statusCtx.ui.notifications.length, 1);
		assert.match(statusCtx.ui.notifications[0], /1 compressed/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});


test("language ask-once: three questions in unconfigured tui projects, persisted to project config", async () => {
	const { pi, recorded } = fakePi();
	factory(pi as never);
	const dir = mkdtempSync(join(tmpdir(), "sw-ask-"));
	try {
		const answers = ["zh-CN", "en", "zh-CN"];
		let asked = 0;
		const uiCtx = {
			cwd: dir,
			mode: "tui",
			ui: {
				input: async (_title: string, _placeholder: string) => {
					asked++;
					return answers[asked - 1];
				},
				notify: () => {},
			},
		};
		await fire(recorded, "session_start", {}, uiCtx);
		assert.equal(asked, 3);
		const written = JSON.parse(readFileSync(join(dir, ".pi", "switchman.json"), "utf8"));
		assert.deepEqual(written.skills.language, { default: "zh-CN", commit: "en", docs: "zh-CN" });

		// latch: a second session_start in the same process never asks again
		await fire(recorded, "session_start", {}, uiCtx);
		assert.equal(asked, 3);

		// configured projects are not asked (global layer counts too)
		writeRawConfig(join(dir, ".pi", "switchman.json"), { skills: { language: { default: "de" } } });
		let askedAgain = 0;
		const fresh = fakePi();
		factory(fresh.pi as never);
		const uiCtx2 = {
			cwd: dir,
			mode: "tui",
			ui: { input: async () => { askedAgain++; return "x"; }, notify: () => {} },
		};
		await fire(fresh.recorded, "session_start", {}, uiCtx2);
		assert.equal(askedAgain, 0);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("language ask-once: skips and non-tui modes never write", async () => {
	const { pi, recorded } = fakePi();
	factory(pi as never);
	const dir = mkdtempSync(join(tmpdir(), "sw-ask2-"));
	try {
		// user skips everything: no file, no ask on the next event
		let asked = 0;
		const skipCtx = {
			cwd: dir,
			mode: "tui",
			ui: { input: async () => { asked++; return ""; }, notify: () => {} },
		};
		await fire(recorded, "session_start", {}, skipCtx);
		assert.equal(asked, 3);
		assert.equal(existsSync(join(dir, ".pi", "switchman.json")), false);

		// non-tui (print/rpc) is never asked
		let askedTui = 0;
		await fire(recorded, "session_start", {}, {
			cwd: join(dir, "elsewhere"),
			mode: "print",
			ui: { input: async () => { askedTui++; return "x"; }, notify: () => {} },
		});
		assert.equal(askedTui, 0);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
