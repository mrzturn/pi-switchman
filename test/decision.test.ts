/** Decision endpoint + auto-continue tests: validation, provider config
 *  construction, fail-open registration, layered config merge, TUI rows,
 *  and the force-tier compaction continuation. */

import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_CONFIG, mergeConfig } from "../src/config.ts";
import { buildDecisionProviderConfig, normalizeDecisionBaseUrl, registerDecisionEndpoint, validEndpoint } from "../src/decision-model.ts";
import { decisionRows, endpointPrefill, ENDPOINT_FIELDS } from "../src/config-ui.ts";
import { AUTO_CONTINUE_MESSAGE, applyWatermark } from "../src/watermark.ts";

test("validEndpoint: rejects empty fields and non-http URLs", () => {
	assert.equal(validEndpoint({ provider: "p", baseUrl: "http://127.0.0.1:11434/v1/systemone", model: "tev1" }), null);
	assert.equal(validEndpoint({ provider: "p", baseUrl: "https://api.example.com", model: "tev1" }), null);
	assert.match(validEndpoint({ provider: " ", baseUrl: "http://x", model: "m" }) ?? "", /provider/);
	assert.match(validEndpoint({ provider: "p", baseUrl: "ollama://x", model: "m" }) ?? "", /http/);
	assert.match(validEndpoint({ provider: "p", baseUrl: "http://x", model: "" }) ?? "", /model/);
});

test("buildDecisionProviderConfig: systemone classifier, local key fallback", () => {
	const config = buildDecisionProviderConfig({ provider: "sw", baseUrl: "http://127.0.0.1:8080/s1", model: "tev1:4b" });
	assert.equal(config.baseUrl, "http://127.0.0.1:8080/s1");
	assert.equal(config.apiKey, "local"); // pi requires a key; local endpoints get a literal
	assert.equal(config.models.length, 1);
	const model = config.models[0];
	assert.equal(model.type, "classifier");
	assert.equal(model.api, "typesafe-system-one");
	assert.equal(model.id, "tev1:4b");
	assert.deepEqual(model.input, ["text"]);
	assert.deepEqual(model.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

	const keyed = buildDecisionProviderConfig({ provider: "sw", baseUrl: "http://x", model: "m", apiKey: "sk-1" });
	assert.equal(keyed.apiKey, "sk-1");
});

test("normalizeDecisionBaseUrl: dsh-style full endpoint and bare base both land on the transport base", () => {
	// pi's typesafe-system-one transport appends the `systemone` segment itself:
	// new URL("systemone", baseUrl + "/"). A dsh-style FULL endpoint URL (what
	// dsh calls directly) must be stripped, or the request hits /v1/systemone/systemone.
	assert.equal(normalizeDecisionBaseUrl("http://127.0.0.1:11434/v1/systemone"), "http://127.0.0.1:11434/v1");
	assert.equal(normalizeDecisionBaseUrl("http://127.0.0.1:11434/v1/systemone/"), "http://127.0.0.1:11434/v1");
	assert.equal(normalizeDecisionBaseUrl("http://127.0.0.1:11434/v1"), "http://127.0.0.1:11434/v1");
	assert.equal(normalizeDecisionBaseUrl("http://127.0.0.1:11434/v1///"), "http://127.0.0.1:11434/v1");
	assert.equal(normalizeDecisionBaseUrl("https://api.example.com/systemone/systemone"), "https://api.example.com/systemone");
	// user-style full URL flows through the provider config normalized
	const config = buildDecisionProviderConfig({ provider: "sw", baseUrl: "http://127.0.0.1:11434/v1/systemone", model: "d3:4b-mxfp8" });
	assert.equal(config.baseUrl, "http://127.0.0.1:11434/v1");
});

test("registerDecisionEndpoint: fail-open on invalid input and pi rejection", () => {
	const calls: unknown[][] = [];
	const pi = { registerProvider(name: string, config: unknown) { calls.push([name, config]); } } as never;
	assert.equal(registerDecisionEndpoint(pi, { provider: "sw", baseUrl: "http://x", model: "m" }), true);
	assert.equal(calls.length, 1);
	assert.equal(calls[0][0], "sw");
	assert.equal(registerDecisionEndpoint(pi, { provider: "", baseUrl: "http://x", model: "m" }), false);
	assert.equal(calls.length, 1); // no call for invalid entries
	const throwing = { registerProvider() { throw new Error("no"); } } as never;
	assert.equal(registerDecisionEndpoint(throwing, { provider: "sw", baseUrl: "http://x", model: "m" }), false);
});

test("mergeConfig: decisionEndpoint valid/invalid/clear/inherit", () => {
	const entry = { provider: "sw-decision", baseUrl: "http://127.0.0.1:11434/v1/systemone", model: "tev1:4b-mxfp8" };
	const withEndpoint = mergeConfig(DEFAULT_CONFIG, { router: { decisionEndpoint: entry } });
	assert.deepEqual(withEndpoint.router.decisionEndpoint, entry);

	const invalid = mergeConfig(DEFAULT_CONFIG, { router: { decisionEndpoint: { provider: "x" } } });
	assert.equal(invalid.router.decisionEndpoint, null);

	const cleared = mergeConfig(withEndpoint, { router: { decisionEndpoint: null } });
	assert.equal(cleared.router.decisionEndpoint, null);

	// absent key inherits the base value (project override without the field)
	const inherited = mergeConfig(withEndpoint, { router: { switchConfidence: 0.5 } });
	assert.deepEqual(inherited.router.decisionEndpoint, entry);
});

test("decisionRows: options, endpoint rows appear only when relevant", () => {
	const classifiers = [{ provider: "typesafe", id: "jev-latest", name: "Jev" }];
	const without = decisionRows(classifiers, "", null);
	assert.equal(without[0].action, "none");
	assert.equal(without[1].action, "classifier");
	assert.equal(without[1].provider, "typesafe");
	assert.equal(without[2].action, "endpoint"); // add…
	assert.equal(without.length, 3); // no remove row without an endpoint

	const withEndpoint = decisionRows(classifiers, "jev", { provider: "sw", baseUrl: "http://x", model: "tev1" });
	assert.equal(withEndpoint.length, 4);
	assert.equal(withEndpoint[1].action, "classifier"); // filter matched
	assert.ok(withEndpoint[2].label.includes("edit local endpoint"));
	assert.equal(withEndpoint[3].action, "removeEndpoint");

	const noneMatched = decisionRows(classifiers, "zzz", null);
	assert.equal(noneMatched.length, 2); // none + endpoint row survive filtering
});

test("endpointPrefill: defaults for a fresh entry, values for an existing one", () => {
	const fresh = endpointPrefill(null);
	assert.equal(ENDPOINT_FIELDS.length, 4);
	assert.equal(fresh[0], "switchman-decision");
	assert.match(fresh[1], /^http:\/\//);
	assert.equal(fresh[2], "");
	assert.equal(fresh[3], "");
	const existing = endpointPrefill({ provider: "sw", baseUrl: "http://h/s1", model: "tev1", apiKey: "k" });
	assert.deepEqual(existing, ["sw", "http://h/s1", "tev1", "k"]);
});

test("watermark: force tier never compacts mid-run (pi's own compaction owns it)", async () => {
	const handlers = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>();
	const pi = {
		on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
			return () => {};
		},
	} as never;
	let scales: number[] = [];
	let compacted = 0;
	const ctx = {
		hasUI: true,
		getContextUsage: () => ({ percent: 96 }),
		// compact() aborts a live agent run first — the historical "This operation
		// was aborted" dead turns were self-inflicted by calling it from turn_end.
		compact: () => {
			compacted++;
		},
		sessionManager: {},
		registerStatusItem: () => {},
		updateStatusItem: () => {},
		sendMessage: () => {},
	} as never;
	applyWatermark(pi, {
		config: () => ({
			watermark: DEFAULT_CONFIG.watermark,
			compress: { hardRatio: DEFAULT_CONFIG.compress.hardRatio },
			disabled: false,
		}),
		setThresholdScale: (scale) => scales.push(scale),
		onTier: () => {},
		afterCompact: () => {},
	});
	const turnEnd = handlers.get("turn_end") ?? [];
	await turnEnd[0]({ message: { stopReason: "toolUse" } }, ctx); // normal turn crossing force tier
	assert.equal(compacted, 0, "turn_end must never call ctx.compact — it aborts the live run");
	assert.ok(scales.includes(DEFAULT_CONFIG.compress.hardRatio)); // fuse tightened
});

function watermarkHarness(branch: unknown[], usage = { percent: 50 }) {
	const handlers = new Map<string, ((event: unknown, ctx: unknown) => Promise<void>)[]>();
	const pi = {
		on: (event: string, handler: (event: unknown, ctx: unknown) => Promise<void>) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
			return () => {};
		},
	} as never;
	let continued = 0;
	applyWatermark(pi, {
		config: () => ({
			watermark: DEFAULT_CONFIG.watermark,
			compress: { hardRatio: DEFAULT_CONFIG.compress.hardRatio },
			disabled: false,
		}),
		setThresholdScale: () => {},
		onTier: () => {},
		afterCompact: () => {
			continued++;
		},
	});
	const ctx = {
		hasUI: false,
		getContextUsage: () => usage,
		sessionManager: { getBranch: () => branch },
	} as never;
	return { handlers, ctx, count: () => continued };
}

