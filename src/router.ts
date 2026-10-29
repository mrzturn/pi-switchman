/** [C] switchman/auto virtual model: dual-decoder lane routing with
 *  stickiness (DESIGN §4.3). The route core is dependency-injected so the
 *  decision logic is unit-testable without pi; registerRouter wires it into
 *  pi.registerVirtualModel. */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Message } from "@earendil-works/pi-ai";
import type { LaneName, ModelRef, SwitchmanConfig } from "./config.ts";
import { LANE_NAMES } from "./config.ts";
import { builtinDecision, decideSwitch, laneCandidates, type ModelFacts } from "./capability.ts";

export interface RouterState {
	lane: LaneName;
	lastPhysical?: ModelRef;
	lastSwitchTs?: number;
	decision?: { ts: number; by: "classifier" | "builtin"; lane: LaneName; confidence: number };
}

/** Minimal structural views of the runtime objects we need (satisfied by
 *  ModelRegistry and ModelRouteRequest without importing runtime types). */
export interface RegistryLike {
	getAvailable(): ModelFacts[];
	find(provider: string, id: string): unknown;
	findOfType(type: "classifier", provider: string, id: string): unknown;
	classify(model: unknown, context: RouterClassifierContext, options?: { signal?: AbortSignal }): Promise<RouterClassifierResult>;
}

export interface RouterClassifierContext {
	state: Record<string, unknown>;
	questions: Record<string, unknown>;
}

export interface RouterClassifierResult {
	stopReason: string;
	answers?: Record<string, unknown>;
}

export interface RouteRequestLike {
	thinkingLevel: string;
	reason: string;
	previous?: { model: { provider: string; id: string }; thinkingLevel?: string };
	failed?: { model: { provider: string; id: string }; thinkingLevel?: string };
	state?: RouterState;
	messages: readonly Message[];
	signal?: AbortSignal;
}

export interface RouteOutcome {
	ref: ModelRef;
	thinking: string;
	state: RouterState | undefined;
}

/** Observable routing telemetry for /switchman-status (process-level). */
export const routerStats = {
	lastDecision: null as { ts: number; by: "classifier" | "builtin"; lane: LaneName; confidence: number; kept: boolean } | null,
};

export interface RouterDeps {
	config: () => SwitchmanConfig;
	registry: RegistryLike;
	/** Called with every recorded decision (gate, keep, switch) — the footer
	 *  status uses it to surface the decision model's confidence live. */
	onDecision?: (decision: { by: "classifier" | "builtin"; lane: LaneName; confidence: number; kept: boolean }) => void;
}

/** Single decision recorder: stats + optional live footer callback. */
function recordDecision(
	deps: RouterDeps,
	decision: { by: "classifier" | "builtin"; lane: LaneName; confidence: number; kept: boolean },
): void {
	routerStats.lastDecision = { ts: Date.now(), ...decision };
	try {
		deps.onDecision?.(decision);
	} catch {
		/* footer status is advisory */
	}
}

const LANE_CRITERIA: Record<LaneName, string> = {
	hard: "Subtle design, cross-cutting refactors, large migrations, or hard debugging",
	main: "Ordinary feature work, fixes, reviews, questions",
	economy: "Small mechanical lookups, quick factual questions, batch micro-tasks",
	review: "Independent verification or review of already-written changes",
	vision: "Work that involves reading images or screenshots",
};

function lastUserText(messages: readonly Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role !== "user") continue;
		const content = message.content;
		if (typeof content === "string") return content;
		if (Array.isArray(content)) {
			return content
				.filter((part): part is { type: "text"; text: string } => part.type === "text")
				.map((part) => part.text)
				.join("\n");
		}
	}
	return "";
}

function lastUserHasImages(messages: readonly Message[]): boolean {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role !== "user") continue;
		const content = message.content;
		if (Array.isArray(content) && content.some((part) => part.type === "image")) return true;
		return false;
	}
	return false;
}

/** True when the request's newest message carries image content: a user
 *  attachment or an image-bearing tool result (e.g. the read tool on a png).
 *  Handles both toolResult shapes pi/pi-ai use: the agent-session flat form
 *  (`content` on the message, what route() sees after a read of an image) and
 *  the multi-result form (`results[]`). Drives the image capability gate —
 *  a text-only model silently drops images. */
function lastMessageHasImages(messages: readonly Message[]): boolean {
	const last = messages[messages.length - 1];
	if (last === undefined) return false;
	if (last.role === "user") {
		return Array.isArray(last.content) && last.content.some((part) => part.type === "image");
	}
	if (last.role === "toolResult") {
		const flat = (last as { content?: unknown }).content;
		if (Array.isArray(flat) && flat.some((part) => (part as { type?: string }).type === "image")) return true;
		const results = (last as { results?: { content?: unknown }[] }).results ?? [];
		return results.some(
			(result) => Array.isArray(result.content) && result.content.some((part) => (part as { type?: string }).type === "image"),
		);
	}
	return false;
}

/** The classifier decision (guarded: every failure path returns null so the
 *  builtin baseline takes over — decision model down never blocks routing). */
