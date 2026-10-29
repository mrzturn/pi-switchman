/** Local decision endpoint ([M3b] DESIGN §4.6): registers a
 *  typesafe-system-one compatible classifier provider straight from
 *  switchman.json, so the router's decision model needs no manual
 *  models.json editing. Pure builders are test-locked; registration is
 *  fail-open (a broken endpoint never blocks extension load). */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
// Public subpath export of pi-ai: the bundled typesafe-system-one classifier
// implementation. A config-registered provider must attach implementations for
// its non-chat models via the `classifiers`/`images` fields — declaring
// `type: "classifier"` alone makes pi reject calls with "Provider ... does
// not support classification".
import { classify as classifySystemOne } from "@earendil-works/pi-ai/api/typesafe-system-one";
import type { DecisionEndpoint } from "./config.ts";

/** Returns a human-readable validation error, or null when valid. */
export function validEndpoint(entry: { provider: string; baseUrl: string; model: string }): string | null {
	if (entry.provider.trim() === "") return "provider name is required";
	if (!/^https?:\/\//.test(entry.baseUrl.trim())) return "endpoint URL must start with http:// or https://";
	if (entry.model.trim() === "") return "model id is required";
	return null;
}

/** Normalizes a decision endpoint URL to the BASE pi's typesafe-system-one
 *  transport expects: it appends the `systemone` path segment itself
 *  (`new URL("systemone", baseUrl + "/")`). Both styles are accepted — the
 *  dsh-style FULL endpoint (`http://host:11434/v1/systemone`, what dsh calls
 *  directly) and the bare base (`http://host:11434/v1`). */
export function normalizeDecisionBaseUrl(raw: string): string {
	let url = raw.trim().replace(/\/+$/u, "");
	if (url.endsWith("/systemone")) url = url.slice(0, -"/systemone".length).replace(/\/+$/u, "");
	return url;
}

export interface DecisionProviderConfig {
	name: string;
	baseUrl: string;
	apiKey: string;
	classifiers: { "typesafe-system-one": { classify: typeof classifySystemOne } };
	models: {
		type: "classifier";
		id: string;
		name: string;
		api: "typesafe-system-one";
		input: ["text"];
		contextWindow: number;
		cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	}[];
}

/** Maps a decisionEndpoint config entry to a pi ProviderConfig. Local
 *  endpoints without a key get the literal "local" (pi requires one). */
export function buildDecisionProviderConfig(entry: DecisionEndpoint): DecisionProviderConfig {
	return {
		name: `${entry.provider} (switchman decision)`,
		baseUrl: normalizeDecisionBaseUrl(entry.baseUrl),
		apiKey: entry.apiKey !== undefined && entry.apiKey !== "" ? entry.apiKey : "local",
		classifiers: { "typesafe-system-one": { classify: classifySystemOne } },
		models: [
			{
				type: "classifier",
				id: entry.model.trim(),
				name: entry.model.trim(),
				api: "typesafe-system-one",
				input: ["text"],
				contextWindow: 32000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			},
		],
	};
}

/** Registers the endpoint immediately; false when invalid or pi refuses. */
export function registerDecisionEndpoint(pi: ExtensionAPI, entry: DecisionEndpoint): boolean {
	if (validEndpoint(entry) !== null) return false;
	try {
		pi.registerProvider(entry.provider.trim(), buildDecisionProviderConfig(entry));
		return true;
	} catch {
		return false;
	}
}
