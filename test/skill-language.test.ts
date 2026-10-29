import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const helper = resolve(import.meta.dirname, "../skills/_shared/scripts/language.cjs");
const secret = "SECRET-do-not-print-789";

function fixture(t: { after: (fn: () => void) => void }) {
	const root = mkdtempSync(join(tmpdir(), "skill-language-"));
	const home = join(root, "home");
	const agent = join(root, "agent");
	const project = join(root, "project");
	for (const dir of [home, agent, project]) mkdirSync(dir);
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const put = (path: string, value: unknown) => {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
	};
	const run = (extraEnv: Record<string, string> = {}, cwd = project) => {
		const result = spawnSync(process.execPath, [helper], {
			cwd,
			encoding: "utf8",
			env: { ...process.env, HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agent, ...extraEnv },
		});
		assert.equal(result.status, 0, result.stderr);
		assert.equal(result.stderr, "");
		assert.ok(!result.stdout.includes(secret));
		return JSON.parse(result.stdout);
	};
	return { home, agent, project, put, run };
}

const language = (value: unknown) => ({ skills: { language: value }, apiKey: secret });

test("merges valid fields independently and emits no unrelated config", (t) => {
	const { agent, project, put, run } = fixture(t);
	const globalPath = join(agent, "switchman.json");
	const projectPath = join(project, ".pi/switchman.json");
	put(globalPath, language({ default: "English", commit: "日本語", docs: "fr", db: "pt-BR", extra: secret }));
	put(projectPath, language({ default: " 中文 ", commit: "  ", docs: "de", db: 17, extra: secret }));
	const before = [readFileSync(globalPath), readFileSync(projectPath)];
	chmodSync(globalPath, 0o400);
	chmodSync(projectPath, 0o400);
	assert.deepEqual(run(), { default: "中文", commit: "日本語", docs: "de", db: "pt-BR" });
	assert.deepEqual([readFileSync(globalPath), readFileSync(projectPath)], before);
});

test("missing, malformed and non-object layers fall back without exposing errors", (t) => {
	const { agent, project, put, run } = fixture(t);
	const globalPath = join(agent, "switchman.json");
	const projectPath = join(project, ".pi/switchman.json");
	assert.deepEqual(run(), {});
	put(globalPath, language({ default: "English", db: "ko" }));
	for (const invalid of [`{ "apiKey": "${secret}", broken`, null, [], { skills: [] }, { skills: { language: [] } }, { skills: { language: null } }]) {
		put(projectPath, invalid);
		assert.deepEqual(run(), { default: "English", db: "ko" });
	}
	put(projectPath, language({ default: false, commit: {}, docs: ["fr"], db: null }));
	assert.deepEqual(run(), { default: "English", db: "ko" });
	put(globalPath, `{ "apiKey": "${secret}", invalid`);
	put(projectPath, language({ docs: "es" }));
	assert.deepEqual(run(), { docs: "es" });
});

test("honors agent directory, default home, tilde and actual cwd", (t) => {
	const { home, agent, project, put, run } = fixture(t);
	put(join(home, ".pi/agent/switchman.json"), language({ default: "home" }));
	put(join(home, "custom/switchman.json"), language({ default: "tilde" }));
	put(join(agent, "switchman.json"), language({ default: "agent" }));
	put(join(project, ".pi/switchman.json"), language({ docs: "project" }));
	const nested = join(project, "nested");
	mkdirSync(nested);
	put(join(nested, ".pi/switchman.json"), language({ docs: "nested" }));
	assert.deepEqual(run(), { default: "agent", docs: "project" });
	assert.deepEqual(run({}, nested), { default: "agent", docs: "nested" });
	assert.deepEqual(run({ PI_CODING_AGENT_DIR: "" }), { default: "home", docs: "project" });
	assert.deepEqual(run({ PI_CODING_AGENT_DIR: "~/custom" }), { default: "tilde", docs: "project" });
	assert.deepEqual(run({ PI_CODING_AGENT_DIR: "../agent" }), { default: "agent", docs: "project" });
});

test("unreadable paths are ignored without logging their names or contents", (t) => {
	const { agent, project, put, run } = fixture(t);
	// A directory at the config path reliably fails even when tests run as root.
	mkdirSync(join(agent, "switchman.json"));
	put(join(project, ".pi/switchman.json"), language({ commit: "fr" }));
	assert.deepEqual(run(), { commit: "fr" });
});

test("shared policy and git workflow preserve scope and safe helper usage", () => {
	const policy = readFileSync(resolve(import.meta.dirname, "../skills/_shared/language.md"), "utf8");
	assert.match(policy, /only for the parts it covers/);
	assert.match(policy, /For every other part, continue through the configuration and conversation fallback/);
	assert.match(policy, /node .*_shared\/scripts\/language\.cjs/);
	assert.match(policy, /Do not `read`, `cat`, print/);
	assert.match(policy, /also applies to the `db-query` skill/);
	const git = readFileSync(resolve(import.meta.dirname, "../skills/git-commit-message/SKILL.md"), "utf8");
	for (const term of ["git diff --cached", "git diff", "untracked", "both staged and unstaged", "clarify instead of assuming"]) {
		assert.ok(git.includes(term), `missing ${term}`);
	}
});
