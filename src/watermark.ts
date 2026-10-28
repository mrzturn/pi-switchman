/** [E] Watermark dashboard + fuses (DESIGN §4.5): observes context usage after
 *  each turn, tightens compression at hard, steers toward dispatch at soft,
 *  and triggers pi-native compaction (with ledger-aware instructions) at
 *  force. Purely additive: every path fails open. */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { WatermarkConfig } from "./config.ts";
import { ledgerFromBranch, ledgerSummary } from "./ledger.ts";

export type WatermarkTier = "ok" | "soft" | "hard" | "force";

const TIER_RANK: Record<WatermarkTier, number> = { ok: 0, soft: 1, hard: 2, force: 3 };

/** Pure tier computation (test-locked). */
export function tierOf(percent: number, config: WatermarkConfig): WatermarkTier {
	if (percent >= config.force) return "force";
	if (percent >= config.hard) return "hard";
	if (percent >= config.soft) return "soft";
	return "ok";
}

const COMPACT_COOLDOWN_MS = 10 * 60 * 1000;

/** Byte-stable continuation message sent as the user after a force-tier
 *  compaction, so the agent resumes the interrupted task without waiting
 *  for the human (pi serializes the queued turn behind the compaction). */
export const AUTO_CONTINUE_MESSAGE =
	"[SWITCHMAN:CONTINUE] Context was just compacted automatically; the dispatch ledger and routing state are preserved. Continue the interrupted task from where it stopped (re-orient via the switchman:ledger entries if needed). If nothing remains pending, reply that you are standing by.";

export interface WatermarkDeps {
	config: () => { watermark: WatermarkConfig; compress: { hardRatio: number }; disabled: boolean };
	setThresholdScale: (scale: number) => void;
	/** Observes every tier transition (status display). */
	onTier?: (tier: WatermarkTier) => void;
	/** Fired right after a force-tier compaction is triggered (auto-continue). */
	afterCompact?: (ctx: ExtensionContext) => void;
}

export function applyWatermark(pi: ExtensionAPI, deps: WatermarkDeps): void {
	let lastTier: WatermarkTier = "ok";
	let lastCompactAt = 0;

	pi.on("session_start", () => {
		lastTier = "ok";
	});

	pi.on("turn_end", (_event, ctx) => {
		try {
			const config = deps.config();
			if (config.disabled) return;
			const usage = ctx.getContextUsage();
			if (usage === undefined || usage.percent === null) return;
			const tier = tierOf(usage.percent, config.watermark);
			deps.onTier?.(tier);

			// Fuse: hard tier tightens the compression threshold; leaving relaxes it.
			deps.setThresholdScale(tier === "hard" || tier === "force" ? config.compress.hardRatio : 1);

			// Fire only on upward transitions (no per-turn spam).
			if (TIER_RANK[tier] > TIER_RANK[lastTier]) {
				if (tier === "soft") {
					steer(ctx, `[SWITCHMAN:WATERMARK] context at ${Math.round(usage.percent)}% (soft). Prefer dispatch(mode="gather") for bulk reads and dispatch(mode="judge") for independent verdicts; wrap up tangents.`);
					notify(ctx, `switchman: soft tier (${Math.round(usage.percent)}%) — steering toward dispatch`, "info");
				} else if (tier === "hard") {
					notify(ctx, `switchman: hard tier (${Math.round(usage.percent)}%) — read compression tightened`, "warning");
				} else if (tier === "force" && Date.now() - lastCompactAt > COMPACT_COOLDOWN_MS) {
					lastCompactAt = Date.now();
					let pending = "(none)";
					try {
						pending = ledgerSummary(ledgerFromBranch(ctx.sessionManager.getBranch()));
					} catch {
						/* advisory */
					}
					notify(ctx, `switchman: force tier (${Math.round(usage.percent)}%) — compacting with dispatch ledger`, "warning");
					ctx.compact({
						customInstructions: `[SWITCHMAN] Preserve the dispatch ledger (recent dispatches below) and the current routing lane when summarizing. Recent dispatches:\n${pending}`,
					});
					try {
						deps.afterCompact?.(ctx); // auto-continue: queue the next turn without user input
					} catch {
						/* fail-open */
					}
				}
			}
			lastTier = tier;
		} catch {
			/* fail-open */
		}
	});
}

function notify(ctx: ExtensionContext, text: string, level: "info" | "warning"): void {
	try {
		if (ctx.hasUI) ctx.ui.notify(text, level);
	} catch {
		/* best effort */
	}
}

function steer(ctx: ExtensionContext, text: string): void {
	try {
		void Promise.resolve(ctx.sendMessage({
			customType: "switchman.watermark",
			content: text,
			display: true,
		}, { deliverAs: "nextTurn" })).catch(() => {});
	} catch {
		/* best effort */
	}
}
