/**
 * Ultracode's xhigh pin across the places a turn swaps models on its own.
 *
 * test/ultracode-turn-effort.test.ts covers arming, disarming and the re-pin
 * itself. This file covers three consumers that must reason about the pin
 * instead of the selector they were handed:
 *
 * - Retry fallback (`TurnRecovery#isNoOpRetryFallback`). While a turn is
 *   armed, `applyRetryFallbackCandidate` re-pins xhigh over the chain entry's
 *   `:level`. A chain entry that resolves to the model already running at
 *   xhigh therefore changes nothing; counting it as a switch resets the retry
 *   budget and re-sends the same failing request forever. The entry here is a
 *   FUZZY alias (`openrouter/claude-fable-5:high`): a same-string selector is
 *   skipped earlier by cooldown suppression and would pass without the fix.
 *
 * - Fireworks Fast→Standard degrade (`TurnRecovery#tryFireworksFastFallback`).
 *   The swap onto the base must re-pin xhigh like every other fallback, and a
 *   base without an xhigh rung is refused with one warning per turn instead of
 *   carrying the turn on at another effort.
 *
 * - Prewalk hand-off (`PrewalkCoordinator#userThinkingLevel`). An armed turn
 *   reports the borrowed xhigh as the live selector. The hand-off record must
 *   keep the level the user owns, or /new compares against xhigh once the turn
 *   hands the level back and skips the planning-model restore. A prewalk onto
 *   a model without an xhigh rung is refused loudly rather than carrying the
 *   turn on at some other effort, and records no hand-off at all.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentTurnEndContext } from "@oh-my-pi/pi-agent-core";
import { Effort, type Model } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { type GeneratedProvider, getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgUltracode } from "@oh-my-pi/pi-coding-agent/modes/settings";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { PrewalkCoordinator, type PrewalkCoordinatorHost } from "@oh-my-pi/pi-coding-agent/session/prewalk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { AUTO_THINKING, type ConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { TempDir } from "@oh-my-pi/pi-utils";
import { mockSchedulerWaitWithClock } from "./helpers/mock-scheduler-clock";

function bundled(provider: GeneratedProvider, id: string): Model {
	const model: Model | undefined = getBundledModel(provider, id);
	if (!model) throw new Error(`Expected bundled model ${provider}/${id}`);
	return model;
}

describe("retry fallback under an armed turn", () => {
	// Request number that finally succeeds. A regressed no-op detector loops on
	// the failing route; the cap turns that into a request count, not a hang.
	const SUCCEED_AT_REQUEST = 12;
	const MAX_RETRIES = 2;

	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-ultracode-recovery-");
		await initTheme();
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.keys.setRuntime("openrouter", "openrouter-test-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		vi.restoreAllMocks();
	});

	async function failOnRoute(text: string) {
		const primary = bundled("openrouter", "anthropic/claude-fable-5");
		const mock = createMockModel();
		const requests: string[] = [];
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: { model: primary, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (model, context, options) => {
				requests.push(`${model.provider}/${model.id}:${options?.reasoning ?? "none"}`);
				if (requests.length >= SUCCEED_AT_REQUEST) mock.push({ content: ["ok"] });
				else mock.push({ throw: "500 upstream is unwell" });
				return mock.stream(model, context, options);
			},
		});
		// Fuzzy alias: a different selector string that resolves to the primary.
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": MAX_RETRIES,
			"retry.fallbackChains": {
				[`${primary.provider}/${primary.id}`]: ["openrouter/claude-fable-5:high"],
			},
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			thinkingLevel: Effort.Low,
		});
		const fallbacks: Extract<AgentSessionEvent, { type: "retry_fallback_applied" }>[] = [];
		session.subscribe(event => {
			if (event.type === "retry_fallback_applied") fallbacks.push(event);
		});
		mockSchedulerWaitWithClock();
		await session.prompt(text);
		await session.waitForIdle();
		return { session, settings, requests, fallbacks };
	}

	it("treats a same-model chain entry as no switch while the turn is pinned at xhigh", async () => {
		// Guards the retry-budget reset loop: without the armed branch, the
		// `:high` alias counts as a switch every time, re-pins xhigh, resets the
		// budget and re-sends the identical request until the cap stops it.
		const run = await failOnRoute("ultracode fail on a route");

		expect(cfgUltracode.get(run.settings)).toBe(true);
		expect(run.requests.length).toBeGreaterThanOrEqual(1);
		expect(run.requests.length).toBeLessThanOrEqual(1 + MAX_RETRIES);
		expect(run.requests).toEqual(run.requests.map(() => "openrouter/anthropic/claude-fable-5:xhigh"));
		expect(run.fallbacks).toEqual([]);
	});

	it("still applies the alias as one real low-to-high switch when the turn is not armed", async () => {
		// Guards against the armed branch leaking into ordinary turns: an
		// unarmed low session must still take the `:high` entry exactly once.
		const run = await failOnRoute("fail on a route");

		expect(cfgUltracode.get(run.settings)).toBe(false);
		expect(run.requests).toEqual([
			"openrouter/anthropic/claude-fable-5:low",
			"openrouter/anthropic/claude-fable-5:high",
			"openrouter/anthropic/claude-fable-5:high",
		]);
		expect(run.fallbacks.map(event => [event.from, event.to])).toEqual([
			["openrouter/anthropic/claude-fable-5:low", "openrouter/claude-fable-5:high"],
		]);
	});
});

describe("Fireworks fast→base degrade under an armed turn", () => {
	// The bundled Fast variants and their bases have no xhigh rung, so a session
	// on them can never arm. These tests give the rung back through a
	// `modelOverrides` file, which is how a user-edited catalog would expose it.
	const XHIGH_LADDER = [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max];
	const NO_XHIGH_LADDER = [Effort.Low, Effort.Medium, Effort.High, Effort.Max];
	const FAST_ID = "glm-5.2-fast";
	const BASE_ID = "glm-5.2";
	// Request number that finally succeeds, so a regression is a count, not a hang.
	const SUCCEED_AT_REQUEST = 12;
	const MAX_RETRIES = 2;

	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-ultracode-fireworks-");
		await initTheme();
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.keys.setRuntime("fireworks", "fireworks-test-key");
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		vi.restoreAllMocks();
	});

	/**
	 * `keyword`: the root arms through the prompt, pinning the Fast model at
	 * xhigh first. `inherited`: a task child's settings snapshot carries the
	 * flag without the child ever arming, so it still runs at its own level
	 * (low) and only the post-swap re-pin can lift it; the agent-level prompt
	 * keeps the session's keyword-free disarm from clearing that flag.
	 */
	async function degradeFromFast(baseEfforts: Effort[], baseAnswers: boolean, arm: "keyword" | "inherited") {
		const modelsPath = path.join(tempDir.path(), `models-${baseEfforts.join("-")}.json`);
		await Bun.write(
			modelsPath,
			JSON.stringify({
				providers: {
					fireworks: {
						modelOverrides: {
							[FAST_ID]: { thinking: { mode: "effort", efforts: XHIGH_LADDER } },
							[BASE_ID]: { thinking: { mode: "effort", efforts: baseEfforts } },
						},
					},
				},
			}),
		);
		const modelRegistry = new ModelRegistry(authStorage, modelsPath);
		const fast = modelRegistry.find("fireworks", FAST_ID);
		const base = modelRegistry.find("fireworks", BASE_ID);
		if (!fast || !base) throw new Error("Expected the overridden Fireworks models to resolve");
		expect(fast.thinking?.efforts).toEqual(XHIGH_LADDER);
		expect(base.thinking?.efforts).toEqual(baseEfforts);

		const mock = createMockModel();
		const requests: string[] = [];
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: { model: fast, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (model, context, options) => {
				requests.push(`${model.provider}/${model.id}:${options?.reasoning ?? "none"}`);
				const answer = requests.length >= SUCCEED_AT_REQUEST || (baseAnswers && model.id === BASE_ID);
				mock.push(answer ? { content: ["ok"] } : { throw: "500 upstream is unwell" });
				return mock.stream(model, context, options);
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": MAX_RETRIES,
			ultracode: arm === "inherited",
		});
		settings.setModelRole("default", `fireworks/${FAST_ID}`);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			thinkingLevel: Effort.Low,
		});
		const fallbacks: Extract<AgentSessionEvent, { type: "retry_fallback_applied" }>[] = [];
		const warnings: Extract<AgentSessionEvent, { type: "notice" }>[] = [];
		session.subscribe(event => {
			if (event.type === "retry_fallback_applied") fallbacks.push(event);
			if (event.type === "notice" && event.level === "warning") warnings.push(event);
		});
		mockSchedulerWaitWithClock();
		if (arm === "keyword") await session.prompt("ultracode degrade off Fast");
		else await session.agent.prompt("degrade off Fast");
		await session.waitForIdle();
		return { session, settings, requests, fallbacks, warnings };
	}

	it("re-pins exactly xhigh on the Standard base when an inherited flag degrades off Fast", async () => {
		// Guards the missing re-pin after the swap: a child running on the flag
		// it inherited would carry its own low level onto the base and answer the
		// ultracode turn below xhigh. (A keyword-armed root already sits at xhigh
		// and `agent.setModel` keeps it, so only this path exposes the re-pin.)
		const run = await degradeFromFast(XHIGH_LADDER, true, "inherited");

		expect(cfgUltracode.get(run.settings)).toBe(true);
		expect(run.fallbacks.map(event => [event.role, event.to])).toEqual([["fireworks-fast", `fireworks/${BASE_ID}`]]);
		expect(run.requests).toEqual([`fireworks/${FAST_ID}:low`, `fireworks/${BASE_ID}:xhigh`]);
		expect(run.session.thinkingLevel).toBe(Effort.XHigh);
		expect(run.warnings).toEqual([]);
	});

	it("refuses a Standard base without an xhigh rung and says so once per turn", async () => {
		// Guards the silent clamp: degrading onto a base that cannot take xhigh
		// would carry the armed turn on at another effort. Every failed request
		// re-enters the degrade; the refusal notice must not repeat for each.
		// The request COUNT is deliberately not pinned: a degrade that declines
		// while the error stays retryable restarts the retry saga (upstream also
		// does this for a keyless base), so the success cap is what ends the turn.
		const run = await degradeFromFast(NO_XHIGH_LADDER, false, "keyword");

		expect(cfgUltracode.get(run.settings)).toBe(true);
		expect(run.fallbacks).toEqual([]);
		expect(run.requests.length).toBeGreaterThanOrEqual(2);
		expect(run.requests).toEqual(run.requests.map(() => `fireworks/${FAST_ID}:xhigh`));
		expect(run.warnings.map(notice => [notice.source, notice.message])).toEqual([
			[
				"ultracode",
				`ultracode: no fallback — every candidate lacks an xhigh rung (fireworks/${BASE_ID}); staying on the current model`,
			],
		]);
	});
});

