/**
 * Ultracode's xhigh pin across the places a turn swaps models on its own.
 *
 * test/ultracode-turn-effort.test.ts covers arming, disarming and the re-pin
 * itself. This file covers the consumers that must reason about the pin
 * instead of the selector they were handed, mostly through a real
 * AgentSession so the session's own host wiring is exercised too:
 *
 * - Retry fallback (`TurnRecovery`). While a turn is armed,
 *   `applyRetryFallbackCandidate` re-pins xhigh over the chain entry's
 *   `:level`, and every walk (error chain, usage-aware preflight) admits only
 *   candidates with an xhigh rung, warning once per turn when none qualifies.
 *   A chain entry that resolves to the model already pinned changes nothing:
 *   counting it as a switch resets the retry budget and re-sends the same
 *   failing request forever (the FUZZY alias `openrouter/claude-fable-5:high`
 *   matters: a same-string selector is skipped earlier by cooldown suppression).
 *
 * - Cooldown restore of the primary. An armed turn reverts only onto a primary
 *   that can pin (otherwise one warning and the revert waits for an unarmed
 *   turn), compares the USER-owned level and re-bases the hand-back.
 *
 * - Fireworks Fast→Standard degrade (`TurnRecovery#tryFireworksFastFallback`).
 *   Re-pins like every other fallback; a base without the rung is refused.
 *
 * - Prewalk and plan-yolo. The no-op check and the hand-off record use the
 *   level the user owns, never the borrowed xhigh; a hand-off onto a model
 *   without the rung is refused loudly; an internal swap that carries its own
 *   level re-bases the hand-back to it (`ModelControls.rebaseUltracodeRestore`).
 *
 * - The thinking receipt, and a session born armed: the hand-back level and
 *   ceiling it would have had unpinned.
 *
 * - Auxiliary surfaces under an armed turn: advisors (fallback pick, primary
 *   restore, context promotion), main-session context promotion and the
 *   security scan session.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool, type AgentTurnEndContext } from "@oh-my-pi/pi-agent-core";
import { type AssistantMessage, Effort, type Model } from "@oh-my-pi/pi-ai";
import { unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import {
	createMockModel,
	type MockModel,
	type MockResponse,
	type MockResponseSource,
	registerMockApi,
} from "@oh-my-pi/pi-ai/providers/mock";
import { type GeneratedProvider, getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { resolveLocalUrlToPath } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { cfgUltracode } from "@oh-my-pi/pi-coding-agent/modes/settings";
import { SecurityCoordinator } from "@oh-my-pi/pi-coding-agent/security/coordinator";
import type { SecurityGitAdapter } from "@oh-my-pi/pi-coding-agent/security/preflight";
import { SecurityStore } from "@oh-my-pi/pi-coding-agent/security/store";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { PlanYolo, Prewalk } from "@oh-my-pi/pi-coding-agent/session/agent-session-types";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { ModelControls, type ModelControlsHost } from "@oh-my-pi/pi-coding-agent/session/model-controls";
import { PrewalkCoordinator, type PrewalkCoordinatorHost } from "@oh-my-pi/pi-coding-agent/session/prewalk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { AUTO_THINKING, type ConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";
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

	/**
	 * One prompt on openrouter fable-5 (xhigh-capable) at low that keeps failing
	 * with a retryable 500, with `chain` as the primary's fallback chain. The
	 * default chain is a FUZZY alias of the primary itself. `answersOn` names a
	 * model id that answers at once; otherwise only the request cap succeeds.
	 */
	async function failOnRoute(text: string, chain = ["openrouter/claude-fable-5:high"], answersOn?: string) {
		const primary = bundled("openrouter", "anthropic/claude-fable-5");
		const mock = createMockModel();
		const requests: string[] = [];
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: { model: primary, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (model, context, options) => {
				requests.push(`${model.provider}/${model.id}:${options?.reasoning ?? "none"}`);
				if (requests.length >= SUCCEED_AT_REQUEST || model.id === answersOn) mock.push({ content: ["ok"] });
				else mock.push({ throw: "500 upstream is unwell" });
				return mock.stream(model, context, options);
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": MAX_RETRIES,
			"retry.fallbackChains": { [`${primary.provider}/${primary.id}`]: chain },
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			thinkingLevel: Effort.Low,
		});
		const fallbacks: Extract<AgentSessionEvent, { type: "retry_fallback_applied" }>[] = [];
		const warnings: Array<[string | undefined, string]> = [];
		session.subscribe(event => {
			if (event.type === "retry_fallback_applied") fallbacks.push(event);
			if (event.type === "notice" && event.level === "warning") warnings.push([event.source, event.message]);
		});
		mockSchedulerWaitWithClock();
		await session.prompt(text);
		await session.waitForIdle();
		return { session, settings, requests, fallbacks, warnings };
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

	it("re-pins exactly xhigh when an armed turn falls back onto another model's `:high` entry", async () => {
		// Guards the re-pin after a real chain swap: applying the entry's own
		// `:high` would run the rest of the armed turn below xhigh with the flag
		// still up and no notice, the silent clamp ultracode forbids.
		const run = await failOnRoute(
			"ultracode fail on a route",
			["openrouter/anthropic/claude-opus-5.5:high"],
			"anthropic/claude-opus-5.5",
		);

		expect(cfgUltracode.get(run.settings)).toBe(true);
		expect(run.fallbacks.map(event => event.to)).toEqual(["openrouter/anthropic/claude-opus-5.5:high"]);
		expect(run.requests.at(-1)).toBe("openrouter/anthropic/claude-opus-5.5:xhigh");
		expect(run.session.thinkingLevel).toBe(Effort.XHigh);
		expect(run.warnings).toEqual([]);
	});

	it("never requests a chain entry without an xhigh rung, and says so exactly once", async () => {
		// Guards the chain walk's admit filter: a candidate that cannot pin
		// xhigh is skipped before the swap, and the refusal is announced once
		// per turn even though every failed request walks the chain again.
		const run = await failOnRoute(
			"ultracode fail on a route",
			["openrouter/anthropic/claude-opus-4.6:high"],
			"anthropic/claude-opus-4.6",
		);

		expect(cfgUltracode.get(run.settings)).toBe(true);
		expect(run.fallbacks).toEqual([]);
		expect(run.requests.length).toBeGreaterThanOrEqual(2);
		expect(run.requests).toEqual(run.requests.map(() => "openrouter/anthropic/claude-fable-5:xhigh"));
		expect(run.warnings).toEqual([
			[
				"ultracode",
				"ultracode: no fallback — every candidate lacks an xhigh rung (openrouter/anthropic/claude-opus-4.6); staying on the current model",
			],
		]);
	});

	it("skips a candidate without an xhigh rung in the usage-aware walk", async () => {
		// Guards the usage-aware preflight's admit filter: with the primary's
		// quota depleted, the walk must pass over the no-xhigh entry and land on
		// the next one that can carry the pin, instead of picking the first.
		const primary = bundled("openrouter", "anthropic/claude-fable-5");
		const mock = createMockModel({ handler: { content: ["ok"] } });
		const requests: string[] = [];
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: { model: primary, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (model, context, options) => {
				requests.push(`${model.provider}/${model.id}:${options?.reasoning ?? "none"}`);
				return mock.stream(model, context, options);
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.usageAwareFallback": true,
			"retry.usageReservePolicy": "auto",
			"retry.fallbackChains": {
				[`${primary.provider}/${primary.id}`]: [
					"openrouter/anthropic/claude-opus-4.6",
					"openrouter/anthropic/claude-opus-5.5",
				],
			},
		});
		vi.spyOn(modelRegistry.authStorage.health, "model").mockImplementation(async (_provider, options) =>
			options.modelId === primary.id ? { state: "depleted", accounts: [] } : { state: "healthy", accounts: [] },
		);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			thinkingLevel: Effort.Low,
		});
		const warnings: string[] = [];
		session.subscribe(event => {
			if (event.type === "notice" && event.level === "warning") warnings.push(event.message);
		});

		await session.prompt("ultracode keep working");
		await session.waitForIdle();

		expect(cfgUltracode.get(settings)).toBe(true);
		expect(requests).toEqual(["openrouter/anthropic/claude-opus-5.5:xhigh"]);
		expect(warnings).toEqual([]);
	});
});

