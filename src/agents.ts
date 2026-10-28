/** Agent discovery for Tier 3 dispatch: markdown files with YAML frontmatter
 *  under the user agent dir (~/.pi/agent/agents) and, when scoped, the nearest
 *  project dir (.pi/agents). Agents are re-discovered on every dispatch, so
 *  mid-session edits take effect immediately (official-example semantics). */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

export type AgentScope = "user" | "project" | "both";

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	/** "provider/model" pin; omitted = inherit the dispatching session's model. */
	model?: string;
	systemPrompt: string;
	source: "user" | "project";
	filePath: string;
}

function parseToolList(value: unknown): string[] | undefined {
	const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
	const tools = raw
		.filter((tool): tool is string => typeof tool === "string")
		.map((tool) => tool.trim())
		.filter((tool) => tool !== "");
	return tools.length > 0 ? tools : undefined;
}

function loadAgentsFromDir(dir: string, source: "user" | "project"): AgentConfig[] {
	const agents: AgentConfig[] = [];
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;
		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = readFileSync(filePath, "utf8");
		} catch {
			continue;
		}
		const { frontmatter, body } = parseFrontmatter<{
			name?: unknown;
			description?: unknown;
			tools?: unknown;
			model?: unknown;
		}>(content);
		if (typeof frontmatter.name !== "string" || typeof frontmatter.description !== "string") continue;
		agents.push({
			name: frontmatter.name,
			description: frontmatter.description,
			tools: parseToolList(frontmatter.tools),
			model: typeof frontmatter.model === "string" && frontmatter.model !== "" ? frontmatter.model : undefined,
			systemPrompt: body,
			source,
			filePath,
		});
	}
	return agents;
}

function isDirectory(candidate: string): boolean {
	try {
		return statSync(candidate).isDirectory();
	} catch {
		return false;
	}
}

function findNearestProjectAgentsDir(cwd: string): string | null {
	let currentDir = cwd;
	for (;;) {
		const candidate = path.join(currentDir, CONFIG_DIR_NAME, "agents");
		if (isDirectory(candidate)) return candidate;
		const parent = path.dirname(currentDir);
		if (parent === currentDir) return null;
		currentDir = parent;
	}
}

/** Scope-filtered agent map; project agents override user agents with the
 *  same name when scope is "both". */
export function discoverAgents(cwd: string, scope: AgentScope): AgentConfig[] {
	const userDir = path.join(getAgentDir(), "agents");
	const projectDir = findNearestProjectAgentsDir(cwd);
	const byName = new Map<string, AgentConfig>();
	if (scope !== "project") {
		for (const agent of loadAgentsFromDir(userDir, "user")) byName.set(agent.name, agent);
	}
	if (scope === "project" || scope === "both") {
		if (projectDir !== null) {
			for (const agent of loadAgentsFromDir(projectDir, "project")) byName.set(agent.name, agent);
		}
	}
	return [...byName.values()];
}

export function findAgent(cwd: string, scope: AgentScope, name: string): AgentConfig | undefined {
	return discoverAgents(cwd, scope).find((agent) => agent.name === name);
}
