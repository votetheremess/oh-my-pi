/**
 * Ultracode's per-turn effort pin.
 *
 * Keyword detection, highlighting and the notice are covered elsewhere
 * (test/modes/ultracode.test.ts, test/modes/magic-keywords.test.ts). This file
 * covers the thing the keyword exists for: `ModelControls.beginUltracodeTurn()`
 * pinning the turn at xhigh, `endUltracodeTurn()` handing the borrowed level
 * back on the next turn without the word, and the ultracode branch of
 * `applyAutoThinkingLevel` refusing to let the difficulty classifier walk that
 * pin back down.
 *
 * The pin is deliberately clamp-based rather than `resolveTaskEffortLevel`-based:
 * a ladder that sits entirely above xhigh (`["max"]`) must resolve to max, not
 * throw. See the "ladder entirely above xhigh" case.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	Agent,
	type AgentMessage,
	ASIDE_MESSAGE_COMMIT,
	type CommittableAsideMessage,
	ThinkingLevel,
} from "@oh-my-pi/pi-agent-core";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { Effort } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session-events";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { ModelControls, type ModelControlsHost } from "@oh-my-pi/pi-coding-agent/session/model-controls";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { AUTO_THINKING, type ConfiguredThinkingLevel } from "@oh-my-pi/pi-coding-agent/thinking";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

function makeModel(id: string, thinking: Model<Api>["thinking"], reasoning = true): Model<Api> {
	return {
		id,
		name: id,
		api: "openai-responses",
		provider: "test",
		baseUrl: "https://example.test/v1",
		reasoning,
		input: ["text"],
		cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 1 },
		contextWindow: 200000,
		maxTokens: 8192,
		thinking,
	} as Model<Api>;
}

/** Five-tier ladder with a genuine xhigh tier (GPT-5.6 / Sonnet 5 shape). */
const HAS_XHIGH = makeModel("has-xhigh", {
	mode: "effort",
	efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max],
});
/** Tops out below xhigh (default reasoning scale, no xhigh tier). */
const TOPS_AT_HIGH = makeModel("tops-at-high", {
	mode: "effort",
	efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High],
});
/** Whole ladder sits ABOVE xhigh — the crash case for a resolve-based pin. */
const MAX_ONLY = makeModel("max-only", { mode: "effort", efforts: [Effort.Max] });
/** Reasoning, but effort is routed by sibling model id (devin-agent Cascade). */
const NO_EFFORT_SURFACE = makeModel("no-effort-surface", undefined);
const NON_REASONING = makeModel("non-reasoning", undefined, false);

interface Harness {
	controls: ModelControls;
	settings: Settings;
	/** Efforts handed to the agent, oldest first. The constructor contributes one. */
	agentEfforts: Array<Effort | undefined>;
	/** Every setting path read through the host, in order. */
	settingReads: string[];
	/** Times the host handed out its session id. Only the classifier's deps ask. */
	sessionIdReads(): number;
	events: AgentSessionEvent[];
	entries: Array<{ thinkingLevel?: string; configured?: string }>;
}

/**
 * `Settings` view that logs every `get` path. `classifyDifficulty` opens by
 * reading `providers.autoThinkingModel`, so that path showing up in the log is
 * direct evidence the difficulty classifier was entered.
 */
function recordSettingReads(settings: Settings, log: string[]): Settings {
	return new Proxy(settings, {
		get(target, prop) {
			// Receiver is the real instance: Settings methods touch private fields.
			const value = Reflect.get(target, prop, target);
			if (typeof value !== "function") return value;
			if (prop === "get") {
				return (path: string) => {
					log.push(path);
					return (value as (p: string) => unknown).call(target, path);
				};
			}
			return value.bind(target);
		},
	}) as Settings;
}

const GENERATION = 7;

