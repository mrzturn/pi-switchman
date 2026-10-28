/** [F] /switchman-config: TUI configuration center (DESIGN §4.6).
 *  A single custom screen (ctx.ui.custom) with three views: main (lanes +
 *  decision model), lane editor (reorder/remove/add), model picker
 *  (type-to-filter). The TUI is only an editor for switchman.json — the file
 *  always remains hand-editable. Non-TUI modes print a snapshot instead. */

import { existsSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Anchor, LaneName, LoadedConfig, ModelRef, RouterConfig } from "./config.ts";
import { LANE_NAMES } from "./config.ts";
import { inferTier, type ModelFacts, type Tier } from "./capability.ts";

const LANE_DESCRIPTIONS: Record<LaneName, string> = {
	hard: "high-stakes reasoning and large refactors",
	main: "everyday coding",
	economy: "small mechanical lookups",
	review: "independent verification",
	vision: "image-reading work",
};

// ---- pure row builders (test-locked) -------------------------------------------

export interface MainRow {
	kind: "lane" | "decision" | "hint";
	key: string;
	label: string;
}

export function mainRows(router: RouterConfig): MainRow[] {
	const rows: MainRow[] = [];
	for (const lane of LANE_NAMES) {
		const list = router.lanes[lane];
		const value =
			list === null || list.length === 0
				? "(auto — capability-ranked)"
				: list.map((ref) => `${ref.provider}/${ref.model}`).join(", ");
		rows.push({ kind: "lane", key: lane, label: `${lane.padEnd(8)} ${value}` });
	}
	const decision =
		router.decisionModel === null
			? "(builtin rules only)"
			: `${router.decisionModel.provider}/${router.decisionModel.model}`;
	rows.push({ kind: "decision", key: "decision", label: `decision  ${decision}` });
	return rows;
}

export function laneRows(lane: LaneName, list: ModelRef[] | null): { label: string; action: "model" | "add" | "auto" }[] {
	const rows: { label: string; action: "model" | "add" | "auto" }[] = [];
	if (list === null || list.length === 0) {
		rows.push({ label: "(auto — capability-ranked)", action: "auto" });
	} else {
		list.forEach((ref, index) => {
			rows.push({ label: `${index + 1}. ${ref.provider}/${ref.model}`, action: "model" });
		});
	}
	rows.push({ label: "── add model…", action: "add" });
	return rows;
}

export function formatModelFacts(facts: ModelFacts, anchors: readonly Anchor[]): string {
	const tier = anchors.find((a) => a.provider === facts.provider && a.model === facts.id)?.tier ?? inferTier(facts);
	const vision = facts.input.includes("image") ? " 👁" : "";
	return `${facts.provider}/${facts.id} [${tier}]${vision} (in ${facts.cost.input} · out ${facts.cost.output})`;
}

export function filterModels<T extends { provider: string; id: string }>(models: readonly T[], filter: string, limit = 40): T[] {
	const needle = filter.trim().toLowerCase();
	const matched = needle === "" ? [...models] : models.filter((facts) => `${facts.provider}/${facts.id}`.toLowerCase().includes(needle));
	return matched.slice(0, limit);
}

// ---- registration ----------------------------------------------------------------

export interface ConfigUiDeps {
	config: () => LoadedConfig;
	save: (patch: Record<string, unknown>) => string;
}

