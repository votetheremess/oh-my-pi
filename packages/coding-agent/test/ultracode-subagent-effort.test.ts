/**
 * Ultracode pins EVERY subagent spawn to EXACTLY xhigh while it is active.
 *
 * These drive the real `runSubprocess` and read the level it hands to
 * `createAgentSession` — `thinkingLevel` (the pinned effort) and
 * `thinkingLevelCeiling` (the ceiling that rides into the session so
 * retry-fallback recovery cannot re-clamp below it). The agent loop itself is
 * a mock that yields immediately, so nothing here talks to a model.
 *
 * The pin deliberately overrides the agent definition's own level (scout's
 * `medium`, task's `auto`), the caller's coarse `effort`, an explicit `:level`
 * suffix on the model pattern, and a `task.maxEffort` ceiling below xhigh.
 * Nothing is allowed to move it — not even the model's own ladder: a model
 * with no xhigh rung cannot satisfy the pin, and the spawn fails loudly with
 * `UltracodeEffortError` (see `ultracodeEffortFor` in packages/tui/src/thinking.ts) before
 * any session exists, instead of quietly running at a substitute level.
 */
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "bun:test";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { cfgAdvisorEnabled } from "@oh-my-pi/pi-coding-agent/advisor/settings";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { all } from "@oh-my-pi/pi-coding-agent/config/registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { runEvalAgent } from "@oh-my-pi/pi-coding-agent/eval/agent-bridge";
import { cfgEvalWorkpoolFreshAgents } from "@oh-my-pi/pi-coding-agent/eval/settings";
import { runEvalWorkpool } from "@oh-my-pi/pi-coding-agent/eval/workpool-bridge";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import { cfgUltracode } from "@oh-my-pi/pi-coding-agent/modes/settings";
import { AgentLifecycleManager, syncChildUltracodeAtResume } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { type AgentRef, AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { CreateAgentSessionOptions, CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession, AgentSessionEvent, PromptOptions } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { cfgCompactionMidTurnEnabled } from "@oh-my-pi/pi-coding-agent/session/context-settings";
import {
	extractSessionInit,
	type PersistedSessionInit,
	SessionManager,
} from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import { getBundledAgent } from "@oh-my-pi/pi-coding-agent/task/agents";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import {
	createIsolatedSettings,
	createSubagentSettings,
	runSubagentFollowUpTurn,
	runSubprocess,
} from "@oh-my-pi/pi-coding-agent/task/executor";
import { createPersistedSubagentReviverFactory } from "@oh-my-pi/pi-coding-agent/task/persisted-revive";
import { cfgTaskBatch, cfgTaskMaxConcurrency } from "@oh-my-pi/pi-coding-agent/task/settings";
import { runStructuredSubagent } from "@oh-my-pi/pi-coding-agent/task/structured-subagent";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import { WorkPoolRegistry } from "@oh-my-pi/pi-coding-agent/task/workpool";
import type { WorkPoolYieldItem } from "@oh-my-pi/pi-coding-agent/task/workpool-yield";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { cfgAsyncEnabled, cfgToolsApprovalMode } from "@oh-my-pi/pi-coding-agent/tools/settings";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import {
	AUTO_THINKING,
	type ConfiguredThinkingLevel,
	type TaskEffort,
	UltracodeEffortError,
} from "@oh-my-pi/pi-tui/thinking";
import type { TaskParams } from "@oh-my-pi/pi-tui/tools/task";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createSessionDefaults } from "./helpers/session-defaults";

function modelOrThrow(provider: Parameters<typeof getBundledModel>[0], id: string): Model {
	const model = getBundledModel(provider, id);
	if (!model) throw new Error(`Expected ${provider}/${id} to exist in the bundled catalog`);
	return model as Model;
}

/** low → max, so an xhigh pin lands exactly on xhigh — and must NOT reach max. */
const FULL_LADDER = modelOrThrow("openai-codex", "gpt-5.6-sol");
/** low → high: the model tops out below xhigh, so the pin cannot be honoured. */
const CAPS_AT_HIGH = modelOrThrow("anthropic", "claude-sonnet-4-6");
/** No `thinking` block at all: no controllable effort surface to pin. */
const NO_EFFORT_SURFACE = modelOrThrow("openai", "gpt-4o");
/**
 * A ladder sitting entirely above xhigh. The old clamp rounded this up to
 * `max`; the strict pin refuses it, because max is not xhigh.
 */
const MAX_ONLY = {
	...FULL_LADDER,
	provider: "mock",
	id: "mock-max-only",
	thinking: { mode: "effort", efforts: [Effort.Max] },
} as Model;
/** A second full-ladder model, distinct from FULL_LADDER, for the prewalk hand-off target. */
const PREWALK_TARGET = {
	...FULL_LADDER,
	provider: "mock",
	id: "mock-prewalk-target",
} as Model;
/** FULL_LADDER plus a catalog `thinking.defaultLevel`, which the SDK picks for a level-less spawn. */
const DEFAULTS_TO_LOW = {
	...FULL_LADDER,
	provider: "mock",
	id: "mock-defaults-to-low",
	thinking: { ...FULL_LADDER.thinking, defaultLevel: Effort.Low },
} as Model;

/**
 * Yields on the first prompt so `runSubprocess` completes without a real loop.
 * `settings` is what `createAgentSession` was handed: the real session owns
 * exactly that object, and the disposers registered on it read it back. Every
 * `session_init` the executor persists lands in `inits` when one is given.
 */
function yieldEmittingSession(settings: Settings | undefined, inits?: SessionInitRecord[]): AgentSession {
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	const disposers: Array<() => void> = [];
	let workPoolYieldItems: readonly WorkPoolYieldItem[] = [];
	const session = {
		settings,
		state: { messages: [] },
		agent: { state: { systemPrompt: ["test"] } },
		model: undefined,
		extensionRunner: undefined,
		sessionManager: {
			appendSessionInit: (init: SessionInitRecord) => {
				inits?.push(init);
				return "session-init";
			},
		},
		getActiveToolNames: () => ["read", "yield"],
		getEnabledToolNames: () => ["read", "yield"],
		setActiveToolsByName: async (_toolNames: string[]) => {},
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.push(listener);
			return () => {
				const index = listeners.indexOf(listener);
				if (index >= 0) listeners.splice(index, 1);
			};
		},
		prompt: async (_text: string, _options?: PromptOptions) => {
			// A workpool worker's strict schema is keyed by its batch items
			// (buildWorkPoolOutputSchema), so it yields one entry per item, the way
			// the real keyed `yield` contract assembles; any other spawn yields a
			// plain object.
			const data =
				workPoolYieldItems.length > 0
					? Object.fromEntries(workPoolYieldItems.map(item => [item.id, "done"]))
					: { ok: true };
			for (const listener of listeners) {
				listener({
					type: "tool_execution_end",
					toolCallId: "tool-ultracode-effort",
					toolName: "yield",
					result: {
						content: [{ type: "text", text: "Result submitted." }],
						details: { status: "success", data },
					},
					isError: false,
				});
			}
		},
		waitForIdle: async () => {},
		getLastAssistantMessage: () => undefined,
		abort: async () => {},
		// The real dispose runs every registered disposer; so does this one, so a
		// disposer that breaks on the child's settings fails here, not in production.
		dispose: async () => {
			for (const dispose of disposers.splice(0)) dispose();
		},
		setIrcWakeTurnObserver: () => {},
		// v17.4.0 (`fix(hub): prevented stale agent refs from blocking wait`) made the agent
		// registry mirror run-state on every spawn, so `runSubprocess` now calls this on the
		// session it is handed. Returns an unsubscribe, matching the real signature.
		subscribeRunState: (_listener: (state: "running" | "idle") => void) => () => {},
		// v18.0.5 (2af99a67d2 `fix(agent): review subagent final yield in advisor`) drains
		// the advisor's final-turn review before teardown, so `finalizeSubagentLifecycle`
		// now calls both of these on every graceful (non-aborted) finish. No-op /
		// instantly-caught-up, matching the real signatures.
		prepareForHeadlessAdvisorDrain: () => {},
		waitForAdvisorCatchup: async (_timeoutMs: number) => true,
		// v18.1.16 (74bdf4c65c `feat(coding-agent): clarify subagent model badges`) publishes
		// the advisor state to the agent registry on every `setActiveSession`, so
		// `runSubprocess` now reads this off the session it is handed. Matches the real
		// signature; no advisor is ever active on this fake.
		isAdvisorActive: () => false,
		// v18.9.0 (045dbee539) re-captures a persisted child's settings for the warm
		// reviver at dispose (`trackSubagentSettings`), reached whenever the spawn has an
		// artifacts dir — which every eval/task frontend always supplies. Real signature:
		// `addDisposer(dispose: () => void): void`.
		addDisposer: (dispose: () => void) => {
			disposers.push(dispose);
		},
		// A workpool worker installs its keyed yield contract before its first turn
		// and clears it when the batch settles. Real signature:
		// `setWorkPoolYieldItems(items: readonly WorkPoolYieldItem[]): Promise<void>`.
		setWorkPoolYieldItems: async (items: readonly WorkPoolYieldItem[]) => {
			workPoolYieldItems = items;
		},
		// A kept-alive child's follow-up turn (`runSubagentFollowUpTurn`) waits out a running
		// turn before installing its pooled yield contract and resets the reused yield tool.
		// Real signatures: `get isStreaming(): boolean`, `getToolByName(name): AgentTool | undefined`.
		isStreaming: false,
		getToolByName: (_name: string) => undefined,
	};
	return session as unknown as AgentSession;
}

/** What the executor hands `sessionManager.appendSessionInit` (the persisted spawn contract). */
type SessionInitRecord = PersistedSessionInit;

/** `createAgentSession` stand-in handing back a yielding session that owns the forwarded settings. */
function mockCreateAgentSession(inits?: SessionInitRecord[]) {
	return vi
		.spyOn(sdkModule, "createAgentSession")
		.mockImplementation(async options => createSessionResult(yieldEmittingSession(options?.settings, inits)));
}

/** The child's turn flag as the forwarded settings resolve it now; undefined when no settings rode in. */
function childFlag(settings: Settings | undefined): boolean | undefined {
	return settings ? cfgUltracode.get(settings) : undefined;
}

function createSessionResult(session: AgentSession): CreateAgentSessionResult {
	return {
		session,
		extensionsResult: {
			extensions: [],
			errors: [],
			runtime: {} as unknown,
		} as unknown as CreateAgentSessionResult["extensionsResult"],
		setToolUIContext: () => {},
		eventBus: new EventBus(),
	};
}

