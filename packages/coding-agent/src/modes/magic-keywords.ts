import { prompt } from "@oh-my-pi/pi-utils";
import jevifyNotice from "../prompts/system/jevify-notice.md" with { type: "text" };
import orchestrateNotice from "../prompts/system/orchestrate-notice.md" with { type: "text" };
import ultrathinkNotice from "../prompts/system/ultrathink-notice.md" with { type: "text" };
import workflowNotice from "../prompts/system/workflow-notice.md" with { type: "text" };
import { renderUltracodeNoticeFor } from "./ultracode";

/**
 * Magic keywords: standalone lowercase prose words in a user prompt that
 * append a hidden, user-attributed notice for that turn and glow in the TUI.
 *
 * This table is the single source of truth. Every downstream surface derives
 * from it: the `magicKeywords.<id>` settings (settings-schema), the notice
 * injection and `<id>-notice` message types (agent-session, queued-messages),
 * and the editor/bubble gradients (`setMagicKeywords` in pi-tui). Adding a
 * keyword means one row here plus its notice template under `prompts/system/`;
 * `rootOnly` rows additionally skip task-spawned child sessions and
 * agent-attributed prompts (a subagent's task text), where the turn state
 * they describe is never set.
 */

/** Session facts a keyword notice may render against. */
export interface MagicKeywordContext {
	/** Enabled tool names for the turn. */
	tools: readonly string[];
	/** `task.batch`: whether `task` accepts a `tasks[]` array. */
	taskBatch: boolean;
	/** Whether the `scout` agent can be dispatched. */
	scoutAvailable: boolean;
	/** `eval.tools.enabled`: whether `@tool`-defined kernel tools exist. */
	evalTools: boolean;
	/** Whether the xhigh effort pin reaches the wire (false once `externalThinking` routes reasoning through the `think` tool). */
	effortApplied: boolean;
	/** Whether this session can pin the turn to exactly xhigh (model exposes the tier, ceiling allows it, not a child). */
	effortPinned: boolean;
	/** `task.maxConcurrency`: the live worker cap; 0 means unbounded. */
	maxConcurrency: number;
	/** Whether the `wait` tool is enabled, so a notice may tell the model to block on it. */
	waitTool: boolean;
}

/** One magic keyword: trigger word, gradient, settings copy, and the notice it injects. */
export interface MagicKeyword {
	/** Settings key suffix (`magicKeywords.<id>`) and notice message type prefix (`<id>-notice`). */
	id: string;
	/** Exact lowercase trigger, matched only as standalone prose. */
	word: string;
	/** Editor/bubble gradient as an HSL hue sweep `[from, to]` in degrees; `to` may exceed 360 to wrap. */
	hue: readonly [number, number];
	/** Settings panel label. */
	label: string;
	/** Settings panel description. */
	description: string;
	/** Tools that must all be enabled for the notice to apply; the notice is skipped otherwise. */
	requires: readonly string[];
	/** Skip on task-spawned child sessions and agent-attributed prompts: the
	 * turn state the notice describes is set only by a root's user-authored turn. */
	rootOnly?: boolean;
	/** Render the hidden notice queued ahead of the user message. */
	notice: (context: MagicKeywordContext) => string;
}

/** Hidden notice for "ultrathink": careful multi-step reasoning. */
export const ULTRATHINK_NOTICE: string = ultrathinkNotice.trim();

/** Hidden notice for "jevify": bulk classification through the eval kernel's `judge()`. */
export const JEVIFY_NOTICE: string = jevifyNotice.trim();

/** Hidden notice for "orchestrate", naming only the tools the session actually exposes. */
export function renderOrchestrateNotice({ tools }: Pick<MagicKeywordContext, "tools">): string {
	return prompt.render(orchestrateNotice, { tools }).trim();
}

/** Hidden notice for "workflowz", shaped by the active task/eval capabilities. */
export function renderWorkflowNotice({
	taskBatch,
	scoutAvailable,
	evalTools,
}: Pick<MagicKeywordContext, "taskBatch" | "scoutAvailable" | "evalTools">): string {
	return prompt.render(workflowNotice, { taskBatch, scoutAvailable, evalTools }).trim();
}

export const MAGIC_KEYWORDS = [
	{
		id: "ultrathink",
		word: "ultrathink",
		hue: [0, 330],
		label: "Ultrathink Keyword",
		description: "Let standalone ultrathink request maximum automatic thinking and append its hidden notice",
		requires: [],
		notice: () => ULTRATHINK_NOTICE,
	},
	{
		id: "orchestrate",
		word: "orchestrate",
		hue: [150, 280],
		label: "Orchestrate Keyword",
		description: "Let standalone orchestrate append its hidden multi-agent orchestration notice",
		// The contract is entirely about `task` subagent dispatch.
		requires: ["task"],
		notice: renderOrchestrateNotice,
	},
	{
		id: "workflow",
		word: "workflowz",
		hue: [30, 150],
		label: "Workflow Keyword",
		description: "Let standalone workflowz append its hidden eval workflow notice",
		requires: ["task", "eval"],
		notice: renderWorkflowNotice,
	},
	{
		id: "jevify",
		word: "jevify",
		hue: [300, 420],
		label: "Jevify Keyword",
		description: "Let standalone jevify append its hidden bulk-judge classification notice",
		// The contract is entirely about the eval kernel's `judge()` helper.
		requires: ["eval"],
		notice: () => JEVIFY_NOTICE,
	},
	{
		id: "ultracode",
		word: "ultracode",
		hue: [280, 400],
		label: "Ultracode Keyword",
		description:
			"Let standalone ultracode run that turn and every subagent it spawns at exactly xhigh effort under the workflow orchestration contract",
		// The notice always ships: its template carries the effort layer and its own
		// reduced branch for sessions where `task`/`eval` are not both active.
		requires: [],
		rootOnly: true,
		notice: renderUltracodeNoticeFor,
	},
] as const satisfies readonly MagicKeyword[];

/** Settings key suffix of a registered keyword. */
export type MagicKeywordId = (typeof MAGIC_KEYWORDS)[number]["id"];

/** Hidden custom-message type carrying a keyword's notice. */
export type MagicKeywordNoticeType = `${MagicKeywordId}-notice`;