describe("cooldown restore of the primary under an armed turn", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-ultracode-restore-");
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

	/**
	 * Turn 1 (unarmed, at medium): the primary fails once and the session falls
	 * back onto `fallbackEntry`. Then the clock jumps past the fallback cooldown
	 * (default revert policy `cooldown-expiry`), so the next dispatch tries to
	 * revert. `requests` is reset after turn 1 and tagged with the turn number.
	 */
	async function onFallbackAfterCooldown(primaryId: string, fallbackEntry: string) {
		const primary = bundled("openrouter", primaryId);
		const mock = createMockModel();
		let turn = 1;
		const requests: string[] = [];
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: { model: primary, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (model, context, options) => {
				requests.push(`t${turn} ${model.id}:${options?.reasoning ?? "none"}`);
				mock.push(
					turn === 1 && model.id === primary.id ? { throw: "500 upstream is unwell" } : { content: ["ok"] },
				);
				return mock.stream(model, context, options);
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 2,
			"retry.fallbackChains": { [`${primary.provider}/${primary.id}`]: [fallbackEntry] },
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			thinkingLevel: Effort.Medium,
		});
		const warnings: Array<[string | undefined, string]> = [];
		session.subscribe(event => {
			if (event.type === "notice" && event.level === "warning") warnings.push([event.source, event.message]);
		});
		mockSchedulerWaitWithClock();
		const live = session;
		await live.prompt("first turn");
		await live.waitForIdle();
		expect(live.model?.id).not.toBe(primary.id);
		const realNow = Date.now.bind(Date);
		vi.spyOn(Date, "now").mockImplementation(() => realNow() + 60 * 60_000);
		requests.length = 0;
		const next = async (text: string) => {
			turn++;
			await live.prompt(text);
			await live.waitForIdle();
		};
		return { session: live, settings, requests, warnings, next };
	}

	it("defers the revert onto a primary without an xhigh rung until the turn is unarmed, and says so once", async () => {
		// Guards the silent clamp on the revert path: reverting an armed turn onto
		// a primary that cannot pin would send it at the user's level with the
		// flag up and no notice. The fallback keeps the turn at xhigh instead,
		// and the next keyword-free turn performs the revert.
		const run = await onFallbackAfterCooldown("anthropic/claude-sonnet-4.6", "openrouter/anthropic/claude-fable-5");

		await run.next("ultracode second turn");
		expect(run.requests).toEqual(["t2 anthropic/claude-fable-5:xhigh"]);
		expect(cfgUltracode.get(run.settings)).toBe(true);
		expect(run.warnings).toEqual([
			[
				"ultracode",
				"ultracode: primary restore deferred — openrouter/anthropic/claude-sonnet-4.6 lacks an xhigh rung (minimal, low, medium, high); this turn stays on openrouter/anthropic/claude-fable-5 and the primary returns once the ultracode turn ends",
			],
		]);

		await run.next("third turn");
		expect(run.requests.at(-1)).toBe("t3 anthropic/claude-sonnet-4.6:medium");
		expect(cfgUltracode.get(run.settings)).toBe(false);
		expect(run.warnings).toHaveLength(1);
	});

	it("hands the user's own level back after an armed turn reverts off a `:level` fallback", async () => {
		// Guards the revert's level bookkeeping under a pin: the arm on the
		// fallback captured the fallback's `:low` as the user's level, and
		// comparing the live xhigh against it handed `low` back for good. The
		// revert must compare the user-owned level and re-base the hand-back.
		const run = await onFallbackAfterCooldown(
			"anthropic/claude-fable-5.1",
			"openrouter/anthropic/claude-fable-5:low",
		);

		await run.next("ultracode second turn");
		expect(run.requests).toEqual(["t2 anthropic/claude-fable-5.1:xhigh"]);
		expect(run.session.userConfiguredThinkingLevel()).toBe(Effort.Medium);

		await run.next("third turn");
		expect(run.requests.at(-1)).toBe("t3 anthropic/claude-fable-5.1:medium");
		expect(run.session.configuredThinkingLevel()).toBe(Effort.Medium);
		expect(run.warnings).toEqual([]);
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
				// The session re-pins xhigh after the swap, so `configured` stays put,
				// and a swap that carries its own level re-bases the hand-back to it
				// (ModelControls.rebaseUltracodeRestore): that is the user's level now.
				state.model = model;
				if (state.armed && level !== undefined) state.user = level;
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
		// store xhigh as the planning model's level, so /new would restore it at
		// the borrowed xhigh, and as the target's level, so once the turn hands
		// the hand-off's own `medium` back /new would see a mismatch and leave the
		// user on the prewalk target.
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

describe("prewalk and plan-yolo on a real armed session", () => {
	// The coordinator above runs against a hand-built host. These drive the
	// real AgentSession host (its optional `ultracodeArmed` and
	// `userConfiguredThinkingLevel` members included) and the real
	// ModelControls, so the hand-back re-base is observed end to end.
	const planning = bundled("anthropic", "claude-sonnet-4-5");
	const xhighTarget = bundled("anthropic", "claude-opus-4-5");
	const noXhighTarget = bundled("anthropic", "claude-opus-4-6");
	const noArgs = type({});

	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	beforeAll(() => {
		tempDir = TempDir.createSync("@pi-ultracode-prewalk-");
		authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("anthropic", "test-key");
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

	function stubTool(name: string): AgentTool {
		const tool: AgentTool<typeof noArgs, undefined> = {
			name,
			label: name,
			description: name,
			parameters: noArgs,
			async execute() {
				return { content: [{ type: "text", text: "ok" }], details: undefined };
			},
		};
		return tool as AgentTool;
	}

	function toolCall(id: string, name: string): MockResponse {
		return { content: [{ type: "toolCall", id, name, arguments: {} }], stopReason: "toolUse" };
	}

	/** A planning session on claude-sonnet-4-5; `requests` are `<model id>:<reasoning>`. */
	function createSession(
		responses: MockResponse[],
		options: { level: Effort; prewalk?: Prewalk; planYolo?: PlanYolo },
	) {
		const todo = stubTool("todo");
		const write = stubTool("write");
		const read = stubTool("read");
		const mock = createMockModel({ responses, handler: { content: ["ok"] } });
		const requests: string[] = [];
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model: planning,
				systemPrompt: ["Test"],
				tools: options.planYolo ? [read] : [todo, write],
				messages: [],
			},
			streamFn: (model, context, streamOptions) => {
				requests.push(`${model.id}:${streamOptions?.reasoning ?? "none"}`);
				return mock.stream(model, context, streamOptions);
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.enabled": false,
			"prewalk.enabled": true,
		});
		const live = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings,
			modelRegistry,
			toolRegistry: new Map<string, AgentTool>([
				["todo", todo],
				["write", write],
				["read", read],
			]),
			builtInToolNames: options.planYolo ? ["read", "write"] : undefined,
			thinkingLevel: options.level,
			prewalk: options.prewalk,
			planYolo: options.planYolo,
		});
		session = live;
		const notices: Array<[string, string | undefined, string]> = [];
		live.subscribe(event => {
			if (event.type === "notice") notices.push([event.level, event.source, event.message]);
		});
		return { session: live, settings, requests, notices };
	}

	/** Write the plan file and run plan-yolo's approval through the session's real proposal handler. */
	async function approvePlanYolo(live: AgentSession) {
		const planPath = resolveLocalUrlToPath("local://demo-plan.md", {
			getArtifactsDir: () => live.sessionManager.getArtifactsDir(),
			getSessionId: () => live.sessionManager.getSessionId(),
		});
		await Bun.write(planPath, "# Demo plan\n\nImplement it.\n");
		const handler = live.peekPlanProposalHandler();
		if (!handler) throw new Error("Expected the plan-yolo proposal handler");
		await handler("demo");
	}

	const buildTurn = () => [toolCall("todo-1", "todo"), toolCall("write-1", "write"), { content: ["done"] }];

	it("hands an armed turn back at the prewalk's own level, and /new still restores the planning model", async () => {
		// Guards the capture-once hand-back: the hand-off applied `low` on the
		// target, which is where the session is without the keyword, so the turn
		// must hand `low` back rather than the planning level. The hand-off
		// record still names the user's own planning level for /new.
		const run = createSession(buildTurn(), {
			level: Effort.High,
			prewalk: { target: xhighTarget, thinkingLevel: Effort.Low },
		});

		await run.session.prompt("ultracode build it");
		expect(run.requests).toEqual(["claude-sonnet-4-5:xhigh", "claude-sonnet-4-5:xhigh", "claude-opus-4-5:xhigh"]);
		expect(run.session.userConfiguredThinkingLevel()).toBe(Effort.Low);

		await run.session.prompt("keep going");
		expect(cfgUltracode.get(run.settings)).toBe(false);
		expect(run.requests.at(-1)).toBe("claude-opus-4-5:low");

		expect(await run.session.newSession()).toBe(true);
		expect(run.session.model?.id).toBe(planning.id);
		expect(run.session.configuredThinkingLevel()).toBe(Effort.High);
	});

	it("cancels a real session's prewalk onto a target without an xhigh rung", async () => {
		// Guards the session's prewalk host wiring of `ultracodeArmed`: without
		// it the coordinator never refuses and the swap lands below xhigh.
		const run = createSession(buildTurn(), {
			level: Effort.High,
			prewalk: { target: noXhighTarget, thinkingLevel: Effort.Low },
		});

		await run.session.prompt("ultracode build it");

		expect(run.requests).toEqual(["claude-sonnet-4-5:xhigh", "claude-sonnet-4-5:xhigh", "claude-sonnet-4-5:xhigh"]);
		expect(run.session.getPrewalkState()).toBeUndefined();
		expect(run.notices.filter(([level]) => level === "warning")).toEqual([
			[
				"warning",
				"prewalk",
				"Prewalk cancelled: ultracode requires xhigh; anthropic/claude-opus-4-6 exposes [low, medium, high, max]",
			],
		]);
	});

	it("keeps a same-model `:xhigh` prewalk armed through an armed first turn, then hands off", async () => {
		// Guards the no-op check against the borrowed level: the live selector
		// reads xhigh mid-turn, so the prewalk looked like it "already matched"
		// and was dropped for good, leaving the user at low after the turn.
		const run = createSession(buildTurn(), {
			level: Effort.Low,
			prewalk: { target: planning, thinkingLevel: Effort.XHigh },
		});

		await run.session.prompt("ultracode build it");
		expect(run.notices.map(([, , message]) => message)).toContain(
			"Prewalk: switched to anthropic/claude-sonnet-4-5 after first write call.",
		);

		await run.session.prompt("keep going");
		expect(cfgUltracode.get(run.settings)).toBe(false);
		expect(run.session.configuredThinkingLevel()).toBe(Effort.XHigh);
		expect(run.requests.at(-1)).toBe("claude-sonnet-4-5:xhigh");
	});

	it("treats a same-model prewalk at the user's own level as a no-op while the turn is pinned", async () => {
		// The other direction: against the borrowed xhigh a `:low` prewalk on
		// the model the user already runs at low looked like a real switch.
		const run = createSession([], { level: Effort.Low });
		vi.spyOn(run.session.agent, "prompt").mockResolvedValue(undefined);
		await run.session.prompt("please ultracode this");
		expect(run.session.thinkingLevel).toBe(Effort.XHigh);

		expect(run.session.armPrewalk(planning, Effort.Low)).toBe(false);
		expect(run.session.getPrewalkState()).toBeUndefined();
		expect(run.notices.at(-1)).toEqual([
			"info",
			"prewalk",
			"Prewalk: target anthropic/claude-sonnet-4-5 already matches the active model and thinking level; nothing to switch.",
		]);
	});

	it("keeps the plan model when plan-yolo approves onto a target without an xhigh rung", async () => {
		// Guards plan-yolo's admit check: the approval stands, but the hand-off
		// onto a model that cannot pin is skipped loudly instead of running the
		// implementation below xhigh under the ultracode name.
		const run = createSession([{ content: ["planning"] }], {
			level: Effort.Medium,
			planYolo: { target: noXhighTarget, thinkingLevel: Effort.Low },
		});
		await run.session.prompt("ultracode make a plan");

		await approvePlanYolo(run.session);

		expect(run.session.model?.id).toBe(planning.id);
		expect(run.session.thinkingLevel).toBe(Effort.XHigh);
		expect(cfgUltracode.get(run.settings)).toBe(true);
		expect(run.notices.filter(([level]) => level === "warning")).toEqual([
			[
				"warning",
				"plan-yolo",
				"Plan-yolo: plan approved, model switch skipped: ultracode requires xhigh; anthropic/claude-opus-4-6 exposes [low, medium, high, max]",
			],
		]);
	});

	it("hands an armed turn back at plan-yolo's own level after the approved hand-off", async () => {
		// Guards the re-base on plan-yolo's explicit-level swap: without it the
		// implementation model inherits the planning level when the turn ends.
		const run = createSession([{ content: ["planning"] }], {
			level: Effort.Medium,
			planYolo: { target: xhighTarget, thinkingLevel: Effort.Low },
		});
		await run.session.prompt("ultracode make a plan");

		await approvePlanYolo(run.session);
		expect(run.session.model?.id).toBe(xhighTarget.id);
		expect(run.session.thinkingLevel).toBe(Effort.XHigh);

		await run.session.prompt("implement it");
		expect(cfgUltracode.get(run.settings)).toBe(false);
		expect(run.session.configuredThinkingLevel()).toBe(Effort.Low);
		expect(run.requests.at(-1)).toBe("claude-opus-4-5:low");
	});
});

describe("the thinking receipt under an armed turn", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	beforeAll(() => {
		tempDir = TempDir.createSync("@pi-ultracode-receipt-");
		authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
	});

	it("records the user's explicit pick of the pinned level, so a resume keeps it", async () => {
		// Guards change detection on the receipt: the pin writes xhigh with the
		// borrowed-FROM `configured: medium`. Picking xhigh changes no level, so
		// without the receipt in the comparison nothing was written and a resume
		// (which prefers `configured`) discarded the user's explicit choice.
		const mock = createMockModel({ handler: { content: ["ok"] } });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model: bundled("anthropic", "claude-opus-4-5"),
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: mock.stream,
		});
		const settings = Settings.isolated({ "compaction.enabled": false });
		const live = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			thinkingLevel: Effort.Medium,
		});
		session = live;

		await live.prompt("ultracode go");
		expect(live.thinkingLevel).toBe(Effort.XHigh);
		expect(live.buildDisplaySessionContext().configuredThinkingLevel).toBe(Effort.Medium);

		live.setThinkingLevel(Effort.XHigh);
		expect(cfgUltracode.get(settings)).toBe(false);
		expect(live.buildDisplaySessionContext().configuredThinkingLevel).toBe(Effort.XHigh);

		await live.prompt("plain turn");
		expect(live.thinkingLevel).toBe(Effort.XHigh);
		expect(live.buildDisplaySessionContext().configuredThinkingLevel).toBe(Effort.XHigh);
	});
});