/**
 * Plain object, matching the real signatures of exactly the members the spawn
 * path reads — never a tolerant Proxy (see AGENTS.md, "Faking AgentSession").
 * `hasConfiguredAuth` and `awaitBackgroundRefresh` are what the prewalk
 * resolution touches; spying on `hasConfiguredAuth` proves prewalk got as far
 * as choosing its target.
 */
function createModelRegistry(model: Model, ...extra: Model[]): ModelRegistry {
	return {
		authStorage: {},
		refresh: async () => {},
		awaitBackgroundRefresh: async () => {},
		getAvailable: () => [model, ...extra],
		getApiKey: async () => "test-key",
		hasConfiguredAuth: (_model: Model) => true,
	} as unknown as ModelRegistry;
}

const baseAgent: AgentDefinition = {
	name: "task",
	description: "test",
	systemPrompt: "test",
	source: "bundled",
	model: ["@task"],
};

interface SpawnOptions {
	id: string;
	model: Model;
	/** Flipped exactly the way the keyword flips it: the non-persisted runtime layer. */
	ultracode?: boolean;
	/** The agent definition's own pinned level (scout's `medium`, task's `auto`). */
	thinkingLevel?: ConfiguredThinkingLevel;
	/** The caller's coarse per-spawn effort. */
	effort?: TaskEffort;
	maxEffort?: Effort;
	/** Explicit `:level` suffix on the task role's model pattern. */
	modelSuffix?: Effort;
	/** Agent-definition `prewalk` frontmatter; the registry then also offers PREWALK_TARGET. */
	prewalk?: string;
	/** Agent definition to spawn instead of the level-less `task` stand-in. */
	agent?: AgentDefinition;
	/** Model role the agent's `@role` pattern names (default `task`). */
	role?: string;
	/** The parent's `defaultThinkingLevel`, stamped onto the child's settings. */
	defaultThinkingLevel?: ConfiguredThinkingLevel;
}

async function spawn(options: SpawnOptions) {
	const settings = Settings.isolated({
		...(options.maxEffort === undefined ? undefined : { "task.maxEffort": options.maxEffort }),
		...(options.defaultThinkingLevel === undefined
			? undefined
			: { defaultThinkingLevel: options.defaultThinkingLevel }),
	});
	if (options.ultracode) cfgUltracode.override(settings, true);
	const pattern = `${options.model.provider}/${options.model.id}`;
	settings.setModelRole(
		options.role ?? "task",
		options.modelSuffix === undefined ? pattern : `${pattern}:${options.modelSuffix}`,
	);
	const inits: SessionInitRecord[] = [];
	const spy = mockCreateAgentSession(inits);
	const modelRegistry =
		options.prewalk === undefined
			? createModelRegistry(options.model)
			: createModelRegistry(options.model, PREWALK_TARGET);
	const hasConfiguredAuth = vi.spyOn(modelRegistry, "hasConfiguredAuth");
	const agent = options.agent ?? baseAgent;

	const result = await runSubprocess({
		cwd: "/tmp",
		agent: options.prewalk === undefined ? agent : { ...agent, prewalk: options.prewalk },
		task: "do work",
		index: 0,
		enableLsp: false,
		id: options.id,
		settings,
		modelRegistry,
		thinkingLevel: options.thinkingLevel,
		effort: options.effort,
	});

	return { result, forwarded: spy.mock.calls[0]?.[0], spy, hasConfiguredAuth, parentSettings: settings, inits };
}

describe("ultracode subagent effort pin", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("leaves a caller effort untouched while ultracode is off", async () => {
		const { result, forwarded } = await spawn({
			id: "ultracode-off-caller-effort",
			model: FULL_LADDER,
			effort: "lo",
			maxEffort: Effort.Low,
		});

		expect(result.exitCode).toBe(0);
		expect(forwarded?.thinkingLevel).toBe(ThinkingLevel.Low);
		expect(forwarded?.thinkingLevelCeiling).toBe(Effort.Low);
	});

	it("leaves the agent definition's own level untouched while ultracode is off", async () => {
		const { result, forwarded } = await spawn({
			id: "ultracode-off-agent-level",
			model: FULL_LADDER,
			thinkingLevel: ThinkingLevel.Medium,
		});

		expect(result.exitCode).toBe(0);
		expect(forwarded?.thinkingLevel).toBe(ThinkingLevel.Medium);
		// No caller `effort` means no ceiling is computed at all — unchanged.
		expect(forwarded?.thinkingLevelCeiling).toBeUndefined();
	});

	it("overrides an agent pinned to medium, the way scout is", async () => {
		const { result, forwarded } = await spawn({
			id: "ultracode-overrides-pinned-medium",
			model: FULL_LADDER,
			ultracode: true,
			thinkingLevel: ThinkingLevel.Medium,
		});

		expect(result.exitCode).toBe(0);
		expect(forwarded?.thinkingLevel).toBe(Effort.XHigh);
	});

	it("overrides an agent on auto, the way task is", async () => {
		const { result, forwarded } = await spawn({
			id: "ultracode-overrides-auto",
			model: FULL_LADDER,
			ultracode: true,
			thinkingLevel: AUTO_THINKING,
		});

		expect(result.exitCode).toBe(0);
		expect(forwarded?.thinkingLevel).toBe(Effort.XHigh);
		expect(forwarded?.thinkingLevel).not.toBe(AUTO_THINKING);
	});

	it("overrides a caller-supplied effort of lo", async () => {
		const { result, forwarded } = await spawn({
			id: "ultracode-overrides-caller-effort",
			model: FULL_LADDER,
			ultracode: true,
			effort: "lo",
		});

		expect(result.exitCode).toBe(0);
		expect(forwarded?.thinkingLevel).toBe(Effort.XHigh);
	});

	it("caps a caller-supplied effort of hi at xhigh instead of letting it reach max", async () => {
		const { result, forwarded } = await spawn({
			id: "ultracode-caps-caller-hi",
			model: FULL_LADDER,
			ultracode: true,
			effort: "hi",
		});

		// `hi` on a low→max ladder resolves to max without ultracode; under the
		// pin it is exactly xhigh, so the pin caps as well as raises.
		expect(result.exitCode).toBe(0);
		expect(forwarded?.thinkingLevel).toBe(Effort.XHigh);
		expect(forwarded?.thinkingLevel).not.toBe(Effort.Max);
	});

	it("resolves a caller-supplied effort of hi to max while ultracode is off", async () => {
		// The control for the cap above: proves `hi` really does reach max on
		// this ladder, so the xhigh result under ultracode is the pin's doing.
		const { result, forwarded } = await spawn({
			id: "ultracode-off-caller-hi",
			model: FULL_LADDER,
			effort: "hi",
		});

		expect(result.exitCode).toBe(0);
		expect(forwarded?.thinkingLevel).toBe(Effort.Max);
	});

	it("overrides an explicit :max suffix on the model pattern", async () => {
		const { result, forwarded } = await spawn({
			id: "ultracode-overrides-max-suffix",
			model: FULL_LADDER,
			ultracode: true,
			modelSuffix: Effort.Max,
		});

		// The suffix is the strongest non-ultracode selector (it outranks the
		// agent definition); the pin still wins, and lands below it on purpose.
		expect(result.exitCode).toBe(0);
		expect(forwarded?.thinkingLevel).toBe(Effort.XHigh);
	});

	it("honours an explicit :max suffix while ultracode is off", async () => {
		const { result, forwarded } = await spawn({
			id: "ultracode-off-max-suffix",
			model: FULL_LADDER,
			modelSuffix: Effort.Max,
		});

		expect(result.exitCode).toBe(0);
		expect(forwarded?.thinkingLevel).toBe(Effort.Max);
	});

	it("is not capped by task.maxEffort, and raises the ceiling that rides into the session", async () => {
		const { result, forwarded } = await spawn({
			id: "ultracode-ignores-max-effort",
			model: FULL_LADDER,
			ultracode: true,
			effort: "lo",
			maxEffort: Effort.Low,
		});

		expect(result.exitCode).toBe(0);
		expect(forwarded?.thinkingLevel).toBe(Effort.XHigh);
		// The ceiling must be raised, not merely ignored: a stale `low` ceiling
		// would let retry-fallback recovery clamp the child back down mid-run.
		expect(forwarded?.thinkingLevelCeiling).toBe(Effort.XHigh);
	});

	it("rides the pin in as the ceiling even when the caller passed no effort at all", async () => {
		const { result, forwarded } = await spawn({
			id: "ultracode-ceiling-without-effort",
			model: FULL_LADDER,
			ultracode: true,
			thinkingLevel: AUTO_THINKING,
		});

		// Without ultracode a missing `effort` means no ceiling (see the off
		// control above). Under ultracode the ceiling is ALWAYS the pin: retry
		// fallback inside the child re-clamps against it, so it is what stops a
		// swapped-in model from climbing to max or sliding below xhigh.
		expect(result.exitCode).toBe(0);
		expect(forwarded?.thinkingLevel).toBe(Effort.XHigh);
		expect(forwarded?.thinkingLevelCeiling).toBe(Effort.XHigh);
	});

	it("refuses to spawn on a model that tops out at high, naming the ladder", async () => {
		const { result, spy } = await spawn({
			id: "ultracode-refuses-high-ladder",
			model: CAPS_AT_HIGH,
			ultracode: true,
			thinkingLevel: AUTO_THINKING,
		});

		// Not clamped to high: that is the substitute the contract forbids. The
		// failure is loud (exit 1) and actionable (model + the rungs it has), and
		// it happens before any session is created.
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("ultracode requires xhigh");
		expect(result.stderr).toContain(CAPS_AT_HIGH.id);
		expect(result.stderr).toContain("exposes [low, medium, high]");
		expect(spy).not.toHaveBeenCalled();
	});

	it("spawns that same model normally when ultracode is off, proving the pin is what refused it", async () => {
		const { result, forwarded } = await spawn({
			id: "ultracode-off-high-ladder",
			model: CAPS_AT_HIGH,
			thinkingLevel: ThinkingLevel.Medium,
		});

		expect(result.exitCode).toBe(0);
		expect(forwarded?.thinkingLevel).toBe(ThinkingLevel.Medium);
	});

	it("refuses to spawn on a model exposing only max instead of rounding up to it", async () => {
		const { result, spy } = await spawn({
			id: "ultracode-refuses-max-only",
			model: MAX_ONLY,
			ultracode: true,
			effort: "hi",
			maxEffort: Effort.Low,
		});

		// Neither the old RangeError (task.maxEffort blamed for a ceiling
		// ultracode supplied) nor the old clamp to max: max is not xhigh.
		expect(result.exitCode).toBe(1);
		expect(result.stderr).not.toContain("no supported thinking effort");
		expect(result.stderr).toContain("ultracode requires xhigh");
		expect(result.stderr).toContain("mock-max-only");
		expect(result.stderr).toContain("exposes [max]");
		expect(spy).not.toHaveBeenCalled();
	});

	it("still fails that same spawn when ultracode is off, but for the ordinary ceiling reason", async () => {
		const { result, spy } = await spawn({
			id: "ultracode-off-max-only-model",
			model: MAX_ONLY,
			effort: "hi",
			maxEffort: Effort.Low,
		});

		// The control: the refusal above is ultracode's, not this pre-existing
		// task.maxEffort failure wearing a new message.
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain(
			"mock/mock-max-only has no supported thinking effort at or below task.maxEffort=low",
		);
		expect(result.stderr).not.toContain("ultracode requires xhigh");
		expect(spy).not.toHaveBeenCalled();
	});

	it("refuses to spawn on a model with no controllable effort surface", async () => {
		const { result, spy } = await spawn({
			id: "ultracode-refuses-no-effort-surface",
			model: NO_EFFORT_SURFACE,
			ultracode: true,
			thinkingLevel: ThinkingLevel.Low,
		});

		// The old behaviour fell through to the agent's own selector, which ran
		// the spawn at low under an ultracode turn. A model that cannot express
		// xhigh at all cannot satisfy the pin either.
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("ultracode requires xhigh");
		expect(result.stderr).toContain(NO_EFFORT_SURFACE.id);
		expect(result.stderr).toContain("exposes no controllable effort");
		expect(spy).not.toHaveBeenCalled();
	});

	it("spawns a no-effort-surface model normally when ultracode is off", async () => {
		const { result, forwarded } = await spawn({
			id: "ultracode-off-no-effort-surface",
			model: NO_EFFORT_SURFACE,
			thinkingLevel: ThinkingLevel.Low,
		});

		expect(result.exitCode).toBe(0);
		expect(forwarded?.thinkingLevel).toBe(ThinkingLevel.Low);
	});
});