function createHarness(options: {
	model: Model<Api> | undefined;
	thinkingLevel?: ConfiguredThinkingLevel;
	thinkingLevelCeiling?: Effort;
	ultracode?: boolean;
}): Harness {
	const agentEfforts: Array<Effort | undefined> = [];
	const settingReads: string[] = [];
	const events: AgentSessionEvent[] = [];
	const entries: Array<{ thinkingLevel?: string; configured?: string }> = [];
	let sessionIdReads = 0;

	const settings = Settings.isolated({ ultracode: options.ultracode ?? false });

	const agent = {
		setThinkingLevel: (effort: Effort | undefined) => {
			agentEfforts.push(effort);
		},
		setDisableReasoning: () => {},
		metadataForProvider: () => undefined,
	} as unknown as Agent;

	const host: ModelControlsHost = {
		agent,
		settings: recordSettingReads(settings, settingReads),
		// Empty registry: if the classifier ever were entered it would fail to
		// find a tiny/smol model and throw, so no test can reach the network.
		modelRegistry: {
			getAvailable: () => [],
			getApiKey: async () => undefined,
			getApiKeyForProvider: async () => undefined,
			resolver: () => async () => undefined,
		} as unknown as ModelRegistry,
		sessionManager: {
			appendThinkingLevelChange: (thinkingLevel?: string, configured?: string) => {
				entries.push({ thinkingLevel, configured });
				return "entry-id";
			},
		} as unknown as SessionManager,
		providerSessionState: new Map(),
		model: () => options.model,
		sessionId: () => {
			sessionIdReads++;
			return "test-session";
		},
		promptGeneration: () => GENERATION,
		resolveActiveEditMode: () => "hashline",
		syncAfterModelChange: async () => {},
		setModelWithProviderSessionReset: async () => {},
		clearActiveRetryFallback: () => {},
		clearInheritedProviderPromptCacheKey: () => {},
		magicKeywordEnabled: () => true,
		emit: event => {
			events.push(event);
		},
		emitSessionEvent: async () => {},
		emitNotice: () => {},
	};

	const controls = new ModelControls(host, {
		thinkingLevel: options.thinkingLevel,
		thinkingLevelCeiling: options.thinkingLevelCeiling,
	});

	return {
		controls,
		settings,
		agentEfforts,
		settingReads,
		sessionIdReads: () => sessionIdReads,
		events,
		entries,
	};
}

