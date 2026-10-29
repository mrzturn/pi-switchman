/** Ledger + dispatch + child parsing + config round-trip + UI rows tests. */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG, mergeConfig, readRawConfig, writeRawConfig } from "../src/config.ts";
import { currentPhysicalModel, ledgerFromBranch, ledgerSummary } from "../src/ledger.ts";
import { finalOutput, parseChildLine } from "../src/child.ts";
import { discoverAgents } from "../src/agents.ts";
import { filterModels, laneRows, mainRows } from "../src/config-ui.ts";
import { tierOf } from "../src/watermark.ts";

// ---- ledger -------------------------------------------------------------------

test("ledgerFromBranch filters and defaults; summary renders", () => {
	const branch = [
		{ type: "custom", customType: "switchman:ledger", data: { id: "1", mode: "gather", description: "find usages", status: "done", ts: 1 }, id: "a", parentId: null, timestamp: "t" },
		{ type: "custom", customType: "other", data: {}, id: "b", parentId: null, timestamp: "t" },
		{ type: "custom", customType: "switchman:ledger", data: { id: "2", mode: "run", description: "review diff", ts: 2 }, id: "c", parentId: null, timestamp: "t" },
	] as never;
	const records = ledgerFromBranch(branch);
	assert.equal(records.length, 2);
	assert.equal(records[0].description, "find usages");
	assert.equal(records[0].status, "done");
	assert.equal(records[1].status, "done"); // default
	const summary = ledgerSummary(records);
	assert.ok(summary.includes('gather "find usages" -> done'));
});

test("currentPhysicalModel resolves the latest assistant message", () => {
	const branch = [
		{ type: "message", message: { role: "user", content: "hi" }, id: "a", parentId: null, timestamp: "t" },
		{ type: "message", message: { role: "assistant", content: [], provider: "p", model: "virtual-not-here" }, id: "b", parentId: null, timestamp: "t" },
		{ type: "message", message: { role: "assistant", content: [], provider: "q", model: "newer-model" }, id: "c", parentId: null, timestamp: "t" },
	] as never;
	assert.deepEqual(currentPhysicalModel(branch), { provider: "q", model: "newer-model" });
	assert.equal(currentPhysicalModel([]), null);
});

// ---- child parsing --------------------------------------------------------------

test("parseChildLine accepts message events, rejects garbage", () => {
	const line = JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } });
	const parsed = parseChildLine(line);
	assert.ok(parsed);
	assert.equal((parsed.message as { role: string }).role, "assistant");
	assert.equal(parseChildLine(""), null);
	assert.equal(parseChildLine("not json"), null);
	assert.equal(parseChildLine(JSON.stringify({ type: "something_else" })), null);
});

test("finalOutput extracts the last assistant text", () => {
	const messages = [
		{ role: "assistant", content: [{ type: "text", text: "first" }] },
		{ role: "toolResult", toolName: "read", toolCallId: "t1", content: [{ type: "text", text: "file" }], isError: false },
		{ role: "assistant", content: [{ type: "text", text: "final answer" }] },
	] as never;
	assert.equal(finalOutput(messages), "final answer");
});

// ---- watermark tier --------------------------------------------------------------

test("tierOf: percent form, token form, and min() of both", () => {
	const w = DEFAULT_CONFIG.watermark; // {70%} {85%} {95%}
	const usage = (tokens: number, window = 100_000) => ({ tokens, contextWindow: window, percent: (tokens / window) * 100 });
	assert.equal(tierOf(usage(50_000), w), "ok");
	assert.equal(tierOf(usage(71_000), w), "soft");
	assert.equal(tierOf(usage(86_000), w), "hard");
	assert.equal(tierOf(usage(96_000), w), "force");
	// absolute budgets on a 1M window: 80k/120k/150k fire far below the percents
	const abs = { soft: { tokens: 80_000 }, hard: { tokens: 120_000 }, force: { tokens: 150_000 } };
	const big = (tokens: number) => ({ tokens, contextWindow: 1_000_000, percent: (tokens / 1_000_000) * 100 });
	assert.equal(tierOf(big(79_999), abs), "ok");
	assert.equal(tierOf(big(80_000), abs), "soft");
	assert.equal(tierOf(big(120_000), abs), "hard");
	assert.equal(tierOf(big(150_000), abs), "force");
	// mixed: min(percent, tokens) — 70% of 100k = 70k vs tokens 80k → 70k wins
	const mixed = { soft: { percent: 70, tokens: 80_000 }, hard: { percent: 85 }, force: { percent: 95 } };
	assert.equal(tierOf(usage(70_000), mixed), "soft");
	assert.equal(tierOf(usage(69_000), mixed), "ok");
});