// Prewalk exists to cheapen a run at its first edit/write by handing off to a
// fast target with its own (lower) thinking level — exactly the step out from
// under xhigh the pin forbids. Under ultracode the hand-off must not be armed.
describe("ultracode suppresses the prewalk hand-off", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("arms prewalk from the agent definition while ultracode is off", async () => {
		// The control: proves the fixture's prewalk target resolves and would
		// have ridden into the session, so its absence below is the pin's doing.
		const { result, forwarded, hasConfiguredAuth } = await spawn({
			id: "ultracode-off-prewalk",
			model: FULL_LADDER,
			prewalk: `${PREWALK_TARGET.provider}/${PREWALK_TARGET.id}`,
		});

		expect(result.exitCode).toBe(0);
		expect(hasConfiguredAuth).toHaveBeenCalledWith(expect.objectContaining({ id: PREWALK_TARGET.id }));
		expect(forwarded?.prewalk?.target.id).toBe(PREWALK_TARGET.id);
	});

	it("hands no prewalk into the session while ultracode is armed", async () => {
		const { result, forwarded, hasConfiguredAuth } = await spawn({
			id: "ultracode-suppresses-prewalk",
			model: FULL_LADDER,
			ultracode: true,
			prewalk: `${PREWALK_TARGET.provider}/${PREWALK_TARGET.id}`,
		});

		expect(result.exitCode).toBe(0);
		expect(forwarded?.thinkingLevel).toBe(Effort.XHigh);
		// Suppressed at the source, not resolved-then-dropped: the target was
		// never even looked up.
		expect(forwarded?.prewalk).toBeUndefined();
		expect(hasConfiguredAuth).not.toHaveBeenCalled();
	});
});

/**
 * The pin chokepoint (`runSubprocess`) is only as good as the plumbing above
 * it: `buildExecutorOptions` in structured-subagent.ts hands the PARENT
 * session's live settings — runtime override layer included — to the executor.
 * The tests below enter at the two real frontends ABOVE that seam (the eval
 * `agent()` bridge and a task-kind `runStructuredSubagent` call) instead of
 * hand-building executor options the way `spawn` does, so a regression that
 * gives those spawns derivative or clean settings (dropping the override)
 * fails HERE even though every direct-`runSubprocess` test above stays green.
 *
 * Plain object, not a Proxy: only the members the structured-subagent seam and
 * the executor actually read, each matching the real ToolSession signature.
 */
const jobManagers = new Set<AsyncJobManager>();

function frontendToolSession(options: { model: Model; ultracode?: boolean }): ToolSession {
	const settings = Settings.isolated();
	// Flipped exactly the way the keyword flips it: the non-persisted runtime layer.
	if (options.ultracode) cfgUltracode.override(settings, true);
	settings.setModelRole("task", `${options.model.provider}/${options.model.id}`);
	// v18.1.16 (05bb0c1989 `feat: reengineered evaluation, added WorkPool`) made the eval
	// frontends handle-based: `runEvalAgent` and a workpool push register the spawn as a
	// background job on the session's manager and return at once, so the spawn - and the
	// pin computed for it - happens inside that job. A real manager, so the job runs.
	const manager = new AsyncJobManager({});
	jobManagers.add(manager);
	return {
		cwd: "/tmp",
		settings,
		modelRegistry: createModelRegistry(options.model),
		asyncJobManager: manager,
		getAgentId: () => "Main",
		getArtifactsDir: () => null,
		getSessionSpawns: () => "*",
		getSessionFile: () => null,
		enableLsp: false,
		enableIrc: false,
		enableMCP: false,
	} as unknown as ToolSession;
}

/** Settle the background job an eval frontend registered, so its spawn has happened. */
async function settleEvalJob(session: ToolSession, id: string): Promise<void> {
	const job = session.asyncJobManager?.getJob(id);
	if (!job) throw new Error(`eval frontend registered no job ${id}`);
	await job.promise;
	if (job.status === "failed") throw new Error(`eval job ${id} failed: ${job.errorText ?? "unknown"}`);
}

function mockFrontendSpawnSeams() {
	vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [baseAgent], projectAgentsDir: null });
	return mockCreateAgentSession();
}

describe("ultracode pin through the real spawn frontends", () => {
	afterEach(async () => {
		vi.restoreAllMocks();
		for (const manager of jobManagers) await manager.dispose();
		jobManagers.clear();
		AgentRegistry.resetGlobalForTests();
		WorkPoolRegistry.resetForTests();
	});

	it("pins an eval agent() spawn to xhigh end-to-end through the bridge", async () => {
		const spy = mockFrontendSpawnSeams();
		const session = frontendToolSession({ model: FULL_LADDER, ultracode: true });

		const handle = await runEvalAgent({ prompt: "do work", agent: "task" }, { session });
		await settleEvalJob(session, handle.id);

		expect(spy).toHaveBeenCalledTimes(1);
		const forwarded = spy.mock.calls[0]?.[0];
		// Fails if the bridge or buildExecutorOptions stops handing the parent's
		// live settings through runStructuredSubagent (e.g. eval spawns given a
		// derivative/clean Settings): the pin computation at the chokepoint then
		// reads `ultracode: false` and this spawn dispatches cold.
		expect(forwarded?.thinkingLevel).toBe(Effort.XHigh);
		// The same severing also breaks inheritance: the child's settings are
		// built from what the frontend forwarded.
		expect(childFlag(forwarded?.settings)).toBe(true);
		// Stamped by value, not read through: the parent's turn ending does not
		// reach a child that is still running its armed assignment.
		cfgUltracode.override(session.settings, false);
		expect(childFlag(forwarded?.settings)).toBe(true);
	});

	it("leaves an eval agent() spawn unpinned when ultracode is off", async () => {
		const spy = mockFrontendSpawnSeams();
		const session = frontendToolSession({ model: FULL_LADDER });

		const handle = await runEvalAgent({ prompt: "do work", agent: "task" }, { session });
		await settleEvalJob(session, handle.id);

		// The control: proves the pin above came from the parent's live flag,
		// not from anything constant about the eval path.
		const forwarded = spy.mock.calls[0]?.[0];
		expect(forwarded?.thinkingLevel).toBeUndefined();
		expect(childFlag(forwarded?.settings)).toBe(false);
		// An unarmed child stays unarmed when the parent arms after it spawned.
		cfgUltracode.override(session.settings, true);
		expect(childFlag(forwarded?.settings)).toBe(false);
	});

	it("pins a workpool() worker spawn to xhigh through the pool's own dispatch", async () => {
		const spy = mockFrontendSpawnSeams();
		const session = frontendToolSession({ model: FULL_LADDER, ultracode: true });

		// The v18.1.16 fan-out primitive the ultracode notice now teaches. Its
		// workers are spawned by the pool's own dispatch (workpool.ts #startTurn ->
		// runStructuredSubagent), not by the agent() bridge, so a pin that only
		// covered the bridge would let the recommended fan-out path run cold.
		const created = await runEvalWorkpool({ op: "create", agent: "task", name: "pinned" }, { session });
		expect(created).toMatchObject({ name: "pinned", agent: "task" });
		await runEvalWorkpool({ op: "push", name: "pinned", items: ["do work"] }, { session });
		// The pool job settles once every item's batch has run, i.e. after the spawn.
		await settleEvalJob(session, "pinned");

		expect(spy).toHaveBeenCalledTimes(1);
		const forwarded = spy.mock.calls[0]?.[0];
		expect(forwarded?.thinkingLevel).toBe(Effort.XHigh);
		expect(childFlag(forwarded?.settings)).toBe(true);
		// The pool job settles even when its batches fail (allSettled), so a
		// settled pool proves nothing on its own: the item itself must have
		// completed, i.e. the pinned worker ran its turn and its keyed yield
		// passed the pool's strict per-item schema.
		expect(await runEvalWorkpool({ op: "status", name: "pinned" }, { session })).toMatchObject({
			items: { completed: 1, failed: 0, cancelled: 0, queued: 0, running: 0 },
		});
		// A keep-alive worker outlives the turn that spawned it: its pin is stamped, not read through.
		cfgUltracode.override(session.settings, false);
		expect(childFlag(forwarded?.settings)).toBe(true);
	});

	it("pins a task-kind structured-subagent spawn identically", async () => {
		const spy = mockFrontendSpawnSeams();
		const session = frontendToolSession({ model: FULL_LADDER, ultracode: true });

		const execution = await runStructuredSubagent({
			session,
			invocationKind: "task",
			assignment: "do work",
			agent: "task",
		});

		// Fails if the task-kind settings plumbing above runSubprocess diverges
		// from the eval kind — the "one seam covers both" claim, tested for both.
		expect(execution.result.exitCode).toBe(0);
		const forwarded = spy.mock.calls[0]?.[0];
		expect(forwarded?.thinkingLevel).toBe(Effort.XHigh);
		expect(childFlag(forwarded?.settings)).toBe(true);
		cfgUltracode.override(session.settings, false);
		expect(childFlag(forwarded?.settings)).toBe(true);
	});
});

