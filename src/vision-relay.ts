/** [M5] Vision relay — the large-context half of the image capability gate.
 *
 *  When a user turn carries images but the conversation runs on a text-only
 *  model and the context is large, cold-switching the whole turn to a vision
 *  model re-reads the entire history uncached. Instead, this relay:
 *
 *    1. asks a cheap vision-lane model to describe the images (one small,
 *       image-only request via modelRegistry.complete), and
 *    2. splices the images out of the run trigger (before_agent_start gets a
 *       shallow copy, so event.images is the live array) and injects the
 *       description as a custom message right after the user message.
 *
 *  The router's image gate then sees a text-only request and keeps the current
 *  model — prompt cache intact, no full-context re-read. Every failure path
 *  (no vision model, describe error/timeout, splice rejection) leaves the
 *  images untouched, and the gate falls back to switching the whole turn:
 *  relay is an optimization layered on the gate, never a dependency of it.
 *
 *  Coordination contract with the gate (src/router.ts, step 0):
 *    - relay only fires at/above visionRelayThresholdTokens; below it the gate
 *      switches turns (small context = cheap cold read, lossless perception).
 *    - relay only fires when the current physical model is text-only; an
 *      image-capable model keeps its images (gate keeps it sticky). */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { LaneName, ModelRef, SwitchmanConfig } from "./config.ts";
import { laneCandidates } from "./capability.ts";

/** Pure decision for testability: when should the relay intercept this turn? */
export function relayDecision(input: {
	hasImages: boolean;
	thresholdTokens: number;
	contextTokens: number | null;
	physicalImageCapable: boolean | null;
}): "relay" | "gate" {
	if (!input.hasImages) return "gate";
	if (input.thresholdTokens <= 0) return "gate"; // relay disabled
	if (input.physicalImageCapable === null) return "gate"; // unknown model: prefer lossless switch
	if (input.physicalImageCapable) return "gate"; // current model reads images natively
	if (input.contextTokens === null) return "gate"; // size unknown (post-compaction): switch
	if (input.contextTokens < input.thresholdTokens) return "gate"; // small: cheap to switch
	return "relay";
}

/** First image-capable model, vision-lane ordering first (same order the gate
 *  would switch to, so the relay describes with the model that would answer). */
export function describeModelRef(ctx: ExtensionContext, config: SwitchmanConfig): ModelRef | null {
	let available: { provider: string; id: string; input?: readonly string[] }[] = [];
	try {
		available = ctx.modelRegistry.getAvailable() as never;
	} catch {
		return null;
	}
	const capable = (facts: { input?: readonly string[] } | undefined) => facts?.input?.includes("image") === true;
	for (const ref of laneCandidates("vision", config, available as never)) {
		if (capable(available.find((m) => m.provider === ref.provider && m.id === ref.model))) return ref;
	}
	const fallback = available.find((m) => capable(m));
	return fallback === undefined ? null : { provider: fallback.provider, model: fallback.id };
}

/** Last physical model the switchman/auto router landed on, from the session
 *  branch's virtual-model-state entry. Null when unknown (fresh session). */
function lastPhysicalRef(ctx: ExtensionContext): ModelRef | null {
	try {
		const branch = ctx.sessionManager.getBranch() as { type?: string; data?: { state?: { lastPhysical?: ModelRef } } }[];
		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i];
			if (entry?.type === "pi.virtual-model-state") {
				const ref = entry.data?.state?.lastPhysical;
				if (ref !== undefined && ref !== null) return ref;
			}
		}
	} catch {
		/* unknown: the gate handles it */
	}
	return null;
}

function modelIsImageCapable(ctx: ExtensionContext, ref: ModelRef): boolean | null {
	try {
		const model = ctx.modelRegistry.find(ref.provider, ref.model) as { input?: readonly string[] } | undefined;
		if (model === undefined || model === null) return null;
		return model.input?.includes("image") === true;
	} catch {
		return null;
	}
}