describe("beginUltracodeTurn", () => {
	it("pins the turn at xhigh on a model whose ladder offers it", () => {
		const h = createHarness({ model: HAS_XHIGH, thinkingLevel: Effort.Low });
		h.controls.beginUltracodeTurn();

		expect(h.controls.thinkingLevel).toBe(Effort.XHigh);
		expect(h.agentEfforts.at(-1)).toBe(Effort.XHigh);
		expect(h.events).toEqual([{ type: "thinking_level_changed", thinkingLevel: Effort.XHigh }]);
	});

	it("clamps down to the highest supported level when the ladder stops below xhigh", () => {
		const h = createHarness({ model: TOPS_AT_HIGH, thinkingLevel: Effort.Minimal });
		h.controls.beginUltracodeTurn();

		expect(h.controls.thinkingLevel).toBe(Effort.High);
		// The point of the clamp: never hand the provider an unsupported tier.
		expect(h.agentEfforts).not.toContain(Effort.XHigh);
	});

	it("resolves up to max when the whole ladder sits above xhigh, without throwing", () => {
		const h = createHarness({ model: MAX_ONLY });

		// Regression: pinning through `resolveTaskEffortLevel` with an xhigh
		// ceiling threw RangeError here, because no supported effort is at or
		// below xhigh. The clamp has to snap to the nearest tier instead.
		expect(() => h.controls.beginUltracodeTurn()).not.toThrow();
		expect(h.controls.thinkingLevel).toBe(Effort.Max);
		expect(h.agentEfforts.at(-1)).toBe(Effort.Max);
	});

	it("leaves a reasoning model with no controllable effort surface untouched", () => {
		const h = createHarness({ model: NO_EFFORT_SURFACE, thinkingLevel: Effort.Medium });
		const agentCallsBefore = h.agentEfforts.length;

		expect(() => h.controls.beginUltracodeTurn()).not.toThrow();
		// Untouched: still whatever the session was configured with.
		expect(h.controls.thinkingLevel).toBe(Effort.Medium);
		expect(h.agentEfforts.length).toBe(agentCallsBefore);
		expect(h.events).toEqual([]);
		expect(h.entries).toEqual([]);
	});

	it("leaves a non-reasoning model untouched", () => {
		const h = createHarness({ model: NON_REASONING, thinkingLevel: Effort.Medium });
		const agentCallsBefore = h.agentEfforts.length;

		expect(() => h.controls.beginUltracodeTurn()).not.toThrow();
		expect(h.controls.thinkingLevel).toBe(Effort.Medium);
		expect(h.agentEfforts.length).toBe(agentCallsBefore);
		expect(h.events).toEqual([]);
	});

	it("leaves auto behind so the difficulty classifier stops running", () => {
		const h = createHarness({ model: HAS_XHIGH, thinkingLevel: AUTO_THINKING });
		expect(h.controls.configuredThinkingLevel()).toBe(AUTO_THINKING);
		expect(h.controls.isAutoThinking).toBe(true);

		h.controls.beginUltracodeTurn();

		// `AgentSession` only calls `applyAutoThinkingLevel` while `isAutoThinking`
		// is true, so clearing it is what takes the classifier out of the turn.
		expect(h.controls.isAutoThinking).toBe(false);
		expect(h.controls.configuredThinkingLevel()).toBe(Effort.XHigh);
		expect(h.controls.autoResolvedThinkingLevel).toBeUndefined();
		// The pin's session receipt records the borrowed-FROM selector ("auto"
		// here), never xhigh itself — see the "ultracode resume receipt" block.
		expect(h.entries.at(-1)).toEqual({ thinkingLevel: Effort.XHigh, configured: AUTO_THINKING });
	});

	it("is turn-scoped: it never rewrites the persisted defaultThinkingLevel", () => {
		const h = createHarness({ model: HAS_XHIGH, thinkingLevel: AUTO_THINKING });
		h.settings.set("defaultThinkingLevel", Effort.Medium);

		h.controls.beginUltracodeTurn();

		expect(h.controls.thinkingLevel).toBe(Effort.XHigh);
		expect(h.settings.get("defaultThinkingLevel")).toBe(Effort.Medium);
	});

	it("never exceeds a hard thinking-level ceiling", () => {
		const h = createHarness({
			model: HAS_XHIGH,
			thinkingLevel: Effort.Low,
			thinkingLevelCeiling: Effort.Medium,
		});
		h.controls.beginUltracodeTurn();

		expect(h.controls.thinkingLevelCeiling).toBe(Effort.Medium);
		expect(h.controls.thinkingLevel).toBe(Effort.Medium);
		expect(h.agentEfforts).not.toContain(Effort.XHigh);
	});

	it("hands the borrowed level back when the turn ends", () => {
		const h = createHarness({ model: HAS_XHIGH, thinkingLevel: Effort.Low });
		h.controls.beginUltracodeTurn();
		expect(h.controls.thinkingLevel).toBe(Effort.XHigh);

		// The whole point of per-turn: the next keyword-free turn is back to normal.
		h.controls.endUltracodeTurn();
		expect(h.controls.configuredThinkingLevel()).toBe(Effort.Low);
	});

	it("restores auto, not a concrete level, when auto was running before", () => {
		const h = createHarness({ model: HAS_XHIGH, thinkingLevel: AUTO_THINKING });
		h.controls.beginUltracodeTurn();
		expect(h.controls.isAutoThinking).toBe(false);

		h.controls.endUltracodeTurn();
		expect(h.controls.configuredThinkingLevel()).toBe(AUTO_THINKING);
		expect(h.controls.isAutoThinking).toBe(true);
	});

	it("survives the keyword on consecutive turns without stranding the session at xhigh", () => {
		const h = createHarness({ model: HAS_XHIGH, thinkingLevel: Effort.Low });
		h.controls.beginUltracodeTurn();
		// A second capture must not overwrite the saved level with xhigh itself.
		h.controls.beginUltracodeTurn();
		h.controls.endUltracodeTurn();

		expect(h.controls.configuredThinkingLevel()).toBe(Effort.Low);
	});

	it("ending without a begin is a no-op, so ordinary turns cost nothing", () => {
		const h = createHarness({ model: HAS_XHIGH, thinkingLevel: Effort.Medium });
		const before = h.entries.length;
		h.controls.endUltracodeTurn();

		expect(h.controls.configuredThinkingLevel()).toBe(Effort.Medium);
		expect(h.entries.length).toBe(before);
	});

	it("yields to the user's own effort control instead of overwriting their choice", () => {
		const h = createHarness({ model: HAS_XHIGH, thinkingLevel: Effort.Low, ultracode: true });
		h.controls.beginUltracodeTurn();
		expect(h.controls.thinkingLevel).toBe(Effort.XHigh);

		// Reaching for the effort control mid-turn is explicit. The pending restore
		// must be dropped, or it would silently discard the level they just picked.
		const picked = h.controls.cycleThinkingLevel();
		h.controls.endUltracodeTurn();

		expect(h.settings.get("ultracode")).toBe(false);
		expect(h.controls.configuredThinkingLevel()).toBe(picked);
		expect(h.controls.thinkingLevel).not.toBe(Effort.XHigh);
	});

	it("leaves the flag alone when cycling on a turn that never used the keyword", () => {
		const h = createHarness({ model: HAS_XHIGH, thinkingLevel: Effort.Low });
		h.controls.cycleThinkingLevel();
		expect(h.settings.get("ultracode")).toBe(false);
	});
});