// Queued fan-out decides the floor at REQUEST time. An armed turn pushes more
// work than `task.maxConcurrency` admits, its turn ends (pool results
// auto-deliver), and the user's next keyword-free prompt disarms the root while
// items still wait for a slot: those items were requested armed and must spawn
// (or continue) pinned — and the reverse for an unarmed request the root armed
// after. Each drives the real frontend → runStructuredSubagent → runSubprocess
// (and runSubagentFollowUpTurn for a reused worker) path; only the SDK is faked.
interface CreatedChild {
	options: CreateAgentSessionOptions;
	/** The child's own turn flag when the SDK built it. */
	flagAtCreate: boolean;
	log: string[];
}

/** Drains pending microtasks until an in-memory condition holds (no I/O in between). */
async function untilSettled(predicate: () => boolean, what: string): Promise<void> {
	for (let attempt = 0; attempt < 1_000; attempt++) {
		if (predicate()) return;
		await Promise.resolve();
	}
	throw new Error(`Never observed ${what}`);
}

describe("queued fan-out follows the arm state at request time", () => {
	const workerIds: string[] = [];

	afterEach(async () => {
		const lifecycle = AgentLifecycleManager.global();
		for (const id of workerIds.splice(0)) await lifecycle.release(id);
		for (const manager of jobManagers) await manager.dispose();
		jobManagers.clear();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
		WorkPoolRegistry.resetForTests();
		vi.restoreAllMocks();
	});

	/**
	 * A root admitting one spawn at a time, registered as the live `Main` the resume sync
	 * mirrors, whose SDK builds kept-alive children registered under their parent like the
	 * real one does. The first child's prompts wait on `release` (a worker busy on its first
	 * batch), so later requests queue behind it. `created(n)` settles once n children exist.
	 */
	function queuedRoot(options: { armed: boolean; freshAgents?: boolean }) {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [baseAgent], projectAgentsDir: null });
		const session = frontendToolSession({ model: FULL_LADDER, ultracode: options.armed });
		cfgTaskMaxConcurrency.override(session.settings, 1);
		cfgEvalWorkpoolFreshAgents.override(session.settings, options.freshAgents ?? false);
		AgentRegistry.global().register({
			id: "Main",
			displayName: "Main",
			kind: "main",
			status: "running",
			session: { settings: session.settings, emitIrcRelayObservation: () => {} } as unknown as AgentSession,
		});
		const busy = Promise.withResolvers<void>();
		const children: CreatedChild[] = [];
		const waiters: Array<{ count: number; resolve: () => void }> = [];
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			if (!options?.settings || !options.agentId) throw new Error("Expected settings and an agent id to ride in");
			const log: string[] = [];
			const child = keptAliveSession(options, log, children.length === 0 ? busy.promise : undefined);
			children.push({ options, flagAtCreate: cfgUltracode.get(options.settings), log });
			workerIds.push(options.agentId);
			AgentRegistry.global().register({
				id: options.agentId,
				displayName: options.agentId,
				kind: "sub",
				parentId: options.parentAgentId,
				session: child,
				sessionFile: options.sessionManager?.getSessionFile() ?? null,
				status: "running",
			});
			for (const waiter of waiters) if (children.length >= waiter.count) waiter.resolve();
			return createSessionResult(child);
		});
		const created = (count: number): Promise<void> => {
			if (children.length >= count) return Promise.resolve();
			const { promise, resolve } = Promise.withResolvers<void>();
			waiters.push({ count, resolve });
			return promise;
		};
		return { session, children, created, release: () => busy.resolve() };
	}

	it("spawns a fresh-agent item pushed while armed pinned, though the root disarmed before it started", async () => {
		const { session, children, created, release } = queuedRoot({ armed: true, freshAgents: true });
		await runEvalWorkpool({ op: "create", agent: "task", name: "queued" }, { session });
		await runEvalWorkpool({ op: "push", name: "queued", items: ["one", "two"] }, { session });
		await created(1);

		// The armed turn ended; the user's next keyword-free prompt disarms the root.
		cfgUltracode.override(session.settings, false);
		release();
		await settleEvalJob(session, "queued");

		expect(children.map(child => [child.options.thinkingLevel, child.flagAtCreate])).toEqual([
			[Effort.XHigh, true],
			[Effort.XHigh, true],
		]);
		expect(await runEvalWorkpool({ op: "status", name: "queued" }, { session })).toMatchObject({
			items: { completed: 2, failed: 0 },
		});
	});

	it("spawns a fresh-agent item pushed while unarmed unpinned, though the root armed before it started", async () => {
		const { session, children, created, release } = queuedRoot({ armed: false, freshAgents: true });
		await runEvalWorkpool({ op: "create", agent: "task", name: "queued" }, { session });
		await runEvalWorkpool({ op: "push", name: "queued", items: ["one", "two"] }, { session });
		await created(1);

		cfgUltracode.override(session.settings, true);
		release();
		await settleEvalJob(session, "queued");

		expect(children.map(child => [child.options.thinkingLevel, child.flagAtCreate])).toEqual([
			[undefined, false],
			[undefined, false],
		]);
	});

	it("keeps a reused worker pinned for a batch pushed while armed, though the root disarmed before it ran", async () => {
		const { session, children, created, release } = queuedRoot({ armed: true });
		await runEvalWorkpool({ op: "create", agent: "task", name: "reused" }, { session });
		await runEvalWorkpool({ op: "push", name: "reused", items: ["one", "two"] }, { session });
		await created(1);

		cfgUltracode.override(session.settings, false);
		release();
		await settleEvalJob(session, "reused");

		// One worker, two turns: the follow-up batch mirrors its push, not the root's
		// state when the worker freed up (that would be "disarm", "prompt:false").
		expect(children).toHaveLength(1);
		expect(children[0]?.log).toEqual(["prompt:true", "repin", "prompt:true"]);
		expect(await runEvalWorkpool({ op: "status", name: "reused" }, { session })).toMatchObject({
			items: { completed: 2, failed: 0 },
			batches: 2,
		});
	});

	it("never batches items pushed under different arm states into one worker turn", async () => {
		const { session, children, created, release } = queuedRoot({ armed: true });
		await runEvalWorkpool({ op: "create", agent: "task", name: "mixed" }, { session });
		await runEvalWorkpool({ op: "push", name: "mixed", items: ["one"] }, { session });
		await created(1);
		await runEvalWorkpool({ op: "push", name: "mixed", items: ["two"] }, { session });
		cfgUltracode.override(session.settings, false);
		await runEvalWorkpool({ op: "push", name: "mixed", items: ["three"] }, { session });
		// Both later items queue on the one busy worker before it is released.
		const pool = WorkPoolRegistry.global().get("Main", "mixed");
		await untilSettled(() => pool?.agents[0]?.queue.length === 2, "both items queued on the busy worker");

		release();
		await settleEvalJob(session, "mixed");

		expect(children).toHaveLength(1);
		expect(children[0]?.log).toEqual(["prompt:true", "repin", "prompt:true", "disarm", "prompt:false"]);
		expect(await runEvalWorkpool({ op: "status", name: "mixed" }, { session })).toMatchObject({
			items: { completed: 3, failed: 0 },
			batches: 3,
		});
	});

	it("pins an eval agent() requested while armed, though the root disarmed before its job reached the spawn", async () => {
		const { session, children, release } = queuedRoot({ armed: true });
		release();
		// agent() preflights once before it returns the handle; the background job's spawn
		// preflights again. Holding that second discovery holds the job before runSubprocess.
		const jobPreflightReached = Promise.withResolvers<void>();
		const jobPreflight = Promise.withResolvers<void>();
		let discoveries = 0;
		vi.spyOn(discoveryModule, "discoverAgents").mockImplementation(async () => {
			discoveries++;
			if (discoveries > 1) {
				jobPreflightReached.resolve();
				await jobPreflight.promise;
			}
			return { agents: [baseAgent], projectAgentsDir: null };
		});

		const handle = await runEvalAgent({ prompt: "do work", agent: "task" }, { session });
		await jobPreflightReached.promise;
		cfgUltracode.override(session.settings, false);
		jobPreflight.resolve();
		await settleEvalJob(session, handle.id);

		expect(children.map(child => [child.options.agentId, child.options.thinkingLevel, child.flagAtCreate])).toEqual([
			[handle.id, Effort.XHigh, true],
		]);
	});

	it("pins a queued background task spawn requested while armed, though the root disarmed before it got a slot", async () => {
		const { session, children, created, release } = queuedRoot({ armed: true });
		cfgAsyncEnabled.override(session.settings, true);
		cfgTaskBatch.override(session.settings, true);
		const tool = await TaskTool.create(session);

		await tool.execute("tc-queued", {
			context: "shared",
			tasks: [
				{ name: "One", agent: "task", task: "first" },
				{ name: "Two", agent: "task", task: "second" },
			],
		} as TaskParams);
		// `task.maxConcurrency` 1: the second spawn waits on the session semaphore.
		await created(1);
		cfgUltracode.override(session.settings, false);
		release();
		await created(2);

		expect(children.map(child => [child.options.thinkingLevel, child.flagAtCreate])).toEqual([
			[Effort.XHigh, true],
			[Effort.XHigh, true],
		]);
	});
});

