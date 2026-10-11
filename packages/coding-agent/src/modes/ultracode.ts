import { prompt } from "@oh-my-pi/pi-utils";
import ultracodeNotice from "../prompts/system/ultracode-notice.md" with { type: "text" };
import { normalizeConcurrencyLimit } from "../task/parallel";
import type { MagicKeywordContext } from "./magic-keywords";

/**
 * "ultracode" notice rendering.
 *
 * Detection and the editor/bubble gradient come from the `ultracode` row of
 * `MAGIC_KEYWORDS` (see `./magic-keywords`); this module only renders the
 * hidden notice that row injects. Submitting a message that mentions the
 * standalone word runs THAT TURN at xhigh reasoning effort, for the turn and
 * every subagent it spawns, under the workflow orchestration contract carried
 * by {@link ULTRACODE_NOTICE}. The word must be repeated on any later message
 * that wants the same treatment.
 */

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
 * - `effortPinned` false: the active model exposes no xhigh rung, so the turn
 *   was NOT armed (no pin, no subagent floor) and the user was told. The
 *   notice must say so instead of promising an effort the harness refused to
 *   substitute for; the orchestration contract still ships.
 * - `maxConcurrency` is the live `task.maxConcurrency`; 0 means unbounded and
 *   the cap sentence is omitted entirely, matching the system prompt.
 * - `evalTools` is the live `eval.tools.enabled`; off, the notice never names
 *   `tool()`/`tools=`, which the kernel would reject.
 * - `waitTool` false: the `wait` tool is not enabled, so the notice must not
 *   tell the model to leave `eval` and call it.
 */
export function renderUltracodeNotice({
	workflowAvailable,
	scoutAvailable,
	effortApplied,
	effortPinned,
	maxConcurrency,
	evalTools,
	waitTool,
	viaPlanApproval,
}: {
	workflowAvailable: boolean;
	scoutAvailable?: boolean;
	effortApplied?: boolean;
	effortPinned?: boolean;
	maxConcurrency?: number;
	evalTools?: boolean;
	waitTool?: boolean;
	viaPlanApproval?: boolean;
}): string {
	return prompt
		.render(ultracodeNotice, {
			workflowAvailable,
			scoutAvailable: scoutAvailable ?? true,
			effortApplied: effortApplied ?? true,
			effortPinned: effortPinned ?? true,
			MAX_CONCURRENCY: normalizeConcurrencyLimit(maxConcurrency ?? 0),
			evalTools: evalTools ?? false,
			waitTool: waitTool ?? true,
			viaPlanApproval: viaPlanApproval ?? false,
		})
		.trim();
}

/** ULTRACODE_NOTICE is the default ultracode notice for sessions with workflow tooling live. */
export const ULTRACODE_NOTICE: string = renderUltracodeNotice({ workflowAvailable: true });

/**
 * The `MAGIC_KEYWORDS` row's notice renderer: maps the shared session context
 * onto {@link renderUltracodeNotice}. The fan-out contract needs both `task`
 * and `eval`, so `workflowAvailable` is derived from the enabled tool list the
 * same way the `workflowz` row's `requires` gate reads it. `viaPlanApproval` is
 * per-call rather than a session fact: the keyword path never sets it, while
 * the plan-review approval path renders the same notice with it on.
 */
export function renderUltracodeNoticeFor(context: MagicKeywordContext, viaPlanApproval = false): string {
	return renderUltracodeNotice({
		workflowAvailable: context.tools.includes("task") && context.tools.includes("eval"),
		scoutAvailable: context.scoutAvailable,
		effortApplied: context.effortApplied,
		effortPinned: context.effortPinned,
		maxConcurrency: context.maxConcurrency,
		evalTools: context.evalTools,
		waitTool: context.waitTool,
		viaPlanApproval,
	});
}
