/** /switchman-status command + per-session stats. */

import { readdirSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { LoadedConfig } from "./config.ts";
import type { OutputStore } from "./compress.ts";
import { ledgerFromBranch } from "./ledger.ts";
import { routerStats } from "./router.ts";
import type { WatermarkTier } from "./watermark.ts";

/** In-memory, reset on session_start. Never persisted — purely informational. */
export class Stats {
	compressed = 0;
	passThrough = 0;
	expanded = 0;
	originalChars = 0;
	distilledChars = 0;

	reset(): void {
		this.compressed = 0;
		this.passThrough = 0;
		this.expanded = 0;
		this.originalChars = 0;
		this.distilledChars = 0;
	}

	savedChars(): number {
		return this.originalChars - this.distilledChars;
	}
}

export interface StatusDeps {
	stats: Stats;
	store: OutputStore;
	config: () => LoadedConfig;
	protocolInjected: () => boolean;
	watermarkTier: () => WatermarkTier;
}

export function registerStatusCommand(pi: ExtensionAPI, deps: StatusDeps): void {
	pi.registerCommand("switchman-status", {
		description: "Show pi-switchman status: config, compression, router, ledger",
		handler: async (_args, ctx) => {
			const lines: string[] = [];
			const loaded = deps.config();
			const cfg = loaded.config;
			lines.push(`pi-switchman ${cfg.disabled ? "· DISABLED" : "· enabled"}`);
			lines.push(`config: ${loaded.globalPath}${loaded.projectPath ? ` + ${loaded.projectPath}` : ""}`);
			for (const error of loaded.errors) lines.push(`config error: ${error}`);
			lines.push(`protocol section: ${deps.protocolInjected() ? "injected" : "not injected yet"}`);
			lines.push(`watermark tier: ${deps.watermarkTier()}`);
			lines.push(
				`compress: ${cfg.compress.enabled ? `on (threshold ${cfg.compress.threshold} chars)` : "off"}`,
			);

			// Router
			if (cfg.router.enabled) {
				const laneSummary = (Object.keys(cfg.router.lanes) as Array<keyof typeof cfg.router.lanes>)
					.map((lane) => {
						const list = cfg.router.lanes[lane];
						return `${lane}:${list === null || list.length === 0 ? "auto" : list.length}`;
					})
					.join(" ");
				const decision = cfg.router.decisionModel
					? `${cfg.router.decisionModel.provider}/${cfg.router.decisionModel.model}`
					: "builtin rules";
				lines.push(`router: on (${laneSummary}) · decision: ${decision} · enforce: ${cfg.enforce}`);
				const last = routerStats.lastDecision;
				if (last !== null) {
					const age = Math.round((Date.now() - last.ts) / 1000);
					lines.push(
						`last decision: lane=${last.lane} by=${last.by} confidence=${last.confidence.toFixed(2)} kept=${last.kept} (${age}s ago)`,
					);
				}
			} else {
				lines.push("router: off (switchman/auto not registered)");
			}

			// Compression stats
			const stats = deps.stats;
			if (stats.compressed > 0 || stats.passThrough > 0 || stats.expanded > 0) {
				const saved = stats.savedChars();
				const pct = stats.originalChars > 0 ? Math.round((saved / stats.originalChars) * 100) : 0;
				lines.push(
					`this session: ${stats.compressed} compressed · ${stats.passThrough} oversized-but-skipped · ${stats.expanded} expands`,
				);
				lines.push(`chars: ${stats.originalChars} → ${stats.distilledChars} (saved ${saved}, ${pct}%)`);
			} else {
				lines.push("this session: nothing compressed yet");
			}

			// Ledger tail
			try {
				const ledger = ledgerFromBranch(ctx.sessionManager.getBranch());
				if (ledger.length > 0) {
					lines.push(`ledger: ${ledger.length} dispatches, latest:`);
					for (const record of ledger.slice(-3)) {
						lines.push(`  ${record.mode} "${record.description}" -> ${record.status}${record.model ? ` [${record.model}]` : ""}`);
					}
				} else {
					lines.push("ledger: no dispatches yet");
				}
			} catch {
				lines.push("ledger: (unavailable)");
			}

			let files = 0;
			try {
				files = readdirSync(deps.store.dir).length;
			} catch {
				/* store dir not created yet */
			}
			lines.push(`store: ${deps.store.dir} (${files} files)`);
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
