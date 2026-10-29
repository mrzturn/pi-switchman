/** Config layer tests: defaults, merge precedence, malformed input fail-open. */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG, ConfigStore, mergeConfig } from "../src/config.ts";

test("defaults when no config files exist", () => {
	const dir = mkdtempSync(join(tmpdir(), "sw-cfg-"));
	try {
		const store = new ConfigStore(join(dir, "global.json"), join(dir, ".pi", "switchman.json"));
		const loaded = store.load();
		assert.deepEqual(loaded.config, DEFAULT_CONFIG);
		assert.deepEqual(loaded.errors, []);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("global overrides defaults, project overrides global", () => {
	const merged1 = mergeConfig(DEFAULT_CONFIG, { compress: { threshold: 12345, readHead: 30 } });
	assert.equal(merged1.compress.threshold, 12345);
	assert.equal(merged1.compress.readHead, 30);
	assert.equal(merged1.compress.readTail, DEFAULT_CONFIG.compress.readTail); // untouched
	assert.equal(merged1.watermark.soft, DEFAULT_CONFIG.watermark.soft);

	const merged2 = mergeConfig(merged1, { compress: { threshold: 99 }, watermark: { soft: 50 } });
	assert.equal(merged2.compress.threshold, 99);
	assert.equal(merged2.compress.readHead, 30); // global layer survives
	assert.equal(merged2.watermark.soft, 50);
});

test("invalid values fall back to the layer below (fail-open)", () => {
	const merged = mergeConfig(DEFAULT_CONFIG, {
		compress: { threshold: -5, readHead: "many", enabled: "yes", hardRatio: 2 },
		watermark: { soft: 0, hard: 150, force: null },
		disabled: 1,
	});
	assert.equal(merged.compress.threshold, DEFAULT_CONFIG.compress.threshold);
	assert.equal(merged.compress.readHead, DEFAULT_CONFIG.compress.readHead);
	assert.equal(merged.compress.enabled, DEFAULT_CONFIG.compress.enabled);
	assert.equal(merged.compress.hardRatio, DEFAULT_CONFIG.compress.hardRatio);
	assert.equal(merged.watermark.soft, DEFAULT_CONFIG.watermark.soft);
	assert.equal(merged.watermark.hard, DEFAULT_CONFIG.watermark.hard);
	assert.equal(merged.disabled, DEFAULT_CONFIG.disabled);
});

test("malformed JSON records an error and keeps defaults", () => {
	const dir = mkdtempSync(join(tmpdir(), "sw-cfg-"));
	try {
		writeFileSync(join(dir, "global.json"), "{ not json", "utf8");
		const store = new ConfigStore(join(dir, "global.json"), join(dir, "none.json"));
		const loaded = store.load();
		assert.deepEqual(loaded.config, DEFAULT_CONFIG);
		assert.equal(loaded.errors.length, 1);
		assert.match(loaded.errors[0] as string, /global\.json/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("store loads layered files from disk", () => {
	const dir = mkdtempSync(join(tmpdir(), "sw-cfg-"));
	try {
		writeFileSync(join(dir, "global.json"), JSON.stringify({ compress: { threshold: 5000 } }), "utf8");
		const projectDir = join(dir, "proj", ".pi");
		mkdirSync(projectDir, { recursive: true });
		writeFileSync(join(projectDir, "switchman.json"), JSON.stringify({ disabled: true }), "utf8");
		const store = new ConfigStore(join(dir, "global.json"), join(projectDir, "switchman.json"));
		const loaded = store.load();
		assert.equal(loaded.config.disabled, true);
		assert.equal(loaded.config.compress.threshold, 5000);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
