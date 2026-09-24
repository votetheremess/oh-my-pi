import { describe, expect, it } from "bun:test";
import {
	MAGIC_KEYWORDS,
	type MagicKeyword,
	type MagicKeywordContext,
	renderOrchestrateNotice,
	renderWorkflowNotice,
} from "@oh-my-pi/pi-coding-agent/modes/magic-keywords";
import { clearBundledCommandsCache, loadBundledCommands } from "@oh-my-pi/pi-coding-agent/task/commands";

function keywordContext(tools: readonly string[]): MagicKeywordContext {
	return {
		tools,
		taskBatch: true,
		scoutAvailable: true,
		evalTools: true,
		effortApplied: true,
		effortPinned: true,
		maxConcurrency: 4,
		waitTool: tools.includes("wait"),
	};
}

function ultracodeRow(): MagicKeyword {
	const row: MagicKeyword | undefined = MAGIC_KEYWORDS.find(keyword => keyword.id === "ultracode");
	if (!row) throw new Error("ultracode row missing");
	return row;
}

describe("magic keyword registry", () => {
	it("keeps ids and words unique so notice types and settings keys cannot collide", () => {
		expect(new Set(MAGIC_KEYWORDS.map(keyword => keyword.id)).size).toBe(MAGIC_KEYWORDS.length);
		expect(new Set(MAGIC_KEYWORDS.map(keyword => keyword.word)).size).toBe(MAGIC_KEYWORDS.length);
	});

	it("registers ultracode as a root-only row whose notice always ships", () => {
		const row = ultracodeRow();
		expect(row.word).toBe("ultracode");
		// The template carries its own reduced branch for sessions without fan-out,
		// so the loop's `requires` gate must never skip it.
		expect(row.requires).toEqual([]);
		expect(row.rootOnly).toBe(true);
		for (const other of MAGIC_KEYWORDS) {
			if (other.id === "ultracode") continue;
			expect(other.hue).not.toEqual(row.hue);
		}
	});

	it("renders the ultracode contract from the shared context by tool availability", () => {
		const row = ultracodeRow();
		const full = row.notice(keywordContext(["read", "task", "eval", "wait"]));
		expect(full).toContain("<orchestration>");
		expect(full).toContain("`workpool(");
		expect(full).toContain("<adjudication>");
		expect(full).not.toContain("not both active");
		for (const tools of [["read", "task"], ["read", "eval"], ["read"]]) {
			const reduced = row.notice(keywordContext(tools));
			expect(reduced).toContain("not both active");
			expect(reduced).not.toContain("`workpool(");
			expect(reduced).not.toContain("<adjudication>");
		}
	});
});

describe("orchestrate notice", () => {
	it("is a self-contained system notice carrying the orchestration contract", () => {
		const notice = renderOrchestrateNotice({
			tools: ["read", "task", "edit", "write", "lsp", "bash", "todo"],
		});
		expect(notice.startsWith("<system-notice>")).toBe(true);
		expect(notice.endsWith("</system-notice>")).toBe(true);
		expect(notice).toContain("orchestrator");
		// The contract must not retain the slash-command input placeholder.
		expect(notice).not.toContain("$@");
		// Positive controls for the omission test below: each phrase it negates
		// must exist in the full-tools render, or a template rewrite would turn
		// those negatives vacuously green.
		for (const phrase of [
			"`task` dispatch",
			"`edit`/`write`",
			"`lsp diagnostics`",
			"via `bash`",
			"`todo` tracking",
		]) {
			expect(notice).toContain(phrase);
		}
	});

	it("omits tool-budget mentions for tools absent from the session", () => {
		const notice = renderOrchestrateNotice({ tools: ["read"] });
		expect(notice).not.toContain("`task` dispatch");
		expect(notice).not.toContain("`edit`");
		expect(notice).not.toContain("`write`");
		expect(notice).not.toContain("`lsp diagnostics`");
		expect(notice).not.toContain("via `bash`");
		expect(notice).not.toContain("`todo` tracking");
	});

	it("does not name edit when only write is available", () => {
		const writeOnly = renderOrchestrateNotice({ tools: ["read", "write"] });
		expect(writeOnly).toContain("with `write`");
		expect(writeOnly).not.toContain("`edit`/`write`");
		expect(writeOnly).not.toContain("with `edit`");
	});

	it("does not name write when only edit is available", () => {
		const editOnly = renderOrchestrateNotice({ tools: ["read", "edit"] });
		expect(editOnly).toContain("with `edit`");
		expect(editOnly).not.toContain("`edit`/`write`");
	});
});

describe("workflow notice", () => {
	it("defaults to workpools and hides eval-defined tools when disabled", () => {
		const enabled = renderWorkflowNotice({ taskBatch: true, scoutAvailable: true, evalTools: true });
		const disabled = renderWorkflowNotice({ taskBatch: true, scoutAvailable: true, evalTools: false });
		expect(enabled).toContain("Default to `workpool()`");
		expect(enabled).toContain("`@tool`");
		expect(disabled).toContain("Default to `workpool()`");
		expect(disabled).not.toContain("`@tool`");
		expect(disabled).not.toContain("tools=None");
	});
});

describe("orchestrate slash command removal", () => {
	it("is no longer bundled as a slash command", () => {
		clearBundledCommandsCache();
		const names = loadBundledCommands().map(command => command.name);
		expect(names).not.toContain("orchestrate");
		expect(names).toContain("init");
	});
});
