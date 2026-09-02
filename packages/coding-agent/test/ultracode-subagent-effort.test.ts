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
 * `UltracodeEffortError` (see `ultracodeEffortFor` in src/thinking.ts) before
 * any session exists, instead of quietly running at a substitute level.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SETTINGS_SCHEMA, type SettingPath } from "@oh-my-pi/pi-coding-agent/config/settings-schema";
import { runEvalAgent } from "@oh-my-pi/pi-coding-agent/eval/agent-bridge";
import type { CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession, AgentSessionEvent, PromptOptions } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import { createIsolatedSettings, createSubagentSettings, runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import { runStructuredSubagent } from "@oh-my-pi/pi-coding-agent/task/structured-subagent";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import { AUTO_THINKING, type ConfiguredThinkingLevel, type TaskEffort } from "@oh-my-pi/pi-coding-agent/thinking";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";

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

/** Yields on the first prompt so `runSubprocess` completes without a real loop. */
function yieldEmittingSession(): AgentSession {
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	const session = {
		state: { messages: [] },
		agent: { state: { systemPrompt: ["test"] } },
		model: undefined,
		extensionRunner: undefined,
		sessionManager: { appendSessionInit: () => {} },
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
			for (const listener of listeners) {
				listener({
					type: "tool_execution_end",
					toolCallId: "tool-ultracode-effort",
					toolName: "yield",
					result: {
						content: [{ type: "text", text: "Result submitted." }],
						details: { status: "success", data: { ok: true } },
					},
					isError: false,
				});
			}
		},
		waitForIdle: async () => {},
		getLastAssistantMessage: () => undefined,
		abort: async () => {},
		dispose: async () => {},
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
	};
	return session as unknown as AgentSession;
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
}

async function spawn(options: SpawnOptions) {
	const settings = Settings.isolated(
		options.maxEffort === undefined ? undefined : { "task.maxEffort": options.maxEffort },
	);
	if (options.ultracode) settings.override("ultracode", true);
	const pattern = `${options.model.provider}/${options.model.id}`;
	settings.setModelRole("task", options.modelSuffix === undefined ? pattern : `${pattern}:${options.modelSuffix}`);
	const spy = vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(yieldEmittingSession()));
	const modelRegistry =
		options.prewalk === undefined
			? createModelRegistry(options.model)
			: createModelRegistry(options.model, PREWALK_TARGET);
	const hasConfiguredAuth = vi.spyOn(modelRegistry, "hasConfiguredAuth");

	const result = await runSubprocess({
		cwd: "/tmp",
		agent: options.prewalk === undefined ? baseAgent : { ...baseAgent, prewalk: options.prewalk },
		task: "do work",
		index: 0,
		enableLsp: false,
		id: options.id,
		settings,
		modelRegistry,
		thinkingLevel: options.thinkingLevel,
		effort: options.effort,
	});

	return { result, forwarded: spy.mock.calls[0]?.[0], spy, hasConfiguredAuth };
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
function frontendToolSession(options: { model: Model; ultracode?: boolean }): ToolSession {
	const settings = Settings.isolated();
	// Flipped exactly the way the keyword flips it: the non-persisted runtime layer.
	if (options.ultracode) settings.override("ultracode", true);
	settings.setModelRole("task", `${options.model.provider}/${options.model.id}`);
	return {
		cwd: "/tmp",
		settings,
		modelRegistry: createModelRegistry(options.model),
		getSessionSpawns: () => "*",
		getSessionFile: () => null,
		enableLsp: false,
		enableIrc: false,
		enableMCP: false,
	} as unknown as ToolSession;
}

function mockFrontendSpawnSeams() {
	vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [baseAgent], projectAgentsDir: null });
	return vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(yieldEmittingSession()));
}

describe("ultracode pin through the real spawn frontends", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("pins an eval agent() spawn to xhigh end-to-end through the bridge", async () => {
		const spy = mockFrontendSpawnSeams();
		const session = frontendToolSession({ model: FULL_LADDER, ultracode: true });

		await runEvalAgent({ prompt: "do work", agent: "task" }, { session });

		expect(spy).toHaveBeenCalledTimes(1);
		const forwarded = spy.mock.calls[0]?.[0];
		// Fails if the bridge or buildExecutorOptions stops handing the parent's
		// live settings through runStructuredSubagent (e.g. eval spawns given a
		// derivative/clean Settings): the pin computation at the chokepoint then
		// reads `ultracode: false` and this spawn dispatches cold.
		expect(forwarded?.thinkingLevel).toBe(Effort.XHigh);
		// The same severing also breaks inheritance: the child's settings
		// snapshot is taken from what the frontend forwarded.
		expect(forwarded?.settings?.get("ultracode")).toBe(true);
	});

	it("leaves an eval agent() spawn unpinned when ultracode is off", async () => {
		const spy = mockFrontendSpawnSeams();
		const session = frontendToolSession({ model: FULL_LADDER });

		await runEvalAgent({ prompt: "do work", agent: "task" }, { session });

		// The control: proves the pin above came from the parent's live flag,
		// not from anything constant about the eval path.
		const forwarded = spy.mock.calls[0]?.[0];
		expect(forwarded?.thinkingLevel).toBeUndefined();
		expect(forwarded?.settings?.get("ultracode")).toBe(false);
	});

	it("pins a task-kind structured-subagent spawn identically", async () => {
		const spy = mockFrontendSpawnSeams();
		const session = frontendToolSession({ model: FULL_LADDER, ultracode: true });

		await runStructuredSubagent({ session, invocationKind: "task", assignment: "do work", agent: "task" });

		// Fails if the task-kind settings plumbing above runSubprocess diverges
		// from the eval kind — the "one seam covers both" claim, tested for both.
		const forwarded = spy.mock.calls[0]?.[0];
		expect(forwarded?.thinkingLevel).toBe(Effort.XHigh);
		expect(forwarded?.settings?.get("ultracode")).toBe(true);
	});
});

