/** pi-switchman configuration: defaults, validation, layered merge, mtime-cached load,
 *  and raw round-trip helpers for the TUI config editor.
 *
 *  Pure module: node builtins only, safe to unit-test without the pi runtime.
 *  Layers: DEFAULT_CONFIG <- ~/.pi/agent/switchman.json (global) <- .pi/switchman.json (project).
 *  Malformed values never throw: unknown keys are ignored, invalid values fall back
 *  to the layer below (fail-open constitution #5). */

import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface CompressConfig {
	enabled: boolean;
	/** Results whose joined text exceeds this many chars are distilled. */
	threshold: number;
	/** Head/tail lines kept for `read` results. */
	readHead: number;
	readTail: number;
	/** Head/tail lines kept for every other tool. */
	genericHead: number;
	genericTail: number;
	/** Multiplier applied to `threshold` at watermark hard tier (M4). */
	hardRatio: number;
}

/** One watermark threshold: percent of the context window and/or an absolute
 *  token budget. The tier fires at whichever comes first (the smaller). */
export interface WatermarkThreshold {
	/** Percent of context window, 0-100. */
	percent?: number;
	/** Absolute context tokens (e.g. 80000 = 80k). */
	tokens?: number;
}

export interface WatermarkConfig {
	soft: WatermarkThreshold;
	hard: WatermarkThreshold;
	force: WatermarkThreshold;
}

export type LaneName = "hard" | "main" | "economy" | "review" | "vision";
export const LANE_NAMES: readonly LaneName[] = ["hard", "main", "economy", "review", "vision"];

export type AnchorTier = "light" | "mid" | "heavy";

export interface ModelRef {
	provider: string;
	model: string;
}

export interface Anchor extends ModelRef {
	tier: AnchorTier;
}

/** A local decision endpoint registered as a provider at load time
 *  (typesafe-system-one compatible, e.g. an Ollama-exposed systemone service). */
export interface DecisionEndpoint {
	/** Provider id to register (e.g. "switchman-decision"). */
	provider: string;
	/** Base URL of the systemone endpoint (e.g. http://127.0.0.1:11434/v1/systemone). */
	baseUrl: string;
	/** Classifier model id served by the endpoint (e.g. "tev1:4b-mxfp8"). */
	model: string;
	/** Optional literal API key; local endpoints need none. */
	apiKey?: string;
}

export interface RouterConfig {
	/** Register the switchman/auto virtual model. */
	enabled: boolean;
	/** Ordered model lists per lane; null/empty = capability layer auto-ranking. */
	lanes: Record<LaneName, ModelRef[] | null>;
	/** Confidence required to leave the current model for the decided lane. */
	switchConfidence: number;
	/** Keep the current model while within this window after the last switch. */
	cacheWindowMs: number;
	/** Minimum interval between decision-model calls. */
	decisionIntervalMs: number;
	/** Decision-model call timeout. */
	decisionTimeoutMs: number;
	/** Optional classifier used for lane decisions; null = builtin rules only. */
	decisionModel: ModelRef | null;
	/** Optional local decision endpoint; registered as a provider at load. */
	decisionEndpoint: DecisionEndpoint | null;
	/** Image-relay threshold in context tokens: at or above this, image turns on
	 *  text-only models stay put and a vision model describes the images into a
	 *  custom message instead of cold-switching the whole turn. 0 disables relay. */
	visionRelayThresholdTokens: number;
	/** Timeout for the vision-relay describe call. */
	visionRelayTimeoutMs: number;
}

export interface SwitchmanConfig {
	disabled: boolean;
	/** "enforce": dispatch calls naming out-of-lane models are denied. */
	enforce: "advice" | "enforce";
	compress: CompressConfig;
	watermark: WatermarkConfig;
	/** Comment-convention injection ([]-[]-[] bracket annotations). */
	annotate: { enabled: boolean };
	anchors: Anchor[];
	router: RouterConfig;
}

export const DEFAULT_CONFIG: SwitchmanConfig = {
	disabled: false,
	enforce: "advice",
	compress: {
		enabled: true,
		threshold: 8000,
		readHead: 60,
		readTail: 20,
		genericHead: 40,
		genericTail: 10,
		hardRatio: 0.4,
	},
	watermark: { soft: { percent: 70 }, hard: { percent: 85 }, force: { percent: 95 } },
	annotate: { enabled: true },
	anchors: [],
	router: {
		enabled: true,
		lanes: { hard: null, main: null, economy: null, review: null, vision: null },
		switchConfidence: 0.8,
		cacheWindowMs: 300_000,
		decisionIntervalMs: 60_000,
		decisionTimeoutMs: 8000,
		decisionModel: null,
		decisionEndpoint: null,
		visionRelayThresholdTokens: 50_000,
		visionRelayTimeoutMs: 30_000,
	},
};

// ---- validation helpers -----------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boolOr(source: Record<string, unknown>, key: string, fallback: boolean): boolean {
	const value = source[key];
	return typeof value === "boolean" ? value : fallback;
}

