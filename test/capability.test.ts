/** Capability layer tests: tier inference, ranking, lane candidates, builtin
 *  decision baseline, keep-or-switch verdict. */

import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_CONFIG, type SwitchmanConfig } from "../src/config.ts";
import { builtinDecision, decideSwitch, inferTier, laneCandidates, rankByCapability, type ModelFacts } from "../src/capability.ts";

function facts(overrides: Partial<ModelFacts> & { id: string; provider?: string }): ModelFacts {
	return {
		provider: overrides.provider ?? "test",
		id: overrides.id,
		name: overrides.id,
		input: overrides.input ?? ["text"],
		reasoning: overrides.reasoning ?? false,
		contextWindow: overrides.contextWindow ?? 200_000,
		cost: overrides.cost ?? { input: 3, output: 15 },
	};
}

test("inferTier: name heuristics across provider conventions", () => {
	assert.equal(inferTier(facts({ id: "glm-5.3-flash" })), "light");
	assert.equal(inferTier(facts({ id: "claude-haiku-4-5" })), "light");
	assert.equal(inferTier(facts({ id: "gpt-5.6-mini" })), "light");
	assert.equal(inferTier(facts({ id: "claude-opus-4-5" })), "heavy");
	assert.equal(inferTier(facts({ id: "glm-5.3" })), "mid");
	assert.equal(inferTier(facts({ id: "some-unknown-model" })), "mid");
});

test("inferTier: cost as weak proxy when the name says nothing", () => {
	assert.equal(inferTier(facts({ id: "mystery", cost: { input: 0.2, output: 1 } })), "light");
	assert.equal(inferTier(facts({ id: "mystery-xl", cost: { input: 30, output: 90 } })), "heavy");
});

test("rankByCapability: anchors override inference, cost breaks ties", () => {
	const a = facts({ id: "model-a", provider: "p", cost: { input: 1, output: 2 } });
	const b = facts({ id: "model-b", provider: "p", cost: { input: 5, output: 10 } });
	const c = facts({ id: "model-c", provider: "p", cost: { input: 0.8, output: 2 } });
	// all three name-mid; cost keeps c cheapest among the mids. b is anchored heavy.
	const config = { ...DEFAULT_CONFIG, anchors: [{ provider: "p", model: "model-b", tier: "heavy" as const }] };
	const ranked = rankByCapability([a, b, c], config.anchors);
	assert.equal(ranked[0].id, "model-b"); // anchored heavy despite light name
	assert.equal(ranked[1].id, "model-c"); // cheaper mid first
	assert.equal(ranked[2].id, "model-a");
});

test("laneCandidates: configured list wins with availability filter and order", () => {
	const config: SwitchmanConfig = {
		...DEFAULT_CONFIG,
		router: {
			...DEFAULT_CONFIG.router,
			lanes: {
				...DEFAULT_CONFIG.router.lanes,
				hard: [
					{ provider: "p", model: "model-a" },
					{ provider: "p", model: "missing" },
					{ provider: "p", model: "model-b" },
				],
			},
		},
	};
	const available = [facts({ id: "model-a", provider: "p" }), facts({ id: "model-b", provider: "p" })];
	const refs = laneCandidates("hard", config, available);
	assert.deepEqual(refs, [
		{ provider: "p", model: "model-a" },
		{ provider: "p", model: "model-b" },
	]);
});

test("laneCandidates: auto-selection — vision filters on image input, economy prefers light, main heads heavy", () => {
	const vision = facts({ id: "model-v", provider: "p", input: ["text", "image"] });
	const light = facts({ id: "claude-haiku-4-5", provider: "p" });
	const heavy = facts({ id: "claude-opus-4-5", provider: "p" });
	const available = [facts({ id: "glm-4.7", provider: "p" }), light, heavy, vision];
	assert.deepEqual(laneCandidates("vision", DEFAULT_CONFIG, available), [{ provider: "p", model: "model-v" }]);
	assert.deepEqual(laneCandidates("economy", DEFAULT_CONFIG, available), [{ provider: "p", model: "claude-haiku-4-5" }]);
	assert.deepEqual(laneCandidates("main", DEFAULT_CONFIG, available)[0], { provider: "p", model: "claude-opus-4-5" });
});

test("builtinDecision: rule chain", () => {
	const lanes = ["hard", "main", "economy", "review", "vision"] as const;
	assert.equal(builtinDecision({ lastUserText: "look at this", hasImages: true, thinkingLevel: "low", liveLanes: lanes }).lane, "vision");
	assert.equal(
		builtinDecision({ lastUserText: "refactor the auth layer across services", hasImages: false, thinkingLevel: "medium", liveLanes: lanes }).lane,
		"hard",
	);
	assert.equal(builtinDecision({ lastUserText: "what does this flag do?", hasImages: false, thinkingLevel: "low", liveLanes: lanes }).lane, "economy");
	assert.equal(builtinDecision({ lastUserText: "add input validation to the endpoint", hasImages: false, thinkingLevel: "medium", liveLanes: lanes }).lane, "main");
	// heavy signal only reroutes when the lane is live
	assert.equal(
		builtinDecision({ lastUserText: "refactor everything", hasImages: false, thinkingLevel: "medium", liveLanes: ["main"] }).lane,
		"main",
	);
});

test("decideSwitch: cache window and confidence double gate", () => {
	const current = { provider: "p", model: "cur" };
	const head = { provider: "p", model: "head" };
	const candidates = [head, current];
	// in-lane, low confidence -> keep
	assert.deepEqual(
		decideSwitch({ current, candidates, confidence: 0.5, switchConfidence: 0.8, withinCacheWindow: false }),
		{ action: "keep" },
	);
	// in-lane, high confidence, inside cache window -> keep
	assert.deepEqual(
		decideSwitch({ current, candidates, confidence: 0.95, switchConfidence: 0.8, withinCacheWindow: true }),
		{ action: "keep" },
	);
	// in-lane, high confidence, outside window -> switch to head
	assert.deepEqual(
		decideSwitch({ current, candidates, confidence: 0.95, switchConfidence: 0.8, withinCacheWindow: false }),
		{ action: "switch", pick: head },
	);
	// not in candidates -> switch regardless
	assert.deepEqual(
		decideSwitch({ current, candidates: [head], confidence: 0.5, switchConfidence: 0.8, withinCacheWindow: true }),
		{ action: "switch", pick: head },
	);
	// empty candidates -> keep (caller falls back)
	assert.deepEqual(
		decideSwitch({ current, candidates: [], confidence: 1, switchConfidence: 0.8, withinCacheWindow: false }),
		{ action: "keep" },
	);
});