// The grandchild middle link. The pin tests above prove the parent's flag pins
// the CHILD's level, and agent-session-magic-keywords proves an armed child
// keeps an inherited flag through its agent-authored turn — but only the
// by-value `ultracode` stamp in createSubagentSettings connects the two. Since
// v18.9.0 (6962d5cd2e) the child's settings are a LIVE overlay of the parent's,
// so without that stamp the child reads the parent's flag through: right while
// the parent stays armed, wrong the moment the parent's turn ends while the
// child still runs (grandchildren lose the floor, the child's retry-fallback
// re-pin stops, and the resume sync's disarm branch never fires). The
// assertions after each parent flip fail on exactly that read-through.
describe("ultracode override inheritance into child settings", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("carries the runtime ultracode override into the child settings, by value", async () => {
		const { result, forwarded, parentSettings } = await spawn({
			id: "ultracode-inherits-into-child",
			model: FULL_LADDER,
			ultracode: true,
		});

		expect(result.exitCode).toBe(0);
		expect(childFlag(forwarded?.settings)).toBe(true);
		cfgUltracode.override(parentSettings, false);
		expect(childFlag(forwarded?.settings)).toBe(true);
	});

	it("spawns children with the flag off when the parent turn is not armed, and keeps it off", async () => {
		const { result, forwarded, parentSettings } = await spawn({
			id: "ultracode-not-inherited-when-off",
			model: FULL_LADDER,
		});

		expect(result.exitCode).toBe(0);
		expect(childFlag(forwarded?.settings)).toBe(false);
		cfgUltracode.override(parentSettings, true);
		expect(childFlag(forwarded?.settings)).toBe(false);
	});
});

// The pin is BORROWED, even for a child constructed directly at xhigh. When
// the parent's turn ends, the lifecycle sync disarms the child at its next
// resume boundary, and `endUltracodeTurn` hands back `#levelBeforeUltracode` —
// which a child never captured, because it never ran `beginUltracodeTurn`.
// `ultracodeRestoreLevel` seeds that capture with the level the child would
// have run at WITHOUT the pin. Dropping it leaves every disarmed child parked
// at xhigh as if that were its own choice.
describe("ultracode restore level rides into the child", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("forwards the agent definition's own level as the restore level under ultracode", async () => {
		const { result, forwarded } = await spawn({
			id: "ultracode-restore-agent-level",
			model: FULL_LADDER,
			ultracode: true,
			thinkingLevel: ThinkingLevel.Medium,
		});

		expect(result.exitCode).toBe(0);
		expect(forwarded?.thinkingLevel).toBe(Effort.XHigh);
		expect(forwarded?.thinkingLevelCeiling).toBe(Effort.XHigh);
		expect(forwarded?.ultracodeRestoreLevel).toBe(ThinkingLevel.Medium);
	});

	it("prefers an explicit :level suffix as the restore level, exactly as the unpinned spawn would run", async () => {
		const { result, forwarded } = await spawn({
			id: "ultracode-restore-suffix",
			model: FULL_LADDER,
			ultracode: true,
			thinkingLevel: ThinkingLevel.Medium,
			modelSuffix: Effort.Low,
		});

		expect(result.exitCode).toBe(0);
		expect(forwarded?.thinkingLevel).toBe(Effort.XHigh);
		// Precedence without the pin is suffix > agent default, so the handback
		// lands where the unpinned spawn would have: low, not medium.
		expect(forwarded?.ultracodeRestoreLevel).toBe(Effort.Low);
	});

	it("keeps auto as the restore level, so a disarmed child resumes classifying", async () => {
		const { result, forwarded } = await spawn({
			id: "ultracode-restore-auto",
			model: FULL_LADDER,
			ultracode: true,
			thinkingLevel: AUTO_THINKING,
		});

		expect(result.exitCode).toBe(0);
		expect(forwarded?.thinkingLevel).toBe(Effort.XHigh);
		expect(forwarded?.ultracodeRestoreLevel).toBe(AUTO_THINKING);
	});

	// A child born armed must never ride with an undefined hand-back: ModelControls
	// seeds `#levelBeforeUltracode` only from `ultracodeRestoreLevel`, so `undefined`
	// turns the resume-boundary disarm into a no-op and the borrowed xhigh becomes
	// the child's own level. Agents with no level of their own (a user agent without
	// `thinkingLevel`, the bundled `reviewer`/`security-reviewer`) hit exactly that.
	it("hands a level-less agent back to the child's default level and persists the hand-back", async () => {
		const { result, forwarded, inits } = await spawn({
			id: "ultracode-restore-levelless",
			model: FULL_LADDER,
			ultracode: true,
			defaultThinkingLevel: ThinkingLevel.Medium,
		});

		expect(result.exitCode).toBe(0);
		expect(forwarded?.thinkingLevel).toBe(Effort.XHigh);
		// Unpinned, the SDK picks the model's catalog default (FULL_LADDER has none),
		// then the child's `defaultThinkingLevel`: the level the pin borrowed from.
		expect(forwarded?.ultracodeRestoreLevel).toBe(ThinkingLevel.Medium);
		// No caller `effort`: unpinned, the spawn rides with no ceiling at all.
		expect(forwarded?.ultracodeRestoreCeiling).toBeNull();
		// The cold-revive contract carries the same hand-back.
		expect(inits).toHaveLength(1);
		expect(inits[0]).toMatchObject({
			ultracode: true,
			ultracodeRestoreLevel: ThinkingLevel.Medium,
			ultracodeRestoreCeiling: null,
		});
	});

	it("prefers the model's catalog default level over the settings default for a level-less agent", async () => {
		const { result, forwarded } = await spawn({
			id: "ultracode-restore-model-default",
			model: DEFAULTS_TO_LOW,
			ultracode: true,
			defaultThinkingLevel: ThinkingLevel.Medium,
		});

		expect(result.exitCode).toBe(0);
		expect(forwarded?.thinkingLevel).toBe(Effort.XHigh);
		expect(forwarded?.ultracodeRestoreLevel).toBe(Effort.Low);
	});

	it("hands the bundled reviewer, which pins no level of its own, back below xhigh", async () => {
		const reviewer = getBundledAgent("reviewer");
		if (!reviewer) throw new Error("Expected the bundled reviewer agent");
		// The premise: nothing in the definition names a level for the hand-back.
		expect(reviewer.thinkingLevel).toBeUndefined();
		const { result, forwarded } = await spawn({
			id: "ultracode-restore-reviewer",
			model: FULL_LADDER,
			ultracode: true,
			agent: reviewer,
			role: "slow",
			defaultThinkingLevel: ThinkingLevel.Medium,
		});

		expect(result.exitCode).toBe(0);
		expect(forwarded?.thinkingLevel).toBe(Effort.XHigh);
		expect(forwarded?.ultracodeRestoreLevel).toBe(ThinkingLevel.Medium);
	});

	it("hands a caller effort back to the level it resolves to unpinned, outranking the agent's level", async () => {
		const { result, forwarded, inits } = await spawn({
			id: "ultracode-restore-caller-effort",
			model: FULL_LADDER,
			ultracode: true,
			thinkingLevel: ThinkingLevel.Medium,
			effort: "lo",
		});

		expect(result.exitCode).toBe(0);
		expect(forwarded?.thinkingLevel).toBe(Effort.XHigh);
		// Unpinned, `lo` on a low→max ladder runs at low (effort outranks the agent level)
		// under `task.maxEffort` (default max) — the pin's xhigh ceiling is borrowed too.
		expect(forwarded?.ultracodeRestoreLevel).toBe(Effort.Low);
		expect(forwarded?.ultracodeRestoreCeiling).toBe(Effort.Max);
		expect(inits[0]).toMatchObject({ ultracodeRestoreLevel: Effort.Low, ultracodeRestoreCeiling: Effort.Max });
	});

	it("hands a capped caller effort back under task.maxEffort, the ceiling the pin ignored", async () => {
		const { result, forwarded } = await spawn({
			id: "ultracode-restore-capped-effort",
			model: FULL_LADDER,
			ultracode: true,
			effort: "hi",
			maxEffort: Effort.High,
		});

		expect(result.exitCode).toBe(0);
		expect(forwarded?.thinkingLevel).toBe(Effort.XHigh);
		expect(forwarded?.thinkingLevelCeiling).toBe(Effort.XHigh);
		expect(forwarded?.ultracodeRestoreLevel).toBe(Effort.High);
		expect(forwarded?.ultracodeRestoreCeiling).toBe(Effort.High);
	});

	it("forwards and persists no hand-back while ultracode is off", async () => {
		// Control: outside an armed turn nothing is borrowed, so seeding a
		// handback would make the child's first disarm rewrite a level it owns.
		const { result, forwarded, inits } = await spawn({
			id: "ultracode-off-no-restore",
			model: FULL_LADDER,
			thinkingLevel: ThinkingLevel.Medium,
			effort: "lo",
		});

		expect(result.exitCode).toBe(0);
		expect(forwarded?.thinkingLevel).toBe(ThinkingLevel.Low);
		expect(forwarded?.ultracodeRestoreLevel).toBeUndefined();
		expect(forwarded?.ultracodeRestoreCeiling).toBeUndefined();
		expect(inits).toHaveLength(1);
		expect(inits[0]?.ultracode).toBeUndefined();
		expect(inits[0]?.ultracodeRestoreLevel).toBeUndefined();
		expect(inits[0]?.ultracodeRestoreCeiling).toBeUndefined();
	});
});

