/** Byte-stable, model-facing protocol text (cache constitution #1, #6).
 *
 *  English only. Must be a pure function of configuration flags — never embeds
 *  live numbers, timestamps, or paths, so the system-prompt section keyed
 *  PROTOCOL_SECTION_KEY stays byte-identical for a given config across turns,
 *  keeping the provider prompt-cache prefix stable. */

export const PROTOCOL_SECTION_KEY = "switchman";

export function protocolText(compressEnabled: boolean): string {
	const lines = ["[SWITCHMAN:DOCTRINE] Context economics layer active."];
	if (compressEnabled) {
		lines.push(
			"- Oversized tool results are distilled before entering the transcript: head and tail lines are kept, the omitted middle is marked, and the full output is saved to a file named in the result footer.",
			"- To read any span of a stored full output, call expand with that path and 1-indexed offset/limit instead of re-running the source tool.",
			"- Work from the distilled view first; expand only the specific spans you actually need.",
		);
	}
	return lines.join("\n");
}
