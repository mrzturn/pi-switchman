/** Router tests: routeCore with a fake registry — platform stickiness, dual
 *  decoder, keep/switch, classifier failure fallbacks. */

import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_CONFIG, type SwitchmanConfig } from "../src/config.ts";
import { routeCore, type RegistryLike, type RouteRequestLike, type RouterState } from "../src/router.ts";

function factsOf(id: string, provider = "p") {
	return {
		provider,
		id,
		name: id,
		input: ["text" as const],
		reasoning: false,
		contextWindow: 200_000,
		cost: { input: 3, output: 15 },
	};
}

const MODELS = [factsOf("model-heavy"), factsOf("model-flash"), factsOf("model-mid")];
const IMAGE_MODEL = { ...factsOf("model-vision", "p2"), input: ["text" as const, "image" as const] };

function fakeRegistry(
	options: {
		classifyResult?: { stopReason: string; answers?: Record<string, unknown> };
		classifyThrows?: boolean;
		models?: typeof MODELS;
	} = {},
): RegistryLike & { classifyCalls: number } {
	let classifyCalls = 0;
	return {
		classifyCalls: 0,
		get available() {
			return this.getAvailable();
		},
		getAvailable: () => options.models ?? MODELS,
		find: (provider, id) => MODELS.find((m) => m.provider === provider && m.id === id),
		findOfType: () => ({}),
		async classify(_model, _context, _options) {
			classifyCalls++;
			(this as { classifyCalls: number }).classifyCalls = classifyCalls;
			if (options.classifyThrows) throw new Error("endpoint down");
			return (
				options.classifyResult ?? {
					stopReason: "stop",
					answers: { lane: { type: "choice", choice: "main", confidence: 0.9 } },
				}
			);
		},
	};
}

function request(overrides: Partial<RouteRequestLike> = {}): RouteRequestLike {
	return {
		thinkingLevel: "medium",
		reason: "user",
		messages: [{ role: "user", content: [{ type: "text", text: "hello world" }], timestamp: Date.now() }] as never,
		...overrides,
	};
}

const CONFIG: SwitchmanConfig = {
	...DEFAULT_CONFIG,
	router: {
		...DEFAULT_CONFIG.router,
		decisionModel: { provider: "typesafe", model: "jev" },
	},
};

test("continuation keeps previous (platform stickiness, no decision call)", async () => {
	const registry = fakeRegistry();
	const previous = { model: { provider: "p", id: "model-mid" }, thinkingLevel: "high" as never };
	const outcome = await routeCore({ config: () => CONFIG, registry }, request({ reason: "continuation", previous }));
	assert.deepEqual(outcome.ref, { provider: "p", model: "model-mid" });
	assert.equal(outcome.thinking, "high");
});

test("retry keeps the failed model (thinking signature)", async () => {
	const registry = fakeRegistry();
	const failed = { model: { provider: "p", id: "model-flash" }, thinkingLevel: "low" as never };
	const outcome = await routeCore({ config: () => CONFIG, registry }, request({ reason: "retry", failed }));
	assert.deepEqual(outcome.ref, { provider: "p", model: "model-flash" });
	assert.equal(outcome.thinking, "low");
});

test("direct rides the economy lane", async () => {
	const registry = fakeRegistry();
	const outcome = await routeCore({ config: () => CONFIG, registry }, request({ reason: "direct" }));
	// economy auto-picks the light model
	assert.equal(outcome.ref.model, "model-flash");
});

test("user + classifier decision: high confidence switches to lane head and records state", async () => {
	const registry = fakeRegistry({
		classifyResult: { stopReason: "stop", answers: { lane: { type: "choice", choice: "main", confidence: 0.95 } } },
	});
	const outcome = await routeCore({ config: () => CONFIG, registry }, request());
	assert.equal(outcome.ref.model, "model-heavy"); // main head = capability-ranked first
	assert.ok(outcome.state?.decision);
	assert.equal(outcome.state.decision.by, "classifier");
	assert.equal(outcome.state.decision.confidence, 0.95);
});

test("user + in-lane current + low confidence keeps (cache continuation)", async () => {
	const registry = fakeRegistry({
		classifyResult: { stopReason: "stop", answers: { lane: { type: "choice", choice: "main", confidence: 0.6 } } },
	});
	const previous = { model: { provider: "p", id: "model-mid" }, thinkingLevel: "medium" as never };
	const outcome = await routeCore({ config: () => CONFIG, registry }, request({ previous }));
	assert.deepEqual(outcome.ref, { provider: "p", model: "model-mid" });
});

test("classifier down/timeout/error -> builtin baseline, never blocks", async () => {
	const registry = fakeRegistry({ classifyThrows: true });
	const question = [{ role: "user", content: [{ type: "text", text: "what time is it?" }], timestamp: Date.now() }] as never;
	const outcome = await routeCore({ config: () => CONFIG, registry }, request({ messages: question }));
	// builtin: short question -> economy lane -> light model head
	assert.equal(outcome.ref.model, "model-flash");
});

test("decision interval: within the interval the previous decision is reused without a call", async () => {
	const registry = fakeRegistry();
	const state: RouterState = {
		lane: "economy",
		lastPhysical: { provider: "p", model: "model-flash" },
		lastSwitchTs: Date.now(),
		decision: { ts: Date.now(), by: "classifier", lane: "economy", confidence: 0.9 },
	};
	const outcome = await routeCore({ config: () => CONFIG, registry }, request({ state }));
	assert.equal(outcome.ref.model, "model-flash");
	assert.equal(registry.classifyCalls, 0);
});

