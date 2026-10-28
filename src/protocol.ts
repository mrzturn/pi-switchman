/** Byte-stable, model-facing protocol text (cache constitution #1, #6).
 *
 *  English only. Must be a pure function of configuration flags — never embeds
 *  live numbers, timestamps, or paths, so the system-prompt section keyed
 *  PROTOCOL_SECTION_KEY stays byte-identical for a given config across turns,
 *  keeping the provider prompt-cache prefix stable. */

export const PROTOCOL_SECTION_KEY = "switchman";

export function protocolText(options: { compressEnabled: boolean; dispatchEnabled: boolean }): string {
	const lines = ["[SWITCHMAN:DOCTRINE] Context economics layer active."];
	if (options.compressEnabled) {
		lines.push(
			"- Oversized tool results are distilled before entering the transcript: head and tail lines are kept, the omitted middle is marked, and the full output is saved to a file named in the result footer.",
			"- To read any span of a stored full output, call expand with that path and 1-indexed offset/limit instead of re-running the source tool.",
			"- Work from the distilled view first; expand only the specific spans you actually need.",
		);
	}
	if (options.dispatchEnabled) {
		lines.push(
			"- Dispatch tiers: prefer the cheapest sufficient executor.",
			'  * gather: ordered read-only steps (read/grep/glob/find/ls) inside one dispatch call — the process is discarded, only the summary enters context.',
			"  * judge: one-shot verdict from a lane model (review, verify, classify) with no transcript footprint.",
			"  * run: isolated subagent for multi-step work that needs its own agent loop.",
			"  * parallel: several gather/judge/run tasks at once.",
			"- Under [SWITCHMAN:WATERMARK] pressure notices, prefer gather/judge over in-session bulk reads.",
		);
	}
	return lines.join("\n");
}
