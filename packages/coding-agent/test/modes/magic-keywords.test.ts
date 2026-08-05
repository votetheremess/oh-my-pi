import { beforeAll, describe, expect, it } from "bun:test";
import { hasMagicKeyword, highlightMagicKeywords } from "@oh-my-pi/pi-coding-agent/modes/magic-keywords";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

beforeAll(async () => {
	// Gradient palettes read the active theme's color mode.
	await initTheme(false);
});

describe("highlightMagicKeywords", () => {
	it("paints every magic keyword in a single prose pass, preserving visible text", () => {
		const input = "first ultrathink then orchestrate the workflowz";
		const decorated = highlightMagicKeywords(input);
		expect(decorated).not.toBe(input);
		expect(decorated).toContain("\x1b[38");
		expect(Bun.stripANSI(decorated)).toBe(input);
		// Each keyword is gradient-painted character-by-character, so none survives as a
		// contiguous run in the decorated output.
		for (const keyword of ["ultrathink", "orchestrate", "workflowz"]) {
			expect(decorated).not.toContain(keyword);
			expect(Bun.stripANSI(decorated)).toContain(keyword);
		}
	});

	it("paints all four magic keywords in one pass, whatever order they appear in", () => {
		const input = "ultracode then workflowz, orchestrate, and ultrathink";
		const decorated = highlightMagicKeywords(input);
		expect(decorated).not.toBe(input);
		expect(Bun.stripANSI(decorated)).toBe(input);
		// Each highlighter paints only its own keyword, so chaining them is
		// order-independent: all four survive as visible text, none as a
		// contiguous run in the decorated output.
		for (const keyword of ["ultracode", "workflowz", "orchestrate", "ultrathink"]) {
			expect(decorated).not.toContain(keyword);
			expect(Bun.stripANSI(decorated)).toContain(keyword);
		}
	});

	it("paints a standalone ultracode keyword", () => {
		const input = "please ultracode this";
		const decorated = highlightMagicKeywords(input);
		expect(decorated).not.toBe(input);
		expect(decorated).not.toContain("ultracode");
		expect(Bun.stripANSI(decorated)).toBe(input);
	});

	it("paints punctuation-adjacent prose keywords without changing visible text", () => {
		const input = 'first "ultrathink," then orchestrate. Finally workflowz!';
		const decorated = highlightMagicKeywords(input);
		expect(decorated).not.toBe(input);
		expect(Bun.stripANSI(decorated)).toBe(input);
		for (const keyword of ["ultrathink", "orchestrate", "workflowz"]) {
			expect(decorated).not.toContain(keyword);
		}
	});

	it("never paints keywords inside code spans, fenced blocks, or XML sections", () => {
		const input = "`ultrathink`\n```\norchestrate\n```\n<x>workflowz</x>";
		expect(highlightMagicKeywords(input)).toBe(input);
	});

	it("paints only the prose occurrence when the keyword also appears in code", () => {
		const decorated = highlightMagicKeywords("`orchestrate` but please orchestrate now");
		// The code-span occurrence stays literal; the prose one is split by gradient escapes.
		expect(decorated).toContain("`orchestrate`");
		expect(Bun.stripANSI(decorated)).toBe("`orchestrate` but please orchestrate now");
		// Exactly one prose occurrence painted ⇒ one contiguous "orchestrate" remains (the code one).
		expect(decorated.split("orchestrate").length - 1).toBe(1);
	});

	it("restores the supplied foreground after each painted keyword", () => {
		const reset = "\x1b[38;2;1;2;3m";
		const decorated = highlightMagicKeywords("go orchestrate go", reset);
		expect(decorated).toContain(reset);
		// The reset must land before the trailing prose so it keeps the bubble color.
		expect(decorated.endsWith(`${reset} go`)).toBe(true);
	});

	it("shifts the gradient when phase advances — same visible text, different SGR bytes", () => {
		const text = "go ultrathink now";
		const frame0 = highlightMagicKeywords(text, undefined, 0);
		const frame1 = highlightMagicKeywords(text, undefined, 0.5);
		expect(Bun.stripANSI(frame0)).toBe(text);
		expect(Bun.stripANSI(frame1)).toBe(text);
		// The visible output is unchanged width-wise but the painted bytes differ
		// because the per-stop palette has cycled.
		expect(frame0).not.toBe(frame1);
	});

	it("treats out-of-range phase values as wrapping into [0, 1)", () => {
		const text = "do ultrathink please";
		// 1.0 wraps back to 0, so the painted output must match.
		expect(highlightMagicKeywords(text, undefined, 1)).toBe(highlightMagicKeywords(text, undefined, 0));
		// Negative phase wraps too — -0.25 ≡ 0.75.
		expect(highlightMagicKeywords(text, undefined, -0.25)).toBe(highlightMagicKeywords(text, undefined, 0.75));
	});
});

