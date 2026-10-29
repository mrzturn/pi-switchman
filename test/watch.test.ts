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

test("TmuxWatch: right-column layout, background queue, seamless handoff, fullscreen restore", () => {
	const calls: string[][] = [];
	const fakePanes = new Set<string>(["%0"]); // main pane
	let nextPane = 0;
	const runner: TmuxRunner = (_b, args) => {
		calls.push(args);
		if (args[0] === "display-message") return { status: 0, stdout: "@0", stderr: "" };
		if (args[0] === "list-panes" && args[1] === "-a") {
			return { status: 0, stdout: [...fakePanes].map((p) => `${p}\t/dev/ttysTEST\t@0`).join("\n"), stderr: "" };
		}
		if (args[0] === "list-panes") {
			return { status: 0, stdout: [...fakePanes].join("\n"), stderr: "" };
		}
		if (args[0] === "split-window") {
			const id = `%${++nextPane}`;
			fakePanes.add(id);
			return { status: 0, stdout: id, stderr: "" };
		}
		return { status: 0, stdout: "", stderr: "" };
	};
	const watch = new TmuxWatch("in-tmux", "tmux", runner, 0, 2, "%0");
	const a = watch.attach("/tmp/a.log");
	const b = watch.attach("/tmp/b.log");
	const c = watch.attach("/tmp/c.log");
	assert.match(a ?? "", /^sw-/);
	assert.match(b ?? "", /^sw-/);
	// first displayed: horizontal split FROM the main pane — pi keeps the left
	const splitH = calls.find((x) => x[0] === "split-window" && x.includes("-h"));
	assert.ok(splitH, "first pane splits the main pane horizontally");
	assert.equal(splitH?.[4], "%0");
	// second displayed: vertical split of the right column
	const splitV = calls.find((x) => x[0] === "split-window" && x.includes("-v"));
	assert.equal(splitV?.[4], "%1");
	// third agent: background — no pane created for it
	const splits = calls.filter((x) => x[0] === "split-window");
	assert.equal(splits.length, 2, "max 2 displayed panes");
	// agent a finishes while c waits: seamless respawn into a's pane
	watch.detach(a);
	const respawn = calls.find((x) => x[0] === "respawn-pane");
	assert.ok(respawn, "slot handed off via respawn-pane");
	assert.equal(respawn?.[3], "%1");
	assert.ok(respawn?.some((x) => x.includes("/tmp/c.log")), "respawn tails the queued agent's log");
	// c (now displayed) and b finish: no queue — panes linger-close (linger 0 in test)
	watch.detach(c);
	watch.detach(b);
	const kills = calls.filter((x) => x[0] === "kill-pane").map((x) => x[2]);
	assert.deepEqual(kills.sort(), ["%1", "%2"], "both right panes closed — main pane returns to full width");
	assert.ok(!calls.some((x) => x[0] === "new-window" || x[0] === "select-window"), "never leaves the current window");
});

test("TmuxWatch: background agent finishing just leaves the queue", () => {
	const calls: string[][] = [];
	const runner: TmuxRunner = (_b, args) => {
		calls.push(args);
		if (args[0] === "display-message") return { status: 0, stdout: "@0", stderr: "" };
		if (args[0] === "list-panes" && args[1] === "-a") return { status: 0, stdout: "%0\t/dev/ttysTEST\t@0", stderr: "" };
		if (args[0] === "list-panes") return { status: 0, stdout: "%0\n%1", stderr: "" };
		if (args[0] === "split-window") return { status: 0, stdout: "%1", stderr: "" };
		return { status: 0, stdout: "", stderr: "" };
	};
	const watch = new TmuxWatch("in-tmux", "tmux", runner, 0, 2, "%0");
	const a = watch.attach("/tmp/a.log");
	watch.attach("/tmp/b.log");
	watch.attach("/tmp/c.log"); // background (only 1 slot in this config? default 2 — c is bg)
	watch.detach("sw-3"); // background agent finishes
	assert.ok(!calls.some((x) => x[0] === "kill-pane" || x[0] === "respawn-pane"), "no pane churn for background agents");
	// displayed agent then finishes with empty queue: pane closes
	watch.detach(a);
	assert.ok(calls.some((x) => x[0] === "kill-pane"));
});

test("TmuxWatch: linger defers the kill", () => {
	const calls: string[][] = [];
	const runner: TmuxRunner = (_b, args) => {
		calls.push(args);
		if (args[0] === "display-message") return { status: 0, stdout: "@0", stderr: "" };
		if (args[0] === "list-panes" && args[1] === "-a") return { status: 0, stdout: "%0\t/dev/ttysTEST\t@0", stderr: "" };
		if (args[0] === "split-window") return { status: 0, stdout: "%1", stderr: "" };
		return { status: 0, stdout: "", stderr: "" };
	};
	const watch = new TmuxWatch("in-tmux", "tmux", runner, 60, 2, "%0");
	assert.equal(watch.attach("/tmp/a.log"), "sw-1");
	watch.detach("sw-1");
	assert.equal(calls.filter((c) => c[0] === "kill-pane").length, 0, "not killed yet — lingering");
});
