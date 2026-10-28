/** /switchman-status command + per-session compression stats. */

import { readdirSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { LoadedConfig } from "./config.ts";
import type { OutputStore } from "./compress.ts";

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
}

export function registerStatusCommand(pi: ExtensionAPI, deps: StatusDeps): void {
	pi.registerCommand("switchman-status", {
		description: "Show pi-switchman status: config, compression stats, store",
		handler: async (_args, ctx) => {
			const lines: string[] = [];
			const loaded = deps.config();
			const cfg = loaded.config;
			lines.push(`pi-switchman ${cfg.disabled ? "· DISABLED" : "· enabled"}`);
			lines.push(`config: ${loaded.globalPath}${loaded.projectPath ? ` + ${loaded.projectPath}` : ""}`);
			for (const error of loaded.errors) lines.push(`config error: ${error}`);
			lines.push(`protocol section: ${deps.protocolInjected() ? "injected" : "not injected yet"}`);
			lines.push(
				`compress: ${cfg.compress.enabled ? `on (threshold ${cfg.compress.threshold} chars)` : "off"}`,
			);
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