describe("applyAutoThinkingLevel under ultracode", () => {
	it("resolves straight to the clamped xhigh without invoking the classifier", async () => {
		const h = createHarness({ model: HAS_XHIGH, thinkingLevel: AUTO_THINKING, ultracode: true });

		await h.controls.applyAutoThinkingLevel("rename a local variable", GENERATION);

		expect(h.controls.thinkingLevel).toBe(Effort.XHigh);
		expect(h.controls.autoResolvedThinkingLevel).toBe(Effort.XHigh);
		// The classifier was bypassed, not merely outvoted: its first read never
		// happened and it was never handed a session id.
		expect(h.settingReads).toContain("ultracode");
		expect(h.settingReads).not.toContain("providers.autoThinkingModel");
		expect(h.sessionIdReads()).toBe(0);
	});

	it("clamps the bypass to the model's ladder", async () => {
		const h = createHarness({ model: TOPS_AT_HIGH, thinkingLevel: AUTO_THINKING, ultracode: true });

		await h.controls.applyAutoThinkingLevel("rename a local variable", GENERATION);

		expect(h.controls.thinkingLevel).toBe(Effort.High);
		expect(h.settingReads).not.toContain("providers.autoThinkingModel");
	});

	it("still honors a hard ceiling below xhigh", async () => {
		const h = createHarness({
			model: HAS_XHIGH,
			thinkingLevel: AUTO_THINKING,
			thinkingLevelCeiling: Effort.Medium,
			ultracode: true,
		});

		await h.controls.applyAutoThinkingLevel("rename a local variable", GENERATION);

		expect(h.controls.thinkingLevel).toBe(Effort.Medium);
	});

	it("runs the classifier when ultracode is off", async () => {
		// Counterpart to the bypass assertions above: without ultracode the same
		// probes fire, so their absence there is meaningful rather than vacuous.
		const h = createHarness({ model: HAS_XHIGH, thinkingLevel: AUTO_THINKING, ultracode: false });

		await h.controls.applyAutoThinkingLevel("rename a local variable", GENERATION);

		expect(h.settingReads).toContain("providers.autoThinkingModel");
		expect(h.sessionIdReads()).toBe(1);
		// The empty registry makes classification fail, so auto falls back to the
		// provisional level — notably NOT xhigh.
		expect(h.controls.thinkingLevel).toBe(Effort.High);
		expect(h.controls.isAutoThinking).toBe(true);
	});

	it("does not clear auto, so a later turn re-pins xhigh", async () => {
		const h = createHarness({ model: HAS_XHIGH, thinkingLevel: AUTO_THINKING, ultracode: true });

		await h.controls.applyAutoThinkingLevel("first turn", GENERATION);
		expect(h.controls.configuredThinkingLevel()).toBe(AUTO_THINKING);

		h.controls.restoreThinkingLevel(ThinkingLevel.Low);
		expect(h.controls.thinkingLevel).toBe(Effort.Low);
		h.controls.restoreThinkingLevel(AUTO_THINKING);

		await h.controls.applyAutoThinkingLevel("second turn", GENERATION);
		expect(h.controls.thinkingLevel).toBe(Effort.XHigh);
		expect(h.settingReads).not.toContain("providers.autoThinkingModel");
	});
});

