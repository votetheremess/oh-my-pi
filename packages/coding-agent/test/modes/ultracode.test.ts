import { beforeAll, describe, expect, it } from "bun:test";
import { containsOrchestrate, highlightOrchestrate } from "@oh-my-pi/pi-coding-agent/modes/orchestrate";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import {
	containsUltracode,
	highlightUltracode,
	renderUltracodeNotice,
	ULTRACODE_NOTICE,
} from "@oh-my-pi/pi-coding-agent/modes/ultracode";
import { renderWorkflowNotice, WORKFLOW_NOTICE } from "@oh-my-pi/pi-coding-agent/modes/workflow";

beforeAll(() => {
	// highlightUltracode/highlightOrchestrate read the global theme's color mode.
	initTheme();
});

/** First SGR escape emitted by a gradient highlighter, i.e. its opening color stop. */
function firstEscape(decorated: string): string {
	const start = decorated.indexOf("\x1b");
	if (start < 0) return "";
	return decorated.slice(start, decorated.indexOf("m", start) + 1);
}

describe("ultracode keyword detection", () => {
	it("matches the lowercase word delimited by whitespace or a string edge", () => {
		expect(containsUltracode("ultracode")).toBe(true);
		expect(containsUltracode("please ultracode this refactor")).toBe(true);
		expect(containsUltracode("ultracode the migration")).toBe(true);
		// A newline is whitespace, and end-of-string is a valid right boundary.
		expect(containsUltracode("do it now\nultracode")).toBe(true);
	});

	it("matches the lowercase word beside prose punctuation and quotes", () => {
		for (const text of ["do it. ultracode.", "please ultracode, then report", 'say "ultracode" now']) {
			expect(containsUltracode(text)).toBe(true);
		}
	});

	it("ignores casing, inflections, and path-embedded forms", () => {
		expect(containsUltracode("Ultracode")).toBe(false);
		expect(containsUltracode("ULTRACODE")).toBe(false);
		expect(containsUltracode("ultracoded the build")).toBe(false);
		// A path/extension must not trigger even though sentence punctuation does.
		expect(containsUltracode("packages/coding-agent/src/modes/ultracode.ts")).toBe(false);
		expect(containsUltracode("nothing to see here")).toBe(false);
	});

	it("ignores the word bound into an identifier, symbol reference, or call", () => {
		for (const text of ["foo::ultracode", "ultracode()", "my-ultracode", "ultracode_x"]) {
			expect(containsUltracode(text)).toBe(false);
		}
	});

	it("ignores keywords inside code spans, fenced blocks, and XML sections", () => {
		expect(containsUltracode("use `ultracode` here")).toBe(false);
		expect(containsUltracode("```\nultracode\n```")).toBe(false);
		expect(containsUltracode("<note>ultracode</note>")).toBe(false);
		expect(containsUltracode("<!-- ultracode -->")).toBe(false);
		// A real prose request alongside code still triggers.
		expect(containsUltracode("run `setup` then ultracode the migration")).toBe(true);
	});
});

describe("ultracode keyword highlighting", () => {
	it("decorates the keyword with zero-width escapes, preserving visible text", () => {
		const input = "please ultracode this";
		const decorated = highlightUltracode(input);
		expect(decorated).not.toBe(input);
		expect(decorated).toContain("\x1b");
		expect(Bun.stripANSI(decorated)).toBe(input);
	});

	it("decorates punctuation-adjacent prose while preserving visible text", () => {
		const input = 'please "ultracode," then continue';
		const decorated = highlightUltracode(input);
		expect(decorated).not.toBe(input);
		expect(Bun.stripANSI(decorated)).toBe(input);
	});

	it("leaves text without the standalone keyword untouched", () => {
		expect(highlightUltracode("nothing here")).toBe("nothing here");
		// The probe hits the substring but token/path boundaries fail, so no decoration.
		expect(highlightUltracode("ultracoded builds")).toBe("ultracoded builds");
		expect(highlightUltracode("Ultracode this")).toBe("Ultracode this");
		expect(highlightUltracode("ultracode_x")).toBe("ultracode_x");
		const filePath = "packages/coding-agent/src/modes/ultracode.ts";
		expect(highlightUltracode(filePath)).toBe(filePath);
		// Code spans, fences, and XML sections stay literal.
		expect(highlightUltracode("`ultracode`")).toBe("`ultracode`");
		expect(highlightUltracode("```\nultracode\n```")).toBe("```\nultracode\n```");
		expect(highlightUltracode("<note>ultracode</note>")).toBe("<note>ultracode</note>");
	});

	it("paints a gradient distinct from the orchestrate one", () => {
		const ultracode = highlightUltracode("ultracode");
		const orchestrate = highlightOrchestrate("orchestrate");
		expect(firstEscape(ultracode)).not.toBe("");
		expect(firstEscape(orchestrate)).not.toBe("");
		// Both ripples open on their own hue, so the first color stop differs.
		expect(firstEscape(ultracode)).not.toBe(firstEscape(orchestrate));
	});

	it("does not cross-trigger with the orchestrate highlighter", () => {
		expect(highlightUltracode("orchestrate")).toBe("orchestrate");
		expect(highlightOrchestrate("ultracode")).toBe("ultracode");
		expect(containsOrchestrate("ultracode")).toBe(false);
		expect(containsUltracode("orchestrate")).toBe(false);
	});
});