function intOr(source: Record<string, unknown>, key: string, fallback: number): number {
	const value = source[key];
	if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.floor(value);
	return fallback;
}

function nonNegativeIntOr(source: Record<string, unknown>, key: string, fallback: number): number {
	const value = source[key];
	if (typeof value === "number" && Number.isFinite(value) && value >= 0) return Math.floor(value);
	return fallback;
}

function ratioOr(source: Record<string, unknown>, key: string, fallback: number): number {
	const value = source[key];
	if (typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 1) return value;
	return fallback;
}

function percentValue(value: unknown): number | null {
	// Watermark percents live on pi's getContextUsage scale (0-100).
	if (typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 100) return value;
	return null;
}

function positiveIntValue(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value) && value >= 1) return Math.floor(value);
	return undefined;
}

function modelRefOf(value: unknown): ModelRef | null {
	if (!isPlainObject(value)) return null;
	const provider = value.provider;
	const model = value.model;
	if (typeof provider !== "string" || provider === "" || typeof model !== "string" || model === "") return null;
	return { provider, model };
}

function modelRefList(value: unknown): ModelRef[] | null {
	if (!Array.isArray(value)) return null;
	const refs = value.map(modelRefOf).filter((ref): ref is ModelRef => ref !== null);
	return refs.length > 0 ? refs : null;
}

// ---- merge -------------------------------------------------------------------

/** One merge step: `override` wins where it carries a well-formed value. */
export function mergeConfig(base: SwitchmanConfig, override: Record<string, unknown> | null): SwitchmanConfig {
	if (override === null) return base;
	const out: SwitchmanConfig = {
		disabled: boolOr(override, "disabled", base.disabled),
		enforce: override.enforce === "enforce" ? "enforce" : override.enforce === "advice" ? "advice" : base.enforce,
		compress: { ...base.compress },
		watermark: { ...base.watermark },
		annotate: { ...base.annotate },
		anchors: base.anchors,
		router: { ...base.router, lanes: { ...base.router.lanes } },
	};

	const compress = override.compress;
	if (isPlainObject(compress)) {
		out.compress = {
			enabled: boolOr(compress, "enabled", base.compress.enabled),
			threshold: intOr(compress, "threshold", base.compress.threshold),
			readHead: intOr(compress, "readHead", base.compress.readHead),
			readTail: intOr(compress, "readTail", base.compress.readTail),
			genericHead: intOr(compress, "genericHead", base.compress.genericHead),
			genericTail: intOr(compress, "genericTail", base.compress.genericTail),
			hardRatio: ratioOr(compress, "hardRatio", base.compress.hardRatio),
		};
	}

	const watermark = override.watermark;
	if (isPlainObject(watermark)) {
		const threshold = (value: unknown, base: WatermarkThreshold): WatermarkThreshold => {
			// Plain number keeps the percent form (and inherits the base token
			// budget); an object sets percent/tokens independently, each
			// inheriting from the layer below when omitted.
			if (typeof value === "number") {
				const percent = percentValue(value);
				return percent === null ? base : { percent, tokens: base.tokens };
			}
			if (isPlainObject(value)) {
				// invalid values fall back to the layer below (fail-open)
				const percent = value.percent === undefined ? base.percent : (percentValue(value.percent) ?? base.percent);
				const tokens = value.tokens === undefined ? base.tokens : (positiveIntValue(value.tokens) ?? base.tokens);
				const merged: WatermarkThreshold = {};
				if (percent !== undefined) merged.percent = percent;
				if (tokens !== undefined) merged.tokens = tokens;
				return merged;
			}
			return base;
		};
		out.watermark = {
			soft: threshold(watermark.soft, base.watermark.soft),
			hard: threshold(watermark.hard, base.watermark.hard),
			force: threshold(watermark.force, base.watermark.force),
		};
	}
	if (override.annotate !== undefined) {
		// fail-open: only a strict boolean is honored; anything else inherits
		out.annotate = typeof override.annotate === "boolean" ? { enabled: override.annotate } : base.annotate;
	}

	if (Array.isArray(override.anchors)) {
		const anchors: Anchor[] = [];
		for (const entry of override.anchors) {
			const ref = modelRefOf(entry);
			const tier = isPlainObject(entry) ? entry.tier : undefined;
			if (ref && (tier === "light" || tier === "mid" || tier === "heavy")) {
				anchors.push({ ...ref, tier });
			}
		}
		out.anchors = anchors;
	}

	const router = override.router;
	if (isPlainObject(router)) {
		const lanes = { ...out.router.lanes };
		const routerLanes = router.lanes;
		if (isPlainObject(routerLanes)) {
			for (const lane of LANE_NAMES) {
				const value = routerLanes[lane];
				if (value === null) lanes[lane] = null;
				else {
					const refs = modelRefList(value);
					if (refs !== null) lanes[lane] = refs;
				}
			}
		}
		const decision = modelRefOf(router.decisionModel);
		// decisionEndpoint: absent key inherits the base (global) value; explicit
		// null clears; an object must pass validation or falls back to null.
		let endpoint = base.router.decisionEndpoint;
		if ("decisionEndpoint" in router) {
			const raw = router.decisionEndpoint;
			if (raw === null || !isPlainObject(raw)) {
				endpoint = null;
			} else {
				const provider = typeof raw.provider === "string" ? raw.provider.trim() : "";
				const baseUrl = typeof raw.baseUrl === "string" ? raw.baseUrl.trim() : "";
				const model = typeof raw.model === "string" ? raw.model.trim() : "";
				const apiKey = typeof raw.apiKey === "string" && raw.apiKey.length > 0 ? raw.apiKey : undefined;
				endpoint = provider !== "" && baseUrl !== "" && model !== "" ? { provider, baseUrl, model, ...(apiKey !== undefined ? { apiKey } : {}) } : null;
			}
		}
		out.router = {
			enabled: boolOr(router, "enabled", base.router.enabled),
			lanes,
			switchConfidence: ratioOr(router, "switchConfidence", base.router.switchConfidence),
			cacheWindowMs: intOr(router, "cacheWindowMs", base.router.cacheWindowMs),
			decisionIntervalMs: intOr(router, "decisionIntervalMs", base.router.decisionIntervalMs),
			decisionTimeoutMs: intOr(router, "decisionTimeoutMs", base.router.decisionTimeoutMs),
			decisionModel: router.decisionModel === null ? null : decision,
			decisionEndpoint: endpoint,
			visionRelayThresholdTokens: nonNegativeIntOr(router, "visionRelayThresholdTokens", base.router.visionRelayThresholdTokens),
			visionRelayTimeoutMs: Math.max(1_000, intOr(router, "visionRelayTimeoutMs", base.router.visionRelayTimeoutMs)),
		};
	}
	return out;
}

