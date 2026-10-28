/** Vision relay tests: threshold decision, describe-inject flow, fail-open
 *  paths back to the router's image gate. */

import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_CONFIG, mergeConfig } from "../src/config.ts";
import { describeImages, describeModelRef, relayDecision, registerVisionRelay } from "../src/vision-relay.ts";

test("relayDecision: every branch of the threshold gate", () => {
	const base = { hasImages: true, thresholdTokens: 50_000, contextTokens: 120_000, physicalImageCapable: false };
	assert.equal(relayDecision(base), "relay"); // large context + text model: describe-inject
	assert.equal(relayDecision({ ...base, hasImages: false }), "gate");
	assert.equal(relayDecision({ ...base, thresholdTokens: 0 }), "gate"); // relay disabled
	assert.equal(relayDecision({ ...base, physicalImageCapable: true }), "gate"); // native vision: keep images
	assert.equal(relayDecision({ ...base, physicalImageCapable: null }), "gate"); // unknown model: lossless switch
	assert.equal(relayDecision({ ...base, contextTokens: null }), "gate"); // size unknown: switch
	assert.equal(relayDecision({ ...base, contextTokens: 49_999 }), "gate"); // small: cheap cold read
});

test("mergeConfig: vision relay defaults, override, clamps", () => {
	assert.equal(DEFAULT_CONFIG.router.visionRelayThresholdTokens, 50_000);
	assert.equal(DEFAULT_CONFIG.router.visionRelayTimeoutMs, 30_000);
	const over = mergeConfig(DEFAULT_CONFIG, { router: { visionRelayThresholdTokens: 100_000, visionRelayTimeoutMs: 60_000 } });
	assert.equal(over.router.visionRelayThresholdTokens, 100_000);
	assert.equal(over.router.visionRelayTimeoutMs, 60_000);
	const clamped = mergeConfig(DEFAULT_CONFIG, { router: { visionRelayThresholdTokens: -5, visionRelayTimeoutMs: 10 } });
	assert.equal(clamped.router.visionRelayThresholdTokens, 50_000); // invalid falls back
	assert.equal(clamped.router.visionRelayTimeoutMs, 1_000); // floor
	const off = mergeConfig(DEFAULT_CONFIG, { router: { visionRelayThresholdTokens: 0 } });
	assert.equal(off.router.visionRelayThresholdTokens, 0); // 0 explicitly disables relay
	const inherited = mergeConfig(over, { router: { switchConfidence: 0.5 } });
	assert.equal(inherited.router.visionRelayThresholdTokens, 100_000); // absent key inherits
});

function fakeCtx(options: {
	tokens?: number | null;
	textPhysical?: boolean;
	describe?: string | null;
	capableVision?: boolean;
} = {}) {
	const calls: { complete: unknown[] } = { complete: [] };
	const available = [
		{ provider: "p", id: "model-mid", input: ["text"], reasoning: false, contextWindow: 200_000, cost: { input: 3, output: 15 } },
		...(options.capableVision === false
			? []
			: [{ provider: "p2", id: "model-vision", input: ["text", "image"], reasoning: false, contextWindow: 200_000, cost: { input: 1, output: 5 } }]),
	];
	const ctx = {
		hasUI: false,
		getContextUsage: () => ({ tokens: options.tokens === undefined ? 120_000 : options.tokens, contextWindow: 200_000, percent: 0.6 }),
		sessionManager: {
			getBranch: () => [{ type: "pi.virtual-model-state", data: { state: { lastPhysical: { provider: "p", model: options.textPhysical === false ? "model-vision" : "model-mid" } } } }],
		},
		modelRegistry: {
			getAvailable: () => available,
			find: (provider: string, id: string) => available.find((m) => m.provider === provider && m.id === id),
			complete: async (model: unknown, request: unknown, completeOptions?: { signal?: AbortSignal }) => {
				calls.complete.push({ model, request, options: completeOptions });
				if (options.describe === null) throw new Error("provider down");
				return { content: [{ type: "text", text: options.describe ?? "A terminal screenshot showing a pi TUI session." }] };
			},
		},
	};
	return { ctx: ctx as never, calls };
}

async function runHandler(ctx: never, images: { type: "image" }[], config = DEFAULT_CONFIG) {
	const handlers: ((event: unknown, ctx: never) => Promise<unknown>)[] = [];
	const pi = { on: (_event: string, handler: (event: unknown, ctx: never) => Promise<unknown>) => { handlers.push(handler); return () => {}; } } as never;
	registerVisionRelay(pi, { config: () => config });
	const event = { messageType: "user", prompt: "why did auto-continue fail, see screenshot", images };
	return await handlers[0](event as never, ctx);
}

test("relay: large context + text model describes, splices images, injects message", async () => {
	const { ctx, calls } = fakeCtx();
	const images = [{ type: "image" as const }];
	const result = (await runHandler(ctx, images)) as { message: { customType: string; content: { text: string }[] } };
	assert.equal(calls.complete.length, 1);
	const request = calls.complete[0].request as { messages: { content: unknown[] }[] };
	assert.equal(request.messages[0].content.filter((part) => (part as { type: string }).type === "image").length, 1);
	assert.equal(images.length, 0); // spliced out of the shared trigger array
	assert.equal(result.message.customType, "switchman.image-describe");
	assert.ok(result.message.content[0].text.includes("terminal screenshot"));
	assert.ok(result.message.content[0].text.includes("p2/model-vision"));
});

test("relay: describe failure leaves images for the gate (fail-open)", async () => {
	const { ctx } = fakeCtx({ describe: null } as never);
	const images = [{ type: "image" as const }];
	const result = await runHandler(ctx, images);
	assert.equal(result, undefined);
	assert.equal(images.length, 1); // untouched -> router image gate switches the turn
});

test("relay: small context and capable model are not intercepted", async () => {
	const small = fakeCtx({ tokens: 10_000 });
	assert.equal(await runHandler(small.ctx, [{ type: "image" }]), undefined);
	const capable = fakeCtx({ textPhysical: false });
	assert.equal(await runHandler(capable.ctx, [{ type: "image" }]), undefined);
	assert.equal(capable.calls.complete.length, 0);
});

test("relay: no image-capable model -> no interception (gate strips or switches)", async () => {
	const { ctx } = fakeCtx({ capableVision: false });
	assert.equal(await runHandler(ctx, [{ type: "image" }]), undefined);
});

test("describeModelRef: vision lane ordering", () => {
	const { ctx } = fakeCtx();
	assert.deepEqual(describeModelRef(ctx, DEFAULT_CONFIG), { provider: "p2", model: "model-vision" });
	const none = fakeCtx({ capableVision: false });
	assert.equal(describeModelRef(none.ctx, DEFAULT_CONFIG), null);
});

test("describeImages: returns null on provider failure", async () => {
	const { ctx } = fakeCtx();
	const ok = await describeImages(ctx as never, { provider: "p2", model: "model-vision" }, [{ type: "image" } as never], "ctx", 5_000);
	assert.match(ok ?? "", /screenshot/);
	const missing = await describeImages(ctx as never, { provider: "p2", model: "nope" }, [], "ctx", 5_000);
	assert.equal(missing, null);
});