describe("ultracode notice", () => {
	it("is a self-contained system notice carrying the standing session contract", () => {
		expect(ULTRACODE_NOTICE.startsWith("<system-notice>")).toBe(true);
		expect(ULTRACODE_NOTICE.endsWith("</system-notice>")).toBe(true);
		// The contract is a session-wide opt-in pinned at xhigh, not a one-turn nudge.
		expect(ULTRACODE_NOTICE).toContain("xhigh");
		expect(ULTRACODE_NOTICE).toContain("standing");
		// The contract must not retain the slash-command input placeholder.
		expect(ULTRACODE_NOTICE).not.toContain("$@");
	});
});

describe("ultracode orchestration contract", () => {
	// The whole point of the keyword is that the turn runs as a dynamic workflow.
	// A notice that only NAMES the helpers tells the model to orchestrate while
	// withholding the API it must orchestrate with, so these assert the contract
	// travels with the instruction rather than being referred to.
	const withTooling = renderUltracodeNotice({ taskBatch: true, workflowAvailable: true });
	const withoutTooling = renderUltracodeNotice({ taskBatch: true, workflowAvailable: false });

	it("carries the executable helper API, not a pointer to it", () => {
		for (const helper of ["agent(", "parallel(", "pipeline(", "phase(", "completion("]) {
			expect(withTooling).toContain(helper);
		}
		// Signatures and worked structure, not a passing mention: the standalone
		// workflowz notice is the source of truth, so the contract must match it.
		expect(withTooling).toContain(renderWorkflowNotice({ taskBatch: true, embedded: true }));
	});

	it("is one notice block that names the keyword the user actually typed", () => {
		expect(withTooling.split("<system-notice>")).toHaveLength(2);
		expect(withTooling).toContain("**ultracode**");
		expect(withTooling).not.toContain("**workflowz**");
	});

	it("makes the contract standing rather than per-turn", () => {
		expect(withTooling).toContain("standing default for the session");
		expect(withTooling).toContain("does not expire when this turn does");
	});

	it("prescribes no fan-out API when the tools to run it are inactive", () => {
		for (const helper of ["agent(", "parallel(", "pipeline(", "phase("]) {
			expect(withoutTooling).not.toContain(helper);
		}
		// Silence would read as "orchestrate anyway"; the notice must say why not.
		expect(withoutTooling).toContain("not both active");
		expect(withoutTooling).toContain("xhigh");
	});

	it("leaves the standalone workflowz notice unchanged", () => {
		expect(WORKFLOW_NOTICE.startsWith("<system-notice>")).toBe(true);
		expect(WORKFLOW_NOTICE.endsWith("</system-notice>")).toBe(true);
		expect(WORKFLOW_NOTICE).toContain("**workflowz**");
		expect(renderWorkflowNotice({ taskBatch: true, embedded: true })).not.toContain("system-notice");
	});

	it("renders every template branch, leaving no handlebars behind", () => {
		for (const notice of [withTooling, withoutTooling, ULTRACODE_NOTICE]) {
			expect(notice).not.toContain("{{");
		}
	});
});