export function registerConfigCommand(pi: ExtensionAPI, deps: ConfigUiDeps): void {
	pi.registerCommand("switchman-config", {
		description: "Configure pi-switchman lanes, ordering, and the decision model (TUI)",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui" || !ctx.hasUI) {
				const loaded = deps.config();
				const lines = ["pi-switchman config (non-interactive snapshot):", `  global : ${loaded.globalPath}`, `  project: ${loaded.projectPath}`];
				for (const row of mainRows(loaded.config.router)) lines.push(`  ${row.label}`);
				lines.push("Edit the JSON files above, or run /switchman-config in a TUI session.");
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}

			const loaded = deps.config();
			const working: RouterConfig = {
				...loaded.config.router,
				lanes: { ...loaded.config.router.lanes },
			};
			// The registry rides on the command context (fresh per invocation).
			let available: ModelFacts[] = [];
			let classifiers: { provider: string; id: string; name: string }[] = [];
			try {
				available = ctx.modelRegistry.getAvailable();
			} catch {
				/* snapshot editor degrades to empty candidate lists */
			}
			try {
				classifiers = ctx.modelRegistry
					.getModelsOfType("classifier")
					.map((model) => ({ provider: model.provider, id: model.id, name: model.name }));
			} catch {
				/* builtin-only */
			}
			const anchors = loaded.config.anchors;

			type View = { name: "main" } | { name: "lane"; lane: LaneName } | { name: "pick"; lane: LaneName } | { name: "decision" };
			let view: View = { name: "main" };
			let cursor = 0;
			let filter = "";
			let saved = false;
			let dirty = false;

			const rowsForView = (): { labels: string[]; actions: string[] } => {
				if (view.name === "main") {
					const rows = mainRows(working);
					return { labels: rows.map((row) => row.label), actions: rows.map((row) => row.kind) };
				}
				if (view.name === "lane") {
					const rows = laneRows(view.lane, working.lanes[view.lane]);
					return { labels: rows.map((row) => row.label), actions: rows.map((row) => row.action) };
				}
				if (view.name === "pick") {
					const models = filterModels(available, filter);
					return {
						labels: models.map((facts) => formatModelFacts(facts, anchors)),
						actions: models.map(() => "model"),
					};
				}
				const options = ["(none — builtin rules only)", ...filterModels(classifiers, filter).map((c) => `${c.provider}/${c.id} ${c.name}`)];
				return { labels: options, actions: options.map(() => "option") };
			};

			const decision = await ctx.ui.custom<boolean>((tui, theme, keybindings, done) => {
				let cachedWidth: number | undefined;
				let cachedLines: string[] | undefined;

				return {
					render(width: number): string[] {
						if (cachedLines !== undefined && cachedWidth === width) return cachedLines;
						cachedWidth = width;
						const { labels } = rowsForView();
						const maxIndex = Math.max(0, labels.length - 1);
						if (cursor > maxIndex) cursor = maxIndex;
						const title =
							view.name === "main"
								? "Switchman — lanes & decision model"
								: view.name === "lane"
									? `Switchman — lane "${view.lane}" (${LANE_DESCRIPTIONS[view.lane]})`
									: view.name === "pick"
										? `Switchman — add model to "${(view as { lane: LaneName }).lane}"  (type to filter: "${filter}")`
										: "Switchman — decision model";
						const help =
							view.name === "main"
								? "enter edit · s save · esc quit"
								: view.name === "lane"
									? "u/d move · x remove · enter add · esc back"
									: "type filter · enter pick · esc back";
						const lines = [
							theme.fg("accent", title),
							...labels.map((label, index) => `${index === cursor ? "> " : "  "}${label}`),
							theme.fg("dim", help),
							theme.fg("dim", dirty ? "unsaved changes — press s to save" : " "),
						];
						cachedLines = lines.map((line) => (line.length > width ? `${line.slice(0, Math.max(0, width - 1))}…` : line));
						return cachedLines;
					},
					handleInput(data: string): void {
						const { labels, actions } = rowsForView();
						const maxIndex = Math.max(0, labels.length - 1);
						const invalidate = () => {
							cachedLines = undefined;
							tui.requestRender();
						};

						if (keybindings.matches(data, "tui.select.up")) {
							cursor = cursor <= 0 ? maxIndex : cursor - 1;
							invalidate();
							return;
						}
						if (keybindings.matches(data, "tui.select.down")) {
							cursor = cursor >= maxIndex ? 0 : cursor + 1;
							invalidate();
							return;
						}
						if (keybindings.matches(data, "tui.select.cancel")) {
							if (view.name === "main") {
								done(false);
								return;
							}
							view = view.name === "pick" ? { name: "lane", lane: view.lane } : { name: "main" };
							filter = "";
							cursor = 0;
							invalidate();
							return;
						}
						if (view.name === "pick" || view.name === "decision") {
							// printable chars build the filter; backspace erases.
							if (data === "\x7f" || data === "\b") {
								filter = filter.slice(0, -1);
								cursor = 0;
								invalidate();
								return;
							}
							if (data.length === 1 && data >= " " && !keybindings.matches(data, "tui.select.confirm")) {
								filter += data;
								cursor = 0;
								invalidate();
								return;
							}
						}

						if (keybindings.matches(data, "tui.select.confirm")) {
							if (view.name === "main") {
								const rows = mainRows(working);
								const row = rows[Math.min(cursor, rows.length - 1)];
								if (row === undefined) return;
								if (row.kind === "lane") view = { name: "lane", lane: row.key as LaneName };
								else view = { name: "decision" };
								cursor = 0;
								filter = "";
								invalidate();
								return;
							}
							if (view.name === "lane") {
								const list = working.lanes[view.lane] ?? [];
								const action = actions[cursor];
								if (action === "add" || action === "auto") {
									view = { name: "pick", lane: view.lane };
									filter = "";
									cursor = 0;
									invalidate();
									return;
								}
								// enter on a model: no-op (editing via u/d/x)
								return;
							}
							if (view.name === "pick") {
								const models = filterModels(available, filter);
								const facts = models[cursor];
								if (facts === undefined) return;
								const list = [...(working.lanes[view.lane] ?? [])];
								list.push({ provider: facts.provider, model: facts.id });
								working.lanes[view.lane] = list;
								dirty = true;
								view = { name: "lane", lane: view.lane };
								filter = "";
								cursor = 0;
								invalidate();
								return;
							}
							// decision picker
							if (cursor === 0) {
								working.decisionModel = null;
							} else {
								const choice = filterModels(classifiers, filter)[cursor - 1];
								if (choice === undefined) return;
								working.decisionModel = { provider: choice.provider, model: choice.id };
							}
							dirty = true;
							view = { name: "main" };
							cursor = 0;
							invalidate();
							return;
						}

						if (view.name === "lane" && data.length === 1) {
							const list = working.lanes[view.lane];
							if (list === null || list.length === 0) return;
							const modelIndex = actions.slice(0, cursor + 1).lastIndexOf("model");
							if (modelIndex < 0) return;
							if (data === "x") {
								list.splice(modelIndex, 1);
								working.lanes[view.lane] = list.length > 0 ? list : null;
								dirty = true;
								invalidate();
								return;
							}
							if (data === "u" && modelIndex > 0) {
								const [moved] = list.splice(modelIndex, 1);
								list.splice(modelIndex - 1, 0, moved);
								cursor = Math.max(0, cursor - 1);
								dirty = true;
								invalidate();
								return;
							}
							if (data === "d" && modelIndex < list.length - 1) {
								const [moved] = list.splice(modelIndex, 1);
								list.splice(modelIndex + 1, 0, moved);
								cursor = Math.min(maxIndex, cursor + 1);
								dirty = true;
								invalidate();
								return;
							}
						}

						if (view.name === "main" && data === "s" && dirty) {
							saved = true;
							done(true);
							return;
						}
					},
					invalidate(): void {
						cachedLines = undefined;
					},
				};
			});

			if (decision && saved) {
				const target = deps.save({ router: { lanes: working.lanes, decisionModel: working.decisionModel } });
				ctx.ui.notify(`switchman config saved to ${target}`, "info");
			} else if (!decision) {
				ctx.ui.notify("switchman config closed without saving", "info");
			}
		},
	});
}

/** Save target: the project file when it exists, else the global file. */
export function saveTarget(globalPath: string, projectPath: string): string {
	return existsSync(projectPath) ? projectPath : globalPath;
}

export type { Tier };