// Two overlay flavours of the parent's settings. Since v18.9.0 both are LIVE
// overlays (every key reads through to the parent) with the `ultracode` turn
// flag stamped BY VALUE at creation. `createIsolatedSettings` carries NONE of
// the headless-subagent policy stamps, for surfaces the user still drives (the
// Agents Hub architect, the legacy-shim session). `createSubagentSettings` is
// that plus the policy stamps. The split must not drift: a stamp leaking into
// the isolated flavour would silently yolo an interactive clone, and the flag
// read through instead of stamped would drop a running child's xhigh floor the
// moment the parent's turn ends.
describe("createIsolatedSettings vs createSubagentSettings", () => {
	/** Keys createSubagentSettings stamps with a value of its own on top of the read-through. */
	const SUBAGENT_STAMPS: Record<string, true> = {
		"tools.approvalMode": true,
		"advisor.enabled": true,
		"compaction.midTurnEnabled": true,
		"tier.openai": true,
		"tier.anthropic": true,
		"tier.google": true,
	};

	function parentSettings(armed: boolean): Settings {
		const parent = Settings.isolated({
			"tools.approvalMode": "always-ask",
			"advisor.enabled": true,
			"compaction.midTurnEnabled": false,
			"task.maxConcurrency": 3,
		});
		// The runtime override layer, exactly how the keyword arms it: the stamp
		// must read the merged value, not the persisted base.
		cfgUltracode.override(parent, armed);
		return parent;
	}

	it("createIsolatedSettings keeps the parent's approval mode and advisor, and the armed flag", () => {
		const isolated = createIsolatedSettings(parentSettings(true));

		expect(cfgToolsApprovalMode.get(isolated)).toBe("always-ask");
		expect(cfgAdvisorEnabled.get(isolated)).toBe(true);
		expect(cfgUltracode.get(isolated)).toBe(true);
		expect(cfgTaskMaxConcurrency.get(isolated)).toBe(3);
	});

	it("createIsolatedSettings freezes only the turn flag, and its own writes stay on the overlay", () => {
		const parent = parentSettings(true);
		const isolated = createIsolatedSettings(parent);

		// The flag is stamped: a parent disarm does not reach the isolated view...
		cfgUltracode.override(parent, false);
		expect(cfgUltracode.get(isolated)).toBe(true);
		// ...and a disarm written on the view stays there.
		cfgUltracode.override(parent, true);
		cfgUltracode.override(isolated, false);
		expect(cfgUltracode.get(parent)).toBe(true);
		expect(cfgUltracode.get(isolated)).toBe(false);

		// Every other key is a live read-through, and an overlay write never leaks back.
		cfgTaskMaxConcurrency.override(parent, 5);
		expect(cfgTaskMaxConcurrency.get(isolated)).toBe(5);
		cfgTaskMaxConcurrency.override(isolated, 9);
		expect(cfgTaskMaxConcurrency.get(parent)).toBe(5);
	});

	it("createIsolatedSettings leaves an unarmed view unarmed when the parent arms later", () => {
		const parent = parentSettings(false);
		const isolated = createIsolatedSettings(parent);

		cfgUltracode.override(parent, true);
		expect(cfgUltracode.get(isolated)).toBe(false);
	});

	it("createSubagentSettings is the isolated view plus exactly the subagent stamps", () => {
		const parent = parentSettings(true);
		const isolated = createIsolatedSettings(parent);
		const subagent = createSubagentSettings(parent);

		expect(cfgToolsApprovalMode.get(subagent)).toBe("yolo");
		expect(cfgAdvisorEnabled.get(subagent)).toBe(false);
		expect(cfgCompactionMidTurnEnabled.get(subagent)).toBe(true);
		// Every other registered setting resolves identically through both
		// flavours — enumerated from the registry so a new key cannot fall out of
		// the check.
		for (const setting of all()) {
			if (SUBAGENT_STAMPS[setting.id]) continue;
			expect([setting.id, setting.get(subagent)]).toEqual([setting.id, setting.get(isolated)]);
		}
		expect(cfgUltracode.get(subagent)).toBe(true);
	});

	it("createSubagentSettings stamps the turn flag by value, down to the grandchild", () => {
		// Armed at spawn: the child (and a grandchild built from it) keeps the
		// pin until its own resume boundary, whatever the parent does meanwhile.
		const armedParent = parentSettings(true);
		const child = createSubagentSettings(armedParent);
		const grandchild = createSubagentSettings(child);
		cfgUltracode.override(armedParent, false);
		expect(cfgUltracode.get(child)).toBe(true);
		expect(cfgUltracode.get(grandchild)).toBe(true);
		cfgUltracode.override(armedParent, true);
		expect(cfgUltracode.get(child)).toBe(true);

		// Unarmed at spawn: the parent arming later must not flag a child that
		// was never pinned (its spawns would floor at a level it is not running at).
		const unarmedParent = parentSettings(false);
		const unarmedChild = createSubagentSettings(unarmedParent);
		cfgUltracode.override(unarmedParent, true);
		expect(cfgUltracode.get(unarmedChild)).toBe(false);
	});

	it("keeps a child's own flag writes on the child", () => {
		// The child's resume sync disarms with override(false) on the child; that
		// must never reach the parent's still-running turn, and vice versa.
		const armedParent = parentSettings(true);
		const child = createSubagentSettings(armedParent);
		cfgUltracode.override(child, false);
		expect(cfgUltracode.get(armedParent)).toBe(true);

		const unarmedParent = parentSettings(false);
		const repinned = createSubagentSettings(unarmedParent);
		cfgUltracode.override(repinned, true);
		expect(cfgUltracode.get(unarmedParent)).toBe(false);
	});

	it("carries the stamp through the warm-revive capture of the child's own layers", () => {
		// The warm reviver keeps `child.overlayLayers()` and rebuilds the child
		// with `parent.restoreOverlay(layers)` (executor.ts capture/restore). The
		// stamp has to live in those own layers, or a revived child reads the
		// parent's then-current flag instead of its spawn-time pin.
		const parent = parentSettings(true);
		const layers = createSubagentSettings(parent).overlayLayers();
		cfgUltracode.override(parent, false);
		expect(cfgUltracode.get(parent.restoreOverlay(layers))).toBe(true);
	});

	it("createSubagentSettings still lets caller overrides win over the stamps", () => {
		const subagent = createSubagentSettings(parentSettings(true), { "advisor.enabled": true });

		expect(cfgAdvisorEnabled.get(subagent)).toBe(true);
		expect(cfgToolsApprovalMode.get(subagent)).toBe("yolo");
		// The flag stamp too: persisted-revive seeds a child from its recorded
		// session_init this way, whatever the root's flag reads now.
		expect(cfgUltracode.get(createSubagentSettings(parentSettings(false), { ultracode: true }))).toBe(true);
	});
});

// A kept-alive child spawned under the pin carries the borrowed xhigh as its
// spec's `thinkingLevel`, and the warm reviver rebuilds it from that spec. A
// resume boundary that disarmed the child before it parked leaves its own
// `override(false)` in the captured overlay; reviving it at the spec level
// would bring it back at xhigh, unflagged, with no hand-back seeded (the
// session seeds one only when constructed armed) — xhigh as if it were its own
// choice. These drive the real runSubprocess → lifecycle park → ensureLive path
// and read what the warm reviver hands `createAgentSession`.
const REVIVE_PARENT_ID = "ultracode-revive-parent";

/**
 * The yielding fake as a kept-alive child: it owns the real SessionManager it
 * was handed (its prompt persists the turn, so the warm reviver finds history
 * on disk), closes it on dispose like the real session, and carries the three
 * ultracode members `syncChildUltracodeAtResume` calls. The disarm has the real
 * one's effect on the flag: `override(settings, false)`, never `clearOverride`.
 * `log` records each sync call and the child's own flag at every prompt, in order;
 * a `gate` holds every prompt until it resolves (a worker busy on its first batch).
 */
function keptAliveSession(
	options: CreateAgentSessionOptions | undefined,
	log: string[] = [],
	gate?: Promise<void>,
): AgentSession {
	const settings = options?.settings;
	const sessionManager = options?.sessionManager;
	if (!settings || !sessionManager) throw new Error("Expected settings and a session manager to ride in");
	const base = yieldEmittingSession(settings);
	const session = {
		...base,
		sessionManager,
		prompt: async (text: string, promptOptions?: PromptOptions) => {
			if (gate) await gate;
			log.push(`prompt:${cfgUltracode.get(settings)}`);
			sessionManager.appendMessage({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });
			sessionManager.appendMessage({
				role: "assistant",
				provider: FULL_LADDER.provider,
				model: FULL_LADDER.id,
				api: FULL_LADDER.api,
				content: [{ type: "text", text: "done" }],
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			});
			await base.prompt(text, promptOptions);
		},
		dispose: async () => {
			await base.dispose();
			await sessionManager.close();
		},
		disarmUltracodeTurn: () => {
			log.push("disarm");
			if (cfgUltracode.get(settings)) cfgUltracode.override(settings, false);
		},
		// FULL_LADDER has an xhigh rung and no ceiling below it: the pin always lands.
		ultracodePinRefusal: () => undefined,
		repinUltracodeIfArmed: () => {
			log.push("repin");
			return true;
		},
	};
	return session as unknown as AgentSession;
}