describe("a session born armed hands back what it would have run at unpinned", () => {
	// openrouter fable-5: low..max with `thinking.defaultLevel: high`.
	const withMax = bundled("openrouter", "anthropic/claude-fable-5");
	// anthropic opus-4-5: minimal..xhigh, no catalog default level.
	const noDefault = bundled("anthropic", "claude-opus-4-5");

	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	beforeAll(() => {
		tempDir = TempDir.createSync("@pi-ultracode-born-armed-");
		authStorage = createInMemoryAuthStorage();
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	/**
	 * Real ModelControls for a child constructed under an armed parent (the
	 * settings flag is up at construction). `disarm` is what the resume-boundary
	 * sync does through `AgentSession.disarmUltracodeTurn`: flag down, hand back.
	 */
	function bornArmed(
		model: Model,
		options: ConstructorParameters<typeof ModelControls>[1],
		overrides: Record<string, unknown> = {},
	) {
		const settings = Settings.isolated({ ultracode: true, ...overrides });
		const host: ModelControlsHost = {
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			settings,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			providerSessionState: new Map(),
			model: () => model,
			sessionId: () => "born-armed",
			promptGeneration: () => 0,
			resolveActiveEditMode: () => "hashline",
			syncAfterModelChange: async () => {},
			setModelWithProviderSessionReset: async () => {},
			clearActiveRetryFallback: () => {},
			clearInheritedProviderPromptCacheKey: () => {},
			magicKeywordEnabled: () => true,
			emit: () => {},
			emitSessionEvent: async () => {},
			emitNotice: () => {},
		};
		const controls = new ModelControls(host, options);
		const disarm = () => {
			cfgUltracode.override(settings, false);
			controls.endUltracodeTurn();
		};
		return { controls, settings, disarm };
	}

	const pinned = { thinkingLevel: Effort.XHigh, thinkingLevelCeiling: Effort.XHigh } as const;

	it("lifts the pin's xhigh ceiling at the hand-back when it would have had none", async () => {
		// Guards the turn-scoped ceiling: a readonly spawn ceiling kept clamping
		// the restored `max` (and every later pick) to xhigh after the disarm.
		const child = bornArmed(withMax, { ...pinned, ultracodeRestoreLevel: Effort.Max, ultracodeRestoreCeiling: null });
		expect(child.controls.getAvailableEffortSelectors()).not.toContain(Effort.Max);

		child.disarm();

		expect(child.controls.thinkingLevel).toBe(Effort.Max);
		expect(child.controls.thinkingLevelCeiling).toBeUndefined();
		expect(child.controls.getAvailableEffortSelectors()).toContain(Effort.Max);
	});

	it("hands back to an unpinned ceiling below xhigh, which a later re-arm then refuses like any capped child", async () => {
		// The child is exactly what it would have been unpinned, so it re-arms
		// under the same rule as a child spawned unarmed with that cap.
		const child = bornArmed(withMax, {
			...pinned,
			ultracodeRestoreLevel: Effort.Max,
			ultracodeRestoreCeiling: Effort.High,
		});

		child.disarm();

		expect(child.controls.thinkingLevelCeiling).toBe(Effort.High);
		expect(child.controls.thinkingLevel).toBe(Effort.High);
		expect(child.controls.ultracodePinRefusal()).toBe("ceiling");
	});

	it("keeps the current ceiling when the unpinned one is unknown", async () => {
		// A legacy transcript carries no restore ceiling: nothing to apply.
		const child = bornArmed(withMax, { ...pinned, ultracodeRestoreLevel: Effort.Max });

		child.disarm();

		expect(child.controls.thinkingLevelCeiling).toBe(Effort.XHigh);
		expect(child.controls.thinkingLevel).toBe(Effort.XHigh);
	});

	it("lifts the ceiling on the user's own off-ramp too, so an explicit max is not clamped", async () => {
		// The session's user-source setThinkingLevel off-ramp: forget the
		// restore, drop the flag, apply the pick.
		const child = bornArmed(withMax, { ...pinned, ultracodeRestoreLevel: Effort.Low, ultracodeRestoreCeiling: null });

		child.controls.forgetUltracodeRestore();
		cfgUltracode.override(child.settings, false);
		child.controls.setThinkingLevel(Effort.Max);

		expect(child.controls.thinkingLevel).toBe(Effort.Max);
	});

	it("cycles on from the pinned xhigh to max, since the effort control lifts the pin's ceiling first", async () => {
		// Guards the cycle off-ramp's ordering: the selector list was taken under
		// the pin's xhigh ceiling, so cycling from the pinned xhigh wrapped to off.
		const child = bornArmed(withMax, { ...pinned, ultracodeRestoreLevel: Effort.Low, ultracodeRestoreCeiling: null });

		expect(child.controls.cycleThinkingLevel()).toBe(Effort.Max);

		expect(child.controls.thinkingLevel).toBe(Effort.Max);
		expect(cfgUltracode.get(child.settings)).toBe(false);
		expect(child.controls.hasPendingUltracodeRestore()).toBe(false);
	});

	it("falls back to the model's default level when born at the pin without a hand-back level", async () => {
		// Guards the borrowed pin becoming the child's own level: with no restore
		// level the disarm kept xhigh and recorded it as the user's choice.
		const child = bornArmed(withMax, pinned, { defaultThinkingLevel: "low" });
		expect(child.controls.userConfiguredThinkingLevel()).toBe(Effort.High);

		child.disarm();

		expect(child.controls.thinkingLevel).toBe(Effort.High);
	});

	it("then to the configured default thinking level", async () => {
		const child = bornArmed(noDefault, pinned, { defaultThinkingLevel: "low" });

		child.disarm();

		expect(child.controls.thinkingLevel).toBe(Effort.Low);
	});

	it("leaves a session born armed but not at the pin with nothing to hand back", async () => {
		// A root whose flag was persisted by hand starts at the user's level:
		// it was never pinned, so the fallback must not invent a hand-back.
		const root = bornArmed(noDefault, { thinkingLevel: Effort.Medium }, { defaultThinkingLevel: "low" });
		expect(root.controls.hasPendingUltracodeRestore()).toBe(false);

		root.disarm();

		expect(root.controls.thinkingLevel).toBe(Effort.Medium);
	});
});

describe("advisors under an armed turn", () => {
	const OVERLOADED = "overloaded_error: provider returned error 503";
	const COOLDOWN_JUMP_MS = 60 * 60_000;

	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-ultracode-advisor-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.keys.setRuntime("anthropic", "anthropic-test-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await session?.dispose();
		session = undefined;
	});

	interface AdvisorRequest {
		model: string;
		effort: string;
		armed: boolean;
	}

	/**
	 * Real session on claude-sonnet-4-5 with one advisor. `failOnce` names the
	 * advisor model whose first request fails with a retryable overload, which
	 * sends the advisor down `retry.fallbackChains.advisor`.
	 */
	function startAdvisorSession(options: {
		advisorRole: string;
		chain: string[];
		failOnce: string;
		settings?: Record<string, unknown>;
	}) {
		const main = bundled("anthropic", "claude-sonnet-4-5");
		const primary = createMockModel({ handler: { content: ["primary complete"] } });
		const advisorMock = createMockModel();
		const requests: AdvisorRequest[] = [];
		let failed = false;
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"advisor.syncBacklog": "1",
			"retry.baseDelayMs": 5,
			"retry.fallbackChains": { advisor: options.chain },
			...options.settings,
		});
		settings.setModelRole("advisor", options.advisorRole);
		const agent = new Agent({
			initialState: { model: main, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: primary.stream,
		});
		const live = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings,
			modelRegistry,
			advisorTools: [],
			advisorStreamFn: (model, context, streamOptions) => {
				requests.push({
					model: model.id,
					effort: streamOptions?.reasoning ?? "none",
					armed: cfgUltracode.get(settings),
				});
				if (model.id === options.failOnce && !failed) {
					failed = true;
					advisorMock.push({ throw: OVERLOADED });
				} else {
					advisorMock.push({ content: ["advisor ok"] });
				}
				return advisorMock.stream(model, context, streamOptions);
			},
		});
		session = live;
		expect(live.setAdvisorEnabled(true)).toBe(true);
		const turn = async (text: string) => {
			await live.prompt(text);
			await live.waitForIdle();
			await live.waitForAdvisorCatchup(5000);
		};
		return { session: live, settings, requests, turn };
	}

	// Guards resyncUltracodeEffort's unarmed branch rewriting
	// `retryFallback.originalThinkingLevel` to the configured level: a fallback
	// taken while armed records the borrowed xhigh as the primary's level, and
	// without the rewrite the cooldown restore hands xhigh back on every later
	// unarmed turn.
	it("restores the advisor primary at its configured level after a fallback taken while armed", async () => {
		const { session, requests, turn } = startAdvisorSession({
			advisorRole: "anthropic/claude-opus-4-5:medium",
			chain: ["anthropic/claude-haiku-4-5"],
			failOnce: "claude-opus-4-5",
		});

		await turn("ultracode first turn");
		expect(requests[0]).toEqual({ model: "claude-opus-4-5", effort: Effort.XHigh, armed: true });
		expect(session.getAdvisorAgent()?.state.model.id).toBe("claude-haiku-4-5");
		await turn("second turn");
		vi.spyOn(Date, "now").mockReturnValue(Date.now() + COOLDOWN_JUMP_MS);
		await turn("third turn after the cooldown");
		await turn("fourth turn");

		const restored = requests.slice(1).filter(request => request.model === "claude-opus-4-5");
		expect(restored.length).toBeGreaterThan(0);
		expect(restored.map(request => request.effort)).toEqual(restored.map(() => Effort.Medium));
		expect(session.getAdvisorAgent()?.state.model.id).toBe("claude-opus-4-5");
		expect(session.getAdvisorAgent()?.state.thinkingLevel).toBe(Effort.Medium);
	});

	// Guards `#recoverAdvisorTurn`'s `if (armed && ultracodePin === undefined)
	// continue;`: while armed, a chain entry without an xhigh rung is skipped,
	// never clamped onto its own ladder.
	it("skips an advisor fallback without an xhigh rung while armed", async () => {
		const { session, requests, turn } = startAdvisorSession({
			advisorRole: "anthropic/claude-opus-4-5:medium",
			chain: ["anthropic/claude-opus-4-6", "anthropic/claude-haiku-4-5"],
			failOnce: "claude-opus-4-5",
		});

		await turn("ultracode first turn");
		await turn("ultracode second turn");

		expect(requests.map(request => request.model)).not.toContain("claude-opus-4-6");
		const fallback = requests.filter(request => request.model === "claude-haiku-4-5");
		expect(fallback.length).toBeGreaterThan(0);
		expect(fallback).toEqual(fallback.map(() => ({ model: "claude-haiku-4-5", effort: Effort.XHigh, armed: true })));
		expect(session.getAdvisorAgent()?.state.model.id).toBe("claude-haiku-4-5");
		expect(session.getAdvisorAgent()?.state.thinkingLevel).toBe(Effort.XHigh);
	});

	// Guards `#recoverAdvisorTurn`'s `ultracodePin ?? selector.thinkingLevel`:
	// a chain entry's `:low` suffix cannot lower the armed turn's xhigh pin.
	it("pins an advisor fallback's `:low` chain entry at xhigh while armed", async () => {
		const { session, requests, turn } = startAdvisorSession({
			advisorRole: "anthropic/claude-opus-4-5:medium",
			chain: ["anthropic/claude-haiku-4-5:low"],
			failOnce: "claude-opus-4-5",
		});

		await turn("ultracode first turn");
		expect(session.getAdvisorAgent()?.state.model.id).toBe("claude-haiku-4-5");
		expect(session.getAdvisorAgent()?.state.thinkingLevel).toBe(Effort.XHigh);
		await turn("ultracode second turn");

		const fallback = requests.filter(request => request.model === "claude-haiku-4-5");
		expect(fallback.length).toBeGreaterThan(0);
		expect(fallback).toEqual(fallback.map(() => ({ model: "claude-haiku-4-5", effort: Effort.XHigh, armed: true })));
	});

	// Guards `#maybeRestoreAdvisorRetryFallbackPrimary`'s `if (armed &&
	// ultracodePin === undefined) return;`: once the cooldown expires during an
	// armed turn, a primary without an xhigh rung is not restored; the advisor
	// stays on its xhigh-capable fallback at xhigh.
	it("keeps an advisor on its xhigh fallback when the cooldown expires during an armed turn", async () => {
		const { session, requests, turn } = startAdvisorSession({
			advisorRole: "anthropic/claude-opus-4-6:medium",
			chain: ["anthropic/claude-haiku-4-5"],
			failOnce: "claude-opus-4-6",
		});

		await turn("first turn");
		await turn("second turn");
		expect(session.getAdvisorAgent()?.state.model.id).toBe("claude-haiku-4-5");
		const before = requests.length;
		vi.spyOn(Date, "now").mockReturnValue(Date.now() + COOLDOWN_JUMP_MS);
		await turn("ultracode turn after the cooldown");

		const armedTurn = requests.slice(before);
		expect(armedTurn.length).toBeGreaterThan(0);
		expect(armedTurn).toEqual(
			armedTurn.map(() => ({ model: "claude-haiku-4-5", effort: Effort.XHigh, armed: true })),
		);
		expect(session.getAdvisorAgent()?.state.model.id).toBe("claude-haiku-4-5");
		expect(session.getAdvisorAgent()?.state.thinkingLevel).toBe(Effort.XHigh);
	});

	/** A session whose advisor role is set but not enabled; prompts arm/disarm without a model call. */
	function idleAdvisorSession(advisorRole: string) {
		const settings = Settings.isolated({ "compaction.enabled": false });
		settings.setModelRole("advisor", advisorRole);
		const live = new AgentSession({
			agent: new Agent({
				initialState: {
					model: bundled("anthropic", "claude-sonnet-4-5"),
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
				},
			}),
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings,
			modelRegistry,
			advisorTools: [],
		});
		session = live;
		vi.spyOn(live.agent, "prompt").mockResolvedValue(undefined);
		const warnings: string[] = [];
		live.subscribe(event => {
			if (event.type === "notice" && event.level === "warning") warnings.push(event.message);
		});
		return { session: live, settings, warnings };
	}

	// Guards the descriptor build's armed branch: an advisor attached during an
	// armed turn is one of the turn's agents and starts at exactly xhigh, not at
	// its configured `:medium`.
	it("builds an advisor attached during an armed turn at exactly xhigh", async () => {
		const run = idleAdvisorSession("anthropic/claude-opus-4-5:medium");
		await run.session.prompt("please ultracode this");
		expect(cfgUltracode.get(run.settings)).toBe(true);

		expect(run.session.setAdvisorEnabled(true)).toBe(true);

		expect(run.session.getAdvisorAgent()?.state.thinkingLevel).toBe(Effort.XHigh);
		expect(run.warnings).toEqual([]);
	});

	// Guards the build's refusal: an advisor whose model has no xhigh rung is
	// skipped with a notice while armed, never built at a clamped level.
	it("skips building an advisor without an xhigh rung during an armed turn, loudly", async () => {
		const run = idleAdvisorSession("anthropic/claude-opus-4-6:medium");
		await run.session.prompt("please ultracode this");

		run.session.setAdvisorEnabled(true);

		expect(run.session.getAdvisorAgent()).toBeUndefined();
		expect(run.warnings).toEqual([
			'Advisor "default" skipped: ultracode requires xhigh; anthropic/claude-opus-4-6 exposes [low, medium, high, max]',
		]);
	});

	// Guards the arm-time resync's refusal: a live advisor that cannot pin is
	// left at its own level with a visible notice instead of a silent clamp.
	it("leaves a live advisor without an xhigh rung at its level when the turn arms, and says so", async () => {
		const run = idleAdvisorSession("anthropic/claude-opus-4-6:medium");
		expect(run.session.setAdvisorEnabled(true)).toBe(true);
		expect(run.session.getAdvisorAgent()?.state.thinkingLevel).toBe(Effort.Medium);

		await run.session.prompt("please ultracode this");

		expect(cfgUltracode.get(run.settings)).toBe(true);
		expect(run.session.getAdvisorAgent()?.state.thinkingLevel).toBe(Effort.Medium);
		expect(run.warnings).toEqual([
			'Advisor "default" left at medium: ultracode requires xhigh; anthropic/claude-opus-4-6 exposes [low, medium, high, max]',
		]);
	});

	// Guards `#promoteAdvisorContextModel`'s armed skip: an overflowing advisor
	// is not promoted onto a `contextPromotionTarget` without an xhigh rung while
	// armed; it stays on its own model at xhigh. A lone usage anchor leaves
	// nothing to summarize, so maintenance re-primes without a network call.
	it("skips advisor context promotion onto a target without an xhigh rung while armed", async () => {
		const active = bundled("anthropic", "claude-opus-4-5");
		const target = { ...bundled("anthropic", "claude-opus-4-6"), contextWindow: 1_000_000 };
		const overflowing = {
			...active,
			contextWindow: 200_000,
			contextPromotionTarget: `${target.provider}/${target.id}`,
		};
		const { session, requests, turn } = startAdvisorSession({
			advisorRole: "anthropic/claude-opus-4-5:medium",
			chain: [],
			failOnce: "none",
			settings: {
				"compaction.enabled": true,
				"compaction.methodOrder": ["soft"],
				"contextPromotion.enabled": true,
			},
		});
		const advisor = session.getAdvisorAgent();
		if (!advisor) throw new Error("Expected advisor agent to be active");
		advisor.setModel(overflowing);
		vi.spyOn(modelRegistry, "getAvailable").mockReturnValue([overflowing, target]);
		const anchor: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "prior advisor output" }],
			api: overflowing.api,
			provider: overflowing.provider,
			model: overflowing.id,
			usage: {
				input: 200,
				output: 150,
				cacheRead: 199_000,
				cacheWrite: 0,
				totalTokens: 199_350,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now() - 1_000,
		};
		advisor.emitExternalEvent({ type: "message_end", message: anchor });

		await turn("ultracode overflowing turn");

		expect(requests.map(request => request.model)).not.toContain(target.id);
		expect(requests.length).toBeGreaterThan(0);
		expect(requests).toEqual(requests.map(() => ({ model: active.id, effort: Effort.XHigh, armed: true })));
		expect(advisor.state.model.id).toBe(active.id);
	});
});

