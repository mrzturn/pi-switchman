/** The expand tool: on-demand spans of stored full outputs — the sanctioned
 *  "front door" back to the original text after a distillation. */

import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { sliceSpan, type OutputStore } from "./compress.ts";

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;

export function createExpandTool(store: OutputStore) {
	return defineTool({
		name: "expand",
		label: "expand",
		description:
			"Read a span of a stored full tool output (the path named in a [switchman] result footer). Lines are 1-indexed; use offset/limit like the read tool.",
		parameters: Type.Object({
			path: Type.String({ description: "File path from a [switchman] footer note" }),
			offset: Type.Optional(
				Type.Number({ description: `Line number to start from (1-indexed, default 1)` }),
			),
			limit: Type.Optional(
				Type.Number({ description: `Maximum lines to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT})` }),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const text = store.read(params.path);
			if (text === null) {
				throw new Error(
					`Not a readable file in the switchman store: ${params.path} (it may have been evicted; re-run the source tool if the full output is still needed)`,
				);
			}
			const limit = Math.min(Math.max(1, params.limit ?? DEFAULT_LIMIT), MAX_LIMIT);
			const span = sliceSpan(text, params.offset ?? 1, limit);
			return {
				content: [
					{
						type: "text" as const,
						text: `${span.text}\n[switchman] ${params.path} lines ${span.from}-${span.to} of ${span.total}`,
					},
				],
				details: { path: params.path, from: span.from, to: span.to, total: span.total },
			};
		},
	});
}
