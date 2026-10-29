#!/usr/bin/env node
// Only emit the explicitly supported language fields, never the source JSON or errors.
const { readFileSync } = require("node:fs");
const { homedir } = require("node:os");
const { join } = require("node:path");

const fields = ["default", "commit", "docs", "db"];
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function readLanguages(path) {
	try {
		const config = JSON.parse(readFileSync(path, "utf8"));
		if (!isObject(config) || !isObject(config.skills) || !isObject(config.skills.language)) return {};
		const result = {};
		for (const field of fields) {
			const value = config.skills.language[field];
			if (typeof value === "string" && value.trim()) result[field] = value.trim();
		}
		return result;
	} catch {
		return {};
	}
}

const home = homedir();
let agentDir = process.env.PI_CODING_AGENT_DIR || join(home, ".pi", "agent");
if (agentDir === "~") agentDir = home;
else if (agentDir.startsWith("~/") || agentDir.startsWith("~\\")) agentDir = join(home, agentDir.slice(2));

const globalLanguages = readLanguages(join(agentDir, "switchman.json"));
const projectLanguages = readLanguages(join(process.cwd(), ".pi", "switchman.json"));
process.stdout.write(`${JSON.stringify({ ...globalLanguages, ...projectLanguages })}\n`);