test("cache window: freshly switched sessions keep the current model even at high confidence", async () => {
	const registry = fakeRegistry({
		classifyResult: { stopReason: "stop", answers: { lane: { type: "choice", choice: "main", confidence: 0.99 } } },
	});
	const state: RouterState = {
		lane: "economy",
		lastPhysical: { provider: "p", model: "model-flash" },
		lastSwitchTs: Date.now(),
	};
	const previous = { model: { provider: "p", id: "model-flash" }, thinkingLevel: "medium" as never };
	const outcome = await routeCore({ config: () => CONFIG, registry }, request({ previous, state }));
	assert.deepEqual(outcome.ref, { provider: "p", model: "model-flash" });
});

test("empty catalog fails over to previous, then to anything available", async () => {
	const registry = fakeRegistry();
	registry.getAvailable = () => [];
	const previous = { model: { provider: "p", id: "model-mid" }, thinkingLevel: "medium" as never };
	const keep = await routeCore({ config: () => CONFIG, registry }, request({ previous }));
	assert.deepEqual(keep.ref, { provider: "p", model: "model-mid" });
});

// ---- image capability gate ----------------------------------------------------

const userImageRequest = request({
	messages: [
		{ role: "user", content: [{ type: "text", text: "what is in this" }, { type: "image" as never, source: {} as never }], timestamp: Date.now() },
	] as never,
});
const toolImageRequest = request({
	reason: "continuation",
	messages: [
		{ role: "user", content: [{ type: "text", text: "read the png" }], timestamp: Date.now() },
		{ role: "assistant", content: [{ type: "text", text: "reading" }], timestamp: Date.now() },
		{ role: "toolResult", results: [{ content: [{ type: "image" as never, source: {} as never }] }] },
	] as never,
});

test("image gate: user attachment overrides continuation stickiness and routes to a vision model", async () => {
	const registry = fakeRegistry({ models: [...MODELS, IMAGE_MODEL] });
	const previous = { model: { provider: "p", id: "model-mid" }, thinkingLevel: "high" as never };
	const outcome = await routeCore({ config: () => CONFIG, registry }, { ...toolImageRequest, previous });
	assert.deepEqual(outcome.ref, { provider: "p2", model: "model-vision" });
	assert.equal(outcome.state?.lane, "vision");
	assert.equal(registry.classifyCalls, 0); // gate short-circuits the classifier
});

test("image gate: image-capable previous model keeps the cache", async () => {
	const registry = fakeRegistry({ models: [...MODELS, IMAGE_MODEL] });
	const previous = { model: { provider: "p2", id: "model-vision" }, thinkingLevel: "medium" as never };
	const outcome = await routeCore({ config: () => CONFIG, registry }, { ...userImageRequest, previous });
	assert.deepEqual(outcome.ref, { provider: "p2", model: "model-vision" });
	assert.equal(registry.classifyCalls, 0);
});

test("image gate: overrides decision-interval lane reuse", async () => {
	const registry = fakeRegistry({ models: [...MODELS, IMAGE_MODEL] });
	const outcome = await routeCore(
		{ config: () => CONFIG, registry },
		{
			...userImageRequest,
			state: { lane: "main", lastPhysical: { provider: "p", model: "model-heavy" }, lastSwitchTs: Date.now(), decision: { ts: Date.now(), by: "classifier", lane: "main", confidence: 0.95 } },
		},
	);
	assert.equal(outcome.ref.model, "model-vision");
});

test("image gate: fail-open when no image-capable model exists", async () => {
	const registry = fakeRegistry(); // all text models
	const outcome = await routeCore({ config: () => CONFIG, registry }, userImageRequest);
	// normal routing path runs (classifier picks main); images are stripped downstream
	assert.equal(outcome.ref.model, "model-heavy");
	assert.equal(registry.classifyCalls, 1);
});

test("image gate: flat agent-session toolResult shape (read tool on an image)", async () => {
	// The shape pi's agent state actually uses after `read` on a png: content
	// directly on the toolResult message, no results[] wrapper. Regression: the
	// gate used to miss this shape and sticky continuation stayed on a text model.
	const flatRequest = request({
		reason: "continuation",
		messages: [
			{ role: "user", content: [{ type: "text", text: "看截图" }], timestamp: Date.now() },
			{ role: "assistant", content: [{ type: "toolCall", id: "t1", name: "read", arguments: {} }], timestamp: Date.now() },
			{ role: "toolResult", toolCallId: "t1", toolName: "read", content: [{ type: "text", text: "Read image file" }, { type: "image" as never, source: {} as never }] },
		] as never,
	});
	const registry = fakeRegistry({ models: [...MODELS, IMAGE_MODEL] });
	const previous = { model: { provider: "p", id: "model-mid" }, thinkingLevel: "medium" as never };
	const outcome = await routeCore({ config: () => CONFIG, registry }, { ...flatRequest, previous });
	assert.deepEqual(outcome.ref, { provider: "p2", model: "model-vision" });
	assert.equal(outcome.state?.lane, "vision");
});
