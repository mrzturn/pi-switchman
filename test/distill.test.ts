/** Distillation tests: line mode, char fallback, no-reduction guard, slicing. */

import assert from "node:assert/strict";
import test from "node:test";
import { distillText, sliceSpan, storeFooter, textOf } from "../src/compress.ts";

function lines(n: number): string {
	return Array.from({ length: n }, (_, i) => `line-${i + 1}`).join("\n");
}

test("textOf joins text blocks and rejects image blocks", () => {
	assert.equal(textOf([{ type: "text", text: "a" }, { type: "text", text: "b" }]), "a\nb");
	assert.equal(textOf([{ type: "text", text: "a" }]), "a");
	assert.equal(
		textOf([{ type: "text", text: "a" }, { type: "image" as const, data: "x", mimeType: "image/png" }]),
		null,
	);
	assert.equal(textOf([]), "");
});

test("line-based distillation keeps head, tail, marker, footer", () => {
	const text = lines(100);
	const footer = storeFooter("/tmp/x.txt", text.length, 100);
	const distilled = distillText(text, { head: 5, tail: 3, footer });
	assert.ok(distilled);
	const out = distilled as string;
	assert.ok(out.includes("line-1\n"));
	assert.ok(out.includes("line-5"));
	assert.ok(!out.includes("line-6\n"));
	assert.ok(out.includes("92 lines omitted"));
	assert.ok(out.includes("line-98"));
	assert.ok(out.endsWith(footer));
	assert.ok(out.length < text.length * 0.9);
});

test("char-based fallback for few very long lines", () => {
	const text = "x".repeat(20_000);
	const footer = storeFooter("/tmp/x.txt", text.length, 1);
	const distilled = distillText(text, { head: 60, tail: 20, footer });
	assert.ok(distilled);
	const out = distilled as string;
	assert.ok(out.includes("chars omitted"));
	assert.ok(out.startsWith("xxxx"));
	assert.ok(out.endsWith(footer));
});

test("no meaningful reduction returns null (pass-through)", () => {
	assert.equal(distillText("short", { head: 5, tail: 3, footer: "" }), null);
	// enough lines but head+tail covers nearly everything
	const text = lines(12);
	assert.equal(distillText(text, { head: 6, tail: 5, footer: "" }), null);
	// char fallback under its own floor
	assert.equal(distillText("y".repeat(4000), { head: 1, tail: 1, footer: "" }), null);
});

test("sliceSpan is 1-indexed, clamped, and notes continuation", () => {
	const text = lines(10);
	const span = sliceSpan(text, 2, 3);
	assert.equal(span.from, 2);
	assert.equal(span.to, 4);
	assert.ok(span.text.startsWith("line-2\n"));
	assert.ok(span.text.includes("line-4"));
	assert.ok(span.text.includes("6 more lines below"));
	assert.ok(span.text.includes("offset=5"));

	const full = sliceSpan(text, 1, 50);
	assert.equal(full.to, 10);
	assert.ok(!full.text.includes("more lines below"));

	const clamped = sliceSpan(text, 99, 5);
	assert.equal(clamped.from, 10);
	assert.equal(clamped.to, 10);
});

test("storeFooter format is stable", () => {
	const footer = storeFooter("/tmp/pi-switchman/bash-abc.txt", 12345, 678);
	assert.ok(footer.includes("full output (12345 chars, 678 lines) saved to: /tmp/pi-switchman/bash-abc.txt"));
	assert.ok(footer.includes('expand(path="/tmp/pi-switchman/bash-abc.txt"'));
});