// ---- config schema + round-trip ---------------------------------------------------

test("router config parsing: lanes, decision model, invalid refs dropped", () => {
	const merged = mergeConfig(DEFAULT_CONFIG, {
		router: {
			lanes: {
				hard: [{ provider: "p", model: "m1" }, { provider: "p", model: "" }],
				main: "not-a-list",
			},
			decisionModel: { provider: "ollama-local", model: "tev1:4b-mxfp8" },
			switchConfidence: 0.9,
		},
	});
	assert.deepEqual(merged.router.lanes.hard, [{ provider: "p", model: "m1" }]);
	assert.equal(merged.router.lanes.main, null); // invalid -> stays auto
	assert.deepEqual(merged.router.decisionModel, { provider: "ollama-local", model: "tev1:4b-mxfp8" });
	assert.equal(merged.router.switchConfidence, 0.9);
});

test("writeRawConfig merges into raw file and preserves unknown keys", () => {
	const dir = mkdtempSync(join(tmpdir(), "sw-raw-"));
	try {
		const path = join(dir, "switchman.json");
		writeFileSync(path, JSON.stringify({ customFutureKey: 7, compress: { threshold: 1000 } }), "utf8");
		writeRawConfig(path, { router: { decisionModel: { provider: "x", model: "y" } } });
		const after = readRawConfig(path);
		assert.equal(after.customFutureKey, 7); // unknown key survives
		assert.deepEqual(after.compress, { threshold: 1000 });
		assert.deepEqual(after.router, { decisionModel: { provider: "x", model: "y" } });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// ---- config UI rows ---------------------------------------------------------------

test("mainRows and laneRows shapes", () => {
	const rows = mainRows(DEFAULT_CONFIG.router);
	assert.equal(rows.length, 6); // 5 lanes + decision
	assert.ok(rows[0].label.startsWith("hard"));
	assert.ok(rows[0].label.includes("(auto"));
	const configured = { ...DEFAULT_CONFIG.router, lanes: { ...DEFAULT_CONFIG.router.lanes, main: [{ provider: "p", model: "m" }] } };
	assert.ok(mainRows(configured).some((row) => row.label.includes("p/m")));

	const empty = laneRows("hard", null);
	assert.equal(empty[0].action, "auto");
	assert.equal(empty[1].action, "add");
	const filled = laneRows("hard", [{ provider: "p", model: "a" }, { provider: "p", model: "b" }]);
	assert.deepEqual(filled.map((row) => row.action), ["model", "model", "add"]);
});

test("filterModels is generic over provider/id shapes", () => {
	const models = [
		{ provider: "p", id: "alpha", name: "A" },
		{ provider: "p", id: "beta", name: "B" },
	];
	assert.equal(filterModels(models, "alp").length, 1);
	assert.equal(filterModels(models, "").length, 2);
	assert.equal(filterModels(models, "zzz").length, 0);
});

// ---- builtin agents floor (package installs ship no agent files) ----------

test("discoverAgents: built-in floor when no agent dirs exist (project scope)", () => {
	const empty = mkdtempSync(join(tmpdir(), "switchman-agents-"));
	const agents = discoverAgents(empty, "project");
	const names = agents.map((a) => a.name).sort();
	assert.deepEqual(names, ["reviewer", "scout", "tester", "worker"]);
	assert.ok(agents.every((a) => a.source === "builtin"));
	const scout = agents.find((a) => a.name === "scout");
	assert.match(scout?.systemPrompt ?? "", /codebase scout/);
	assert.deepEqual(scout?.tools, ["read", "grep", "glob", "find", "ls"]);
});