export async function classifyDecision(
	deps: RouterDeps,
	request: RouteRequestLike,
	liveLanes: readonly LaneName[],
): Promise<{ lane: LaneName; confidence: number } | null> {
	const config = deps.config();
	const decisionModel = config.router.decisionModel;
	if (decisionModel === null) return null;
	let classifier: unknown;
	try {
		classifier = deps.registry.findOfType("classifier", decisionModel.provider, decisionModel.model);
	} catch {
		return null;
	}
	if (classifier === undefined || classifier === null) return null;

	const signals: AbortSignal[] = [];
	if (request.signal !== undefined) signals.push(request.signal);
	signals.push(AbortSignal.timeout(config.router.decisionTimeoutMs));
	let signal: AbortSignal | undefined;
	try {
		signal = AbortSignal.any(signals);
	} catch {
		signal = signals[signals.length - 1];
	}

	const questions: Record<string, unknown> = {
		lane: {
			type: "choice",
			instructions: "Which execution lane fits the user's latest request best?",
			criteria: LANE_CRITERIA,
		},
	};
	const state = {
		prompt: lastUserText(request.messages).slice(0, 8000),
		hasImages: lastUserHasImages(request.messages),
		thinkingLevel: request.thinkingLevel,
		liveLanes: [...liveLanes],
	};
	try {
		const result = await deps.registry.classify(classifier, { state, questions }, { signal });
		if (result.stopReason !== "stop") return null;
		const answer = result.answers?.lane as
			| { type: string; choice?: string; confidence?: number; probabilities?: Record<string, number> }
			| undefined;
		if (answer === undefined || answer.type !== "choice" || typeof answer.choice !== "string") return null;
		if (!(LANE_NAMES as readonly string[]).includes(answer.choice)) return null;
		const confidence =
			typeof answer.confidence === "number" ? answer.confidence : answer.probabilities?.[answer.choice] ?? 0;
		return { lane: answer.choice as LaneName, confidence };
	} catch {
		return null;
	}
}

/** The route core (pure-ish; the only async part is the optional classifier). */
export async function routeCore(deps: RouterDeps, request: RouteRequestLike): Promise<RouteOutcome> {
	const config = deps.config();
	const state = request.state;
	const prevRef: ModelRef | null = request.previous
		? { provider: request.previous.model.provider, model: request.previous.model.id }
		: null;
	const now = Date.now();

	const keepPrev = (): RouteOutcome => ({
		ref: prevRef as ModelRef,
		thinking: request.previous?.thinkingLevel ?? request.thinkingLevel,
		state,
	});

	// 0. Image capability gate — a request carrying images (user attachment
	//    or an image tool result) must land on an image-capable model. This
	//    outranks platform stickiness, decision-interval reuse, and the
	//    classifier: a text-only model silently drops the images.
	const available = (() => {
		try {
			return deps.registry.getAvailable();
		} catch {
			return [];
		}
	})();
	if (lastMessageHasImages(request.messages)) {
		const prevFacts =
			prevRef !== null ? available.find((m) => m.provider === prevRef.provider && m.id === prevRef.model) : undefined;
		if (prevFacts !== undefined && prevFacts.input.includes("image")) {
			return keepPrev(); // already image-capable: keep the cache window intact
		}
		const imageRefs: ModelRef[] = [];
		const seen = new Set<string>();
		const pushIfCapable = (facts: ModelFacts | undefined) => {
			if (facts === undefined || !facts.input.includes("image")) return;
			const key = `${facts.provider}/${facts.id}`;
			if (seen.has(key)) return;
			seen.add(key);
			imageRefs.push({ provider: facts.provider, model: facts.id });
		};
		for (const ref of laneCandidates("vision", config, available)) {
			pushIfCapable(available.find((m) => m.provider === ref.provider && m.id === ref.model));
		}
		for (const facts of available) pushIfCapable(facts);
		const pick = imageRefs[0];
		if (pick !== undefined) {
			recordDecision(deps, { by: "builtin", lane: "vision", confidence: 1, kept: false });
			return {
				ref: pick,
				thinking: request.thinkingLevel,
				state: {
					lane: "vision",
					lastPhysical: pick,
					lastSwitchTs: now,
					decision: { ts: now, by: "builtin", lane: "vision", confidence: 1 },
				},
			};
		}
		// No image-capable model available: fail-open — route normally below
		// (pi strips images for text-only models, exactly as without switchman).
	}

	// 1. Platform stickiness first — continuation keeps the cache, retry keeps
	//    the thinking signature.
	if (request.reason === "continuation" && prevRef !== null) return keepPrev();
	if (request.reason === "retry" && request.failed !== undefined) {
		return {
			ref: { provider: request.failed.model.provider, model: request.failed.model.id },
			thinking: request.failed.thinkingLevel ?? request.thinkingLevel,
			state,
		};
	}

	// 2. Lane decision at user boundaries (dual decoder); direct requests
	//    (compaction summaries & friends) ride the economy lane.
	const liveLanes = LANE_NAMES.filter((lane) => laneCandidates(lane, config, available).length > 0);

	let lane: LaneName = "main";
	let confidence = 0.5;
	let by: "classifier" | "builtin" = "builtin";
	if (request.reason === "user") {
		const withinInterval =
			state?.decision !== undefined && now - state.decision.ts < config.router.decisionIntervalMs;
		if (withinInterval && state?.decision !== undefined) {
			lane = state.decision.lane;
			confidence = state.decision.confidence;
			by = state.decision.by;
		} else {
			const classified = await classifyDecision(deps, request, liveLanes);
			if (classified !== null) {
				lane = classified.lane;
				confidence = classified.confidence;
				by = "classifier";
			} else {
				const builtin = builtinDecision({
					lastUserText: lastUserText(request.messages),
					hasImages: lastUserHasImages(request.messages),
					thinkingLevel: request.thinkingLevel,
					liveLanes: liveLanes.length > 0 ? liveLanes : ["main"],
				});
				lane = builtin.lane;
				confidence = builtin.confidence;
				by = "builtin";
			}
		}
	} else if (request.reason === "direct") {
		lane = "economy";
	}

	// 3. Keep-or-switch: cache window + confidence double gate.
	let candidates = laneCandidates(lane, config, available);
	if (candidates.length === 0) candidates = laneCandidates("main", config, available);
	if (candidates.length === 0 && prevRef !== null) return keepPrev();
	if (candidates.length === 0) {
		const fallback = available[0];
		if (fallback === undefined) throw new Error("no available model to route to");
		return {
			ref: { provider: fallback.provider, model: fallback.id },
			thinking: request.thinkingLevel,
			state,
		};
	}

	const withinCacheWindow = state?.lastSwitchTs !== undefined && now - state.lastSwitchTs < config.router.cacheWindowMs;
	const verdict = decideSwitch({
		current: prevRef,
		candidates,
		confidence,
		switchConfidence: config.router.switchConfidence,
		withinCacheWindow,
	});

	if (verdict.action === "keep" && prevRef !== null) {
		recordDecision(deps, { by, lane, confidence, kept: true });
		return keepPrev();
	}
	const pick = verdict.action === "keep" ? candidates[0] : verdict.pick;
	recordDecision(deps, { by, lane, confidence, kept: false });
	const nextState: RouterState = {
		lane,
		lastPhysical: pick,
		lastSwitchTs: now,
		decision: { ts: now, by, lane, confidence },
	};
	return { ref: pick, thinking: request.thinkingLevel, state: nextState };
}

