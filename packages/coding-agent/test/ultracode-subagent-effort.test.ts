/**
 * Ultracode pins EVERY subagent spawn to xhigh while it is active.
 *
 * These drive the real `runSubprocess` and read the level it hands to
 * `createAgentSession` — `thinkingLevel` (the pinned effort) and
 * `thinkingLevelCeiling` (the ceiling that rides into the session so
 * retry-fallback recovery cannot re-clamp below it). The agent loop itself is
 * a mock that yields immediately, so nothing here talks to a model.
 *
 * The pin deliberately overrides the agent definition's own level (scout's
 * `medium`, task's `auto`), the caller's coarse `effort`, and a `task.maxEffort`
 * ceiling below xhigh. Only the model's own ladder is allowed to move it.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { runEvalAgent } from "@oh-my-pi/pi-coding-agent/eval/agent-bridge";
import type { CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession, AgentSessionEvent, PromptOptions } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
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

/** low → max, so an xhigh pin lands exactly on xhigh. */
const FULL_LADDER = modelOrThrow("openai-codex", "gpt-5.6-sol");
/** low → high: the model tops out below xhigh, so the pin must clamp down. */
const CAPS_AT_HIGH = modelOrThrow("anthropic", "claude-sonnet-4-6");
/** No `thinking` block at all: no controllable effort surface to pin. */
const NO_EFFORT_SURFACE = modelOrThrow("openai", "gpt-4o");
/**
 * A ladder sitting entirely above xhigh. `resolveTaskEffortLevel` would throw
 * `RangeError` here under a sub-xhigh `task.maxEffort`; the clamp the pin uses
 * must land it on `max` instead.
 */
const MAX_ONLY = {
	...FULL_LADDER,
	provider: "mock",
	id: "mock-max-only",
	thinking: { mode: "effort", efforts: [Effort.Max] },
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

function createModelRegistry(model: Model): ModelRegistry {
	return {
		authStorage: {},
		refresh: async () => {},
		getAvailable: () => [model],
		getApiKey: async () => "test-key",
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
}

async function spawn(options: SpawnOptions) {
	const settings = Settings.isolated(
		options.maxEffort === undefined ? undefined : { "task.maxEffort": options.maxEffort },
	);
	if (options.ultracode) settings.override("ultracode", true);
	settings.setModelRole("task", `${options.model.provider}/${options.model.id}`);
	const spy = vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(yieldEmittingSession()));

	const result = await runSubprocess({
		cwd: "/tmp",
		agent: baseAgent,
		task: "do work",
		index: 0,
		enableLsp: false,
		id: options.id,
		settings,
		modelRegistry: createModelRegistry(options.model),
		thinkingLevel: options.thinkingLevel,
		effort: options.effort,
	});

	return { result, forwarded: spy.mock.calls[0]?.[0], spy };
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

	it("clamps down to a model that tops out at high", async () => {
		const { result, forwarded } = await spawn({
			id: "ultracode-clamps-to-high",
			model: CAPS_AT_HIGH,
			ultracode: true,
			thinkingLevel: AUTO_THINKING,
		});

		expect(result.exitCode).toBe(0);
		expect(forwarded?.thinkingLevel).toBe(Effort.High);
	});

	it("resolves max for a model exposing only max instead of throwing", async () => {
		const { result, forwarded } = await spawn({
			id: "ultracode-max-only-model",
			model: MAX_ONLY,
			ultracode: true,
			effort: "hi",
			maxEffort: Effort.Low,
		});

		// `resolveTaskEffortLevel(model, "hi", Effort.Low)` would have thrown
		// RangeError and killed the spawn outright.
		expect(result.exitCode).toBe(0);
		expect(result.stderr ?? "").not.toContain("no supported thinking effort");
		expect(forwarded?.thinkingLevel).toBe(Effort.Max);
	});

	it("still fails that same spawn when ultracode is off, proving the clamp is what saves it", async () => {
		const { result, spy } = await spawn({
			id: "ultracode-off-max-only-model",
			model: MAX_ONLY,
			effort: "hi",
			maxEffort: Effort.Low,
		});

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain(
			"mock/mock-max-only has no supported thinking effort at or below task.maxEffort=low",
		);
		expect(spy).not.toHaveBeenCalled();
	});

	it("falls through to the normal selectors for a model with no controllable effort surface", async () => {
		const { result, forwarded } = await spawn({
			id: "ultracode-no-effort-surface",
			model: NO_EFFORT_SURFACE,
			ultracode: true,
			thinkingLevel: ThinkingLevel.Low,
		});

		expect(result.exitCode).toBe(0);
		// Forcing xhigh onto a model that cannot express it would be an invalid
		// level downstream; the agent's own selector must survive instead.
		expect(forwarded?.thinkingLevel).toBe(ThinkingLevel.Low);
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
