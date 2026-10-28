/** Distillation pure functions + the full-output store ([A] entry compression).
 *
 *  Runtime deps: node builtins only (unit-testable without pi). Type-only dep
 *  on pi-ai content blocks. Everything here is deterministic: same input,
 *  same distillation (test-locked). */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve as resolvePath, sep } from "node:path";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";

export type ContentBlock = TextContent | ImageContent;

/** Joined text of a result, or null when it carries images (pass through —
 *  image results are deliberate and small in text terms). */
export function textOf(content: readonly ContentBlock[]): string | null {
	let text = "";
	for (const block of content) {
		if (block.type === "image") return null;
		if (block.type === "text") text += (text === "" ? "" : "\n") + block.text;
	}
	return text;
}

export interface DistillOptions {
	head: number;
	tail: number;
	/** Footer naming the stored full output (storeFooter). */
	footer: string;
}

/** Head/tail distillation. Line-based when there are enough lines; falls back
 *  to char-based for few-very-long-lines results (minified JSON, data URLs).
 *  Returns null when no meaningful reduction is possible — the caller passes
 *  the original through (never distill into something barely smaller). */
export function distillText(text: string, options: DistillOptions): string | null {
	const { head, tail, footer } = options;
	const lines = text.split("\n");
	const total = lines.length;
	let distilled: string;
	if (total > head + tail + 4) {
		const omitted = total - head - tail;
		distilled =
			lines.slice(0, head).join("\n") +
			`\n[switchman: ${omitted} lines omitted — full output in footer]\n` +
			lines.slice(total - tail).join("\n");
	} else {
		const HEAD_CHARS = 3000;
		const TAIL_CHARS = 1500;
		if (text.length <= HEAD_CHARS + TAIL_CHARS + 512) return null;
		distilled =
			text.slice(0, HEAD_CHARS) +
			`\n[switchman: ${text.length - HEAD_CHARS - TAIL_CHARS} chars omitted — full output in footer]\n` +
			text.slice(text.length - TAIL_CHARS);
	}
	distilled += footer;
	return distilled.length < text.length * 0.9 ? distilled : null;
}

/** The footer note naming the stored full output. English, fixed format. */
export function storeFooter(path: string, chars: number, lines: number): string {
	return `\n[switchman] full output (${chars} chars, ${lines} lines) saved to: ${path}\nUse expand(path="${path}", offset=<1-indexed line>, limit=<line count>) to read any span.`;
}

export interface SpanResult {
	text: string;
	total: number;
	from: number;
	to: number;
}

/** 1-indexed line slicing for expand, with a continuation note when lines
 *  remain below the span. Clamped: never throws on out-of-range input. */
export function sliceSpan(text: string, offset: number, limit: number): SpanResult {
	const lines = text.split("\n");
	const total = lines.length;
	const from = Math.min(Math.max(1, Math.floor(offset)), total);
	const count = Math.min(Math.max(1, Math.floor(limit)), total - from + 1);
	const to = from + count - 1;
	const span = lines.slice(from - 1, to).join("\n");
	const rest = total - to;
	return {
		text: rest > 0 ? `${span}\n[switchman: ${rest} more lines below — use offset=${to + 1}]` : span,
		total,
		from,
		to,
	};
}

function sanitize(name: string): string {
	return name.replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 24) || "tool";
}

/** Process-level store of full outputs under one temp dir, bounded by
 *  evicting the oldest files beyond `capacity`. Paths it hands out are the
 *  only paths expand will read (contains() is the security fence). */
export class OutputStore {
	readonly dir: string;
	private readonly capacity: number;
	private seq = 0;

	constructor(baseTmp: string, capacity = 256) {
		this.dir = join(baseTmp, "pi-switchman");
		this.capacity = capacity;
	}

	add(toolName: string, text: string): string {
		mkdirSync(this.dir, { recursive: true });
		const name = `${sanitize(toolName)}-${Date.now().toString(36)}-${(this.seq++).toString(36)}.txt`;
		const path = join(this.dir, name);
		writeFileSync(path, text, "utf8");
		this.evict();
		return path;
	}

	/** True only when path resolves to an existing file directly inside the
	 *  store dir (no traversal, no symlinks out — resolved prefix check). */
	contains(path: string): boolean {
		let resolved: string;
		try {
			resolved = resolvePath(path);
		} catch {
			return false;
		}
		if (!resolved.startsWith(this.dir + sep)) return false;
		try {
			return existsSync(resolved);
		} catch {
			return false;
		}
	}

	read(path: string): string | null {
		if (!this.contains(path)) return null;
		try {
			return readFileSync(path, "utf8");
		} catch {
			return null;
		}
	}

	count(): number {
		try {
			return readdirSync(this.dir).length;
		} catch {
			return 0;
		}
	}

	private evict(): void {
		try {
			const paths = readdirSync(this.dir)
				.filter((name) => name.endsWith(".txt"))
				.map((name) => join(this.dir, name));
			if (paths.length <= this.capacity) return;
			const stamped: { path: string; mtime: number }[] = [];
			for (const path of paths) {
				try {
					stamped.push({ path, mtime: statSync(path).mtimeMs });
				} catch {
					/* raced away — ignore */
				}
			}
			stamped.sort((a, b) => a.mtime - b.mtime);
			const excess = stamped.length - this.capacity;
			for (let i = 0; i < excess; i++) {
				try {
					unlinkSync(stamped[i].path);
				} catch {
					/* best effort */
				}
			}
		} catch {
			/* best effort */
		}
	}
}
