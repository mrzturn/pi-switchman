/** [E] Watermark dashboard + fuses (DESIGN §4.5): observes context usage after
 *  each turn, tightens compression at hard, steers toward dispatch at soft,
 *  and triggers pi-native compaction (with ledger-aware instructions) at
 *  force. Purely additive: every path fails open. */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { WatermarkConfig } from "./config.ts";
import { ledgerFromBranch, ledgerSummary } from "./ledger.ts";

export type WatermarkTier = "ok" | "soft" | "hard" | "force";

const TIER_RANK: Record<WatermarkTier, number> = { ok: 0, soft: 1, hard: 2, force: 3 };

/** Effective trigger percent of one threshold: the percent form and the
 *  absolute-token form (converted against the live context window), whichever
 *  fires first — min(percent, tokens/window*100). Pure. */
export function effectiveThreshold(
	threshold: { percent?: number; tokens?: number },
	contextWindow: number,
): number {
	const byPercent = threshold.percent ?? Number.POSITIVE_INFINITY;
	const byTokens =
		threshold.tokens !== undefined && contextWindow > 0
			? (threshold.tokens / contextWindow) * 100
			: Number.POSITIVE_INFINITY;
	return Math.min(byPercent, byTokens);
}

/** Pure tier computation from actual context usage (test-locked). The
 *  percentage is derived from tokens/window when possible (the source of
 *  truth), falling back to the reported percent. */
export function tierOf(
	usage: { percent: number | null; tokens: number | null; contextWindow: number },
	config: WatermarkConfig,
): WatermarkTier {
	const percent =
		usage.tokens !== null && usage.contextWindow > 0 ? (usage.tokens / usage.contextWindow) * 100 : usage.percent;
	if (percent === null) return "ok";
	if (percent >= effectiveThreshold(config.force, usage.contextWindow)) return "force";
	if (percent >= effectiveThreshold(config.hard, usage.contextWindow)) return "hard";
	if (percent >= effectiveThreshold(config.soft, usage.contextWindow)) return "soft";
	return "ok";
}

export const COMPACT_COOLDOWN_MS = 10 * 60 * 1000;
const CONTINUE_COOLDOWN_MS = 60 * 1000;

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
	/** Fired when the force tier is crossed: index queues a handover
	 *  compaction for the moment the agent run settles (never mid-run). */
	requestCompact?: () => void;
}

export function applyWatermark(pi: ExtensionAPI, deps: WatermarkDeps): void {
	let lastTier: WatermarkTier = "ok";
	let lastCompactAt = 0;
	let lastContinueAt = 0;

	pi.on("session_start", () => {
		lastTier = "ok";
	});

	pi.on("turn_end", (event, ctx) => {
		try {
			const config = deps.config();
			if (config.disabled) return;

			// Dead-turn continuation. A provider-killed response ends its turn with
			// stopReason "error"; pi's post-error handling may then run a threshold
			// compaction that never retries, so without a nudge the run dies with the
			// error shown to the user. turn_end fires from the finishTurn hook BEFORE
			// that compaction decision, so we cannot wait for a compaction entry —
			// queue the continuation now with deliverAs followUp: it rides the live
			// agent run (pi compacts first if the threshold is hit), or starts the
			// next run if the run settles first. stopReason "aborted" is the user's
			// own interrupt — never continue those.
			const stopReason = (event as { message?: { stopReason?: string } } | undefined)?.message?.stopReason;
			if (stopReason === "error" && Date.now() - lastContinueAt > CONTINUE_COOLDOWN_MS) {
				lastContinueAt = Date.now();
				deps.afterCompact?.(ctx);
				return; // the turn is dead; tier logic below would misfire on stale usage
			}

			const usage = ctx.getContextUsage();
			if (usage === undefined || (usage.percent === null && usage.tokens === null)) return;
			const tier = tierOf(usage, config.watermark);
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
					// NEVER ctx.compact() here: turn_end fires inside a live run and
					// compact() aborts the agent first (the historical dead turns were
					// exactly this). Instead raise the flag; the agent_end handler in
					// index.ts performs the handover compaction once the run settles —
					// compacting while idle aborts nothing — and continues the task.
					deps.requestCompact?.();
					notify(ctx, `switchman: force tier (${Math.round(usage.percent)}%) — handover compaction queued for turn end`, "warning");
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
