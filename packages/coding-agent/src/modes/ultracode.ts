import ultracodeNotice from "../prompts/system/ultracode-notice.md" with { type: "text" };
import { createGradientHighlighter, type KeywordHighlighter } from "./gradient-highlight";
import { magicKeywordRegex } from "./magic-keyword-boundary";
import { keywordInProse } from "./markdown-prose";

/**
 * "ultracode" keyword support, mirroring Claude Code's affordance.
 *
 * Typing the standalone word in the input editor paints it with a violet ->
 * magenta -> gold ripple ({@link highlightUltracode}); submitting a message that
 * mentions it turns ultracode ON for the rest of the session: xhigh reasoning
 * effort on every turn and every subagent, plus the standing workflow
 * orchestration contract carried by {@link ULTRACODE_NOTICE}. Matching is
 * prose-delimited and case-sensitive (lowercase only), so "ultracoded",
 * "Ultracode", or "ultracode.ts" never trigger either behavior.
 */

// Detection: lowercase keyword flanked by prose punctuation, whitespace, or a string edge.
const ULTRACODE_WORD = magicKeywordRegex("ultracode");

/** Hidden system notice appended after a user message that mentions "ultracode". */
export const ULTRACODE_NOTICE: string = ultracodeNotice.trim();

/**
 * Whether `text` contains the standalone keyword "ultracode" (lowercase,
 * prose-delimited) in prose - never inside a code block, inline code span,
 * or XML/HTML section.
 */
export function containsUltracode(text: string): boolean {
	return keywordInProse(text, ULTRACODE_WORD);
}

/**
 * Highlight every standalone "ultracode" in `text` for editor display with a
 * violet -> magenta -> gold ripple (hue 280..40, wrapping through 360), which
 * mirrors Claude Code's own violet ultracode treatment. Visually distinct from
 * the other three keywords: ultrathink is a full-spectrum rainbow, orchestrate
 * is hue 150..280 (teal -> violet), and workflowz is hue 30..150 (amber ->
 * green).
 */
export const highlightUltracode: KeywordHighlighter = createGradientHighlighter({
	probe: /ultracode/,
	highlight: magicKeywordRegex("ultracode", "g"),
	stops: 14,
	hue: t => (280 + t * 120) % 360,
});
