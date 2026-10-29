/**
 * Repro: run the router's exact classifier path against the live local
 * decision endpoint. Loads the real extension (registers the provider from
 * the user's global switchman.json), then calls modelRuntime.findOfType +
 * classify with the lane question shape and prints the raw result.
 *
 * Run: bun repro/repro-classifier.ts
 */
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const log = (m: string) => console.log(`[repro] ${m}`);

const cwd = mkdtempSync(join(tmpdir(), "switchman-clf-"));
const modelRuntime = await ModelRuntime.create({ refreshOnCreate: false });
let captured: unknown = null;
const resourceLoader = new DefaultResourceLoader({
	cwd,
	agentDir: join(cwd, "agent"),
	extensionFactories: [
		// Capture the extension context so we can reach the SAME modelRegistry
		// facade the router uses at runtime.
		((pi: { on: (e: string, h: (_ev: unknown, ctx: unknown) => void) => void }) => {
			pi.on("session_start", (_ev, ctx) => {
				captured = ctx;
			});
		}) as never,
		(await import("../src/index.ts")).default,
	],
});
await resourceLoader.reload();

const { session } = await createAgentSession({
	modelRuntime,
	resourceLoader,
	sessionManager: SessionManager.inMemory(),
	cwd,
});
await session.bindExtensions({}); // fires session_start in SDK sessions

const rt = (captured as { modelRegistry: { findOfType: (t: string, p: string, m: string) => unknown; classify: (m: unknown, c: unknown, o?: unknown) => Promise<{ stopReason: string; errorMessage?: string; answers?: unknown }> } })?.modelRegistry;
if (!rt) {
	console.log("[repro] no captured ctx — session_start never fired");
	process.exit(1);
}
const clf = rt.findOfType("classifier", "switchman-decision", "d3:4b-mxfp8");
log(`findOfType -> ${clf ? `${clf.provider}/${clf.id} api=${clf.api}` : "NOT FOUND"}`);
if (clf) {
	log(`baseUrl: ${clf.baseUrl}`);
	try {
		const result = await rt.classify(clf as never, {
			state: "Current model: glm-5.3 (main lane). Recent conversation:\nuser: review my changes",
			questions: {
				lane: {
					type: "choice",
					instructions: "Which execution lane fits the user's latest request best?",
					criteria: {
						hard: "Subtle design, cross-cutting refactors, large migrations, or hard debugging",
						main: "Ordinary feature work, fixes, reviews, questions",
						economy: "Small mechanical lookups, quick factual questions, batch micro-tasks",
						review: "Independent verification or review of already-written changes",
						vision: "Work that involves reading images or screenshots",
					},
				},
			},
		} as never, { signal: AbortSignal.timeout(8000) } as never);
		log(`stopReason=${result.stopReason} errorMessage=${result.errorMessage ?? "none"}`);
		log(`answers=${JSON.stringify(result.answers)}`);
	} catch (e) {
		log(`classify THREW: ${(e as Error).message}`);
	}
}
session.dispose();
process.exit(0);