// ---- raw round-trip (TUI saves preserve unknown keys) ------------------------

function deepMerge(target: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = { ...target };
	for (const [key, value] of Object.entries(patch)) {
		const existing = out[key];
		if (isPlainObject(existing) && isPlainObject(value)) {
			out[key] = deepMerge(existing, value);
		} else if (isPlainObject(value)) {
			out[key] = deepMerge({}, value);
		} else {
			out[key] = value;
		}
	}
	return out;
}

/** Read a config file as a raw object ({} when missing/unreadable). */
export function readRawConfig(path: string): Record<string, unknown> {
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		return isPlainObject(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

/** Atomically write `patch` merged into the raw contents of `path`. */
export function writeRawConfig(path: string, patch: Record<string, unknown>): void {
	const merged = deepMerge(readRawConfig(path), patch);
	const tmp = join(dirname(path), `.${basenameSafe(path)}.tmp-${Date.now().toString(36)}`);
	writeFileSync(tmp, `${JSON.stringify(merged, null, "\t")}\n`, "utf8");
	renameSync(tmp, path);
}

function basenameSafe(path: string): string {
	const parts = path.split("/");
	return parts[parts.length - 1] || "config";
}

// ---- loader -------------------------------------------------------------------

function readJsonObject(path: string): { value: Record<string, unknown> | null; error?: string } {
	if (!existsSync(path)) return { value: null };
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (!isPlainObject(parsed)) return { value: null, error: `${path}: not a JSON object` };
		return { value: parsed };
	} catch (error) {
		return { value: null, error: `${path}: ${(error as Error).message}` };
	}
}

export interface LoadedConfig {
	config: SwitchmanConfig;
	globalPath: string;
	projectPath: string;
	/** Human-readable notes for /switchman-status; never fatal. */
	errors: string[];
}

/** mtime-cached loader: fresh enough for "edit and it takes effect next event",
 *  cheap enough to call per tool result. */
export class ConfigStore {
	private readonly globalPath: string;
	private readonly projectPath: string;
	private cache: LoadedConfig | null = null;
	private stamp = "";

	constructor(globalPath: string, projectPath: string) {
		this.globalPath = globalPath;
		this.projectPath = projectPath;
	}

	load(): LoadedConfig {
		let stamp = "";
		for (const path of [this.globalPath, this.projectPath]) {
			try {
				const stats = statSync(path);
				stamp += `${path}:${stats.mtimeMs}:${stats.size}|`;
			} catch {
				stamp += `${path}:-|`;
			}
		}
		if (this.cache !== null && stamp === this.stamp) return this.cache;
		const errors: string[] = [];
		const global = readJsonObject(this.globalPath);
		if (global.error !== undefined) errors.push(global.error);
		const project = readJsonObject(this.projectPath);
		if (project.error !== undefined) errors.push(project.error);
		const config = mergeConfig(mergeConfig(DEFAULT_CONFIG, global.value), project.value);
		this.cache = { config, globalPath: this.globalPath, projectPath: this.projectPath, errors };
		this.stamp = stamp;
		return this.cache;
	}
}