describe("ultracode resume receipt", () => {
	// Invariant: the xhigh pin is turn state, never the session's own configured
	// level on disk. The handback state (`#levelBeforeUltracode`) lives in process
	// memory only, so the pin's `thinking_level_change` entry must carry the
	// borrowed-FROM level as `configured` — the value session restore replays
	// (session-context reads `entry.configured`, sdk feeds it through
	// `parseConfiguredThinkingLevel`). A process killed mid-ultracode-turn
	// therefore resumes at the pre-ultracode level instead of stranded at xhigh
	// with no handback state left to run.
	it("records the borrowed-from level, not xhigh, as the pin's configured receipt", () => {
		const h = createHarness({ model: HAS_XHIGH, thinkingLevel: Effort.Low });
		h.controls.beginUltracodeTurn();

		expect(h.controls.thinkingLevel).toBe(Effort.XHigh);
		expect(h.entries.at(-1)).toEqual({ thinkingLevel: Effort.XHigh, configured: Effort.Low });
	});

	it("writes the handed-back level as both fields once the turn ends", () => {
		const h = createHarness({ model: HAS_XHIGH, thinkingLevel: Effort.Low });
		h.controls.beginUltracodeTurn();
		h.controls.endUltracodeTurn();

		expect(h.entries.at(-1)).toEqual({ thinkingLevel: Effort.Low, configured: Effort.Low });
	});

	it("leaves ordinary level changes writing the level itself as the receipt", () => {
		const h = createHarness({ model: HAS_XHIGH, thinkingLevel: Effort.Low });
		h.controls.setThinkingLevel(Effort.Medium);

		expect(h.entries.at(-1)).toEqual({ thinkingLevel: Effort.Medium, configured: Effort.Medium });
	});
});

