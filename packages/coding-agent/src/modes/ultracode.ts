import { prompt } from "@oh-my-pi/pi-utils";
import ultracodeNotice from "../prompts/system/ultracode-notice.md" with { type: "text" };
import { normalizeConcurrencyLimit } from "../task/parallel";
import { createGradientHighlighter, type KeywordHighlighter } from "./gradient-highlight";
import { magicKeywordRegex } from "./magic-keyword-boundary";
import { keywordInProse } from "./markdown-prose";

/**
 * "ultracode" keyword support.
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
 * Carries the full workflow orchestration contract: the orchestration
 * doctrine, the script API for this harness's `eval` helpers, the
 * barrier rules, the quality patterns, and the three-verdict adjudication that
 * keeps adversarial verification from destroying real findings. Deliberately
 * NOT the `workflowz` notice: that one is shorter prose by design, and the
 * point of ultracode is the fuller contract.
 *
 * Every claim the notice makes about the runtime is rendered from the live
 * session, never hardcoded, because a notice that misdescribes the API is worse
 * than no notice: the model writes code against it and the code fails.
 * - `workflowAvailable` false: no `eval`/`task`, so no fan-out mechanism exists.
 *   The notice says so and keeps only the effort layer.
 * - `scoutAvailable` false: `scout` is disabled or outside the spawn policy, so
 *   naming it would hand the model an agent type that throws at preflight.
 * - `effortApplied` false: `externalThinking` has replaced native reasoning with
 *   the think tool, and the transport honors that (`forceReasoningOff`), so the
 *   xhigh pin never reaches the wire. The notice must not assert an effort the
 *   request will not carry.
 * - `maxConcurrency` is the live `task.maxConcurrency`; 0 means unbounded and
 *   the cap sentence is omitted entirely, matching the system prompt.
 */
export function renderUltracodeNotice({
	workflowAvailable,
	scoutAvailable,
	effortApplied,
	maxConcurrency,
	viaPlanApproval,
}: {
	workflowAvailable: boolean;
	scoutAvailable?: boolean;
	effortApplied?: boolean;
	maxConcurrency?: number;
	viaPlanApproval?: boolean;
}): string {
	return prompt
		.render(ultracodeNotice, {
			workflowAvailable,
			scoutAvailable: scoutAvailable ?? true,
			effortApplied: effortApplied ?? true,
			MAX_CONCURRENCY: normalizeConcurrencyLimit(maxConcurrency ?? 0),
			viaPlanApproval: viaPlanApproval ?? false,
		})
		.trim();
}

/** ULTRACODE_NOTICE is the default ultracode notice for sessions with workflow tooling live. */
export const ULTRACODE_NOTICE: string = renderUltracodeNotice({ workflowAvailable: true });

/**
 * Whether `text` contains the standalone keyword "ultracode" (lowercase,
 * prose-delimited) in prose — never inside a code block, inline code span,
 * or XML/HTML section.
 */
export function containsUltracode(text: string): boolean {
	return keywordInProse(text, ULTRACODE_WORD);
}

/**
 * Highlight every standalone "ultracode" in `text` for editor display with a
 * violet -> magenta -> gold ripple (hue 280..40, wrapping through 360), chosen
 * to stay distinct from the other three keywords' palettes: ultrathink is a
 * full-spectrum rainbow, orchestrate is hue 150..280 (teal -> violet), and
 * workflowz is hue 30..150 (amber -> green).
 */
export const highlightUltracode: KeywordHighlighter = createGradientHighlighter({
	probe: /ultracode/,
	highlight: magicKeywordRegex("ultracode", "g"),
	stops: 14,
	hue: t => (280 + t * 120) % 360,
});
