/** pi-switchman — context economics engine for pi.
 *
 *  M0+M1 wiring (DESIGN.md §8):
 *  - [M0] byte-stable protocol section (before_agent_start.sections)
 *  - [M0] /switchman-status command
 *  - [M1] entry compression pipeline (tool_result, distill-before-transcript)
 *  - [M1] expand tool (spans of stored full outputs)
 *
 *  Cache constitution: the protocol section text is a pure function of config
 *  flags; all hook paths fail open; tool declarations never change mid-session. */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ConfigStore, type LoadedConfig } from "./config.ts";
import { OutputStore, distillText, storeFooter, textOf, type ContentBlock } from "./compress.ts";
import { PROTOCOL_SECTION_KEY, protocolText } from "./protocol.ts";
import { createExpandTool } from "./expand.ts";
import { registerStatusCommand, Stats } from "./status.ts";

/** Watermark coupling point for M4: multiplies the compression threshold
 *  (1 = full threshold; < 1 tightens under pressure, e.g. hardRatio). */
let thresholdScale = 1;
export function setCompressionThresholdScale(scale: number): void {
	thresholdScale = scale > 0 && scale <= 1 ? scale : 1;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export default function (pi: ExtensionAPI) {
	const stats = new Stats();
	const store = new OutputStore(tmpdir());
	let protocolSeen = false;

	let configStore: ConfigStore | null = null;
	let configCwd: string | null = null;
	function configFor(cwd: string): LoadedConfig {
		if (configStore === null || configCwd !== cwd) {
			configStore = new ConfigStore(join(getAgentDir(), "switchman.json"), join(cwd, ".pi", "switchman.json"));
			configCwd = cwd;
		}
		return configStore.load();
	}

	pi.on("session_start", () => {
		stats.reset();
	});

	// [M0] Byte-stable protocol section. Mutating sections here records at most
	// one prompt change per distinct config — stable within a session.
	pi.on("before_agent_start", (event) => {
		try {
			const cfg = configFor(event.systemPromptOptions.cwd).config;
			if (cfg.disabled) return;
			event.systemPromptOptions.sections[PROTOCOL_SECTION_KEY] = protocolText(cfg.compress.enabled);
			protocolSeen = true;
		} catch {
			/* fail-open: no section */
		}
	});

	// [M1] Entry compression: distill oversized text results before they enter
	// the transcript; the full output goes to the store, the footer names it.
	pi.on("tool_result", (event, ctx) => {
		try {
			if (event.isError) return; // diagnostics pass through untouched
			if (event.parentToolCallId !== undefined) return; // nested: never enters the transcript
			if (event.toolName === "expand") return; // our own results stay small
			const cfg = configFor(ctx.cwd).config;
			if (cfg.disabled || !cfg.compress.enabled) return;
			const text = textOf(event.content as ContentBlock[]);
			if (text === null) return; // image results pass through
			const threshold = Math.floor(cfg.compress.threshold * thresholdScale);
			if (text.length <= threshold) return;
			// structuredContent contract: replace it for read/bash; other tools
			// that carry one pass through (compressing their text alone would
			// desync content from structuredContent for codemode callers).
			const hasStructured = event.structuredContent !== undefined;
			if (hasStructured && event.toolName !== "read" && event.toolName !== "bash") {
				stats.passThrough++;
				return;
			}
			const isRead = event.toolName === "read";
			const head = isRead ? cfg.compress.readHead : cfg.compress.genericHead;
			const tail = isRead ? cfg.compress.readTail : cfg.compress.genericTail;
			const path = store.add(event.toolName, text);
			const lines = text.split("\n").length;
			const distilled = distillText(text, { head, tail, footer: storeFooter(path, text.length, lines) });
			if (distilled === null) {
				stats.passThrough++;
				return;
			}
			stats.compressed++;
			stats.originalChars += text.length;
			stats.distilledChars += distilled.length;
			const result: { content: { type: "text"; text: string }[]; structuredContent?: unknown } = {
				content: [{ type: "text", text: distilled }],
			};
			if (event.toolName === "read") {
				result.structuredContent = distilled; // read outputSchema: string | image object
			} else if (event.toolName === "bash" && isPlainObject(event.structuredContent)) {
				result.structuredContent = { ...event.structuredContent, output: distilled };
			}
			return result;
		} catch {
			return; // fail-open: original result passes through
		}
	});

	pi.registerTool(createExpandTool(store));
	registerStatusCommand(pi, {
		stats,
		store,
		config: () => configFor(configCwd ?? process.cwd()),
		protocolInjected: () => protocolSeen,
	});
}