// The seam between AgentSession.prompt() and ModelControls is two one-line
// calls (arm in the keyword branch, disarm in the keyword-free branch of the
// turn-state applier). Each test below fails if its call is severed, which the
// ModelControls-level blocks above cannot see.
describe("AgentSession ultracode turn wiring", () => {
	let session: AgentSession | undefined;
	let authStorage: AuthStorage;
	let authRoot: string;
	let modelRegistry: ModelRegistry;

	beforeAll(async () => {
		authRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ultracode-turn-auth-"));
		authStorage = await AuthStorage.create(path.join(authRoot, "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(authRoot, "models.yml"));
	});

	afterAll(async () => {
		authStorage.close();
		await removeWithRetries(authRoot);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		if (session) await session.dispose();
		session = undefined;
	});

	async function createSession(): Promise<{ session: AgentSession; settings: Settings }> {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Claude Sonnet model");
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
				thinkingLevel: Effort.High,
			},
		});
		const settings = Settings.isolated();
		const created = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		return { session: created, settings };
	}

	/** Forces the streaming queue path in prompt() without a live agent loop. */
	function forceStreaming(target: AgentSession): void {
		Object.defineProperty(target, "isStreaming", { configurable: true, get: () => true });
	}

	/**
	 * Fires the queued message's delivery effect exactly as the agent loop does
	 * when it commits the message into the live context. Fails when no effect is
	 * attached — a severed hook would otherwise pass silently as a no-op.
	 */
	function deliverQueued(message: AgentMessage | undefined): void {
		const hook = (message as CommittableAsideMessage | undefined)?.[ASIDE_MESSAGE_COMMIT];
		expect(typeof hook).toBe("function");
		hook?.();
	}

	it("pins the turn's thinking level through prompt(), not just through ModelControls", async () => {
		const created = await createSession();
		session = created.session;
		session.setThinkingLevel(Effort.Low);
		vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);

		await session.prompt("please ultracode this refactor");

		expect(created.settings.get("ultracode")).toBe(true);
		expect(session.thinkingLevel).toBe(Effort.XHigh);
	});

	it("hands the borrowed level back on the next keyword-free user turn through prompt()", async () => {
		const created = await createSession();
		session = created.session;
		session.setThinkingLevel(Effort.Low);
		vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);

		await session.prompt("please ultracode this refactor");
		expect(session.thinkingLevel).toBe(Effort.XHigh);

		await session.prompt("now the keyword-free follow-up");
		expect(created.settings.get("ultracode")).toBe(false);
		expect(session.thinkingLevel).toBe(Effort.Low);
	});

	it("does not disarm the in-flight ultracode turn when a keyword-free steer is enqueued", async () => {
		const created = await createSession();
		session = created.session;
		session.setThinkingLevel(Effort.Low);
		vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);
		await session.prompt("please ultracode this refactor");
		expect(session.thinkingLevel).toBe(Effort.XHigh);

		forceStreaming(session);
		await session.prompt("also check the tests", { streamingBehavior: "steer" });

		// Enqueue leaves the in-flight armed turn alone: the pin and the subagent
		// floor stay up for everything the turn still spawns.
		expect(created.settings.get("ultracode")).toBe(true);
		expect(session.thinkingLevel).toBe(Effort.XHigh);

		// The flip fires only when the loop delivers the queued message.
		deliverQueued(session.agent.peekSteeringQueue().find(m => m.role === "user"));
		expect(created.settings.get("ultracode")).toBe(false);
		expect(session.thinkingLevel).toBe(Effort.Low);
	});

	it("arms a queued ultracode follow-up at delivery, not under the current turn", async () => {
		const created = await createSession();
		session = created.session;
		session.setThinkingLevel(Effort.Low);
		vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);

		forceStreaming(session);
		await session.prompt("ultracode the next piece", { streamingBehavior: "followUp" });

		// The tail of the CURRENT (keyword-free) turn must not borrow xhigh.
		expect(created.settings.get("ultracode")).toBe(false);
		expect(session.thinkingLevel).toBe(Effort.Low);

		deliverQueued(session.agent.peekFollowUpQueue().find(m => m.role === "user"));
		expect(created.settings.get("ultracode")).toBe(true);
		expect(session.thinkingLevel).toBe(Effort.XHigh);
	});

	it("keeps the user's explicit selector pick instead of the stale ultracode handback", async () => {
		const created = await createSession();
		session = created.session;
		session.setThinkingLevel(Effort.Low);
		vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);
		await session.prompt("please ultracode this refactor");
		expect(session.thinkingLevel).toBe(Effort.XHigh);

		// The selector / RPC / ACP / extension path: an unambiguous "I want THIS
		// effort". It drops the pending restore and the subagent floor with it.
		session.setThinkingLevel(Effort.Medium);
		expect(created.settings.get("ultracode")).toBe(false);
		expect(session.thinkingLevel).toBe(Effort.Medium);

		// The next keyword-free turn's handback must not overwrite the pick.
		await session.prompt("keyword-free follow-up");
		expect(session.thinkingLevel).toBe(Effort.Medium);
	});
});
