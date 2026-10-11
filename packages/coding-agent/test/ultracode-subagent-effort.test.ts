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
import { afterEach, describe, expect, it, vi } from "bun:test";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { cfgAdvisorEnabled } from "@oh-my-pi/pi-coding-agent/advisor/settings";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { all } from "@oh-my-pi/pi-coding-agent/config/registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { runEvalAgent } from "@oh-my-pi/pi-coding-agent/eval/agent-bridge";
import { runEvalWorkpool } from "@oh-my-pi/pi-coding-agent/eval/workpool-bridge";
import { cfgUltracode } from "@oh-my-pi/pi-coding-agent/modes/settings";
import { AgentLifecycleManager, syncChildUltracodeAtResume } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { CreateAgentSessionOptions, CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession, AgentSessionEvent, PromptOptions } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { cfgCompactionMidTurnEnabled } from "@oh-my-pi/pi-coding-agent/session/context-settings";
import { extractSessionInit, SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import { createIsolatedSettings, createSubagentSettings, runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import { cfgTaskMaxConcurrency } from "@oh-my-pi/pi-coding-agent/task/settings";
import { runStructuredSubagent } from "@oh-my-pi/pi-coding-agent/task/structured-subagent";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import { WorkPoolRegistry } from "@oh-my-pi/pi-coding-agent/task/workpool";
import type { WorkPoolYieldItem } from "@oh-my-pi/pi-coding-agent/task/workpool-yield";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { cfgToolsApprovalMode } from "@oh-my-pi/pi-coding-agent/tools/settings";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { AUTO_THINKING, type ConfiguredThinkingLevel, type TaskEffort } from "@oh-my-pi/pi-tui/thinking";
import { TempDir } from "@oh-my-pi/pi-utils";

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

/**
 * Yields on the first prompt so `runSubprocess` completes without a real loop.
 * `settings` is what `createAgentSession` was handed: the real session owns
 * exactly that object, and the disposers registered on it read it back.
 */
function yieldEmittingSession(settings: Settings | undefined): AgentSession {
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	const disposers: Array<() => void> = [];
	let workPoolYieldItems: readonly WorkPoolYieldItem[] = [];
	const session = {
		settings,
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
	};
	return session as unknown as AgentSession;
}

/** `createAgentSession` stand-in handing back a yielding session that owns the forwarded settings. */
function mockCreateAgentSession() {
	return vi
		.spyOn(sdkModule, "createAgentSession")
		.mockImplementation(async options => createSessionResult(yieldEmittingSession(options?.settings)));
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
}

async function spawn(options: SpawnOptions) {
	const settings = Settings.isolated(
		options.maxEffort === undefined ? undefined : { "task.maxEffort": options.maxEffort },
	);
	if (options.ultracode) cfgUltracode.override(settings, true);
	const pattern = `${options.model.provider}/${options.model.id}`;
	settings.setModelRole("task", options.modelSuffix === undefined ? pattern : `${pattern}:${options.modelSuffix}`);
	const spy = mockCreateAgentSession();
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

	return { result, forwarded: spy.mock.calls[0]?.[0], spy, hasConfiguredAuth, parentSettings: settings };
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
 */
function keptAliveSession(options: CreateAgentSessionOptions | undefined): AgentSession {
	const settings = options?.settings;
	const sessionManager = options?.sessionManager;
	if (!settings || !sessionManager) throw new Error("Expected settings and a session manager to ride in");
	const base = yieldEmittingSession(settings);
	const session = {
		...base,
		sessionManager,
		prompt: async (text: string, promptOptions?: PromptOptions) => {
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
			if (cfgUltracode.get(settings)) cfgUltracode.override(settings, false);
		},
		// FULL_LADDER has an xhigh rung and no ceiling below it: the pin always lands.
		ultracodePinRefusal: () => undefined,
		repinUltracodeIfArmed: () => true,
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

	/** Spawns a kept-alive medium-level child of a registered parent through the real runSubprocess. */
	async function spawnKeptAlive(id: string, armed: boolean) {
		const dir = TempDir.createSync("@pi-ultracode-warm-revive-");
		tempDirs.push(dir);
		const parentSettings = Settings.isolated();
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
		const spy = vi.spyOn(sdkModule, "createAgentSession").mockImplementationOnce(async options => {
			child = keptAliveSession(options);
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
			thinkingLevel: ThinkingLevel.Medium,
			artifactsDir: dir.path(),
			keepAlive: true,
			parentAgentId: REVIVE_PARENT_ID,
		});
		expect(result.exitCode).toBe(0);
		if (!child) throw new Error("Expected the spawn to create a session");
		expect(AgentLifecycleManager.global().has(id)).toBe(true);
		return { child, spawned: spy.mock.calls[0]?.[0], parentSettings };
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
});

// A cold revive (new process, parent's live settings gone) rebuilds an armed
// child from the LATEST session_init. The session appends a newer one whenever
// a model call's base prompt or work-pool items change, spreading the
// extracted init (AgentSession #recordModelCallSystemPrompt) — so extraction
// must carry the ultracode stamp and its restore level, or the first re-record
// silently drops the pin from the persisted contract.
describe("session_init carries the ultracode stamp across re-records", () => {
	const contract = { systemPrompt: ["base"], task: "do work", tools: ["read", "yield"] };

	it("round-trips the flag and restore level through a newer re-recorded session_init", () => {
		const manager = SessionManager.inMemory("/tmp");
		manager.appendSessionInit({ ...contract, ultracode: true, ultracodeRestoreLevel: ThinkingLevel.Medium });
		const init = extractSessionInit(manager.getEntries());
		expect(init?.ultracode).toBe(true);
		expect(init?.ultracodeRestoreLevel).toBe(ThinkingLevel.Medium);
		if (!init) throw new Error("Expected a session_init");

		// Exactly the re-record's spread on a base-prompt change.
		manager.appendSessionInit({ ...init, systemPrompt: ["rebuilt base"], workPoolYieldItems: undefined });
		const latest = extractSessionInit(manager.getEntries());
		expect(latest?.systemPrompt).toEqual(["rebuilt base"]);
		expect(latest?.ultracode).toBe(true);
		expect(latest?.ultracodeRestoreLevel).toBe(ThinkingLevel.Medium);
	});

	it("extracts an unarmed init without the ultracode fields", () => {
		const manager = SessionManager.inMemory("/tmp");
		manager.appendSessionInit(contract);
		const init = extractSessionInit(manager.getEntries());
		if (!init) throw new Error("Expected a session_init");
		expect("ultracode" in init).toBe(false);
		expect("ultracodeRestoreLevel" in init).toBe(false);
	});
});
