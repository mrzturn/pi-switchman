/** Local decision endpoint ([M3b] DESIGN §4.6): registers a
 *  typesafe-system-one compatible classifier provider straight from
 *  switchman.json, so the router's decision model needs no manual
 *  models.json editing. Pure builders are test-locked; registration is
 *  fail-open (a broken endpoint never blocks extension load). */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { DecisionEndpoint } from "./config.ts";

/** Returns a human-readable validation error, or null when valid. */
export function validEndpoint(entry: { provider: string; baseUrl: string; model: string }): string | null {
	if (entry.provider.trim() === "") return "provider name is required";
	if (!/^https?:\/\//.test(entry.baseUrl.trim())) return "endpoint URL must start with http:// or https://";
	if (entry.model.trim() === "") return "model id is required";
	return null;
}

export interface DecisionProviderConfig {
	name: string;
	baseUrl: string;
	apiKey: string;
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
		baseUrl: entry.baseUrl.trim(),
		apiKey: entry.apiKey !== undefined && entry.apiKey !== "" ? entry.apiKey : "local",
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
