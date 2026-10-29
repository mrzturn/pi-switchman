/** pi-switchman — context economics engine for pi.
 *
 *  Full wiring (DESIGN.md §8, M0–M4):
 *  - [A] entry compression pipeline + expand tool
 *  - [B] dispatch tool (gather/judge/run/parallel) + ledger
 *  - [C] switchman/auto virtual model (dual-decoder sticky routing)
 *  - [D] capability knowledge layer (anchors + inference + builtin baseline)
 *  - [E] watermark dashboard + fuses + ledger-aware compaction
 *  - [F] /switchman-config TUI editor
 *
 *  Cache constitution: the protocol section is a pure function of config
 *  flags; all hook paths fail open; tool declarations never change
 *  mid-session; model switches happen only at user boundaries. */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ConfigStore, writeRawConfig, type LoadedConfig, type SwitchmanConfig } from "./config.ts";
import { OutputStore, distillText, storeFooter, textOf, type ContentBlock } from "./compress.ts";
import { ANNOTATE_SECTION_KEY, PROTOCOL_SECTION_KEY, annotateText, protocolText } from "./protocol.ts";
import { createExpandTool } from "./expand.ts";
import { createDispatchTool } from "./dispatch.ts";
import { registerRouter } from "./router.ts";
import { registerVisionRelay } from "./vision-relay.ts";
import { registerDecisionEndpoint } from "./decision-model.ts";
import { applyWatermark, AUTO_CONTINUE_MESSAGE, COMPACT_COOLDOWN_MS, HANDOVER_TTL_MS, type WatermarkTier } from "./watermark.ts";
import { LEDGER_RESTORE_TYPE, ledgerRestorePayload, snapshotLedger } from "./ledger.ts";
import { registerConfigCommand, saveTarget } from "./config-ui.ts";
import { registerStatusCommand, Stats } from "./status.ts";

