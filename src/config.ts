/** pi-switchman configuration: defaults, validation, layered merge, mtime-cached load.
 *
 *  Pure module: node builtins only, safe to unit-test without the pi runtime.
 *  Layers: DEFAULT_CONFIG <- ~/.pi/agent/switchman.json (global) <- .pi/switchman.json (project).
 *  Malformed values never throw: unknown keys are ignored, invalid values fall back
 *  to the layer below (fail-open constitution #5). */

import { existsSync, readFileSync, statSync } from "node:fs";

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

export interface WatermarkConfig {
	soft: number;
	hard: number;
	force: number;
}

export interface SwitchmanConfig {
	disabled: boolean;
	compress: CompressConfig;
	watermark: WatermarkConfig;
}

export const DEFAULT_CONFIG: SwitchmanConfig = {
	disabled: false,
	compress: {
		enabled: true,
		threshold: 8000,
		readHead: 60,
		readTail: 20,
		genericHead: 40,
		genericTail: 10,
		hardRatio: 0.4,
	},
	watermark: { soft: 0.7, hard: 0.85, force: 0.95 },
};

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

/** Ratio in (0, 1] — thresholds and the hard-tier scale. */
function ratioOr(source: Record<string, unknown>, key: string, fallback: number): number {
	const value = source[key];
	if (typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 1) return value;
	return fallback;
}

/** One merge step: `override` wins where it carries a well-formed value. */
export function mergeConfig(base: SwitchmanConfig, override: Record<string, unknown> | null): SwitchmanConfig {
	if (override === null) return base;
	const out: SwitchmanConfig = {
		disabled: boolOr(override, "disabled", base.disabled),
		compress: { ...base.compress },
		watermark: { ...base.watermark },
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
		out.watermark = {
			soft: ratioOr(watermark, "soft", base.watermark.soft),
			hard: ratioOr(watermark, "hard", base.watermark.hard),
			force: ratioOr(watermark, "force", base.watermark.force),
		};
	}
	return out;
}

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
