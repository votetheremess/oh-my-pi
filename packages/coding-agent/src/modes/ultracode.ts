import { prompt } from "@oh-my-pi/pi-utils";
import ultracodeNotice from "../prompts/system/ultracode-notice.md" with { type: "text" };
import { createGradientHighlighter, type KeywordHighlighter } from "./gradient-highlight";
import { magicKeywordRegex } from "./magic-keyword-boundary";
import { keywordInProse } from "./markdown-prose";
import { renderWorkflowNotice } from "./workflow";

/**
 * "ultracode" keyword support, mirroring Claude Code's affordance.
 *
 * Typing the standalone word in the input editor paints it with a violet ->
 * magenta -> gold ripple ({@link highlightUltracode}); submitting a message that
 * mentions it runs THAT TURN at xhigh reasoning effort, for the turn and every
 * subagent it spawns, under the workflow orchestration contract carried by
 * {@link ULTRACODE_NOTICE}. The word must be repeated on any later message that
 * wants the same treatment. Matching is
 * prose-delimited and case-sensitive (lowercase only), so "ultracoded",
 * "Ultracode", or "ultracode.ts" never trigger either behavior.
 */

// Detection: lowercase keyword flanked by prose punctuation, whitespace, or a string edge.
const ULTRACODE_WORD = magicKeywordRegex("ultracode");

/**
 * Hidden system notice appended after a user message that mentions "ultracode".
 *
 * When workflow tooling is live this carries the FULL workflow contract - the
 * same helper signatures, structure and patterns `workflowz` injects - followed
 * by the ultracode layer that pins the effort and commits to it. Naming the
 * contract without shipping it would tell the model to orchestrate while
 * withholding the API it must orchestrate with, so the two travel together.
 *
 * With `eval` or `task` inactive there is no fan-out mechanism, so the notice
 * says so plainly and keeps only the effort layer.
 */
export function renderUltracodeNotice({
	taskBatch,
	scoutAvailable,
	workflowAvailable,
}: {
	taskBatch: boolean;
	scoutAvailable?: boolean;
	workflowAvailable: boolean;
}): string {
	// The contract is embedded, so it drops its own notice wrapper and its
	// workflowz-specific opening line: the user typed "ultracode", and one
	// notice block must not nest another.
	const workflowContract = workflowAvailable
		? renderWorkflowNotice({ taskBatch, scoutAvailable, embedded: true })
		: "";
	return prompt.render(ultracodeNotice, { workflowAvailable, workflowContract }).trim();
}

/** ULTRACODE_NOTICE is the default ultracode notice for sessions with workflow tooling live. */
export const ULTRACODE_NOTICE: string = renderUltracodeNotice({ taskBatch: true, workflowAvailable: true });

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