/** One-shot describe call, mirroring the dispatch judge channel. Returns null
 *  on any failure so the caller can fail open to the gate. */
export async function describeImages(
	ctx: ExtensionContext,
	ref: ModelRef,
	images: readonly ImageContent[],
	promptText: string,
	timeoutMs: number,
): Promise<string | null> {
	let model: unknown;
	try {
		model = ctx.modelRegistry.find(ref.provider, ref.model);
	} catch {
		return null;
	}
	if (model === undefined || model === null) return null;
	const relevance = promptText.slice(-800);
	const labels = images.map((_, index) => `[image ${index + 1}]`).join(" ");
	const signal = AbortSignal.timeout(timeoutMs);
	try {
		const response = (await (ctx.modelRegistry as unknown as {
			complete: (model: unknown, request: unknown, options?: { signal?: AbortSignal }) => Promise<{ content?: unknown }>;
		}).complete(model, {
			systemPrompt:
				"You describe images for a coding agent that cannot see them. Be factual and dense: UI elements, text content, layout, colors, error messages, diagrams — whatever is visually there. No speculation, no advice.",
			messages: [
				{
					role: "user" as const,
					content: [
						{
							type: "text" as const,
							text: `Describe each attached image (${labels}) for the coding agent. The user's accompanying request, for relevance: "${relevance}"`,
						},
						...images,
					],
					timestamp: Date.now(),
				},
			],
		}, { signal })) as { content?: unknown };
		const parts = Array.isArray(response?.content) ? (response.content as { type?: string; text?: string }[]) : [];
		const text = parts
			.filter((part) => part.type === "text" && typeof part.text === "string")
			.map((part) => part.text)
			.join("\n")
			.trim();
		return text === "" ? null : text;
	} catch {
		return null; // timeout, provider error, unsupported content: gate takes over
	}
}

export function registerVisionRelay(pi: ExtensionAPI, deps: { config: () => SwitchmanConfig }): void {
	pi.on("before_agent_start", async (event, ctx) => {
		try {
			if (event.messageType !== "user") return;
			const images = event.images;
			if (images === undefined || images.length === 0) return;
			const config = deps.config();
			if (!config.router.enabled || config.disabled) return;

			const physical = lastPhysicalRef(ctx);
			const usage = ctx.getContextUsage();
			const decision = relayDecision({
				hasImages: true,
				thresholdTokens: config.router.visionRelayThresholdTokens,
				contextTokens: usage?.tokens ?? null,
				physicalImageCapable: physical === null ? null : modelIsImageCapable(ctx, physical),
			});
			if (decision !== "relay") return;

			const ref = describeModelRef(ctx, config);
			if (ref === null) return; // no describer: gate switches the turn
			const description = await describeImages(ctx, ref, images, event.prompt, config.router.visionRelayTimeoutMs);
			if (description === null) return; // describe failed: gate switches the turn
			const count = images.length;

			// Remove the images from the run trigger. event is a shallow copy of
			// the trigger, so event.images is the live array pi will normalize.
			try {
				images.splice(0, images.length);
			} catch {
				return; // frozen/immutable: fail open to the gate
			}
			if (ctx.hasUI) {
				try {
					ctx.ui.notify(`switchman: vision relay — ${count} image(s) described via ${ref.provider}/${ref.model}`, "info");
				} catch {
					/* best effort */
				}
			}
			return {
				message: {
					customType: "switchman.image-describe",
					content: [
						{
							type: "text" as const,
							text: `[SWITCHMAN:VISION-RELAY] The user attached ${count} image(s); the active model cannot read images, so ${ref.provider}/${ref.model} described them. Description:\n\n${description}\n\nWork from this description as if you had seen the images.`,
						},
					],
					display: true,
				},
			};
		} catch {
			return; // fail-open: untouched images let the gate switch the turn
		}
	});
}