describe("context promotion under an armed turn", () => {
	// ~15k estimated tokens: over the 4000-window primary's threshold, so the
	// pre-prompt check promotes before the request goes out.
	const OVERSIZED_PROMPT = `ultracode ${"lorem ipsum ".repeat(5000)}`;

	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-ultracode-promotion-");
		await initTheme();
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.keys.setRuntime("anthropic", "anthropic-test-key");
		authStorage.keys.setRuntime("openrouter", "openrouter-test-key");
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

	// A 4000-window anthropic/claude-sonnet-4-5 (xhigh rung) whose configured
	// promotion target is `target`, the way models.yml users configure it.
	async function armOversized(target: string) {
		const modelsPath = path.join(tempDir.path(), `promotion-${target.replace(/\W/g, "-")}.json`);
		await Bun.write(
			modelsPath,
			JSON.stringify({
				providers: {
					anthropic: {
						modelOverrides: { "claude-sonnet-4-5": { contextWindow: 4000, contextPromotionTarget: target } },
					},
				},
			}),
		);
		const modelRegistry = new ModelRegistry(authStorage, modelsPath);
		const primary = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!primary) throw new Error("Expected override model to resolve");
		expect(primary.contextWindow).toBe(4000);
		const mock = createMockModel();
		const requests: string[] = [];
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: { model: primary, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (model, context, options) => {
				requests.push(`${model.id}:${options?.reasoning ?? "none"}`);
				mock.push({ content: ["ok"] });
				return mock.stream(model, context, options);
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": true,
			"compaction.methodOrder": ["soft"],
			"compaction.thresholdPercent": 80,
			"compaction.thresholdTokens": -1,
			"contextPromotion.enabled": true,
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			thinkingLevel: Effort.Low,
		});
		const notices: Extract<AgentSessionEvent, { type: "notice" }>[] = [];
		session.subscribe(event => {
			if (event.type === "notice") notices.push(event);
		});
		await session.prompt(OVERSIZED_PROMPT);
		await session.waitForIdle();
		return { session, settings, requests, notices };
	}

	it("refuses a promotion target without an xhigh rung, loudly, and keeps the pinned model", async () => {
		// Guards SessionMaintenance#promoteContextModel's armed-turn gate: swapping
		// onto claude-opus-4-6 (low..max, no xhigh) would carry the ultracode turn
		// on at another effort; the overflow must fall through to compaction.
		const { session, settings, requests, notices } = await armOversized("anthropic/claude-opus-4-6");
		const skipped = notices.filter(n => n.message.startsWith("Context promotion skipped: ultracode requires xhigh"));
		expect(skipped).toHaveLength(1);
		expect(skipped[0]).toMatchObject({ level: "warning", source: "compaction" });
		expect(session.model?.id).toBe("claude-sonnet-4-5");
		expect(requests).toEqual(["claude-sonnet-4-5:xhigh"]);
		expect(cfgUltracode.get(settings)).toBe(true);
	});

	it("promotes onto an xhigh-capable target and keeps the turn at exactly xhigh", async () => {
		// Guards ModelControls.setModelTemporary's re-pin on the promotion swap:
		// openrouter anthropic/claude-opus-5.5 has the rung but a `high` default
		// level, which the swap applies first and must not win over the armed xhigh.
		const target = bundled("openrouter", "anthropic/claude-opus-5.5");
		expect(target.thinking?.defaultLevel).toBe(Effort.High);
		const { session, settings, requests, notices } = await armOversized("openrouter/anthropic/claude-opus-5.5");
		expect(notices.filter(n => n.message.includes("ultracode requires xhigh"))).toHaveLength(0);
		expect(session.model?.id).toBe(target.id);
		expect(requests).toEqual([`${target.id}:xhigh`]);
		expect(cfgUltracode.get(settings)).toBe(true);
	});
});

