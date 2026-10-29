/** watch.ts: agent log formatting, file lifecycle, tmux gating (pure-ish). */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { formatChildMessage, startAgentLog, tailAgentLog, TmuxWatch } from "../src/watch.ts";

const msg = (over: Record<string, unknown>) => over as never;

test("formatChildMessage: assistant text, toolCall, toolResult", () => {
	assert.match(formatChildMessage(msg({ role: "assistant", content: [{ type: "text", text: "hello\nworld" }] })) ?? "", /^▶ hello world/);
	assert.match(formatChildMessage(msg({ role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: { command: "ls" } }] })) ?? "", /^⚙ bash\(/);
	assert.match(formatChildMessage(msg({ role: "toolResult", content: [{ type: "text", text: "ok" }] })) ?? "", /^· ok/);
	assert.match(
		formatChildMessage(msg({ role: "toolResult", stopReason: "error", content: [{ type: "text", text: "boom" }] })) ?? "",
		/^✗ boom/,
	);
	assert.equal(formatChildMessage(msg({ role: "user", content: "hi" })), null);
});

test("startAgentLog + tailAgentLog round-trip in a private temp dir", () => {
	const store = mkdtempSync(join(tmpdir(), "switchman-watch-"));
	const log = startAgentLog(store, "run scout", "count the tests");
	assert.ok(log);
	log?.write("▶ working");
	log?.write("■ exit=0");
	assert.ok(existsSync(log?.path ?? ""));
	const tail = tailAgentLog(log?.path ?? "");
	assert.ok(tail.includes("▶ working") && tail.includes("■ exit=0"));
	assert.ok(tailAgentLog(join(store, "missing.log")).includes("missing"));
});

test("TmuxWatch: inactive without TMUX env, attach returns null", () => {
	const watch = new TmuxWatch("", "tmux");
	assert.equal(watch.active, false);
	assert.equal(watch.attach("/tmp/x.log"), null);
	assert.doesNotThrow(() => watch.detach("pane-1"));
});

test("TmuxWatch: corrupted tmux binary fails open (attach null, no throw)", () => {
	const watch = new TmuxWatch("in-tmux", "/nonexistent-tmux-binary");
	assert.equal(watch.active, true);
	assert.equal(watch.attach("/tmp/x.log"), null);
});