/** Watermark coupling point: multiplies the compression threshold
 *  (1 = full threshold; < 1 tightens under pressure). */
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
	let watermarkTier: WatermarkTier = "ok";

	let configStore: ConfigStore | null = null;
	let configCwd: string | null = null;
	function configPaths(cwd: string): { globalPath: string; projectPath: string } {
		return {
			globalPath: join(getAgentDir(), "switchman.json"),
			projectPath: join(cwd, ".pi", "switchman.json"),
		};
	}
	function configFor(cwd: string): LoadedConfig {
		const paths = configPaths(cwd);
		if (configStore === null || configCwd !== cwd) {
			configStore = new ConfigStore(paths.globalPath, paths.projectPath);
			configCwd = cwd;
		}
		return configStore.load();
	}
	const cfgNow = (): SwitchmanConfig => configFor(configCwd ?? process.cwd()).config;

	// ---- lifecycle -----------------------------------------------------------

	pi.on("session_start", () => {
		stats.reset();
		watermarkTier = "ok";
	});

	// ---- [M0] byte-stable protocol section ------------------------------------

	pi.on("before_agent_start", (event) => {
		try {
			const cfg = configFor(event.systemPromptOptions.cwd).config;
			if (cfg.disabled) return;
			event.systemPromptOptions.sections[PROTOCOL_SECTION_KEY] = protocolText({
				compressEnabled: cfg.compress.enabled,
				dispatchEnabled: !cfg.disabled,
			});
			// Comment-convention section (dsh-switchman's []-[]-[] form); set or
			// cleared every run so a mid-session toggle takes effect immediately.
			if (cfg.annotate.enabled) {
				event.systemPromptOptions.sections[ANNOTATE_SECTION_KEY] = annotateText();
			} else {
				delete event.systemPromptOptions.sections[ANNOTATE_SECTION_KEY];
			}
			protocolSeen = true;
		} catch {
			/* fail-open: no section */
		}
	});

	// ---- [M1] entry compression ----------------------------------------------

	pi.on("tool_result", (event, ctx) => {
		try {
			if (event.isError) return; // diagnostics pass through untouched
			if (event.parentToolCallId !== undefined) return; // nested: never enters the transcript
			if (event.toolName === "expand" || event.toolName === "dispatch") return;
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

	// ---- [M2] dispatch + expand tools -----------------------------------------

	pi.registerTool(createExpandTool(store));
	pi.registerTool(
		createDispatchTool({
			config: () => configFor(configCwd ?? process.cwd()),
			store,
			pi,
		}),
	);

	// ---- [M3a/M3b] router + decision model ------------------------------------

	function syncDecisionEndpoint(cwd: string): void {
		try {
			const endpoint = configFor(cwd).config.router.decisionEndpoint;
			if (endpoint !== null) registerDecisionEndpoint(pi, endpoint);
		} catch {
			/* fail-open: registered on next start */
		}
	}
	syncDecisionEndpoint(process.cwd());
	pi.on("session_start", (_event, ctx) => syncDecisionEndpoint(ctx.cwd)); // project overrides may add one

	try {
		registerRouter(pi, { config: cfgNow, enabled: () => cfgNow().router.enabled && !cfgNow().disabled });
		registerVisionRelay(pi, { config: cfgNow }); // large-context image turns: describe-inject instead of cold-switch
	} catch (error) {
		console.error(`[pi-switchman] router registration failed: ${String((error as Error)?.message ?? error)}`);
	}

	// ---- [M4] watermark --------------------------------------------------------

	// Force-tier handover compaction. The watermark raises the flag mid-run
	// (never compacts there — compact() aborts a live run); this handler runs
	// once the agent settles, when compacting aborts nothing. The compaction
	// summary IS the handover document (task state + ledger + lane), and the
	// continuation message resumes the task on the compacted context.
	let forceCompactPending = false;
	let lastForceCompactAt = 0;
	let handoverArmedAt: number | null = null;
	pi.on("agent_end", (_event, ctx) => {
		if (!forceCompactPending) return;
		forceCompactPending = false;
		try {
			if (Date.now() - lastForceCompactAt < COMPACT_COOLDOWN_MS) return;
			if (configFor(ctx.cwd).config.disabled) return;
			lastForceCompactAt = Date.now();
			let ledger = "(none)";
			try {
				ledger = snapshotLedger(ctx.sessionManager.getBranch()) ?? "(none)";
			} catch {
				/* advisory */
			}
			// Arm the event-driven continuation: pi's TUI host drops
			// CompactOptions.onComplete/onError (it forwards only
			// customInstructions), so session_compact below is the single
			// completion signal — in every host mode.
			handoverArmedAt = Date.now();
			ctx.compact({
				customInstructions: `[SWITCHMAN] Handover compaction at the force watermark. Write the summary as a continuation document: (1) the current task, concrete progress so far, and the immediate next steps; (2) the dispatch ledger below (recent dispatches); (3) the active routing lane. Recent dispatches:\n${ledger}`,
			});
		} catch {
			forceCompactPending = false;
		}
	});

	// Ledger survival across pi's automatic compactions: snapshot at
	// session_before_compact (branch still intact), deterministically restore
	// as a custom entry once session_compact lands. Replaces the old mid-run
	// ctx.compact(customInstructions) — the automatic path ignores instructions,
	// and calling compact ourselves mid-run aborted the live agent run.
	let ledgerSnapshot: string | null = null;
	pi.on("session_before_compact", (event) => {
		try {
			ledgerSnapshot = snapshotLedger(event.branchEntries);
		} catch {
			ledgerSnapshot = null;
		}
	});
	pi.on("session_compact", (_event, ctx) => {
		if (ledgerSnapshot !== null) {
			const summary = ledgerSnapshot;
			ledgerSnapshot = null;
			try {
				pi.appendEntry(LEDGER_RESTORE_TYPE, ledgerRestorePayload(summary));
			} catch {
				/* fail-open */
			}
		}
		// Handover continuation: the compaction triggered at the force
		// watermark just landed — resume the task on the compacted context.
		// (pi's TUI host drops CompactOptions.onComplete, so this event is
		// the completion signal; the TTL guards against stale handovers.)
		if (handoverArmedAt !== null && Date.now() - handoverArmedAt < HANDOVER_TTL_MS) {
			handoverArmedAt = null;
			try {
				ctx.sendUserMessage(AUTO_CONTINUE_MESSAGE, { deliverAs: "followUp" } as never);
			} catch {
				/* fail-open: the human can simply speak */
			}
		}
	});
	pi.on("session_compact_failed", (_event, ctx) => {
		// Never leave the handover armed across a failed compaction; the
		// human can simply speak (or /compact) to resume.
		if (handoverArmedAt !== null) {
			handoverArmedAt = null;
			try {
				ctx.ui.notify("switchman: handover compaction failed — continuation cancelled", "warning");
			} catch {
				/* fail-open */
			}
		}
	});

	applyWatermark(pi, {
		config: () => {
			const config = cfgNow();
			return {
				watermark: config.watermark,
				compress: { hardRatio: config.compress.hardRatio },
				disabled: config.disabled,
			};
		},
		setThresholdScale: setCompressionThresholdScale,
		onTier: (tier) => {
			watermarkTier = tier;
		},
			requestCompact: () => {
			forceCompactPending = true;
		},
		afterCompact: (ctx) => {
			// Auto-continue: queue a user turn right after a compaction that killed
			// the run (force-tier onComplete, or pi's post-error threshold compaction
			// detected at turn_end) so the agent resumes without waiting for the human.
			// deliverAs followUp: if the agent is somehow still busy, queue instead of throw.
			try {
				ctx.sendUserMessage(AUTO_CONTINUE_MESSAGE, { deliverAs: "followUp" } as never);
			} catch {
				/* fail-open */
			}
		},
	});

	// ---- [F] config TUI + status ----------------------------------------------

	registerConfigCommand(pi, {
		config: () => configFor(configCwd ?? process.cwd()),
		save: (patch) => {
			const paths = configPaths(configCwd ?? process.cwd());
			const target = saveTarget(paths.globalPath, paths.projectPath);
			writeRawConfig(target, patch);
			return target;
		},
		registerEndpoint: (entry) => registerDecisionEndpoint(pi, entry),
	});

	registerStatusCommand(pi, {
		stats,
		store,
		config: () => configFor(configCwd ?? process.cwd()),
		protocolInjected: () => protocolSeen,
		watermarkTier: () => watermarkTier,
	});
}