describe("prewalk hand-off under an armed turn", () => {
	const planning = bundled("anthropic", "claude-sonnet-4-5");
	const xhighTarget = bundled("anthropic", "claude-opus-4-5");
	const noXhighTarget = bundled("anthropic", "claude-opus-4-6");

	const editTurnEnd = {
		message: { role: "assistant" },
		toolResults: [{ role: "toolResult", toolName: "edit", isError: false }],
	} as unknown as AgentTurnEndContext;

	function armedHost() {
		const state = {
			model: planning as Model,
			armed: true,
			// The turn's borrowed pin, as the live selector reports it.
			configured: Effort.XHigh as ConfiguredThinkingLevel | undefined,
			// The level the user had before the keyword.
			user: AUTO_THINKING as ConfiguredThinkingLevel | undefined,
		};
		const swaps: Array<[string, ConfiguredThinkingLevel | undefined, { ephemeral?: boolean } | undefined]> = [];
		const restores: Array<ConfiguredThinkingLevel | undefined> = [];
		const notices: Array<{ level: "info" | "warning" | "error"; message: string; source?: string }> = [];
		const host: PrewalkCoordinatorHost = {
			agent: {
				steer: () => {},
				state: { messages: [] },
				replaceMessages: () => {},
				peekSteeringQueue: () => [],
				replaceQueue: () => {},
			} as unknown as PrewalkCoordinatorHost["agent"],
			sessionManager: {} as PrewalkCoordinatorHost["sessionManager"],
			settings: Settings.isolated({}),
			model: () => state.model,
			configuredThinkingLevel: () => state.configured,
			userConfiguredThinkingLevel: () => state.user,
			restoreThinkingLevel: level => {
				restores.push(level);
			},
			resolveDefaultPrewalk: () => undefined,
			ultracodeArmed: () => state.armed,
			emitNotice: (level, message, source) => {
				notices.push({ level, message, source });
			},
			setModelTemporary: async (model, level, options) => {
				swaps.push([`${model.provider}/${model.id}`, level, options]);
				// The session re-pins xhigh after the swap, so `configured` stays put.
				state.model = model;
			},
			setActiveToolsByName: async () => {},
			restoreNonMCPToolPresentation: async () => {},
			getActiveToolNames: () => [],
			getEnabledToolNames: () => [],
			getMountedXdevToolNames: () => [],
			hasBuiltInTool: () => false,
			getPlanModeState: () => undefined,
			setPlanModeState: () => {},
			getPlanReferencePath: () => "",
			setPlanProposalHandler: () => {},
			waitForSessionMessagePersistence: async () => {},
			localProtocolOptions: () => ({}),
		};
		// Turn end: ultracode hands the user's level back.
		const disarm = () => {
			state.armed = false;
			state.configured = state.user;
		};
		return { host, swaps, restores, notices, disarm };
	}

	it("records the user's level, so /new restores the planning model at it after the turn", async () => {
		// Guards the borrowed-xhigh capture: recording the live selector would
		// store xhigh as the target's level, so once the turn hands "auto" back
		// /new sees a mismatch and leaves the user on the prewalk target.
		const t = armedHost();
		const coordinator = new PrewalkCoordinator(t.host, {
			prewalk: { target: xhighTarget, thinkingLevel: Effort.Medium },
		});

		await coordinator.advanceAtTurnEnd([], editTurnEnd);
		expect(t.swaps).toEqual([["anthropic/claude-opus-4-5", Effort.Medium, { ephemeral: true }]]);

		t.disarm();
		await coordinator.resetForNewSession(true);

		expect(t.swaps).toEqual([
			["anthropic/claude-opus-4-5", Effort.Medium, { ephemeral: true }],
			["anthropic/claude-sonnet-4-5", AUTO_THINKING, { ephemeral: true }],
		]);
		expect(t.restores).toEqual([AUTO_THINKING]);
	});

	it("cancels a prewalk onto a target without an xhigh rung and records no hand-off", async () => {
		// Guards the silent clamp: an armed turn handed to a model that cannot
		// take xhigh would run on at another effort under the ultracode name.
		// The refusal must also leave nothing for /new to "restore".
		const t = armedHost();
		const coordinator = new PrewalkCoordinator(t.host, {
			prewalk: { target: noXhighTarget, thinkingLevel: Effort.Medium },
		});

		await coordinator.advanceAtTurnEnd([], editTurnEnd);

		expect(t.swaps).toEqual([]);
		const warnings = t.notices.filter(notice => notice.level === "warning");
		expect(warnings).toHaveLength(1);
		expect(warnings[0]?.source).toBe("prewalk");
		expect(warnings[0]?.message).toStartWith(
			"Prewalk cancelled: ultracode requires xhigh; anthropic/claude-opus-4-6 exposes [",
		);

		t.disarm();
		await coordinator.resetForNewSession(true);

		expect(t.swaps).toEqual([]);
		expect(t.restores).toEqual([]);
	});
});