describe("hasMagicKeyword", () => {
	it("detects every standalone keyword in prose", () => {
		expect(hasMagicKeyword("please ultrathink this")).toBe(true);
		expect(hasMagicKeyword("now orchestrate everything")).toBe(true);
		expect(hasMagicKeyword("just workflowz the steps")).toBe(true);
	});

	it("detects standalone keywords beside prose punctuation and quotes", () => {
		for (const text of ["please ultrathink.", 'say "orchestrate" now', "then workflowz, please"]) {
			expect(hasMagicKeyword(text)).toBe(true);
		}
	});

	it("rejects keywords used as code symbols or calls", () => {
		for (const text of [
			"ultrathink()",
			"orchestrate()",
			"workflowz()",
			"foo::ultrathink",
			"foo::orchestrate",
			"foo::workflowz",
		]) {
			expect(hasMagicKeyword(text)).toBe(false);
			expect(highlightMagicKeywords(text)).toBe(text);
		}
	});

	it("rejects casing, inflections, old workflow names, and paths", () => {
		expect(hasMagicKeyword("Ultrathink")).toBe(false);
		expect(hasMagicKeyword("ORCHESTRATE")).toBe(false);
		expect(hasMagicKeyword("workflow")).toBe(false);
		expect(hasMagicKeyword("workflows")).toBe(false);
		expect(hasMagicKeyword("ultrathinking is fun")).toBe(false);
		expect(hasMagicKeyword("workflowzed already")).toBe(false);
		expect(hasMagicKeyword("src/modes/ultrathink.ts")).toBe(false);
		expect(hasMagicKeyword("orchestrate.ts is a file")).toBe(false);
		expect(hasMagicKeyword("packages/coding-agent/test/modes/workflowz.test.ts")).toBe(false);
	});

	it("rejects keywords inside code spans, fences, and xml sections", () => {
		expect(hasMagicKeyword("`ultrathink`")).toBe(false);
		expect(hasMagicKeyword("```\norchestrate\n```")).toBe(false);
		expect(hasMagicKeyword("<x>workflowz</x>")).toBe(false);
	});

	it("returns false for empty / keyword-free text", () => {
		expect(hasMagicKeyword("")).toBe(false);
		expect(hasMagicKeyword("plain message with no keywords")).toBe(false);
	});

	it("detects ultracode on the same prose boundaries as the other keywords", () => {
		expect(hasMagicKeyword("ultracode this")).toBe(true);
		expect(hasMagicKeyword('say "ultracode" now')).toBe(true);
		expect(hasMagicKeyword("ultracoded")).toBe(false);
		expect(hasMagicKeyword("Ultracode")).toBe(false);
		expect(hasMagicKeyword("ultracode()")).toBe(false);
		expect(hasMagicKeyword("foo::ultracode")).toBe(false);
		expect(hasMagicKeyword("src/modes/ultracode.ts")).toBe(false);
		expect(hasMagicKeyword("`ultracode`")).toBe(false);
	});
});
