/** Dispatch ledger: durable, branch-scoped, out-of-context records of every
 *  dispatch — the pi-native answer to dsh-switchman's double-dispatch incident.
 *  Entries are custom entries (never sent to the LLM); compaction instructions
 *  and /switchman-status reconstruct them from the branch. */

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

export const LEDGER_TYPE = "switchman:ledger";
/** Custom entry appended right after a compaction so recent dispatches
 *  deterministically survive the branch rewrite. */
export const LEDGER_RESTORE_TYPE = "switchman:ledger-restore";

export type LedgerStatus = "done" | "error";

export interface LedgerRecord {
	id: string;
	mode: "gather" | "judge" | "run" | "parallel";
	description: string;
	status: LedgerStatus;
	ts: number;
	/** Store path holding the full output (expand-readable) when applicable. */
	reportPath?: string;
	/** Per-agent work logs (watch.ts) for run/parallel dispatches. */
	logPaths?: string[];
	lane?: string;
	model?: string;
}

/** Ledger entries on one branch, oldest first. Fail-open: any malformed
 *  entry is skipped, never thrown. */
export function ledgerFromBranch(branch: readonly SessionEntry[]): LedgerRecord[] {
	const records: LedgerRecord[] = [];
	for (const entry of branch) {
		if (entry.type !== "custom" || entry.customType !== LEDGER_TYPE) continue;
		const data = entry.data;
		if (typeof data !== "object" || data === null) continue;
		const record = data as Record<string, unknown>;
		if (typeof record.id !== "string" || typeof record.mode !== "string" || typeof record.ts !== "number") continue;
		records.push({
			id: record.id,
			mode: record.mode as LedgerRecord["mode"],
			description: typeof record.description === "string" ? record.description : "",
			status: record.status === "error" ? "error" : "done",
			ts: record.ts,
			reportPath: typeof record.reportPath === "string" ? record.reportPath : undefined,
			logPaths: Array.isArray(record.logPaths)
				? record.logPaths.filter((p): p is string => typeof p === "string")
				: undefined,
			lane: typeof record.lane === "string" ? record.lane : undefined,
			model: typeof record.model === "string" ? record.model : undefined,
		});
	}
	return records;
}

/** Human-readable pending-work summary for compaction instructions. */
export function ledgerSummary(records: readonly LedgerRecord[], limit = 8): string {
	if (records.length === 0) return "(no dispatches on this branch)";
	const recent = records.slice(-limit);
	return recent
		.map(
			(record) =>
				`- ${record.mode} "${record.description}" -> ${record.status}${record.model ? ` [${record.model}]` : ""}`,
		)
		.join("\n");
}

/** Resolve the session's current PHYSICAL model for subprocess dispatch:
 *  the provider/model named on the latest assistant message. Virtual ids
 *  (switchman/auto) never appear there — pi records the dispatched physical
 *  model — so this is the virtual->physical resolution point. Returns null
 *  before the first response. */
export function currentPhysicalModel(branch: readonly SessionEntry[]): { provider: string; model: string } | null {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type !== "message") continue;
		const message = entry.message as AgentMessage;
		if (message.role !== "assistant") continue;
		if (typeof message.provider === "string" && typeof message.model === "string" && message.model !== "") {
			return { provider: message.provider, model: message.model };
		}
	}
	return null;
}

/** Snapshot of the dispatch ledger taken at session_before_compact (before
 *  pi rewrites the branch); null when there is nothing worth restoring. */
export function snapshotLedger(branch: readonly SessionEntry[]): string | null {
	try {
		const records = ledgerFromBranch(branch);
		if (records.length === 0) return null;
		return ledgerSummary(records);
	} catch {
		return null;
	}
}

/** Payload for the post-compaction restore entry (pi.appendEntry). */
export function ledgerRestorePayload(summary: string): Record<string, unknown> {
	return { summary, restoredAt: new Date().toISOString() };
}