// The grandchild middle link. The pin tests above prove the parent's flag pins
// the CHILD's level, and agent-session-magic-keywords proves an armed child
// keeps an inherited flag through its agent-authored turn — but only the
// whole-schema snapshot in createSubagentSettings connects the two. If that
// seam force-cleared `ultracode` — a plausible edit, since the adjacent block
// already force-sets "tools.approvalMode" and "advisor.enabled", and the
// schema comment calls the flag turn state, not a preference — grandchildren
// would silently lose the xhigh floor while every level assertion above
// stayed green. These fail on exactly that severing.
describe("ultracode override inheritance into child settings", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("carries the runtime ultracode override into the child settings snapshot", async () => {
		const { result, forwarded } = await spawn({
			id: "ultracode-inherits-into-child",
			model: FULL_LADDER,
			ultracode: true,
		});

		expect(result.exitCode).toBe(0);
		expect(forwarded?.settings?.get("ultracode")).toBe(true);
	});

	it("spawns children with the flag off when the parent turn is not armed", async () => {
		const { result, forwarded } = await spawn({
			id: "ultracode-not-inherited-when-off",
			model: FULL_LADDER,
		});

		expect(result.exitCode).toBe(0);
		expect(forwarded?.settings?.get("ultracode")).toBe(false);
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

	it("forwards no restore level while ultracode is off", async () => {
		// Control: outside an armed turn nothing is borrowed, so seeding a
		// handback would make the child's first disarm rewrite a level it owns.
		const { result, forwarded } = await spawn({
			id: "ultracode-off-no-restore",
			model: FULL_LADDER,
			thinkingLevel: ThinkingLevel.Medium,
		});

		expect(result.exitCode).toBe(0);
		expect(forwarded?.thinkingLevel).toBe(ThinkingLevel.Medium);
		expect(forwarded?.ultracodeRestoreLevel).toBeUndefined();
	});
});

// Two isolation flavours share one snapshot loop. `createIsolatedSettings` is
// "the parent's settings, detached": every schema key by value into a runtime
// override layer, with NONE of the headless-subagent policy stamps, for
// surfaces the user still drives (the Agents Hub, /tan). `createSubagentSettings`
// is that plus the stamps. The split must not drift: a stamp leaking into the
// isolated flavour would silently yolo an interactive clone, and a snapshot
// key lost from the subagent flavour would drop the grandchild's ultracode
// floor while every level assertion above stayed green.
describe("createIsolatedSettings vs createSubagentSettings", () => {
	/** The keys createSubagentSettings rewrites on top of the snapshot. */
	const SUBAGENT_STAMPS: Partial<Record<SettingPath, true>> = {
		"tools.approvalMode": true,
		"advisor.enabled": true,
		"tier.openai": true,
		"tier.anthropic": true,
		"tier.google": true,
	};

	function armedParent(): Settings {
		const parent = Settings.isolated({
			"tools.approvalMode": "always-ask",
			"advisor.enabled": true,
			"task.maxConcurrency": 3,
		});
		// The runtime override layer, exactly how the keyword arms it: the
		// snapshot must read the merged value, not the persisted base.
		parent.override("ultracode", true);
		return parent;
	}

	it("createIsolatedSettings keeps the parent's approval mode and advisor, and the armed flag", () => {
		const parent = armedParent();
		const isolated = createIsolatedSettings(parent);

		expect(isolated.get("tools.approvalMode")).toBe("always-ask");
		expect(isolated.get("advisor.enabled")).toBe(true);
		expect(isolated.get("ultracode")).toBe(true);
		expect(isolated.get("task.maxConcurrency")).toBe(3);
	});

	it("createIsolatedSettings is detached: later parent flips do not reach it and its own writes do not leak back", () => {
		const parent = armedParent();
		const isolated = createIsolatedSettings(parent);

		parent.override("ultracode", false);
		expect(isolated.get("ultracode")).toBe(true);

		isolated.override("task.maxConcurrency", 9);
		expect(parent.get("task.maxConcurrency")).toBe(3);
	});

	it("createSubagentSettings is the same snapshot plus exactly the subagent stamps", () => {
		const parent = armedParent();
		const isolated = createIsolatedSettings(parent);
		const subagent = createSubagentSettings(parent);

		// The stamps, verbatim from the previous (pre-split) implementation.
		expect(subagent.get("tools.approvalMode")).toBe("yolo");
		expect(subagent.get("advisor.enabled")).toBe(false);
		// Every other schema key resolves identically through both flavours —
		// enumerated from the schema so a new key cannot fall out of the check.
		for (const key of Object.keys(SETTINGS_SCHEMA) as SettingPath[]) {
			if (SUBAGENT_STAMPS[key]) continue;
			expect([key, subagent.get(key)]).toEqual([key, isolated.get(key)]);
		}
		expect(subagent.get("ultracode")).toBe(true);
	});

	it("createSubagentSettings still lets caller overrides win over the stamps", () => {
		const parent = armedParent();
		const subagent = createSubagentSettings(parent, { "advisor.enabled": true });

		expect(subagent.get("advisor.enabled")).toBe(true);
		expect(subagent.get("tools.approvalMode")).toBe("yolo");
	});
});
