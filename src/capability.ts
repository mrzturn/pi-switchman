/** Capability knowledge layer ([D]): tier inference, ranking, lane candidates,
 *  and the builtin decision baseline (the router's zero-LLM fallback).
 *
 *  Everything is a pure function over plain facts — the registry is queried by
 *  the caller, so this file needs no pi runtime (unit-testable directly). */

import type { Anchor, LaneName, ModelRef, SwitchmanConfig } from "./config.ts";

/** The subset of a catalog Model the knowledge layer reasons about. */
export interface ModelFacts {
	provider: string;
	id: string;
	name: string;
	input: readonly string[];
	reasoning: boolean;
	contextWindow: number;
	cost: { input: number; output: number };
}

export type Tier = "light" | "mid" | "heavy";

const TIER_WEIGHT: Record<Tier, number> = { heavy: 2, mid: 1, light: 0 };

/** Naming conventions across providers encode size with remarkable consistency.
 *  Anchored families (glm-5.3-flash) fold onto their family tier via the
 *  light/heavy markers; unknown names default to mid. */
const LIGHT_RE = /(flash|mini|haiku|air|lite|nano|small|fast|instant|eco|turbo)/i;
const HEAVY_RE = /(opus|ultra|flagship|frontier|reasoning|-r1\b|thinking|preview)/i;

function modelKey(provider: string, model: string): string {
	return `${provider}/${model}`;
}

/** Inferred tier from name + cost + metadata (anchors are applied by the caller). */
export function inferTier(facts: ModelFacts): Tier {
	const id = facts.id.toLowerCase();
	if (LIGHT_RE.test(id)) return "light";
	if (HEAVY_RE.test(id)) return "heavy";
	// Cost as a weak capability proxy within a provider family: models costing
	// an order of magnitude less than their siblings are almost never the
	// flagship. Absolute thresholds stay coarse on purpose.
	if (facts.cost.input > 0 && facts.cost.input <= 0.5 && facts.cost.output <= 3) return "light";
	if (facts.cost.input >= 10 || facts.cost.output >= 30) return "heavy";
	return "mid";
}

function anchorTier(anchors: readonly Anchor[], facts: ModelFacts): Tier | null {
	for (const anchor of anchors) {
		if (anchor.provider === facts.provider && anchor.model === facts.id) return anchor.tier;
	}
	return null;
}

function effectiveTier(facts: ModelFacts, anchors: readonly Anchor[]): Tier {
	return anchorTier(anchors, facts) ?? inferTier(facts);
}

/** Capability ranking: tier descending, then cheaper first (stable). */
export function rankByCapability(models: readonly ModelFacts[], anchors: readonly Anchor[]): ModelFacts[] {
	return [...models]
		.map((facts) => ({ facts, tier: effectiveTier(facts, anchors) }))
		.sort((a, b) => {
			const byTier = TIER_WEIGHT[b.tier] - TIER_WEIGHT[a.tier];
			if (byTier !== 0) return byTier;
			const aCost = a.facts.cost.input + a.facts.cost.output;
			const bCost = b.facts.cost.input + b.facts.cost.output;
			if (aCost !== bCost) return aCost - bCost;
			return 0;
		})
		.map((entry) => entry.facts);
}

function sameRef(a: ModelRef, b: ModelRef): boolean {
	return a.provider === b.provider && a.model === b.model;
}

function factsOf(ref: ModelRef, available: readonly ModelFacts[]): ModelFacts | undefined {
	return available.find((facts) => facts.provider === ref.provider && facts.id === ref.model);
}

/** Ordered candidate refs for a lane: the configured list (availability-filtered,
 *  order preserved) when it has any live entry; otherwise capability-ranked
 *  auto-selection. Never throws; empty input yields empty output. */
export function laneCandidates(
	lane: LaneName,
	config: SwitchmanConfig,
	available: readonly ModelFacts[],
): ModelRef[] {
	const configured = config.router.lanes[lane];
	if (configured !== null && configured !== undefined) {
		const live = configured.filter((ref) => factsOf(ref, available) !== undefined);
		if (live.length > 0) return live;
	}
	const pool = rankByCapability(available, config.anchors);
	if (lane === "vision") {
		return pool
			.filter((facts) => facts.input.includes("image"))
			.map((facts) => ({ provider: facts.provider, model: facts.id }));
	}
	if (lane === "hard") {
		return pool
			.filter((facts) => effectiveTier(facts, config.anchors) !== "light")
			.map((facts) => ({ provider: facts.provider, model: facts.id }));
	}
	if (lane === "economy") {
		const light = pool.filter((facts) => effectiveTier(facts, config.anchors) === "light");
		const source = light.length > 0 ? light : pool.filter((facts) => effectiveTier(facts, config.anchors) === "mid");
		return source.map((facts) => ({ provider: facts.provider, model: facts.id }));
	}
	if (lane === "review") {
		return pool
			.filter((facts) => effectiveTier(facts, config.anchors) === "heavy" || facts.reasoning)
			.map((facts) => ({ provider: facts.provider, model: facts.id }));
	}
	return pool.map((facts) => ({ provider: facts.provider, model: facts.id }));
}

// ---- builtin decision baseline (router's zero-LLM fallback) ------------------

export interface DecisionInput {
	lastUserText: string;
	hasImages: boolean;
	thinkingLevel: string;
	liveLanes: readonly LaneName[];
}

export interface LaneDecision {
	lane: LaneName;
	confidence: number;
}

/** Rule chain: images -> vision; high effort / long / heavy verbs -> hard;
 *  short QUESTIONS/lookups -> economy; everything else (including short
 *  imperative dev tasks) -> main. Confidence stays below the default switch
 *  threshold (0.8) so the builtin keeps the current model whenever it
 *  already serves the decided lane. */
export function builtinDecision(input: DecisionInput): LaneDecision {
	const text = input.lastUserText;
	const lower = text.toLowerCase();
	const want = (lane: LaneName): boolean => input.liveLanes.includes(lane);
	if (input.hasImages && want("vision")) return { lane: "vision", confidence: 0.7 };
	const heavySignal =
		input.thinkingLevel === "high" ||
		text.length > 2000 ||
		/(refactor|redesign|architecture|migrate|overhaul|tricky|subtle|cross-cutting)/i.test(lower) ||
		/重构|架构|迁移|疑难/.test(text);
	if (heavySignal && want("hard")) return { lane: "hard", confidence: 0.7 };
	const questionLike =
		/\?\s*$/.test(text.trim()) ||
		/^(what|why|how|who|when|where|which|is|are|do|does|can|could|show|list|find)\b/i.test(lower) ||
		/什么|为什么|怎么|哪些|是否/.test(text);
	const lightSignal = text.length < 160 && questionLike;
	if (lightSignal && want("economy")) return { lane: "economy", confidence: 0.6 };
	return { lane: "main", confidence: 0.6 };
}

/** The keep-or-switch verdict (DESIGN §4.3 step 3). Pure, test-locked. */
export function decideSwitch(args: {
	current: ModelRef | null;
	candidates: readonly ModelRef[];
	confidence: number;
	switchConfidence: number;
	withinCacheWindow: boolean;
}): { action: "keep" } | { action: "switch"; pick: ModelRef } {
	if (args.candidates.length === 0) return { action: "keep" };
	if (
		args.current !== null &&
		args.candidates.some((candidate) => sameRef(candidate, args.current as ModelRef)) &&
		(args.confidence < args.switchConfidence || args.withinCacheWindow)
	) {
		return { action: "keep" };
	}
	return { action: "switch", pick: args.candidates[0] };
}
