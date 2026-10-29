/** /switchman-status command + per-session stats. */

import { readdirSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { LoadedConfig } from "./config.ts";
import type { OutputStore } from "./compress.ts";
import { ledgerFromBranch } from "./ledger.ts";
import { routerStats } from "./router.ts";
import { tailAgentLog, TmuxWatch } from "./watch.ts";
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
			// Selection watchdog: the router only runs for requests on the virtual
			// model. If the session's last model_change picked a physical model, the
			// user thinks auto is active while every request bypasses switchman —
			// say so explicitly instead of staying silent.
			try {
				const branch = ctx.sessionManager.getBranch() as { type?: string; modelId?: string }[];
			let selected: string | null = null;
			for (let i = branch.length - 1; i >= 0; i--) {
					if (branch[i]?.type === "model_change") {
						selected = branch[i].modelId ?? null;
					break;
					}
				}
				if (selected !== null && selected !== "auto") {
					lines.push(`⚠ routing dormant: this session's model is ${selected}, not switchman/auto — gate/relay/decision/lane switching are all bypassed. Select switchman/auto to activate.`);
				}
			} catch {
				/* fail-open */
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

	// ---- agent work visibility ----------------------------------------------

	const watch = new TmuxWatch();
	pi.registerCommand("switchman-agents", {
		description: "List subagent work logs, or tail one: /switchman-agents [n]",
		handler: async (args, ctx) => {
			let records: ReturnType<typeof ledgerFromBranch> = [];
			try {
				records = ledgerFromBranch(ctx.sessionManager.getBranch()).filter((r) => (r.logPaths?.length ?? 0) > 0);
			} catch {
				/* fail-open */
			}
			if (records.length === 0) {
				ctx.ui.notify("no subagent dispatches yet (run/parallel create work logs)", "info");
				return;
			}
			const listed = records.slice(-10);
			const arg = args.trim();
			if (arg === "") {
				const lines = [`subagent work logs (tmux: ${watch.active ? "on — live panes open automatically" : "off — tail with /switchman-agents <n>"}):`];
				listed.forEach((record, index) => {
					const time = new Date(record.ts).toLocaleTimeString();
					lines.push(`  ${index + 1}. ${time} ${record.mode} "${record.description}" ${record.status} (${record.logPaths?.length} log${record.logPaths && record.logPaths.length > 1 ? "s" : ""})`);
				});
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}
			const index = Number.parseInt(arg, 10);
			if (!Number.isInteger(index) || index < 1 || index > listed.length) {
				ctx.ui.notify(`/switchman-agents: index out of range (1-${listed.length})`, "warning");
				return;
			}
			const record = listed[index - 1];
			const parts = [`[switchman] ${record.mode} "${record.description}" — ${record.logPaths?.length} log(s):`];
			for (const path of record.logPaths ?? []) {
				parts.push(`--- ${path} ---`, tailAgentLog(path));
			}
			ctx.ui.notify(parts.join("\n"), "info");
		},
	});
}