/** Wire the route core into pi as the switchman/auto virtual model. */
export function registerRouter(pi: ExtensionAPI, deps: { config: () => SwitchmanConfig; enabled: () => boolean }): void {
	pi.registerVirtualModel({
		provider: "switchman",
		id: "auto",
		name: "Auto (Switchman)",
		thinkingLevels: ["low", "medium", "high"],
		route(request, ctx: ExtensionContext) {
			if (!deps.enabled()) {
				// Router disabled by config: pass through to the session's model.
				const direct = ctx.modelRegistry.getAvailable()[0];
				if (direct === undefined) throw new Error("switchman router disabled and no model available");
				return { model: direct, thinkingLevel: request.thinkingLevel };
			}
			const registry = {
				getAvailable: () => ctx.modelRegistry.getAvailable(),
				find: (provider: string, id: string) => ctx.modelRegistry.find(provider, id),
				findOfType: (type: "classifier", provider: string, id: string) =>
					ctx.modelRegistry.findOfType(type, provider, id),
				classify: (model: unknown, context: RouterClassifierContext, options?: { signal?: AbortSignal }) =>
					ctx.modelRegistry.classify(model as never, context as never, options as never),
			};
			return routeCore(
				{
					config: deps.config,
					registry,
					onDecision: (d) => {
						// Live footer status right under the model line: lane + the
						// decision model's confidence (and who decided).
						try {
							const who = d.by === "classifier" ? "d" : "r"; // d = decision model, r = rules
							const text = `sw ${d.lane} ${d.confidence.toFixed(2)} ${who}${d.kept ? " kept" : ""}`;
							(ctx as { ui?: { setStatus?: (k: string, t: string | undefined) => void } }).ui?.setStatus?.("switchman", text);
						} catch {
							/* footer status is advisory */
						}
					},
				},
				request as unknown as RouteRequestLike,
			).then((outcome) => {
				const model = ctx.modelRegistry.find(outcome.ref.provider, outcome.ref.model);
				if (model !== undefined) return { model, thinkingLevel: outcome.thinking as never, state: outcome.state };
				const previous = (request as unknown as RouteRequestLike).previous?.model;
				if (previous !== undefined) {
					return { model: previous, thinkingLevel: outcome.thinking as never, state: undefined };
				}
				const fallback = ctx.modelRegistry.getAvailable()[0];
				if (fallback === undefined) throw new Error(`routed model missing and no fallback: ${outcome.ref.provider}/${outcome.ref.model}`);
				return { model: fallback, thinkingLevel: outcome.thinking as never, state: undefined };
			});
		},
	});
}
