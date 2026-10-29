/** watch.ts: agent log formatting, file lifecycle, tmux gating (pure-ish). */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { formatChildMessage, startAgentLog, tailAgentLog, TmuxWatch, type TmuxRunner } from "../src/watch.ts";

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

test("TmuxWatch: window is created AND selected; splits tile; detach lingers, kills, and focus returns", () => {
	const calls: string[][] = [];
	const out = new Map<string, string>([
		["display-message", "@0"], // origin window
		["new-window", "@9"], // agents window id
		["split-window", "%5"],
		["split-window-2", "%6"],
	]);
	let splitCalls = 0;
	const runner: TmuxRunner = (binary, args) => {
		calls.push(args);
		const cmd = args[0];
		const key = cmd === "split-window" ? `split-window${++splitCalls > 1 ? "-2" : ""}` : cmd;
		return { status: 0, stdout: out.get(key) ?? "", stderr: "" };
	};
	const watch = new TmuxWatch("in-tmux", "tmux", runner, 0); // no linger for the test
	assert.equal(watch.attach("/tmp/a.log"), "@9.0");
	assert.equal(watch.attach("/tmp/b.log"), "%5");
	assert.equal(watch.attach("/tmp/c.log"), "%6");
	// first attach: capture origin, create window, SELECT it (visible split)
	assert.deepEqual(calls[0], ["display-message", "-p", "#{window_id}"]);
	assert.deepEqual(calls[1].slice(0, 4), ["new-window", "-d", "-n", "switchman-agents"]);
	assert.ok(calls[1].includes("bash"));
	assert.deepEqual(calls[2], ["select-window", "-t", "@9"]);
	// subsequent: split into the same window + tiled layout
	assert.equal(calls[3][0], "split-window");
	assert.equal(calls[3][3], "@9");
	assert.deepEqual(calls[4], ["select-layout", "-t", "@9", "tiled"]);
	// detach: pane killed per agent; window dies with the last, focus restored
	watch.detach("%5");
	watch.detach("%6");
	watch.detach("@9.0");
	const flat = calls.map((c) => c.join(" "));
	assert.ok(flat.some((c) => c === "kill-pane -t %5"));
	assert.ok(flat.includes("select-window -t @0"), "focus returns to the origin window before kill-window");
	assert.ok(flat.includes("kill-window -t @9"));
});

test("TmuxWatch: linger defers the kill", () => {
	const calls: string[][] = [];
	const runner: TmuxRunner = (_b, args) => {
		calls.push(args);
		return { status: 0, stdout: args[0] === "new-window" ? "@9" : args[0] === "display-message" ? "@0" : "", stderr: "" };
	};
	const watch = new TmuxWatch("in-tmux", "tmux", runner, 60);
	assert.equal(watch.attach("/tmp/a.log"), "@9.0");
	watch.detach("@9.0");
	assert.equal(calls.filter((c) => c[0] === "kill-pane").length, 0, "not killed yet — lingering");
});