describe("ultracode warm revive of a kept-alive child", () => {
	const tempDirs: TempDir[] = [];
	const childIds: string[] = [];

	afterEach(async () => {
		const lifecycle = AgentLifecycleManager.global();
		for (const id of childIds.splice(0)) await lifecycle.release(id);
		AgentRegistry.global().unregister(REVIVE_PARENT_ID);
		AgentLifecycleManager.resetGlobalForTests();
		vi.restoreAllMocks();
		await Promise.all(tempDirs.splice(0).map(dir => dir.remove()));
	});

	/**
	 * Spawns a kept-alive child of a registered parent through the real runSubprocess, at
	 * `thinkingLevel` (default medium; `null` = an agent with no level of its own).
	 */
	async function spawnKeptAlive(
		id: string,
		armed: boolean,
		options: { thinkingLevel?: ConfiguredThinkingLevel | null; effort?: TaskEffort } = {},
	) {
		const dir = TempDir.createSync("@pi-ultracode-warm-revive-");
		tempDirs.push(dir);
		const parentSettings = Settings.isolated({ defaultThinkingLevel: ThinkingLevel.Low });
		cfgUltracode.override(parentSettings, armed);
		parentSettings.setModelRole("task", `${FULL_LADDER.provider}/${FULL_LADDER.id}`);
		// The resume sync mirrors the nearest live ancestor's flag: exactly its `settings`.
		AgentRegistry.global().register({
			id: REVIVE_PARENT_ID,
			displayName: REVIVE_PARENT_ID,
			kind: "main",
			session: { settings: parentSettings } as unknown as AgentSession,
		});
		let child: AgentSession | undefined;
		const log: string[] = [];
		const spy = vi.spyOn(sdkModule, "createAgentSession").mockImplementationOnce(async options => {
			child = keptAliveSession(options, log);
			// The SDK registers a spawned child under its parent, which keeps it live after it yields.
			AgentRegistry.global().register({
				id,
				displayName: id,
				kind: "sub",
				parentId: options?.parentAgentId,
				session: child,
				sessionFile: options?.sessionManager?.getSessionFile() ?? null,
				status: "running",
			});
			return createSessionResult(child);
		});
		childIds.push(id);
		const result = await runSubprocess({
			cwd: dir.path(),
			agent: baseAgent,
			task: "do work",
			index: 0,
			enableLsp: false,
			enableIrc: false,
			id,
			settings: parentSettings,
			modelRegistry: createModelRegistry(FULL_LADDER),
			thinkingLevel: options.thinkingLevel === null ? undefined : (options.thinkingLevel ?? ThinkingLevel.Medium),
			effort: options.effort,
			artifactsDir: dir.path(),
			keepAlive: true,
			parentAgentId: REVIVE_PARENT_ID,
		});
		expect(result.exitCode).toBe(0);
		if (!child) throw new Error("Expected the spawn to create a session");
		expect(AgentLifecycleManager.global().has(id)).toBe(true);
		// Only what happens after the spawn's own first prompt matters to the callers.
		log.length = 0;
		return { child, spawned: spy.mock.calls[0]?.[0], parentSettings, log };
	}

	/** Parks the child, then warm-revives it through the lifecycle, capturing what the reviver forwards. */
	async function parkAndRevive(id: string) {
		const lifecycle = AgentLifecycleManager.global();
		await lifecycle.park(id);
		expect(AgentRegistry.global().get(id)?.status).toBe("parked");
		let revived: { options: CreateAgentSessionOptions; flagAtCreate: boolean; session: AgentSession } | undefined;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementationOnce(async options => {
			if (!options?.settings) throw new Error("Expected the reviver to forward settings");
			const session = keptAliveSession(options);
			// Read at construction: the lifecycle's resume sync runs on the revived session right after.
			revived = { options, flagAtCreate: cfgUltracode.get(options.settings), session };
			return createSessionResult(session);
		});
		const live = await lifecycle.ensureLive(id);
		if (!revived || live !== revived.session) throw new Error("Expected a warm revive through the lifecycle");
		return revived;
	}

	it("revives a child disarmed at a resume boundary at its restore level, not the borrowed xhigh", async () => {
		const id = "ultracode-warm-revive-disarmed";
		const { child, spawned, parentSettings } = await spawnKeptAlive(id, true);
		expect(spawned?.thinkingLevel).toBe(Effort.XHigh);
		expect(spawned?.ultracodeRestoreLevel).toBe(ThinkingLevel.Medium);

		// The parent's armed turn ends; the child keeps its stamp until its own resume boundary.
		cfgUltracode.override(parentSettings, false);
		expect(childFlag(child.settings)).toBe(true);
		syncChildUltracodeAtResume(id, child, AgentRegistry.global());
		expect(childFlag(child.settings)).toBe(false);

		const revived = await parkAndRevive(id);
		expect(revived.flagAtCreate).toBe(false);
		expect(revived.options.thinkingLevel).toBe(ThinkingLevel.Medium);
		expect(childFlag(revived.options.settings)).toBe(false);
	});

	it("revives a child parked while still flagged at the pin, with its hand-back intact", async () => {
		// Control: no resume boundary between spawn and park, so the child's own
		// stamp still reads armed and the spec's xhigh is the right revive level.
		// The parent disarms first: the reviver must decide by the CHILD's
		// captured flag, and only the lifecycle's resume sync afterwards disarms it.
		const id = "ultracode-warm-revive-flagged";
		const { child, parentSettings } = await spawnKeptAlive(id, true);
		cfgUltracode.override(parentSettings, false);
		expect(childFlag(child.settings)).toBe(true);

		const revived = await parkAndRevive(id);
		expect(revived.flagAtCreate).toBe(true);
		expect(revived.options.thinkingLevel).toBe(Effort.XHigh);
		expect(revived.options.thinkingLevelCeiling).toBe(Effort.XHigh);
		expect(revived.options.ultracodeRestoreLevel).toBe(ThinkingLevel.Medium);
		// ensureLive's resume sync mirrored the unarmed parent onto the revived child.
		expect(childFlag(revived.options.settings)).toBe(false);
	});

	it("revives a child spawned unarmed at its own level, with nothing borrowed", async () => {
		const id = "ultracode-warm-revive-unarmed";
		const { spawned } = await spawnKeptAlive(id, false);
		expect(spawned?.thinkingLevel).toBe(ThinkingLevel.Medium);

		const revived = await parkAndRevive(id);
		expect(revived.flagAtCreate).toBe(false);
		expect(revived.options.thinkingLevel).toBe(ThinkingLevel.Medium);
		expect(revived.options.ultracodeRestoreLevel).toBeUndefined();
	});

	it("revives a level-less child disarmed at a resume boundary at its unpinned default, not xhigh", async () => {
		// The child has no level of its own: without a computed hand-back the reviver
		// cannot tell it was disarmed since the pin and brings it back at the spec's xhigh.
		const id = "ultracode-warm-revive-levelless";
		const { child, spawned, parentSettings } = await spawnKeptAlive(id, true, { thinkingLevel: null });
		expect(spawned?.thinkingLevel).toBe(Effort.XHigh);
		expect(spawned?.ultracodeRestoreLevel).toBe(ThinkingLevel.Low);

		cfgUltracode.override(parentSettings, false);
		syncChildUltracodeAtResume(id, child, AgentRegistry.global());
		expect(childFlag(child.settings)).toBe(false);

		const revived = await parkAndRevive(id);
		expect(revived.flagAtCreate).toBe(false);
		expect(revived.options.thinkingLevel).toBe(ThinkingLevel.Low);
		// No caller effort: the unpinned spawn had no ceiling, so neither does the revive.
		expect(revived.options.thinkingLevelCeiling).toBeUndefined();
	});

	it("revives a disarmed child under the ceiling it had unpinned, not the pin's xhigh", async () => {
		const id = "ultracode-warm-revive-ceiling";
		const { child, spawned, parentSettings } = await spawnKeptAlive(id, true, { effort: "lo" });
		expect(spawned?.thinkingLevelCeiling).toBe(Effort.XHigh);
		expect(spawned?.ultracodeRestoreCeiling).toBe(Effort.Max);

		cfgUltracode.override(parentSettings, false);
		syncChildUltracodeAtResume(id, child, AgentRegistry.global());

		const revived = await parkAndRevive(id);
		expect(revived.options.thinkingLevel).toBe(Effort.Low);
		expect(revived.options.thinkingLevelCeiling).toBe(Effort.Max);
	});

	// runSubagentFollowUpTurn is the resume boundary of a LIVE kept-alive child
	// (workpool worker reuse, vibe): ensureLive hands back the live session without
	// the lifecycle's revive-time sync, so the follow-up's own sync is the only
	// thing that mirrors the parent before the child's next prompt.
	it("hands a pinned child back before its follow-up prompt once the parent disarmed", async () => {
		const id = "ultracode-followup-disarm";
		const { child, parentSettings, log } = await spawnKeptAlive(id, true);
		cfgUltracode.override(parentSettings, false);
		expect(childFlag(child.settings)).toBe(true);

		const turn = await runSubagentFollowUpTurn({ id, agent: baseAgent, message: "follow up" });

		expect(turn.exitCode).toBe(0);
		expect(log).toEqual(["disarm", "prompt:false"]);
	});

	it("re-pins an unpinned child before its follow-up prompt once the parent armed", async () => {
		const id = "ultracode-followup-repin";
		const { parentSettings, log } = await spawnKeptAlive(id, false);
		cfgUltracode.override(parentSettings, true);

		const turn = await runSubagentFollowUpTurn({ id, agent: baseAgent, message: "follow up" });

		expect(turn.exitCode).toBe(0);
		expect(log).toEqual(["repin", "prompt:true"]);
	});

	// A queued workpool batch carries the arm state of its push. When it reaches a
	// reused worker the root may have flipped since; the follow-up mirrors the
	// request, not the root's state at the moment the worker freed up.
	it("keeps the pin for a follow-up requested while armed, though the parent disarmed since", async () => {
		const id = "ultracode-followup-request-armed";
		const { parentSettings, log } = await spawnKeptAlive(id, true);
		cfgUltracode.override(parentSettings, false);

		const turn = await runSubagentFollowUpTurn({ id, agent: baseAgent, message: "follow up", ultracodeArmed: true });

		expect(turn.exitCode).toBe(0);
		expect(log).toEqual(["repin", "prompt:true"]);
	});

	it("stays unpinned for a follow-up requested while unarmed, though the parent armed since", async () => {
		const id = "ultracode-followup-request-unarmed";
		const { parentSettings, log } = await spawnKeptAlive(id, false);
		cfgUltracode.override(parentSettings, true);

		const turn = await runSubagentFollowUpTurn({ id, agent: baseAgent, message: "follow up", ultracodeArmed: false });

		expect(turn.exitCode).toBe(0);
		expect(log).toEqual(["prompt:false"]);
	});
});

// A cold revive (new process, parent's live settings gone) rebuilds an armed
// child from the LATEST session_init. The session appends a newer one whenever
// a model call's base prompt or work-pool items change, spreading the
// extracted init (AgentSession #recordModelCallSystemPrompt) — so extraction
// must carry the ultracode stamp and its hand-back (restore level and ceiling),
// or the first re-record silently drops the pin from the persisted contract.
describe("session_init carries the ultracode stamp across re-records", () => {
	const contract = { systemPrompt: ["base"], task: "do work", tools: ["read", "yield"] };

	it("round-trips the flag, restore level and a no-ceiling hand-back through a re-recorded session_init", () => {
		const manager = SessionManager.inMemory("/tmp");
		manager.appendSessionInit({
			...contract,
			ultracode: true,
			ultracodeRestoreLevel: ThinkingLevel.Medium,
			// `null` is the "no ceiling" hand-back, distinct from an absent (legacy) one.
			ultracodeRestoreCeiling: null,
		});
		const init = extractSessionInit(manager.getEntries());
		expect(init?.ultracode).toBe(true);
		expect(init?.ultracodeRestoreLevel).toBe(ThinkingLevel.Medium);
		expect(init?.ultracodeRestoreCeiling).toBeNull();
		if (!init) throw new Error("Expected a session_init");

		// Exactly the re-record's spread on a base-prompt change.
		manager.appendSessionInit({ ...init, systemPrompt: ["rebuilt base"], workPoolYieldItems: undefined });
		const latest = extractSessionInit(manager.getEntries());
		expect(latest?.systemPrompt).toEqual(["rebuilt base"]);
		expect(latest?.ultracode).toBe(true);
		expect(latest?.ultracodeRestoreLevel).toBe(ThinkingLevel.Medium);
		expect(latest?.ultracodeRestoreCeiling).toBeNull();
	});

	it("extracts an unarmed init without the ultracode fields", () => {
		const manager = SessionManager.inMemory("/tmp");
		manager.appendSessionInit(contract);
		const init = extractSessionInit(manager.getEntries());
		if (!init) throw new Error("Expected a session_init");
		expect("ultracode" in init).toBe(false);
		expect("ultracodeRestoreLevel" in init).toBe(false);
		expect("ultracodeRestoreCeiling" in init).toBe(false);
	});
});