test("watermark: dead-turn continuation on a provider-killed response", async () => {
	// turn_end carries the assistant message itself; pi's finishTurn hook fires it
	// BEFORE any post-error compaction decision, so the check must not wait for a
	// compaction entry. stopReason "error" (provider abort) → queue the followUp.
	const { handlers, ctx, count } = watermarkHarness([]);
	const turnEnd = handlers.get("turn_end") ?? [];
	await turnEnd[0]({ message: { role: "assistant", stopReason: "error", errorMessage: "This operation was aborted" } }, ctx);
	assert.equal(count(), 1);
	// cooldown blocks an immediate repeat
	await turnEnd[0]({ message: { role: "assistant", stopReason: "error" } }, ctx);
	assert.equal(count(), 1);
});

test("watermark: no continuation for finished, aborted, or tool-use turns", async () => {
	const { handlers, ctx, count } = watermarkHarness([]);
	const turnEnd = handlers.get("turn_end") ?? [];
	// finished turn
	await turnEnd[0]({ message: { role: "assistant", stopReason: "stop" } }, ctx);
	// user pressed Esc: aborted is the user's own interrupt — never continue
	await turnEnd[0]({ message: { role: "assistant", stopReason: "aborted" } }, ctx);
	// mid-run tool use turn
	await turnEnd[0]({ message: { role: "assistant", stopReason: "toolUse" } }, ctx);
	assert.equal(count(), 0);
});

test("AUTO_CONTINUE_MESSAGE: byte-stable continuation contract", () => {
	assert.ok(AUTO_CONTINUE_MESSAGE.startsWith("[SWITCHMAN:CONTINUE]"));
	assert.ok(AUTO_CONTINUE_MESSAGE.includes("dispatch ledger"));
});