describe("security scan under an armed turn", () => {
	const MOCK_SOURCE_ID = "ultracode-security-scan";
	const gitAdapter: SecurityGitAdapter = {
		root: async () => repositoryRoot,
		headSha: async () => "a".repeat(40),
		resolveRef: async (_cwd, refName) => (refName === "base" ? "b".repeat(40) : "c".repeat(40)),
		diffTree: async () => "fixture-diff",
		status: async () => "",
		files: async () => ["src/app.ts"],
		untracked: async () => [],
	};
	const PUBLISH_AND_STOP: MockResponseSource = [
		{
			content: [
				{
					type: "toolCall",
					name: "security_publish",
					arguments: { findings: [], coverage: { completeness: "complete" }, report: "# Fixture report\n" },
				},
			],
		},
		{ content: ["Security publication completed."] },
	];

	let authDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let credentialId = 0;
	let scanDir: TempDir;
	let repositoryRoot = "";

	beforeAll(async () => {
		authDir = TempDir.createSync("@pi-ultracode-security-auth-");
		authStorage = await AuthStorage.create(path.join(authDir.path(), "agent.db"));
		await authStorage.credentials.set("openai-codex", {
			type: "oauth",
			access: "fixture-access-token",
			refresh: "fixture-refresh-token",
			expires: Date.now() + 60 * 60_000,
			accountId: "workspace-fixture",
			email: "security@example.invalid",
			orgId: "workspace-fixture",
			orgName: "pro",
		});
		const account = authStorage.oauth.accounts("openai-codex")[0];
		if (!account) throw new Error("expected fixture OAuth account");
		credentialId = account.credentialId;
		modelRegistry = new ModelRegistry(authStorage, path.join(authDir.path(), "models.yml"));
	});

	afterAll(() => {
		authStorage.close();
		authDir.removeSync();
	});

	beforeEach(async () => {
		scanDir = TempDir.createSync("@pi-ultracode-security-");
		repositoryRoot = scanDir.join("repo");
		await Bun.write(path.join(repositoryRoot, "src", "app.ts"), "export const app = true;\n");
		registerMockApi(MOCK_SOURCE_ID);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		unregisterCustomApis(MOCK_SOURCE_ID);
		scanDir.removeSync();
	});

	// The scan model is the host's active model; `xhigh` gives it a ladder
	// with the rung (getSupportedEfforts reads `model.thinking.efforts`).
	async function runScan(options: { armed: boolean; xhigh: boolean }) {
		const mock: MockModel = createMockModel({
			id: "security-mock",
			provider: "openai-codex",
			reasoning: options.xhigh,
			responses: PUBLISH_AND_STOP,
		});
		if (options.xhigh) {
			Object.assign(mock, {
				thinking: { mode: "effort", efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh] },
			});
		}
		const settings = Settings.isolated({ "security.enabled": true, "compaction.enabled": false });
		if (options.armed) cfgUltracode.override(settings, true);
		const coordinator = new SecurityCoordinator(
			{
				cwd: repositoryRoot,
				settings,
				authStorage,
				modelRegistry,
				activeModel: mock,
				sessionId: "parent-session",
				agentId: "Main",
			},
			{ openStore: () => SecurityStore.open(repositoryRoot, { stateRoot: scanDir.join("state") }), gitAdapter },
		);
		const plan = await coordinator.preflight({ credentialId, model: mock });
		const started = await coordinator.start({ planId: plan.id });
		const terminal = await coordinator.wait(started.operationId);
		settings.cancelPendingSaves();
		return { terminal, reasoning: mock.calls.map(call => call.options?.reasoning) };
	}

	it("runs every scan request at exactly xhigh when the host turn is armed", async () => {
		// Guards createDefaultSecuritySession passing the ultracode level as the
		// scan session's thinkingLevel: without it the scan reviews at the model
		// default under a turn that promised xhigh.
		const { terminal, reasoning } = await runScan({ armed: true, xhigh: true });
		expect(terminal.phase).toBe("completed");
		expect(reasoning).toEqual([Effort.XHigh, Effort.XHigh]);
	});

	it("fails the scan before any request when the armed scan model has no xhigh rung", async () => {
		// Guards the UltracodeEffortError refusal in createDefaultSecuritySession:
		// a model without the rung must fail the start, not scan at another effort.
		const { terminal, reasoning } = await runScan({ armed: true, xhigh: false });
		expect(terminal.phase).toBe("failed");
		expect(terminal.error).toContain("ultracode requires xhigh");
		expect(reasoning).toHaveLength(0);
	});

	it("leaves an unarmed scan at the model's own effort", async () => {
		// Control: the pin is the armed turn's, not the security scan's default.
		const { terminal, reasoning } = await runScan({ armed: false, xhigh: true });
		expect(terminal.phase).toBe("completed");
		expect(reasoning).toHaveLength(2);
		expect(reasoning).not.toContain(Effort.XHigh);
	});
});