// A cold revive (new process, no live ancestor) rebuilds the child from that
// persisted contract through createPersistedSubagentReviverFactory: the flag
// stamp seeds its settings, the ceiling is the pin's, and the hand-back pair
// rides into the SDK so the lifecycle's resume sync can disarm it properly.
describe("ultracode cold revive from the persisted session_init", () => {
	const tempDirs: TempDir[] = [];

	afterEach(async () => {
		vi.restoreAllMocks();
		MCPManager.resetForTests();
		await Promise.all(tempDirs.splice(0).map(dir => dir.remove()));
	});

	/** Persists a parked child transcript with `init` on disk and cold-revives it, returning what reached the SDK. */
	async function coldRevive(init: Partial<PersistedSessionInit>): Promise<CreateAgentSessionOptions> {
		const dir = TempDir.createSync("@pi-ultracode-cold-revive-");
		tempDirs.push(dir);
		const cwd = dir.path();
		const manager = SessionManager.create(cwd, path.join(cwd, "sessions"));
		manager.appendSessionInit({ systemPrompt: ["base"], task: "do work", tools: ["read", "yield"], ...init });
		manager.appendMessage({
			role: "assistant",
			provider: FULL_LADDER.provider,
			model: FULL_LADDER.id,
			api: FULL_LADDER.api,
			content: [{ type: "text", text: "done" }],
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		});
		await manager.close();
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted session file");

		let captured: CreateAgentSessionOptions | undefined;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			captured = options;
			// Exactly the members the reviver touches after construction (upstream's
			// persisted-revive.test.ts fake), on top of the shared session defaults.
			const revived = {
				...createSessionDefaults(),
				getMountedXdevToolNames: () => [],
				setActiveToolsByName: async (_toolNames: string[]) => {},
				subscribe: () => () => {},
				setIrcWakeTurnObserver: () => {},
			};
			return { session: revived as unknown as AgentSession } as CreateAgentSessionResult;
		});
		const parentSession = {
			sessionManager: { getCwd: () => cwd, getArtifactManager: () => undefined },
			sessionFile: path.join(cwd, "parent.jsonl"),
			effectiveExtensionRoots: { explicit: [], mode: "merge", configured: [], configuredLevel: "user" },
			preparedExtensions: undefined,
		} as unknown as AgentSession;
		const factory = createPersistedSubagentReviverFactory({
			session: parentSession,
			authStorage: {} as AuthStorage,
			modelRegistry: { authStorage: {} } as unknown as ModelRegistry,
			settings: Settings.isolated(),
			enableLsp: true,
		});
		const ref: AgentRef = {
			id: "ColdChild",
			displayName: "ColdChild",
			kind: "sub",
			parentId: "Main",
			status: "parked",
			session: null,
			sessionFile,
			createdAt: 0,
			lastActivity: 0,
		};
		const reviver = await factory(ref);
		if (!reviver) throw new Error("Expected a persisted reviver");
		await reviver(ref);
		if (!captured) throw new Error("Expected the reviver to build a session");
		return captured;
	}

	it("seeds the flag, the xhigh ceiling and the whole hand-back for a child spawned armed", async () => {
		const forwarded = await coldRevive({
			ultracode: true,
			ultracodeRestoreLevel: ThinkingLevel.Medium,
			ultracodeRestoreCeiling: Effort.High,
		});

		expect(childFlag(forwarded.settings)).toBe(true);
		expect(forwarded.thinkingLevelCeiling).toBe(Effort.XHigh);
		expect(forwarded.ultracodeRestoreLevel).toBe(ThinkingLevel.Medium);
		expect(forwarded.ultracodeRestoreCeiling).toBe(Effort.High);
	});

	it("seeds none of it for a child spawned unarmed", async () => {
		const forwarded = await coldRevive({});

		expect(childFlag(forwarded.settings)).toBe(false);
		expect(forwarded.thinkingLevelCeiling).toBeUndefined();
		expect(forwarded.ultracodeRestoreLevel).toBeUndefined();
		expect(forwarded.ultracodeRestoreCeiling).toBeUndefined();
	});
});

// The resume sync's ancestor walk: the nearest LIVE ancestor decides, and a
// parked (session-less) parent between a grandchild and the root must not stop
// the walk — otherwise the grandchild falls back to its own stale stamp.
describe("the ultracode resume sync walks past parked ancestors", () => {
	afterEach(() => {
		AgentRegistry.resetGlobalForTests();
	});

	function grandchildUnderParkedParent(rootArmed: boolean, childArmed: boolean) {
		const registry = AgentRegistry.global();
		const rootSettings = Settings.isolated();
		cfgUltracode.override(rootSettings, rootArmed);
		registry.register({
			id: "Main",
			displayName: "Main",
			kind: "main",
			status: "running",
			session: { settings: rootSettings } as unknown as AgentSession,
		});
		registry.register({
			id: "ParkedParent",
			displayName: "ParkedParent",
			kind: "sub",
			parentId: "Main",
			status: "parked",
			session: null,
		});
		const settings = createSubagentSettings(rootSettings, { ultracode: childArmed });
		const log: string[] = [];
		const child = {
			settings,
			model: FULL_LADDER,
			disarmUltracodeTurn: () => {
				log.push("disarm");
				cfgUltracode.override(settings, false);
			},
			ultracodePinRefusal: () => undefined,
			repinUltracodeIfArmed: () => {
				log.push("repin");
				return true;
			},
		} as unknown as AgentSession;
		registry.register({
			id: "Grandchild",
			displayName: "Grandchild",
			kind: "sub",
			parentId: "ParkedParent",
			status: "idle",
			session: child,
		});
		return { registry, child, log };
	}

	it("re-pins an unarmed grandchild when the live root above its parked parent is armed", () => {
		const { registry, child, log } = grandchildUnderParkedParent(true, false);
		syncChildUltracodeAtResume("Grandchild", child, registry);
		expect(childFlag(child.settings)).toBe(true);
		expect(log).toEqual(["repin"]);
	});

	it("disarms a flagged grandchild once the live root above its parked parent disarmed", () => {
		const { registry, child, log } = grandchildUnderParkedParent(false, true);
		syncChildUltracodeAtResume("Grandchild", child, registry);
		expect(childFlag(child.settings)).toBe(false);
		expect(log).toEqual(["disarm"]);
	});
});

// The SDK leg of the hand-back and the construction-time refusal, through the
// REAL createAgentSession: every test above fakes the SDK, so a port that drops
// a pass-through line in sdk.ts (the file upstream churns most) would pass them.
describe("ultracode through the real createAgentSession", () => {
	const tempDirs: TempDir[] = [];
	const sessions: AgentSession[] = [];
	const authStorages: AuthStorage[] = [];

	afterEach(async () => {
		for (const session of sessions.splice(0)) await session.dispose();
		for (const authStorage of authStorages.splice(0)) authStorage.close();
		AgentRegistry.resetGlobalForTests();
		await Promise.all(tempDirs.splice(0).map(dir => dir.remove()));
	});

	/** A child (or, without `parentTaskPrefix`, a root) built by the real SDK on anthropic models. */
	async function createReal(
		options: { flagged: boolean; child?: boolean } & Pick<
			CreateAgentSessionOptions,
			| "model"
			| "modelPattern"
			| "thinkingLevel"
			| "thinkingLevelCeiling"
			| "ultracodeRestoreLevel"
			| "ultracodeRestoreCeiling"
		>,
	): Promise<AgentSession> {
		const dir = TempDir.createSync("@pi-ultracode-real-sdk-");
		tempDirs.push(dir);
		const authStorage = await AuthStorage.create(dir.join("auth.db"));
		authStorages.push(authStorage);
		authStorage.keys.setRuntime("anthropic", "test-key");
		const settings = Settings.isolated({ "compaction.enabled": false });
		cfgUltracode.override(settings, options.flagged);
		const { flagged: _flagged, child, ...spawn } = options;
		const { session } = await sdkModule.createAgentSession({
			...spawn,
			cwd: dir.path(),
			agentDir: dir.path(),
			sessionManager: SessionManager.inMemory(dir.path()),
			authStorage,
			modelRegistry: new ModelRegistry(authStorage, dir.join("models.yml")),
			settings,
			...(child === false
				? { agentId: "RealRoot", bindProcessState: false }
				: { agentId: "RealChild", parentTaskPrefix: "RealChild" }),
			disableExtensionDiscovery: true,
			skills: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			hasUI: false,
		});
		sessions.push(session);
		return session;
	}

	const XHIGH_TO_MAX = modelOrThrow("anthropic", "claude-opus-5-5");

	it("hands a child born at the pin back to the forwarded restore level on disarm", async () => {
		const session = await createReal({
			flagged: true,
			model: XHIGH_TO_MAX,
			thinkingLevel: Effort.XHigh,
			thinkingLevelCeiling: Effort.XHigh,
			ultracodeRestoreLevel: Effort.Low,
			ultracodeRestoreCeiling: null,
		});
		expect(session.thinkingLevel).toBe(Effort.XHigh);

		session.disarmUltracodeTurn();
		expect(cfgUltracode.get(session.settings)).toBe(false);
		expect(session.thinkingLevel).toBe(Effort.Low);
	});

	it("lifts the pin's xhigh ceiling to the forwarded unpinned one on disarm, so a max hand-back is not clamped", async () => {
		const session = await createReal({
			flagged: true,
			model: XHIGH_TO_MAX,
			thinkingLevel: Effort.XHigh,
			thinkingLevelCeiling: Effort.XHigh,
			ultracodeRestoreLevel: Effort.Max,
			ultracodeRestoreCeiling: null,
		});

		session.disarmUltracodeTurn();
		expect(session.thinkingLevel).toBe(Effort.Max);
	});

	it("refuses a flagged child whose model only the SDK resolves and which has no xhigh rung", async () => {
		const refused = createReal({
			flagged: true,
			modelPattern: `${CAPS_AT_HIGH.provider}/${CAPS_AT_HIGH.id}`,
			thinkingLevel: Effort.XHigh,
			thinkingLevelCeiling: Effort.XHigh,
			ultracodeRestoreLevel: Effort.Low,
			ultracodeRestoreCeiling: null,
		});

		// Not clamped to high under the ultracode name: loud, before any session exists.
		await expect(refused).rejects.toBeInstanceOf(UltracodeEffortError);
		await expect(refused).rejects.toThrow(`ultracode requires xhigh; ${CAPS_AT_HIGH.provider}/${CAPS_AT_HIGH.id}`);
		expect(AgentRegistry.global().get("RealChild")).toBeUndefined();
	});

	it("builds that same SDK-resolved model normally for an unflagged child", async () => {
		const session = await createReal({
			flagged: false,
			modelPattern: `${CAPS_AT_HIGH.provider}/${CAPS_AT_HIGH.id}`,
		});
		expect(session.model?.id).toBe(CAPS_AT_HIGH.id);
	});

	it("never refuses a root on construction: a root arms per turn and refuses there", async () => {
		const session = await createReal({ flagged: true, child: false, model: CAPS_AT_HIGH });
		expect(session.model?.id).toBe(CAPS_AT_HIGH.id);
	});
});
