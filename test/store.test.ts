/** OutputStore tests: write/read round-trip, path fence, eviction bound. */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { OutputStore } from "../src/compress.ts";

test("add/read round-trip inside a private temp base", () => {
	const base = mkdtempSync(join(tmpdir(), "sw-store-"));
	try {
		const store = new OutputStore(base);
		const path = store.add("bash", "hello\nworld");
		assert.ok(path.startsWith(store.dir));
		assert.equal(store.read(path), "hello\nworld");
		assert.equal(store.count(), 1);
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

test("path fence rejects outside paths and traversal", () => {
	const base = mkdtempSync(join(tmpdir(), "sw-store-"));
	try {
		const store = new OutputStore(base);
		const inside = store.add("read", "x");
		const sibling = store.add("read", "y");
		assert.ok(store.contains(inside));
		assert.ok(store.contains(sibling));
		assert.equal(store.contains(join(base, "other.txt")), false); // sibling dir
		assert.equal(store.contains("/etc/passwd"), false);
		assert.equal(store.contains(join(store.dir, "..", "escape.txt")), false);
		assert.equal(store.read("/etc/hostname"), null);
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

test("eviction keeps the store bounded at capacity", () => {
	const base = mkdtempSync(join(tmpdir(), "sw-store-"));
	try {
		const store = new OutputStore(base, 3);
		for (let i = 0; i < 6; i++) {
			store.add("bash", `payload-${i}`);
			// distinct mtimes so eviction order is deterministic
			const p = store.count();
			assert.ok(p <= 3, `capacity exceeded: ${p}`);
		}
		assert.equal(store.count(), 3);
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

test("sanitize keeps filenames filesystem-safe", () => {
	const base = mkdtempSync(join(tmpdir(), "sw-store-"));
	try {
		const store = new OutputStore(base);
		const path = store.add("weird/tool name!!", "x");
		const name = path.split("/").pop() as string;
		assert.match(name, /^[a-zA-Z0-9_-]+\.txt$/);
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});
