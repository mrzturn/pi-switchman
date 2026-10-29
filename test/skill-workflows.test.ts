import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { loadSkills } from "@earendil-works/pi-coding-agent";

const root = resolve(import.meta.dirname, "..");
const skillPaths = ["git-commit-message", "requirement-docs"].map((name) => resolve(root, "skills", name));
const text = (path: string) => readFileSync(path, "utf8");

test("Pi loads both workflow skills with valid frontmatter and lazy references", () => {
	const result = loadSkills({ cwd: root, agentDir: resolve(root, ".nonexistent-agent"), skillPaths, includeDefaults: false });
	assert.deepEqual(result.diagnostics, []);
	assert.deepEqual(result.skills.map((skill) => skill.name).sort(), ["git-commit-message", "requirement-docs"]);
	for (const skill of result.skills) {
		assert.equal(skill.disableModelInvocation, false);
		const instructions = text(skill.filePath);
		assert.match(instructions, /\.\.\/_shared\/language\.md/);
		assert.ok(existsSync(resolve(dirname(skill.filePath), "../_shared/language.md")));
	}
	const docs = result.skills.find((skill) => skill.name === "requirement-docs")!;
	assert.match(text(docs.filePath), /references\/templates\.md/);
	assert.ok(existsSync(resolve(docs.baseDir, "references/templates.md")));
});

test("shared language policy specifies layers, categories, and stable markers", () => {
	const policy = text(resolve(root, "skills/_shared/language.md"));
	for (const value of ["~/.pi/agent/switchman.json", "<cwd>/.pi/switchman.json", "default", "commit", "docs", "db", "[Decided]", "[Pending]"]) {
		assert.ok(policy.includes(value), `missing ${value}`);
	}
});
