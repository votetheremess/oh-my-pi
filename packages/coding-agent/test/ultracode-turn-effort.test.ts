/**
 * Ultracode's per-turn effort pin.
 *
 * Keyword detection, highlighting and the notice are covered elsewhere
 * (test/modes/ultracode.test.ts, test/modes/magic-keywords.test.ts). This file
 * covers the thing the keyword exists for: `ModelControls.beginUltracodeTurn()`
 * pinning the turn at EXACTLY xhigh, `endUltracodeTurn()` handing the borrowed
 * level back on the next turn without the word, `repinUltracodeIfArmed()`
 * re-applying the pin after an internal model swap, and the ultracode branch of
 * `applyAutoThinkingLevel` refusing to let the difficulty classifier walk that
 * pin back down.
 *
 * The pin is strict, not clamp-based. `ultracodeEffortFor` answers xhigh or
 * nothing: a ladder that stops at high, one that sits entirely above xhigh
 * (`["max"]`), a reasoning model with no effort surface, and a non-reasoning
 * model all REFUSE the pin rather than rounding to a neighbour. The main-session
 * arm then declines to arm at all and tells the user; spawn paths throw
 * `UltracodeEffortError`. See the "refuses" cases and the AgentSession wiring
 * block for the user-visible half.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, type Mock, vi } from "bun:test";
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
import type { Api, Context, ImageContent, Model } from "@oh-my-pi/pi-ai";
import { Effort } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import * as autoThinkingClassifier from "@oh-my-pi/pi-coding-agent/auto-thinking/classifier";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgMagicKeyword, cfgUltracode } from "@oh-my-pi/pi-coding-agent/modes/settings";
import { syncChildUltracodeAtResume } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session-events";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import {
	convertToLlm,
	SKILL_PROMPT_MESSAGE_TYPE,
	type SkillPromptDetails,
} from "@oh-my-pi/pi-coding-agent/session/messages";
import { ModelControls, type ModelControlsHost } from "@oh-my-pi/pi-coding-agent/session/model-controls";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { cfgDefaultThinkingLevel } from "@oh-my-pi/pi-coding-agent/session/settings";
import * as imageLoading from "@oh-my-pi/pi-coding-agent/utils/image-loading";
import { USER_INTERRUPT_LABEL } from "@oh-my-pi/pi-tui/chat/messages";
import {
	AUTO_THINKING,
	type ConfiguredThinkingLevel,
	UltracodeEffortError,
	ultracodeEffortFor,
} from "@oh-my-pi/pi-tui/thinking";
import { removeWithRetries, Snowflake, withTimeout } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

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
/** A second xhigh-capable model, for the swap cases. */
const ALSO_HAS_XHIGH = makeModel("also-has-xhigh", {
	mode: "effort",
	efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
});
/** Tops out below xhigh (default reasoning scale, no xhigh tier). */
const TOPS_AT_HIGH = makeModel("tops-at-high", {
	mode: "effort",
	efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High],
});
/** Whole ladder sits ABOVE xhigh — a clamp would have rounded this to max. */
const MAX_ONLY = makeModel("max-only", { mode: "effort", efforts: [Effort.Max] });
/** Reasoning, but effort is routed by sibling model id (devin-agent Cascade). */
const NO_EFFORT_SURFACE = makeModel("no-effort-surface", undefined);
const NON_REASONING = makeModel("non-reasoning", undefined, false);

/** Every fixture that cannot satisfy "exactly xhigh", so refusal cases share one loop. */
const NO_XHIGH_RUNG = [TOPS_AT_HIGH, MAX_ONLY, NO_EFFORT_SURFACE, NON_REASONING] as const;

interface Harness {
	controls: ModelControls;
	settings: Settings;
	/** Efforts handed to the agent, oldest first. The constructor contributes one. */
	agentEfforts: Array<Effort | undefined>;
	/** Times the host handed out its session id. Only the classifier's deps ask. */
	sessionIdReads(): number;
	events: AgentSessionEvent[];
	entries: Array<{ thinkingLevel?: string; configured?: string }>;
	/**
	 * Swap the model the host reports, the way an internal switch (retry
	 * fallback, role switch, cycle) changes `#model` underneath the controls.
	 * Does NOT re-apply any level: the swap paths do that themselves before
	 * calling `repinUltracodeIfArmed`, which is what the tests drive by hand.
	 */
	swapModel(model: Model<Api> | undefined): void;
}

const GENERATION = 7;

function createHarness(options: {
	model: Model<Api> | undefined;
	thinkingLevel?: ConfiguredThinkingLevel;
	thinkingLevelCeiling?: Effort;
	ultracode?: boolean;
}): Harness {
	const agentEfforts: Array<Effort | undefined> = [];
	const events: AgentSessionEvent[] = [];
	const entries: Array<{ thinkingLevel?: string; configured?: string }> = [];
	let sessionIdReads = 0;
	let currentModel = options.model;

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
		settings,
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
			// v18.1's usage-owner threading: applyAutoThinkingLevel builds
			// { sessionId, parentId } before entering the classifier try-block,
			// and its onUsage callback records usage. Match the real signatures
			// (getSessionId(): string; getLeafId(): string | null;
			// appendModelUsage(usage, owner): string) — never a tolerant Proxy.
			getSessionId: () => "test-session",
			getLeafId: () => null,
			appendModelUsage: () => "usage-entry-id",
		} as unknown as SessionManager,
		providerSessionState: new Map(),
		model: () => currentModel,
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
		sessionIdReads: () => sessionIdReads,
		events,
		entries,
		swapModel: model => {
			currentModel = model;
		},
	};
}

describe("ultracodeEffortFor", () => {
	it("answers exactly xhigh for a ladder that carries the rung", () => {
		expect(ultracodeEffortFor(HAS_XHIGH)).toBe(Effort.XHigh);
		expect(ultracodeEffortFor(ALSO_HAS_XHIGH)).toBe(Effort.XHigh);
	});

	it("is optimistic when no model is resolved yet, so the pin is re-validated later", () => {
		expect(ultracodeEffortFor(undefined)).toBe(Effort.XHigh);
	});

	it("refuses every ladder without an xhigh rung instead of rounding to a neighbour", () => {
		for (const model of NO_XHIGH_RUNG) {
			expect(ultracodeEffortFor(model)).toBeUndefined();
		}
	});

	it("never answers any level but xhigh", () => {
		// The contract is "xhigh or nothing": max above and high below are both
		// substitutes the user rejected, so no fixture may ever surface them.
		for (const model of [HAS_XHIGH, ALSO_HAS_XHIGH, ...NO_XHIGH_RUNG, undefined]) {
			const effort = ultracodeEffortFor(model);
			expect(effort === Effort.XHigh || effort === undefined).toBe(true);
		}
	});
});

describe("UltracodeEffortError", () => {
	it("names the model and the ladder it exposes, so the failure is actionable", () => {
		const error = new UltracodeEffortError("tops-at-high", [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High]);
		expect(error).toBeInstanceOf(Error);
		expect(error.name).toBe("UltracodeEffortError");
		expect(error.message).toBe("ultracode requires xhigh; tops-at-high exposes [minimal, low, medium, high]");
		expect(error.modelId).toBe("tops-at-high");
		expect(error.ladder).toEqual([Effort.Minimal, Effort.Low, Effort.Medium, Effort.High]);
	});

	it("says so plainly when the model exposes no controllable effort at all", () => {
		const error = new UltracodeEffortError("gpt-4o", []);
		expect(error.message).toBe("ultracode requires xhigh; gpt-4o exposes no controllable effort");
		expect(error.ladder).toEqual([]);
	});
});

describe("beginUltracodeTurn", () => {
	it("pins the turn at exactly xhigh on a model whose ladder offers it", () => {
		const h = createHarness({ model: HAS_XHIGH, thinkingLevel: Effort.Low });
		expect(h.controls.beginUltracodeTurn()).toBe(true);

		expect(h.controls.thinkingLevel).toBe(Effort.XHigh);
		expect(h.agentEfforts.at(-1)).toBe(Effort.XHigh);
		// The ladder tops out at max; the pin must not reach for it.
		expect(h.agentEfforts).not.toContain(Effort.Max);
		expect(h.events).toEqual([{ type: "thinking_level_changed", thinkingLevel: Effort.XHigh }]);
		expect(h.controls.hasPendingUltracodeRestore()).toBe(true);
	});

	it("refuses to pin when the ladder stops below xhigh, leaving the level alone", () => {
		const h = createHarness({ model: TOPS_AT_HIGH, thinkingLevel: Effort.Minimal });
		const agentCallsBefore = h.agentEfforts.length;

		expect(h.controls.beginUltracodeTurn()).toBe(false);

		// Not clamped to high: "high under the ultracode name" is the substitute
		// the contract forbids. Nothing moved, nothing was recorded.
		expect(h.controls.thinkingLevel).toBe(Effort.Minimal);
		expect(h.agentEfforts.length).toBe(agentCallsBefore);
		expect(h.events).toEqual([]);
		expect(h.entries).toEqual([]);
		expect(h.controls.hasPendingUltracodeRestore()).toBe(false);
	});

	it("refuses a ladder that sits entirely above xhigh instead of rounding up to max", () => {
		const h = createHarness({ model: MAX_ONLY, thinkingLevel: Effort.Max });
		const agentCallsBefore = h.agentEfforts.length;

		// Neither throws (the old resolve-based crash) nor pins max (the old
		// clamp): max is not xhigh, so the turn simply cannot be armed here.
		expect(() => h.controls.beginUltracodeTurn()).not.toThrow();
		expect(h.controls.beginUltracodeTurn()).toBe(false);
		expect(h.controls.thinkingLevel).toBe(Effort.Max);
		expect(h.agentEfforts.length).toBe(agentCallsBefore);
		expect(h.entries).toEqual([]);
		// With no pin there is nothing to hand back, so ending is a no-op too.
		h.controls.endUltracodeTurn();
		expect(h.entries).toEqual([]);
	});

	it("leaves a reasoning model with no controllable effort surface untouched", () => {
		const h = createHarness({ model: NO_EFFORT_SURFACE, thinkingLevel: Effort.Medium });
		const agentCallsBefore = h.agentEfforts.length;

		expect(h.controls.beginUltracodeTurn()).toBe(false);
		// Untouched: still whatever the session was configured with.
		expect(h.controls.thinkingLevel).toBe(Effort.Medium);
		expect(h.agentEfforts.length).toBe(agentCallsBefore);
		expect(h.events).toEqual([]);
		expect(h.entries).toEqual([]);
	});

	it("leaves a non-reasoning model untouched", () => {
		const h = createHarness({ model: NON_REASONING, thinkingLevel: Effort.Medium });
		const agentCallsBefore = h.agentEfforts.length;

		expect(h.controls.beginUltracodeTurn()).toBe(false);
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
		cfgDefaultThinkingLevel.set(h.settings, Effort.Medium);

		h.controls.beginUltracodeTurn();

		expect(h.controls.thinkingLevel).toBe(Effort.XHigh);
		expect(cfgDefaultThinkingLevel.get(h.settings)).toBe(Effort.Medium);
	});

	it("refuses to pin under a hard ceiling below xhigh rather than pinning the ceiling", () => {
		const h = createHarness({
			model: HAS_XHIGH,
			thinkingLevel: Effort.Low,
			thinkingLevelCeiling: Effort.Medium,
		});
		const agentCallsBefore = h.agentEfforts.length;

		// The ceiling would make setThinkingLevel re-clamp xhigh down to medium,
		// which is "medium under the ultracode name": refused, not applied.
		expect(h.controls.beginUltracodeTurn()).toBe(false);
		expect(h.controls.thinkingLevelCeiling).toBe(Effort.Medium);
		expect(h.controls.thinkingLevel).toBe(Effort.Low);
		expect(h.agentEfforts.length).toBe(agentCallsBefore);
		expect(h.controls.hasPendingUltracodeRestore()).toBe(false);
	});

	it("pins normally under a ceiling at or above xhigh", () => {
		// The control for the refusal above: the ceiling check bites only when
		// it would actually move the pin.
		const h = createHarness({
			model: HAS_XHIGH,
			thinkingLevel: Effort.Low,
			thinkingLevelCeiling: Effort.XHigh,
		});
		expect(h.controls.beginUltracodeTurn()).toBe(true);
		expect(h.controls.thinkingLevel).toBe(Effort.XHigh);
	});

	it("hands the borrowed level back when the turn ends", () => {
		const h = createHarness({ model: HAS_XHIGH, thinkingLevel: Effort.Low });
		h.controls.beginUltracodeTurn();
		expect(h.controls.thinkingLevel).toBe(Effort.XHigh);

		// The whole point of per-turn: the next keyword-free turn is back to normal.
		h.controls.endUltracodeTurn();
		expect(h.controls.configuredThinkingLevel()).toBe(Effort.Low);
		expect(h.controls.hasPendingUltracodeRestore()).toBe(false);
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

		expect(cfgUltracode.get(h.settings)).toBe(false);
		expect(h.controls.configuredThinkingLevel()).toBe(picked);
		expect(h.controls.thinkingLevel).not.toBe(Effort.XHigh);
		expect(h.controls.hasPendingUltracodeRestore()).toBe(false);
	});

	it("leaves the flag alone when cycling on a turn that never used the keyword", () => {
		const h = createHarness({ model: HAS_XHIGH, thinkingLevel: Effort.Low });
		h.controls.cycleThinkingLevel();
		expect(cfgUltracode.get(h.settings)).toBe(false);
	});
});

// Every internal model swap (retry fallback, role switch, cycle, transcript
// restore) re-applies the incoming model's default level or the selector's
// `:level` over the pin, then calls this last. The block drives the same two
// steps by hand: a bare setThinkingLevel standing in for the swap's re-apply,
// then the re-pin.
describe("repinUltracodeIfArmed", () => {
	it("re-pins exactly xhigh after a swap to another xhigh-capable model", () => {
		const h = createHarness({ model: HAS_XHIGH, thinkingLevel: Effort.Low, ultracode: true });
		h.controls.beginUltracodeTurn();

		h.swapModel(ALSO_HAS_XHIGH);
		// The swap applied the new model's default level over the pin...
		h.controls.setThinkingLevel(Effort.Medium);
		expect(h.controls.thinkingLevel).toBe(Effort.Medium);

		// ...and the re-pin puts the armed turn back where it belongs.
		expect(h.controls.repinUltracodeIfArmed()).toBe(true);
		expect(h.controls.thinkingLevel).toBe(Effort.XHigh);
		expect(h.agentEfforts.at(-1)).toBe(Effort.XHigh);
		// The handback still targets the level borrowed by the ORIGINAL pin, not
		// the swap's interim medium: re-pinning must never re-capture.
		h.controls.endUltracodeTurn();
		expect(h.controls.configuredThinkingLevel()).toBe(Effort.Low);
	});

	it("leaves the level alone and reports false when the new model lacks xhigh", () => {
		const h = createHarness({ model: HAS_XHIGH, thinkingLevel: Effort.Low, ultracode: true });
		h.controls.beginUltracodeTurn();

		h.swapModel(TOPS_AT_HIGH);
		h.controls.setThinkingLevel(Effort.High);
		const agentCallsBefore = h.agentEfforts.length;

		// The caller (fallback / cycle / session) decides how to surface this;
		// the controls must not quietly pin high in xhigh's place.
		expect(h.controls.repinUltracodeIfArmed()).toBe(false);
		expect(h.controls.thinkingLevel).toBe(Effort.High);
		expect(h.agentEfforts.length).toBe(agentCallsBefore);
	});

	it("does nothing when the turn is not armed, so ordinary swaps pay nothing", () => {
		const h = createHarness({ model: HAS_XHIGH, thinkingLevel: Effort.Low, ultracode: false });
		h.swapModel(ALSO_HAS_XHIGH);
		h.controls.setThinkingLevel(Effort.Medium);
		const agentCallsBefore = h.agentEfforts.length;

		expect(h.controls.repinUltracodeIfArmed()).toBe(false);
		expect(h.controls.thinkingLevel).toBe(Effort.Medium);
		expect(h.agentEfforts.length).toBe(agentCallsBefore);
		expect(h.controls.hasPendingUltracodeRestore()).toBe(false);
	});

	it("keys on the settings flag, so a child that inherited the flag pins without ever arming", () => {
		// A task-spawned child receives `ultracode: true` through the settings
		// snapshot and never runs beginUltracodeTurn itself; after its own model
		// swap the flag alone has to be enough to re-pin.
		const h = createHarness({ model: HAS_XHIGH, thinkingLevel: Effort.Medium, ultracode: true });
		expect(h.controls.hasPendingUltracodeRestore()).toBe(false);

		expect(h.controls.repinUltracodeIfArmed()).toBe(true);
		expect(h.controls.thinkingLevel).toBe(Effort.XHigh);
		// It captured the level it found, so the handback is still coherent.
		expect(h.controls.hasPendingUltracodeRestore()).toBe(true);
		h.controls.endUltracodeTurn();
		expect(h.controls.configuredThinkingLevel()).toBe(Effort.Medium);
	});

	it("refuses under a hard ceiling below xhigh, exactly like the first pin", () => {
		const h = createHarness({
			model: HAS_XHIGH,
			thinkingLevel: Effort.Low,
			thinkingLevelCeiling: Effort.Medium,
			ultracode: true,
		});
		expect(h.controls.repinUltracodeIfArmed()).toBe(false);
		expect(h.controls.thinkingLevel).toBe(Effort.Low);
	});
});

describe("applyAutoThinkingLevel under ultracode", () => {
	// Call-through spy on the classifier's entry point: a recorded call is
	// direct evidence it ran. The settings-read probe this replaced went dead
	// when v18.9.0 removed the string-keyed `Settings.get` it intercepted, so
	// its bypass assertions passed whatever the code did.
	let classify: Mock<typeof autoThinkingClassifier.classifyDifficulty>;
	beforeEach(() => {
		classify = vi.spyOn(autoThinkingClassifier, "classifyDifficulty");
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("resolves straight to exactly xhigh without invoking the classifier", async () => {
		const h = createHarness({ model: HAS_XHIGH, thinkingLevel: AUTO_THINKING, ultracode: true });

		await h.controls.applyAutoThinkingLevel("rename a local variable", GENERATION);

		expect(h.controls.thinkingLevel).toBe(Effort.XHigh);
		expect(h.controls.autoResolvedThinkingLevel).toBe(Effort.XHigh);
		// The classifier was bypassed, not merely outvoted: it was never entered
		// and never handed a session id.
		expect(classify).not.toHaveBeenCalled();
		expect(h.sessionIdReads()).toBe(0);
	});

	it("leaves a model without an xhigh rung alone instead of clamping the bypass", async () => {
		const h = createHarness({ model: TOPS_AT_HIGH, thinkingLevel: AUTO_THINKING, ultracode: true });
		const agentCallsBefore = h.agentEfforts.length;

		await h.controls.applyAutoThinkingLevel("rename a local variable", GENERATION);

		// Neither the clamp (high) nor the classifier may substitute for xhigh:
		// the turn is armed but this model cannot honour it, so nothing moves.
		expect(h.controls.autoResolvedThinkingLevel).toBeUndefined();
		expect(h.controls.configuredThinkingLevel()).toBe(AUTO_THINKING);
		expect(h.agentEfforts.length).toBe(agentCallsBefore);
		expect(classify).not.toHaveBeenCalled();
		expect(h.sessionIdReads()).toBe(0);
	});

	it("leaves the level alone under a hard ceiling below xhigh, matching beginUltracodeTurn", async () => {
		const h = createHarness({
			model: HAS_XHIGH,
			thinkingLevel: AUTO_THINKING,
			thinkingLevelCeiling: Effort.Medium,
			ultracode: true,
		});
		const agentCallsBefore = h.agentEfforts.length;

		await h.controls.applyAutoThinkingLevel("rename a local variable", GENERATION);

		// The shared ceiling clamp at the bottom of applyAutoThinkingLevel would
		// have landed this on medium; the ultracode branch must bail before it.
		expect(h.controls.autoResolvedThinkingLevel).toBeUndefined();
		expect(h.agentEfforts.length).toBe(agentCallsBefore);
		expect(classify).not.toHaveBeenCalled();
	});

	it("runs the classifier when ultracode is off", async () => {
		// Counterpart to the bypass assertions above: without ultracode the same
		// spy fires, so its silence there is meaningful rather than vacuous.
		const h = createHarness({ model: HAS_XHIGH, thinkingLevel: AUTO_THINKING, ultracode: false });

		await h.controls.applyAutoThinkingLevel("rename a local variable", GENERATION);

		expect(classify).toHaveBeenCalledTimes(1);
		expect(classify.mock.calls[0]?.[0]).toMatchObject({ request: "rename a local variable" });
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
		expect(classify).not.toHaveBeenCalled();
	});

	it("bypasses the classifier for a task-spawned turn's solution space too", async () => {
		// A delegated turn classifies its `solutionSpace` instead of the prompt
		// text — a separate input into the same classifier call, which the armed
		// branch must short-circuit just the same.
		const h = createHarness({ model: HAS_XHIGH, thinkingLevel: AUTO_THINKING, ultracode: true });

		await h.controls.applyAutoThinkingLevel("refactor this", GENERATION, "wide open design space with many options");

		expect(h.controls.thinkingLevel).toBe(Effort.XHigh);
		expect(classify).not.toHaveBeenCalled();
		expect(h.sessionIdReads()).toBe(0);
	});

	it("classifies the solution space when ultracode is off", async () => {
		const h = createHarness({ model: HAS_XHIGH, thinkingLevel: AUTO_THINKING, ultracode: false });

		await h.controls.applyAutoThinkingLevel("refactor this", GENERATION, "wide open design space with many options");

		expect(classify).toHaveBeenCalledTimes(1);
		expect(classify.mock.calls[0]?.[0]).toMatchObject({ solutionSpace: "wide open design space with many options" });
		expect(h.controls.thinkingLevel).not.toBe(Effort.XHigh);
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

/** Bundled ladder without xhigh (low/medium/high), for the fail-loud cases. */
const NO_XHIGH_MODEL_ID = "claude-sonnet-4-6";

/** Registry id of a kept-alive child the executor (or /tan) registered under the root. */
const FOCUSED_CHILD_ID = `${MAIN_AGENT_ID}.Focused`;

/** Registers a live root carrying `parentSettings` and `child` beneath it in the global registry. */
function registerFocusedChild(parentSettings: Settings, child: AgentSession): void {
	const registry = AgentRegistry.global();
	// Only `cfgUltracode.get(settings)` is read off the parent (AGENTS.md, "Faking AgentSession").
	const parent = { settings: parentSettings } as unknown as AgentSession;
	registry.register({ id: MAIN_AGENT_ID, displayName: MAIN_AGENT_ID, kind: "main", session: parent });
	registry.register({
		id: FOCUSED_CHILD_ID,
		displayName: "task",
		kind: "sub",
		parentId: MAIN_AGENT_ID,
		session: child,
	});
}

/** A user-invoked `/skill:deep-work <args>` prompt, the shape the skill command hands promptCustomMessage. */
function skillPrompt(args: string, extra: ImageContent[] = []) {
	const details: SkillPromptDetails = {
		name: "deep-work",
		path: "/skills/deep-work/SKILL.md",
		args,
		lineCount: 1,
	};
	return {
		customType: SKILL_PROMPT_MESSAGE_TYPE,
		content: [{ type: "text" as const, text: `Skill body\n\nUser: ${args}` }, ...extra],
		display: true,
		details,
		attribution: "user" as const,
	};
}

// The seam between AgentSession and ModelControls: arm in the keyword branch of
// the turn-state applier, disarm in its keyword-free branch, disarm again on
// every session transition and user-driven level pick, undo on a dropped
// dispatch, and never any of it on a task-spawned child. Each test below fails
// if its call is severed, which the ModelControls-level blocks above cannot see.
describe("AgentSession ultracode turn wiring", () => {
	let session: AgentSession | undefined;
	let sessionRoot: string | undefined;
	let authStorage: AuthStorage;
	let authRoot: string;
	let modelRegistry: ModelRegistry;

	beforeAll(async () => {
		authRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ultracode-turn-auth-"));
		authStorage = await AuthStorage.create(path.join(authRoot, "auth.db"));
		authStorage.keys.setRuntime("anthropic", "test-key");
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
		if (sessionRoot) await removeWithRetries(sessionRoot);
		sessionRoot = undefined;
		AgentRegistry.resetGlobalForTests();
	});

	interface CreatedSession {
		session: AgentSession;
		settings: Settings;
		/** Every `notice` event the session emitted, oldest first. */
		notices: Array<{ level: string; message: string; source?: string }>;
	}

	async function createSession(options?: {
		/** `"sub"` is what sdk.ts derives for a task-spawned child. */
		agentKind?: "main" | "sub";
		/** Bundled anthropic model id; defaults to one with an xhigh rung. */
		modelId?: string;
		/** Initial selector; defaults to the agent's own `high`. */
		thinkingLevel?: ConfiguredThinkingLevel;
		/** Hard per-session effort ceiling, the way a task spawn passes `task.maxEffort` or the xhigh pin. */
		thinkingLevelCeiling?: Effort;
		/** Seeded handback for a child constructed directly at xhigh under an armed parent. */
		ultracodeRestoreLevel?: ConfiguredThinkingLevel;
		/** Born armed, the way a task child's settings snapshot carries the parent's flag. */
		ultracode?: boolean;
		/** Registry id, the way the executor names a kept-alive child. */
		agentId?: string;
	}): Promise<CreatedSession> {
		const model = getBundledModel("anthropic", options?.modelId ?? "claude-sonnet-4-5");
		if (!model) throw new Error(`Expected bundled anthropic/${options?.modelId ?? "claude-sonnet-4-5"}`);
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
				thinkingLevel: Effort.High,
			},
		});
		// A child spawned under ultracode is BORN with the flag in its snapshot;
		// the restore level is only honoured for such a session.
		const settings = Settings.isolated(options?.ultracode ? { ultracode: true } : {});
		// File-backed so newSession()/switchSession() have somewhere to go.
		sessionRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ultracode-turn-session-"));
		const created = new AgentSession({
			agent,
			sessionManager: SessionManager.create(sessionRoot, path.join(sessionRoot, "sessions")),
			settings,
			modelRegistry,
			agentKind: options?.agentKind,
			agentId: options?.agentId,
			thinkingLevel: options?.thinkingLevel,
			thinkingLevelCeiling: options?.thinkingLevelCeiling,
			ultracodeRestoreLevel: options?.ultracodeRestoreLevel,
		});
		const notices: CreatedSession["notices"] = [];
		created.subscribe(event => {
			if (event.type === "notice")
				notices.push({ level: event.level, message: event.message, source: event.source });
		});
		return { session: created, settings, notices };
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

	/** A session-file header the way switchSession() expects to find one. */
	async function writeSwitchTarget(): Promise<string> {
		if (!sessionRoot) throw new Error("createSession() first");
		const targetId = `target-${Snowflake.next()}`;
		const targetPath = path.join(sessionRoot, "sessions", `${targetId}.jsonl`);
		await Bun.write(
			targetPath,
			`${JSON.stringify({
				type: "session",
				version: 3,
				id: targetId,
				timestamp: new Date().toISOString(),
				cwd: sessionRoot,
			})}\n`,
		);
		return targetPath;
	}

	it("pins the turn's thinking level through prompt(), not just through ModelControls", async () => {
		const created = await createSession();
		session = created.session;
		session.setThinkingLevel(Effort.Low);
		vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);

		await session.prompt("please ultracode this refactor");

		expect(cfgUltracode.get(created.settings)).toBe(true);
		expect(session.thinkingLevel).toBe(Effort.XHigh);
		expect(created.notices).toEqual([]);
	});

	it("hands the borrowed level back on the next keyword-free user turn through prompt()", async () => {
		const created = await createSession();
		session = created.session;
		session.setThinkingLevel(Effort.Low);
		vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);

		await session.prompt("please ultracode this refactor");
		expect(session.thinkingLevel).toBe(Effort.XHigh);

		await session.prompt("now the keyword-free follow-up");
		expect(cfgUltracode.get(created.settings)).toBe(false);
		expect(session.thinkingLevel).toBe(Effort.Low);
	});

	// --- queue modes: a follow-up STARTS a turn, a steer JOINS one -------------
	//
	// A keyword-free message means different things depending on where it
	// lands. A follow-up starts the next turn, so without the word it hands the
	// borrowed effort back. A steer joins the turn already running: "actually,
	// also do X" mid-turn must not yank the pin and the spawn floor out from
	// under the workflow it joins, so a keyword-free steer is inert and a
	// keyword steer only ever arms.

	/** The queued user message's delivery rider, or undefined when none is attached. */
	function queuedHook(message: AgentMessage | undefined): (() => void) | undefined {
		expect(message).toBeDefined();
		return (message as CommittableAsideMessage | undefined)?.[ASIDE_MESSAGE_COMMIT];
	}

	it("attaches no delivery effect to a keyword-free steer, so it cannot disarm the turn it joins", async () => {
		const created = await createSession();
		session = created.session;
		session.setThinkingLevel(Effort.Low);
		vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);
		await session.prompt("please ultracode this refactor");
		expect(session.thinkingLevel).toBe(Effort.XHigh);

		forceStreaming(session);
		await session.prompt("also check the tests", { streamingBehavior: "steer" });

		// Nothing at enqueue, and nothing to fire at delivery either: the rider
		// is absent, not a no-op that could later grow a disarm.
		expect(queuedHook(session.agent.peekSteeringQueue().find(m => m.role === "user"))).toBeUndefined();
		expect(cfgUltracode.get(created.settings)).toBe(true);
		expect(session.thinkingLevel).toBe(Effort.XHigh);
	});

	it("arms at delivery when a steer carries the keyword", async () => {
		const created = await createSession();
		session = created.session;
		session.setThinkingLevel(Effort.Low);
		vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);

		forceStreaming(session);
		await session.prompt("ultracode the rest of this turn", { streamingBehavior: "steer" });

		// Enqueue is not delivery: the running turn keeps its own effort until
		// the loop commits the steer.
		expect(cfgUltracode.get(created.settings)).toBe(false);
		expect(session.thinkingLevel).toBe(Effort.Low);

		deliverQueued(session.agent.peekSteeringQueue().find(m => m.role === "user"));
		expect(cfgUltracode.get(created.settings)).toBe(true);
		expect(session.thinkingLevel).toBe(Effort.XHigh);
	});

	it("still disarms at delivery when a keyword-free follow-up starts the next turn", async () => {
		const created = await createSession();
		session = created.session;
		session.setThinkingLevel(Effort.Low);
		vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);
		await session.prompt("please ultracode this refactor");
		expect(session.thinkingLevel).toBe(Effort.XHigh);

		forceStreaming(session);
		await session.prompt("now the next step", { streamingBehavior: "followUp" });

		// Enqueue leaves the in-flight armed turn alone: the pin and the subagent
		// floor stay up for everything the turn still spawns.
		expect(cfgUltracode.get(created.settings)).toBe(true);
		expect(session.thinkingLevel).toBe(Effort.XHigh);

		// The flip fires only when the loop delivers the queued message.
		deliverQueued(session.agent.peekFollowUpQueue().find(m => m.role === "user"));
		expect(cfgUltracode.get(created.settings)).toBe(false);
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
		expect(cfgUltracode.get(created.settings)).toBe(false);
		expect(session.thinkingLevel).toBe(Effort.Low);

		deliverQueued(session.agent.peekFollowUpQueue().find(m => m.role === "user"));
		expect(cfgUltracode.get(created.settings)).toBe(true);
		expect(session.thinkingLevel).toBe(Effort.XHigh);
	});

	// The RPC/ACP entries `steer()` and `followUp()` reach the same queues
	// without going through prompt(): they are user-authored and must carry the
	// same riders, or a remote client's follow-up would neither arm nor hand
	// back, and its steer could not raise the turn it joins.

	it("steer(): arms at delivery with the keyword, attaches nothing without it", async () => {
		const created = await createSession();
		session = created.session;
		session.setThinkingLevel(Effort.Low);
		// A steer only exists against a running turn; without this the idle
		// drain would consume the queue between the two enqueues.
		forceStreaming(session);

		await session.steer("ultracode the rest of this turn");
		expect(cfgUltracode.get(created.settings)).toBe(false);
		deliverQueued(session.agent.peekSteeringQueue().find(m => m.role === "user"));
		expect(cfgUltracode.get(created.settings)).toBe(true);
		expect(session.thinkingLevel).toBe(Effort.XHigh);

		await session.steer("and mind the tests");
		const steers = session.agent.peekSteeringQueue().filter(m => m.role === "user");
		expect(steers).toHaveLength(2);
		expect(queuedHook(steers[1])).toBeUndefined();
		expect(cfgUltracode.get(created.settings)).toBe(true);
		expect(session.thinkingLevel).toBe(Effort.XHigh);
	});

	it("followUp(): arms at delivery with the keyword, disarms at delivery without it", async () => {
		const created = await createSession();
		session = created.session;
		session.setThinkingLevel(Effort.Low);
		forceStreaming(session);

		await session.followUp("ultracode the next piece");
		expect(cfgUltracode.get(created.settings)).toBe(false);
		deliverQueued(session.agent.peekFollowUpQueue().find(m => m.role === "user"));
		expect(cfgUltracode.get(created.settings)).toBe(true);
		expect(session.thinkingLevel).toBe(Effort.XHigh);

		await session.followUp("now the plain next step");
		const followUps = session.agent.peekFollowUpQueue().filter(m => m.role === "user");
		expect(followUps).toHaveLength(2);
		expect(cfgUltracode.get(created.settings)).toBe(true);
		deliverQueued(followUps[1]);
		expect(cfgUltracode.get(created.settings)).toBe(false);
		expect(session.thinkingLevel).toBe(Effort.Low);
	});

	// v18.9.0's promoteQueuedMessage (RPC `promote_queued_message`) moves the
	// SAME queued follow-up object into the steering queue, rider included. A
	// promoted message joins the running turn as a steer, so it must take the
	// steer shape: arm-only, and nothing at all when keyword-free.

	it("promoteQueuedMessage(): a keyword-free follow-up promoted to a steer drops its disarm", async () => {
		const created = await createSession();
		session = created.session;
		session.setThinkingLevel(Effort.Low);
		session.armUltracodeTurn();
		expect(session.thinkingLevel).toBe(Effort.XHigh);
		forceStreaming(session);

		await session.followUp("now the plain next step");
		// Precondition: queued as a follow-up it carries the disarm rider.
		expect(typeof queuedHook(session.agent.peekFollowUpQueue().find(m => m.role === "user"))).toBe("function");

		expect(session.promoteQueuedMessage("now the plain next step")).toBe(true);

		expect(session.agent.peekFollowUpQueue().filter(m => m.role === "user")).toEqual([]);
		const promoted = session.agent.peekSteeringQueue().find(m => m.role === "user");
		// Absent, exactly like a keyword-free steer: committing it mid-turn must
		// not yank the pin and the spawn floor out from under the armed turn.
		expect(queuedHook(promoted)).toBeUndefined();
		expect(cfgUltracode.get(created.settings)).toBe(true);
		expect(session.thinkingLevel).toBe(Effort.XHigh);
	});

	it("promoteQueuedMessage(): a keyword follow-up promoted to a steer still arms at delivery", async () => {
		const created = await createSession();
		session = created.session;
		session.setThinkingLevel(Effort.Low);
		forceStreaming(session);

		await session.followUp("ultracode the next piece");
		expect(session.promoteQueuedMessage("ultracode the next piece")).toBe(true);
		expect(cfgUltracode.get(created.settings)).toBe(false);

		deliverQueued(session.agent.peekSteeringQueue().find(m => m.role === "user"));
		expect(cfgUltracode.get(created.settings)).toBe(true);
		expect(session.thinkingLevel).toBe(Effort.XHigh);
	});

	it("promoteQueuedMessage(): a host's own follow-up delivery effect survives promotion without the disarm", async () => {
		const created = await createSession();
		session = created.session;
		session.setThinkingLevel(Effort.Low);
		session.armUltracodeTurn();
		forceStreaming(session);
		let hostFired = 0;

		await session.followUp("carry on with the plain step", undefined, {
			onDeliver: () => {
				hostFired++;
			},
		});
		expect(session.promoteQueuedMessage("carry on with the plain step")).toBe(true);

		// The caller's effect is the caller's and still fires; only the ultracode
		// disarm composed with it is dropped by the steer reshape.
		deliverQueued(session.agent.peekSteeringQueue().find(m => m.role === "user"));
		expect(hostFired).toBe(1);
		expect(cfgUltracode.get(created.settings)).toBe(true);
		expect(session.thinkingLevel).toBe(Effort.XHigh);
	});

	it("never attaches a keyword arm or disarm to a child's steer() or followUp()", async () => {
		const created = await createSession({ agentKind: "sub" });
		session = created.session;
		session.setThinkingLevel(Effort.Low);
		forceStreaming(session);

		await session.steer("ultracode this");
		await session.followUp("ultracode that");
		await session.followUp("plain follow-up");

		// A steer joins the child's running turn: nothing rides it.
		expect(queuedHook(session.agent.peekSteeringQueue().find(m => m.role === "user"))).toBeUndefined();
		// A follow-up starts the child's next turn, so it carries the resume-boundary
		// sync (mirror the parent) — never the keyword's arm or disarm. With no
		// registered parent there is nothing to mirror, so firing it changes nothing.
		for (const message of session.agent.peekFollowUpQueue().filter(m => m.role === "user")) {
			deliverQueued(message);
		}
		expect(cfgUltracode.get(created.settings)).toBe(false);
		expect(session.thinkingLevel).toBe(Effort.Low);
	});

	// The queue entries carry an attribution, and real callers use it: a parent
	// agent steering its child (task/executor.ts) and the vibe host
	// (vibe/runtime.ts) both pass `attribution: "agent"`. That text is not the
	// user's turn, so on a ROOT it must carry no rider whatever word it holds —
	// the child guard above never sees these, since the root is the target.
	it("steer(): attaches no rider and never arms on an agent-attributed steer, keyword or not", async () => {
		const created = await createSession();
		session = created.session;
		session.setThinkingLevel(Effort.Low);
		forceStreaming(session);

		await session.steer("ultracode the rest of this turn", undefined, { attribution: "agent" });

		const steer = session.agent.peekSteeringQueue().find(m => m.role === "user");
		expect(steer).toMatchObject({ role: "user", attribution: "agent" });
		expect(queuedHook(steer)).toBeUndefined();
		expect(cfgUltracode.get(created.settings)).toBe(false);
		expect(session.thinkingLevel).toBe(Effort.Low);
	});

	it("sendUserMessage(): an agent-attributed keyword-free follow-up carries no disarm and leaves the root armed", async () => {
		const created = await createSession();
		session = created.session;
		session.setThinkingLevel(Effort.Low);
		session.armUltracodeTurn();
		expect(session.thinkingLevel).toBe(Effort.XHigh);
		forceStreaming(session);

		await session.sendUserMessage("carry on with the brief", { deliverAs: "followUp", attribution: "agent" });

		// Absent, not a no-op: a keyword-free USER follow-up would carry the
		// disarm rider here (see the followUp() case above).
		const followUp = session.agent.peekFollowUpQueue().find(m => m.role === "user");
		expect(followUp).toMatchObject({ role: "user", attribution: "agent" });
		expect(queuedHook(followUp)).toBeUndefined();
		expect(cfgUltracode.get(created.settings)).toBe(true);
		expect(session.thinkingLevel).toBe(Effort.XHigh);
	});

	// --- arm sequence: the latest flip wins ------------------------------------
	//
	// Every arm and disarm bumps a sequence number. A dropped turn's undo and a
	// queued disarm rider both capture it when created and act only if nothing
	// flipped since, so an older decision can never revert a newer one.

	it("does not let a dropped keyword turn's undo disarm an arm that landed after it", async () => {
		const created = await createSession();
		session = created.session;
		const target = session;
		session.setThinkingLevel(Effort.Low);
		vi.spyOn(session.agent, "prompt").mockImplementation(async () => {
			// While the direct turn is mid-dispatch a queued keyword follow-up is
			// committed (the loop draining behind it), then the dispatch fails.
			forceStreaming(target);
			await target.followUp("ultracode the next piece");
			deliverQueued(target.agent.peekFollowUpQueue().find(m => m.role === "user"));
			throw new Error("dispatch failed");
		});

		await expect(session.prompt("please ultracode this refactor")).rejects.toThrow("dispatch failed");

		// The undo belongs to the first arm; the second arm is the newer intent
		// and its pin and floor must survive the first turn's rollback.
		expect(cfgUltracode.get(created.settings)).toBe(true);
		expect(session.thinkingLevel).toBe(Effort.XHigh);
		// And the handback is still the ORIGINAL borrowed level.
		vi.restoreAllMocks();
		vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);
		Object.defineProperty(session, "isStreaming", { configurable: true, get: () => false });
		await session.prompt("keyword-free follow-up");
		expect(cfgUltracode.get(created.settings)).toBe(false);
		expect(session.thinkingLevel).toBe(Effort.Low);
	});

	it("ends armed when a plan directive's arm and an older keyword-free disarm drain in one batch", async () => {
		const created = await createSession();
		session = created.session;
		session.setThinkingLevel(Effort.Low);
		forceStreaming(session);

		// Exactly the queued plan-approval shape, then a plain follow-up typed
		// behind it: both riders are attached while nothing is armed.
		await session.followUp("<system-notice>approved</system-notice>\n\nexecute the plan", undefined, {
			synthetic: true,
			onDeliver: session.armUltracodeTurnDeferred(),
		});
		await session.followUp("and then tidy the changelog");
		expect(cfgUltracode.get(created.settings)).toBe(false);

		const queue = session.agent.peekFollowUpQueue();
		deliverQueued(queue.find(m => m.role === "developer"));
		expect(cfgUltracode.get(created.settings)).toBe(true);
		deliverQueued(queue.find(m => m.role === "user"));

		// Same synchronous commit batch as the arm: the turn carries the
		// keyword, so the older keyword-free rider stands down and the batch
		// runs armed.
		expect(cfgUltracode.get(created.settings)).toBe(true);
		expect(session.thinkingLevel).toBe(Effort.XHigh);
	});

	it("disarms when the same older keyword-free follow-up is delivered as its own later batch", async () => {
		// Default `followUpMode` (one-at-a-time): the follow-up queued before the
		// arm becomes its OWN turn after the armed one ends, and a keyword-free
		// user turn ends ultracode — an enqueue-time sequence would wrongly skip it.
		const created = await createSession();
		session = created.session;
		session.setThinkingLevel(Effort.Low);
		forceStreaming(session);

		await session.followUp("<system-notice>approved</system-notice>\n\nexecute the plan", undefined, {
			synthetic: true,
			onDeliver: session.armUltracodeTurnDeferred(),
		});
		await session.followUp("and then tidy the changelog");

		const queue = session.agent.peekFollowUpQueue();
		deliverQueued(queue.find(m => m.role === "developer"));
		expect(cfgUltracode.get(created.settings)).toBe(true);
		// The agent loop's batch boundary: the arm's microtask has run.
		await Promise.resolve();
		deliverQueued(queue.find(m => m.role === "user"));

		expect(cfgUltracode.get(created.settings)).toBe(false);
		expect(session.thinkingLevel).toBe(Effort.Low);
	});

	it("still disarms when the keyword-free follow-up is queued after the arm", async () => {
		// Control for the batch case: a disarm enqueued once the turn is already
		// armed IS the newer intent, so it must land.
		const created = await createSession();
		session = created.session;
		session.setThinkingLevel(Effort.Low);
		session.armUltracodeTurn();
		expect(session.thinkingLevel).toBe(Effort.XHigh);
		forceStreaming(session);

		await session.followUp("now the keyword-free next step");
		deliverQueued(session.agent.peekFollowUpQueue().find(m => m.role === "user"));

		expect(cfgUltracode.get(created.settings)).toBe(false);
		expect(session.thinkingLevel).toBe(Effort.Low);
	});

	// --- asides: a non-interrupting join, arm-only, unless it strands into a fresh turn ---

	/**
	 * Un-forces streaming and drives the stranded-aside resume the way a mode
	 * teardown does once the session is idle; resolves with the records the
	 * fire-and-forget wake handed to agent.prompt, awaiting that call itself.
	 */
	async function resumeStranded(
		target: AgentSession,
		promptSpy: Mock<AgentSession["agent"]["prompt"]>,
	): Promise<AgentMessage[]> {
		const woke = Promise.withResolvers<AgentMessage[]>();
		promptSpy.mockImplementation(async (records: unknown) => {
			woke.resolve(records as AgentMessage[]);
		});
		Object.defineProperty(target, "isStreaming", { configurable: true, get: () => false });
		await target.runModeExitTeardown(async () => {});
		return woke.promise;
	}

	it("an aside joining a running turn is arm-only: keyword arms at delivery, keyword-free attaches nothing", async () => {
		const created = await createSession();
		session = created.session;
		session.setThinkingLevel(Effort.Low);
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);
		session.setIrcWakeTurnObserver(() => undefined);
		forceStreaming(session);

		// v18.1.16's third queue mode: folded in at the next step boundary rather
		// than interrupting, so like a steer it must never yank the pin out from
		// under the turn it joins.
		await session.prompt("also mind the tests", { streamingBehavior: "aside" });
		expect(cfgUltracode.get(created.settings)).toBe(false);
		expect(session.thinkingLevel).toBe(Effort.Low);

		await session.prompt("ultracode the rest of this turn", { streamingBehavior: "aside" });
		expect(cfgUltracode.get(created.settings)).toBe(false);
		// Deliver both asides exactly as the loop's aside poll does: the wake path
		// hands the stranded records to agent.prompt, whose commit fires the hooks.
		const records = await resumeStranded(session, promptSpy);
		const [plain, keyword] = records.filter(m => m.role === "user");
		expect(queuedHook(plain)).toBeUndefined();
		deliverQueued(keyword);
		expect(cfgUltracode.get(created.settings)).toBe(true);
		expect(session.thinkingLevel).toBe(Effort.XHigh);
	});

	it("a keyword-free user aside that strands into a fresh turn ends ultracode like any turn-starting message", async () => {
		// The aside's normalization await can outlast the run it meant to join;
		// #resumeStrandedIrcAsides then STARTS a turn from it. An arm-only aside
		// carries no disarm hook, so without the wake-time off-ramp that fresh
		// turn would silently inherit the previous turn's xhigh pin.
		const created = await createSession();
		session = created.session;
		session.setThinkingLevel(Effort.Low);
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);
		session.setIrcWakeTurnObserver(() => undefined);
		await session.prompt("please ultracode this refactor");
		expect(session.thinkingLevel).toBe(Effort.XHigh);

		forceStreaming(session);
		await session.prompt("now the keyword-free next step", { streamingBehavior: "aside" });
		// Still joined to the (forced) running turn: nothing flips at enqueue.
		expect(cfgUltracode.get(created.settings)).toBe(true);

		await resumeStranded(session, promptSpy);
		expect(cfgUltracode.get(created.settings)).toBe(false);
		expect(session.thinkingLevel).toBe(Effort.Low);
	});

	it("a stranded aside carrying the keyword keeps its arm: the wake off-ramp defers to the hook", async () => {
		const created = await createSession();
		session = created.session;
		session.setThinkingLevel(Effort.Low);
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);
		session.setIrcWakeTurnObserver(() => undefined);
		await session.prompt("please ultracode this refactor");
		expect(cfgUltracode.get(created.settings)).toBe(true);

		forceStreaming(session);
		await session.prompt("ultracode the follow-on too", { streamingBehavior: "aside" });
		const records = await resumeStranded(session, promptSpy);

		// No disarm churn ahead of the arm: the flag never dropped, and the
		// record's own hook re-pins at commit.
		expect(cfgUltracode.get(created.settings)).toBe(true);
		deliverQueued(records.find(m => m.role === "user"));
		expect(cfgUltracode.get(created.settings)).toBe(true);
		expect(session.thinkingLevel).toBe(Effort.XHigh);
	});

	it("a child never takes the stranded-aside off-ramp", async () => {
		const created = await createSession({ agentKind: "sub", ultracode: true, thinkingLevel: Effort.XHigh });
		session = created.session;
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);
		session.setIrcWakeTurnObserver(() => undefined);

		forceStreaming(session);
		await session.prompt("keyword-free child aside", { streamingBehavior: "aside" });
		await resumeStranded(session, promptSpy);

		// The child's own text never ends a flag: only the live parent does, at the
		// wake's resume sync (see the stranded-wake cases), and there is none here.
		expect(cfgUltracode.get(created.settings)).toBe(true);
	});

	// --- fail-loud: a model with no xhigh rung ----------------------------------

	it("does not arm a typed ultracode turn on a model without xhigh, and tells the user", async () => {
		const created = await createSession({ modelId: NO_XHIGH_MODEL_ID });
		session = created.session;
		session.setThinkingLevel(Effort.Low);
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);

		await session.prompt("please ultracode this refactor");

		// Nothing floored, nothing pinned: the executor would otherwise read the
		// flag and throw on the first spawn, and the level would silently be
		// "high under the ultracode name".
		expect(cfgUltracode.get(created.settings)).toBe(false);
		expect(session.thinkingLevel).toBe(Effort.Low);
		// The turn still dispatches — refusing the pin is not refusing the prompt.
		expect(promptSpy).toHaveBeenCalledTimes(1);
		// ...and the refusal is user-visible, naming the model and its ladder.
		const warning = created.notices.find(notice => notice.source === "ultracode");
		expect(warning?.level).toBe("warning");
		expect(warning?.message).toContain("ultracode requires xhigh");
		expect(warning?.message).toContain(NO_XHIGH_MODEL_ID);
		expect(warning?.message).toContain("not armed");
	});

	it("armUltracodeTurn() pins exactly xhigh and returns the plan-approval notice on a capable model", async () => {
		const created = await createSession();
		session = created.session;
		session.setThinkingLevel(Effort.Low);

		const notice = session.armUltracodeTurn();

		expect(cfgUltracode.get(created.settings)).toBe(true);
		expect(session.thinkingLevel).toBe(Effort.XHigh);
		expect(notice.startsWith("<system-notice>")).toBe(true);
		expect(notice).toContain("approved a plan");
		expect(notice).toContain("exactly xhigh");
		expect(notice).not.toContain("NOT armed");
		expect(created.notices).toEqual([]);
	});

	it("armUltracodeTurn() leaves a model without xhigh unarmed, warns, and says so in the notice", async () => {
		const created = await createSession({ modelId: NO_XHIGH_MODEL_ID });
		session = created.session;
		session.setThinkingLevel(Effort.Low);

		const notice = session.armUltracodeTurn();

		expect(cfgUltracode.get(created.settings)).toBe(false);
		expect(session.thinkingLevel).toBe(Effort.Low);
		// The notice still ships (the plan still executes), but it must not
		// promise the model an effort the harness refused to substitute for.
		expect(notice).toContain("NOT armed");
		expect(notice).not.toContain("has already pinned");
		const warning = created.notices.find(notice => notice.source === "ultracode");
		expect(warning?.level).toBe("warning");
		expect(warning?.message).toContain("ultracode requires xhigh");
		expect(warning?.message).toContain("not armed");
	});

	it("armUltracodeTurnDeferred() arms nothing until the thunk fires", async () => {
		const created = await createSession();
		session = created.session;
		session.setThinkingLevel(Effort.Low);

		const deliver = session.armUltracodeTurnDeferred();

		// The thunk is what rides a queued follow-up as its delivery hook, so
		// building it must be side-effect free.
		expect(cfgUltracode.get(created.settings)).toBe(false);
		expect(session.thinkingLevel).toBe(Effort.Low);

		deliver();
		expect(cfgUltracode.get(created.settings)).toBe(true);
		expect(session.thinkingLevel).toBe(Effort.XHigh);
	});

	// --- off-ramps: session transitions and user-driven level picks -----------

	it("disarmUltracodeTurn() drops the flag and hands the level back", async () => {
		const created = await createSession();
		session = created.session;
		session.setThinkingLevel(Effort.Low);
		session.armUltracodeTurn();
		expect(session.thinkingLevel).toBe(Effort.XHigh);

		session.disarmUltracodeTurn();

		expect(cfgUltracode.get(created.settings)).toBe(false);
		expect(session.thinkingLevel).toBe(Effort.Low);
	});

	it("disarmUltracodeTurn() is a no-op on an unarmed session", async () => {
		const created = await createSession();
		session = created.session;
		session.setThinkingLevel(Effort.Medium);

		session.disarmUltracodeTurn();

		expect(cfgUltracode.get(created.settings)).toBe(false);
		expect(session.thinkingLevel).toBe(Effort.Medium);
	});

	it("newSession() disarms an armed turn, so a fresh session never starts at xhigh", async () => {
		const created = await createSession();
		session = created.session;
		session.setThinkingLevel(Effort.Low);
		vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);
		await session.prompt("please ultracode this refactor");
		expect(cfgUltracode.get(created.settings)).toBe(true);
		expect(session.configuredThinkingLevel()).toBe(Effort.XHigh);

		expect(await session.newSession()).toBe(true);

		// Both halves: the executor's flag AND the borrowed level. Leaking either
		// makes the next session's first turn (and its spawns) run armed.
		expect(cfgUltracode.get(created.settings)).toBe(false);
		expect(session.thinkingLevel).toBe(Effort.Low);
		// The configured selector is the user's own again, not the pin: newSession
		// re-applies and records `configuredThinkingLevel()`, so a disarm landing
		// after that would write xhigh into the fresh transcript as its own level
		// (and a resume would replay it).
		expect(session.configuredThinkingLevel()).toBe(Effort.Low);
		const levelEntries = session.sessionManager
			.getEntries()
			.filter(entry => entry.type === "thinking_level_change")
			.map(entry => ({ thinkingLevel: entry.thinkingLevel, configured: entry.configured }));
		expect(levelEntries.length).toBeGreaterThan(0);
		expect(levelEntries[0]).toEqual({ thinkingLevel: Effort.Low, configured: Effort.Low });
		for (const entry of levelEntries) {
			expect(entry.thinkingLevel).not.toBe(Effort.XHigh);
			expect(entry.configured).not.toBe(Effort.XHigh);
		}
	});

	it("switchSession() disarms an armed turn the same way", async () => {
		const created = await createSession();
		session = created.session;
		session.setThinkingLevel(Effort.Low);
		vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);
		await session.prompt("please ultracode this refactor");
		expect(session.thinkingLevel).toBe(Effort.XHigh);

		expect(await session.switchSession(await writeSwitchTarget())).toBe(true);

		// The target session brings its own level (none recorded here, so the
		// agent's initial `high`); what matters is that the armed state did not
		// ride across: no flag, no xhigh, and no pending handback waiting to
		// overwrite the target's level on its first keyword-free turn.
		expect(cfgUltracode.get(created.settings)).toBe(false);
		expect(session.thinkingLevel).not.toBe(Effort.XHigh);
		const restored = session.thinkingLevel;
		expect(restored).not.toBe(Effort.Low);
		await session.prompt("keyword-free follow-up in the target session");
		expect(session.thinkingLevel).toBe(restored);
	});

	it("keeps the user's explicit selector pick instead of the stale ultracode handback", async () => {
		const created = await createSession();
		session = created.session;
		session.setThinkingLevel(Effort.Low);
		vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);
		await session.prompt("please ultracode this refactor");
		expect(session.thinkingLevel).toBe(Effort.XHigh);

		// The selector / RPC / ACP path: an unambiguous "I want THIS effort". It
		// drops the pending restore and the subagent floor with it.
		session.setThinkingLevel(Effort.Medium);
		expect(cfgUltracode.get(created.settings)).toBe(false);
		expect(session.thinkingLevel).toBe(Effort.Medium);

		// The next keyword-free turn's handback must not overwrite the pick.
		await session.prompt("keyword-free follow-up");
		expect(session.thinkingLevel).toBe(Effort.Medium);
	});

	/** The pick target for the model-selector cases: xhigh-capable, no default level of its own. */
	function pickedModel(): Model<Api> {
		const picked = modelRegistry.find("anthropic", "claude-opus-4-5");
		if (!picked) throw new Error("Expected bundled anthropic/claude-opus-4-5");
		// The fixture only proves something if the pick carries no level: then
		// "what lands" is entirely the handback's doing.
		expect(picked.thinking?.defaultLevel).toBeUndefined();
		return picked;
	}

	it("hands the pre-ultracode level back when the user picks a model without a level", async () => {
		const created = await createSession();
		session = created.session;
		session.setThinkingLevel(Effort.Low);
		vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);
		await session.prompt("please ultracode this refactor");
		expect(session.thinkingLevel).toBe(Effort.XHigh);

		// The model selector / `/model` path is the user's own choice and ends
		// the turn: the flag comes off so the next spawn does not floor at a
		// level the user walked away from. A pick that names no level must land
		// on the level the user OWNED before the keyword — never on the borrowed
		// xhigh, which would quietly become the session's level under the new
		// model. Internal swaps (retry fallback, prewalk, compaction promotion)
		// re-pin instead — see the "extension"/"internal" cases below.
		await session.setModel(pickedModel());

		expect(session.model?.id).toBe("claude-opus-4-5");
		expect(cfgUltracode.get(created.settings)).toBe(false);
		expect(session.thinkingLevel).toBe(Effort.Low);

		// And the handback is spent, not pending: a later plain level set is not
		// overwritten by a stale restore on the next keyword-free turn.
		session.setThinkingLevel(Effort.Medium, false, "extension");
		await session.prompt("keyword-free follow-up");
		expect(cfgUltracode.get(created.settings)).toBe(false);
		expect(session.thinkingLevel).toBe(Effort.Medium);
	});

	it("lets an explicit level on the user's model pick win over the handback", async () => {
		const created = await createSession();
		session = created.session;
		session.setThinkingLevel(Effort.Low);
		vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);
		await session.prompt("please ultracode this refactor");
		expect(session.thinkingLevel).toBe(Effort.XHigh);

		await session.setModelTemporary(pickedModel(), Effort.Medium);

		expect(cfgUltracode.get(created.settings)).toBe(false);
		expect(session.thinkingLevel).toBe(Effort.Medium);
		await session.prompt("keyword-free follow-up");
		expect(session.thinkingLevel).toBe(Effort.Medium);
	});

	it("re-pins instead of disarming when an extension swaps the model mid-turn", async () => {
		const created = await createSession();
		session = created.session;
		session.setThinkingLevel(Effort.Low);
		vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);
		await session.prompt("please ultracode this refactor");
		expect(session.thinkingLevel).toBe(Effort.XHigh);

		// An extension runtime swapping models is not the user reaching for the
		// selector: the armed turn survives the swap and re-pins on the new
		// model, and the handback still points at the ORIGINAL borrowed level.
		await session.setModel(pickedModel(), "default", undefined, "extension");

		expect(session.model?.id).toBe("claude-opus-4-5");
		expect(cfgUltracode.get(created.settings)).toBe(true);
		expect(session.thinkingLevel).toBe(Effort.XHigh);
		expect(created.notices.filter(notice => notice.source === "ultracode")).toEqual([]);

		await session.prompt("keyword-free follow-up");
		expect(cfgUltracode.get(created.settings)).toBe(false);
		expect(session.thinkingLevel).toBe(Effort.Low);
	});

	it("re-pins over the level an internal temporary swap brings with it, and hands back to that level", async () => {
		const created = await createSession();
		session = created.session;
		session.setThinkingLevel(Effort.Low);
		vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);
		await session.prompt("please ultracode this refactor");
		expect(session.thinkingLevel).toBe(Effort.XHigh);

		// The prewalk / deferred plan-model shape: an internal swap that names
		// its own level. The keyword outranks it for this turn, but that level is
		// where the session would be without the keyword, so the turn hands back
		// to it rather than to the level the swap replaced.
		await session.setModelTemporary(pickedModel(), Effort.Medium, undefined, "internal");

		expect(cfgUltracode.get(created.settings)).toBe(true);
		expect(session.thinkingLevel).toBe(Effort.XHigh);

		await session.prompt("keyword-free follow-up");
		expect(session.thinkingLevel).toBe(Effort.Medium);
	});

	it("warns when an internal swap lands on a model that cannot carry the pin", async () => {
		const created = await createSession();
		session = created.session;
		session.setThinkingLevel(Effort.Low);
		vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);
		await session.prompt("please ultracode this refactor");
		expect(session.thinkingLevel).toBe(Effort.XHigh);

		const noXhigh = modelRegistry.find("anthropic", NO_XHIGH_MODEL_ID);
		if (!noXhigh) throw new Error(`Expected bundled anthropic/${NO_XHIGH_MODEL_ID}`);
		await session.setModelTemporary(noXhigh, undefined, undefined, "extension");

		// Never a silent clamp: the turn is still armed (the swap was not the
		// user's), the pin could not land, and the user is told which model
		// refused it.
		expect(cfgUltracode.get(created.settings)).toBe(true);
		expect(session.thinkingLevel).not.toBe(Effort.XHigh);
		const warning = created.notices.find(notice => notice.source === "ultracode");
		expect(warning?.level).toBe("warning");
		expect(warning?.message).toContain("cannot re-pin xhigh");
		expect(warning?.message).toContain(NO_XHIGH_MODEL_ID);
	});

	it("warns when a prewalk restart swaps the armed turn onto a model that cannot carry the pin", async () => {
		// The prewalk host swaps through ModelControls directly ("automatic", so
		// the hand-off survives) rather than the session wrapper; the refused
		// re-pin warning has to be raised on that path too, or the swap lands
		// below xhigh silently.
		const created = await createSession();
		session = created.session;
		session.setThinkingLevel(Effort.Low);
		vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);
		await session.prompt("please ultracode this refactor");
		expect(session.thinkingLevel).toBe(Effort.XHigh);

		const noXhigh = modelRegistry.find("anthropic", NO_XHIGH_MODEL_ID);
		if (!noXhigh) throw new Error(`Expected bundled anthropic/${NO_XHIGH_MODEL_ID}`);
		await session.restartPrewalk(noXhigh, undefined, pickedModel(), undefined);

		expect(session.model?.id).toBe(NO_XHIGH_MODEL_ID);
		expect(cfgUltracode.get(created.settings)).toBe(true);
		expect(session.thinkingLevel).not.toBe(Effort.XHigh);
		const warning = created.notices.find(notice => notice.source === "ultracode");
		expect(warning?.level).toBe("warning");
		expect(warning?.message).toContain("cannot re-pin xhigh");
		expect(warning?.message).toContain(NO_XHIGH_MODEL_ID);
	});

	it("re-pins exactly xhigh, silently, when a prewalk restart lands on an xhigh-capable model", async () => {
		const created = await createSession();
		session = created.session;
		session.setThinkingLevel(Effort.Low);
		vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);
		await session.prompt("please ultracode this refactor");

		const target = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!target) throw new Error("Expected bundled anthropic/claude-sonnet-4-5");
		await session.restartPrewalk(pickedModel(), Effort.Medium, target, undefined);

		expect(session.model?.id).toBe("claude-opus-4-5");
		expect(cfgUltracode.get(created.settings)).toBe(true);
		expect(session.thinkingLevel).toBe(Effort.XHigh);
		expect(created.notices.filter(notice => notice.source === "ultracode")).toEqual([]);
	});

	it("swaps plainly on an extension-sourced pick when no turn is armed", async () => {
		// Control for the two above: outside an armed turn the extension's swap
		// is just a swap — no re-pin, no warning, no flag.
		const created = await createSession();
		session = created.session;
		session.setThinkingLevel(Effort.Low);

		await session.setModelTemporary(pickedModel(), Effort.Medium, undefined, "extension");

		expect(cfgUltracode.get(created.settings)).toBe(false);
		expect(session.thinkingLevel).toBe(Effort.Medium);
		expect(created.notices).toEqual([]);
	});

	it("does not off-ramp on an extension-sourced setThinkingLevel; it re-pins instead", async () => {
		const created = await createSession();
		session = created.session;
		session.setThinkingLevel(Effort.Low);
		vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);
		await session.prompt("please ultracode this refactor");
		expect(session.thinkingLevel).toBe(Effort.XHigh);

		// An extension runtime (executor / persisted-revive wiring) setting a
		// level mid-turn is not the user reaching for the control: the floor and
		// the pin survive, and the armed turn re-pins over the extension's level.
		session.setThinkingLevel(Effort.Medium, false, "extension");
		expect(cfgUltracode.get(created.settings)).toBe(true);
		expect(session.thinkingLevel).toBe(Effort.XHigh);

		// The pending handback is intact: the next keyword-free turn restores the
		// ORIGINAL borrowed level, not the extension's interim one.
		await session.prompt("keyword-free follow-up");
		expect(cfgUltracode.get(created.settings)).toBe(false);
		expect(session.thinkingLevel).toBe(Effort.Low);
	});

	it("applies an extension-sourced setThinkingLevel plainly when no turn is armed", async () => {
		// Control for the re-pin above: outside an armed turn the extension's
		// level lands as-is, proving the re-pin came from the armed flag.
		const created = await createSession();
		session = created.session;
		session.setThinkingLevel(Effort.Low);

		session.setThinkingLevel(Effort.Medium, false, "extension");

		expect(cfgUltracode.get(created.settings)).toBe(false);
		expect(session.thinkingLevel).toBe(Effort.Medium);
	});

	// --- dropped dispatch: the arm must not outlive a turn that never ran ------

	it("rolls the arm back when prompt()'s dispatch throws before the turn runs", async () => {
		const created = await createSession();
		session = created.session;
		session.setThinkingLevel(Effort.Low);
		vi.spyOn(session.agent, "prompt").mockRejectedValue(new Error("dispatch failed"));

		await expect(session.prompt("please ultracode this refactor")).rejects.toThrow("dispatch failed");

		// A turn that never started must leave no armed state behind: the flag
		// would otherwise floor every spawn of the NEXT turn, and the pin would
		// run it at xhigh with no keyword in sight.
		expect(cfgUltracode.get(created.settings)).toBe(false);
		expect(session.thinkingLevel).toBe(Effort.Low);

		// And no stale handback either: a later plain level set survives the next
		// keyword-free turn, which would otherwise "restore" low over it.
		vi.restoreAllMocks();
		vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);
		session.setThinkingLevel(Effort.Medium, false, "extension");
		await session.prompt("keyword-free follow-up");
		expect(session.thinkingLevel).toBe(Effort.Medium);
	});

	it("rolls the arm back on the promptCustomMessage direct path too", async () => {
		const created = await createSession();
		session = created.session;
		session.setThinkingLevel(Effort.Low);
		vi.spyOn(session.agent, "prompt").mockRejectedValue(new Error("dispatch failed"));

		const details: SkillPromptDetails = {
			name: "deep-work",
			path: "/skills/deep-work/SKILL.md",
			args: "ultracode the refactor",
			lineCount: 1,
		};
		await expect(
			session.promptCustomMessage({
				customType: SKILL_PROMPT_MESSAGE_TYPE,
				content: `Skill body\n\nUser: ${details.args}`,
				display: true,
				details,
				attribution: "user",
			}),
		).rejects.toThrow("dispatch failed");

		expect(cfgUltracode.get(created.settings)).toBe(false);
		expect(session.thinkingLevel).toBe(Effort.Low);
	});

	// --- abort races in admission: the drop paths that never reach a dispatch --

	const IMAGE: ImageContent = {
		type: "image",
		mimeType: "image/png",
		data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
	};

	/** Holds image normalization for image-bearing calls until released, like a slow resize. */
	function holdImageNormalization(): { started: Promise<void>; release: () => void } {
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		vi.spyOn(imageLoading, "normalizeModelContextImages").mockImplementation(async images => {
			if (!images?.length) return images;
			started.resolve();
			await release.promise;
			return images;
		});
		return { started: started.promise, release: () => release.resolve() };
	}

	it("hands a plan-approval arm back through onDropped when an abort drops the dispatch during image prep", async () => {
		// v18.9.0 (70b7c0223b) drops a prompt whose admission an abort raced
		// (image normalization / vision description) BEFORE any dispatch, and
		// prompt() still resolves true. Plan approval armed ahead of the call;
		// its onDropped undo is the only way that pin and floor come back down.
		const created = await createSession();
		session = created.session;
		session.setThinkingLevel(Effort.Low);
		const agentPrompt = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);
		const { undo } = session.armUltracodeTurnWithUndo();
		expect(typeof undo).toBe("function");
		expect(session.thinkingLevel).toBe(Effort.XHigh);
		const normalization = holdImageNormalization();
		let dropped = 0;

		const dispatch = session.prompt("<system-notice>approved</system-notice>\n\nexecute the plan", {
			synthetic: true,
			images: [IMAGE],
			onDropped: () => {
				dropped++;
				undo?.();
			},
		});
		await withTimeout(normalization.started, 2_000, "Normalization never started");
		await session.abort();
		normalization.release();

		expect(await dispatch).toBe(true);
		expect(agentPrompt).not.toHaveBeenCalled();
		expect(dropped).toBe(1);
		expect(cfgUltracode.get(created.settings)).toBe(false);
		expect(session.thinkingLevel).toBe(Effort.Low);
	});

	it("does not leave a skill-args arm behind when an abort drops the skill during its image prep", async () => {
		// The skill path arms only right before #promptWithMessage, after the
		// skill-image awaits and their drop: arming any earlier would leave the
		// pin and floor up on a skill turn that never ran.
		const created = await createSession();
		session = created.session;
		session.setThinkingLevel(Effort.Low);
		const agentPrompt = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);
		const normalization = holdImageNormalization();
		const details: SkillPromptDetails = {
			name: "deep-work",
			path: "/skills/deep-work/SKILL.md",
			args: "ultracode the refactor",
			lineCount: 1,
		};

		const dispatch = session.promptCustomMessage({
			customType: SKILL_PROMPT_MESSAGE_TYPE,
			content: [{ type: "text", text: `Skill body\n\nUser: ${details.args}` }, IMAGE],
			display: true,
			details,
			attribution: "user",
		});
		await withTimeout(normalization.started, 2_000, "Skill image normalization never started");
		await session.abort();
		normalization.release();
		await dispatch;

		expect(agentPrompt).not.toHaveBeenCalled();
		expect(cfgUltracode.get(created.settings)).toBe(false);
		expect(session.thinkingLevel).toBe(Effort.Low);
	});

	it("arms the same image-bearing skill prompt when nothing aborts it", async () => {
		// Control for the drop above: the held image prep is not what kept the
		// flag down — released without an abort, the skill arms and dispatches.
		const created = await createSession();
		session = created.session;
		session.setThinkingLevel(Effort.Low);
		const agentPrompt = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);
		const normalization = holdImageNormalization();
		const details: SkillPromptDetails = {
			name: "deep-work",
			path: "/skills/deep-work/SKILL.md",
			args: "ultracode the refactor",
			lineCount: 1,
		};

		const dispatch = session.promptCustomMessage({
			customType: SKILL_PROMPT_MESSAGE_TYPE,
			content: [{ type: "text", text: `Skill body\n\nUser: ${details.args}` }, IMAGE],
			display: true,
			details,
			attribution: "user",
		});
		await withTimeout(normalization.started, 2_000, "Skill image normalization never started");
		normalization.release();
		await dispatch;

		expect(agentPrompt).toHaveBeenCalledTimes(1);
		expect(cfgUltracode.get(created.settings)).toBe(true);
		expect(session.thinkingLevel).toBe(Effort.XHigh);
	});

	it("undoes only what the dropped turn changed, leaving an already-armed session armed", async () => {
		const created = await createSession();
		session = created.session;
		session.setThinkingLevel(Effort.Low);
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);
		await session.prompt("please ultracode this refactor");
		expect(session.thinkingLevel).toBe(Effort.XHigh);

		// A second keyword turn that fails to dispatch changed nothing (the flag
		// was already true, the pin already up), so its undo must not disarm the
		// turn that is legitimately in flight.
		promptSpy.mockRejectedValue(new Error("dispatch failed"));
		await expect(session.prompt("ultracode this one too")).rejects.toThrow("dispatch failed");

		expect(cfgUltracode.get(created.settings)).toBe(true);
		expect(session.thinkingLevel).toBe(Effort.XHigh);
	});

	it("does not touch the level when a keyword-free turn's dispatch is dropped", async () => {
		// Control: the undo is scoped to the arm/disarm, not a blanket reset. A
		// dropped keyword-free turn on an unarmed session changes nothing and
		// must restore nothing.
		const created = await createSession();
		session = created.session;
		session.setThinkingLevel(Effort.Medium);
		vi.spyOn(session.agent, "prompt").mockRejectedValue(new Error("dispatch failed"));

		await expect(session.prompt("just a normal message")).rejects.toThrow("dispatch failed");

		expect(cfgUltracode.get(created.settings)).toBe(false);
		expect(session.thinkingLevel).toBe(Effort.Medium);
	});

	// --- root-only: a task-spawned child never arms or disarms ----------------

	it("never arms on a task-spawned child session, even for a user-attributed keyword turn", async () => {
		const created = await createSession({ agentKind: "sub" });
		session = created.session;
		session.setThinkingLevel(Effort.Low);
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);

		await session.prompt("please ultracode this refactor");

		// Children inherit the flag through the settings snapshot; they never
		// originate it. The text still dispatches.
		expect(promptSpy).toHaveBeenCalledTimes(1);
		expect(cfgUltracode.get(created.settings)).toBe(false);
		expect(session.thinkingLevel).toBe(Effort.Low);
	});

	it("never disarms an inherited flag on a task-spawned child's keyword-free turn", async () => {
		const created = await createSession({ agentKind: "sub" });
		session = created.session;
		session.setThinkingLevel(Effort.Low);
		// Exactly how a child receives the flag: baked into its settings by the
		// parent's snapshot, with the pin re-applied on resume. (Set AFTER the
		// level above: a user-sourced setThinkingLevel is itself an off-ramp.)
		cfgUltracode.override(created.settings, true);
		expect(session.repinUltracodeIfArmed()).toBe(true);
		expect(session.thinkingLevel).toBe(Effort.XHigh);
		vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);

		await session.prompt("just a normal message");

		// The root's keyword-free `else` would have cleared this and handed the
		// level back; on a child it must not run, or every grandchild spawn
		// drops off the xhigh floor.
		expect(cfgUltracode.get(created.settings)).toBe(true);
		expect(session.thinkingLevel).toBe(Effort.XHigh);
	});

	it("still arms on a root session, proving the child guard is what withheld it", async () => {
		const created = await createSession({ agentKind: "main" });
		session = created.session;
		session.setThinkingLevel(Effort.Low);
		vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);

		await session.prompt("please ultracode this refactor");

		expect(cfgUltracode.get(created.settings)).toBe(true);
		expect(session.thinkingLevel).toBe(Effort.XHigh);
	});

	// --- children hand back: the pin is borrowed even when constructed at xhigh -
	//
	// A task child is built directly at xhigh (level AND ceiling) under an
	// armed parent and never runs beginUltracodeTurn, so it has no capture of
	// its own. `ultracodeRestoreLevel` seeds one. The lifecycle sync mirrors the
	// parent's live flag at every resume boundary: parent unarmed → the child
	// disarms and hands back to that level; parent armed → re-pin, or refuse
	// loudly with the flag untouched.

	/** A registry with `Main` (a live root) and one child ref pointing at `child`. */
	function registryWith(parentSettings: Settings, child: AgentSession): { registry: AgentRegistry; childId: string } {
		const registry = new AgentRegistry();
		// Only `cfgUltracode.get(settings)` is read off the parent; a real
		// signature, never a tolerant Proxy (AGENTS.md, "Faking AgentSession").
		const parent = { settings: parentSettings } as unknown as AgentSession;
		registry.register({ id: MAIN_AGENT_ID, displayName: MAIN_AGENT_ID, kind: "main", session: parent });
		const childId = `${MAIN_AGENT_ID}.Child`;
		registry.register({ id: childId, displayName: "task", kind: "sub", parentId: MAIN_AGENT_ID, session: child });
		return { registry, childId };
	}

	it("disarms a child constructed at xhigh to its restore level once the parent is unarmed", async () => {
		// Exactly how the executor builds an ultracode child: pinned level,
		// pinned ceiling, the flag baked into its settings, and the level it
		// would have run at without the pin as the handback.
		const created = await createSession({
			agentKind: "sub",
			thinkingLevel: Effort.XHigh,
			thinkingLevelCeiling: Effort.XHigh,
			ultracodeRestoreLevel: Effort.Low,
			ultracode: true,
		});
		session = created.session;
		expect(session.thinkingLevel).toBe(Effort.XHigh);
		const { registry, childId } = registryWith(Settings.isolated(), session);

		syncChildUltracodeAtResume(childId, session, registry);

		// Both halves: no floor for the grandchildren, and the child's own level
		// is the one it was given to hand back — not xhigh left behind as if it
		// had been the child's choice.
		expect(cfgUltracode.get(created.settings)).toBe(false);
		expect(session.thinkingLevel).toBe(Effort.Low);
		expect(session.userConfiguredThinkingLevel()).toBe(Effort.Low);
	});

	it("reports the restore level, not the pin, as the user's level while the child is armed", async () => {
		const created = await createSession({
			agentKind: "sub",
			thinkingLevel: Effort.XHigh,
			thinkingLevelCeiling: Effort.XHigh,
			ultracodeRestoreLevel: AUTO_THINKING,
			ultracode: true,
		});
		session = created.session;

		// Persistence and "what does the user want" reads must never record the
		// borrowed xhigh as the session's own selector.
		expect(session.configuredThinkingLevel()).toBe(Effort.XHigh);
		expect(session.userConfiguredThinkingLevel()).toBe(AUTO_THINKING);
	});

	it("ignores a restore level on a session that is not born armed", async () => {
		// `#levelBeforeUltracode` set means "a pin is borrowed"; an unarmed
		// session carrying one would later hand back a level nobody borrowed.
		const created = await createSession({
			agentKind: "sub",
			thinkingLevel: Effort.XHigh,
			ultracodeRestoreLevel: Effort.Low,
		});
		session = created.session;

		expect(session.userConfiguredThinkingLevel()).toBe(Effort.XHigh);
		session.disarmUltracodeTurn();
		expect(session.thinkingLevel).toBe(Effort.XHigh);
	});

	it("re-pins a child at resume when the parent is armed", async () => {
		const created = await createSession({ agentKind: "sub", thinkingLevel: Effort.Low });
		session = created.session;
		const { registry, childId } = registryWith(Settings.isolated({ ultracode: true }), session);

		syncChildUltracodeAtResume(childId, session, registry);

		expect(cfgUltracode.get(created.settings)).toBe(true);
		expect(session.thinkingLevel).toBe(Effort.XHigh);
		// The child captured its own handback at the re-pin.
		expect(session.userConfiguredThinkingLevel()).toBe(Effort.Low);
	});

	it("refuses to flag a child whose model has no xhigh rung, naming the ladder", async () => {
		const created = await createSession({ agentKind: "sub", modelId: NO_XHIGH_MODEL_ID, thinkingLevel: Effort.Low });
		session = created.session;
		const { registry, childId } = registryWith(Settings.isolated({ ultracode: true }), session);

		expect(() => syncChildUltracodeAtResume(childId, session!, registry)).toThrow(UltracodeEffortError);
		expect(() => syncChildUltracodeAtResume(childId, session!, registry)).toThrow(NO_XHIGH_MODEL_ID);

		// Refuse BEFORE the flag write: a flagged-but-unpinned child would floor
		// its own spawns at a level it is not running at.
		expect(cfgUltracode.get(created.settings)).toBe(false);
		expect(session.thinkingLevel).toBe(Effort.Low);
	});

	it("refuses to flag a child whose effort ceiling caps the pin below xhigh, and says so", async () => {
		// The rung exists; the ceiling is what refuses. The message has to name
		// the ceiling, or the operator goes looking for a missing tier.
		const created = await createSession({
			agentKind: "sub",
			thinkingLevel: Effort.Low,
			thinkingLevelCeiling: Effort.High,
		});
		session = created.session;
		expect(session.ultracodePinRefusal()).toBe("ceiling");
		const { registry, childId } = registryWith(Settings.isolated({ ultracode: true }), session);

		expect(() => syncChildUltracodeAtResume(childId, session!, registry)).toThrow(/ceiling/);

		expect(cfgUltracode.get(created.settings)).toBe(false);
		expect(session.thinkingLevel).toBe(Effort.Low);
	});

	it("never leaves a child flagged-but-unpinned: a stale flag is dropped before a refused re-pin throws", async () => {
		// A cold revive seeds the flag from the persisted session_init; if the
		// child's model cannot take the pin now, throwing with the flag still up
		// would floor its own spawns at a level it is not running at.
		const created = await createSession({ agentKind: "sub", modelId: NO_XHIGH_MODEL_ID, thinkingLevel: Effort.Low });
		session = created.session;
		cfgUltracode.override(created.settings, true);
		const { registry, childId } = registryWith(Settings.isolated({ ultracode: true }), session);

		expect(() => syncChildUltracodeAtResume(childId, session!, registry)).toThrow(UltracodeEffortError);

		expect(cfgUltracode.get(created.settings)).toBe(false);
		expect(session.thinkingLevel).toBe(Effort.Low);
	});

	it("leaves a root alone at resume: its arm and disarm belong to the user turn", async () => {
		const created = await createSession();
		session = created.session;
		session.setThinkingLevel(Effort.Low);
		session.armUltracodeTurn();
		const registry = new AgentRegistry();
		registry.register({ id: MAIN_AGENT_ID, displayName: MAIN_AGENT_ID, kind: "main", session });

		syncChildUltracodeAtResume(MAIN_AGENT_ID, session, registry);

		expect(cfgUltracode.get(created.settings)).toBe(true);
		expect(session.thinkingLevel).toBe(Effort.XHigh);
	});

	// --- a user prompt typed into a focused kept-alive child is a resume boundary
	//
	// The executor and the IRC bus mirror the parent's live flag before the
	// child turns THEY start. A user typing straight into a focused child starts
	// one too, so the same sync runs before that turn reads its effort: hand the
	// borrowed xhigh back once the parent disarmed, re-pin while it is armed,
	// refuse loudly when this model cannot hold xhigh.

	/** A kept-alive child the executor built under an armed parent: pinned, flagged, restore level low. */
	function pinnedChild(): Promise<CreatedSession> {
		return createSession({
			agentKind: "sub",
			agentId: FOCUSED_CHILD_ID,
			thinkingLevel: Effort.XHigh,
			thinkingLevelCeiling: Effort.XHigh,
			ultracodeRestoreLevel: Effort.Low,
			ultracode: true,
		});
	}

	it("hands a focused child's borrowed xhigh back before a typed prompt once the parent disarmed", async () => {
		const created = await pinnedChild();
		session = created.session;
		const target = session;
		registerFocusedChild(Settings.isolated(), session);
		let levelAtDispatch: unknown;
		vi.spyOn(session.agent, "prompt").mockImplementation(async () => {
			levelAtDispatch = target.thinkingLevel;
		});

		await session.prompt("hi");

		// Before the model call, not after: the turn itself runs at the child's own level.
		expect(levelAtDispatch).toBe(Effort.Low);
		expect(cfgUltracode.get(created.settings)).toBe(false);
		expect(session.thinkingLevel).toBe(Effort.Low);
	});

	it("re-pins a focused child at xhigh before a typed prompt while the parent is armed", async () => {
		const created = await createSession({ agentKind: "sub", agentId: FOCUSED_CHILD_ID, thinkingLevel: Effort.Low });
		session = created.session;
		const target = session;
		registerFocusedChild(Settings.isolated({ ultracode: true }), session);
		let levelAtDispatch: unknown;
		vi.spyOn(session.agent, "prompt").mockImplementation(async () => {
			levelAtDispatch = target.thinkingLevel;
		});

		await session.prompt("hi");

		expect(levelAtDispatch).toBe(Effort.XHigh);
		expect(cfgUltracode.get(created.settings)).toBe(true);
		expect(session.userConfiguredThinkingLevel()).toBe(Effort.Low);
	});

	it("fails a focused child's typed prompt loudly when the parent is armed and the model has no xhigh", async () => {
		const created = await createSession({
			agentKind: "sub",
			agentId: FOCUSED_CHILD_ID,
			modelId: NO_XHIGH_MODEL_ID,
			thinkingLevel: Effort.Low,
		});
		session = created.session;
		registerFocusedChild(Settings.isolated({ ultracode: true }), session);
		const agentPrompt = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);

		await expect(session.prompt("hi")).rejects.toThrow(UltracodeEffortError);

		// Nothing dispatched at a substitute level, and never flagged-but-unpinned.
		expect(agentPrompt).not.toHaveBeenCalled();
		expect(cfgUltracode.get(created.settings)).toBe(false);
		expect(session.thinkingLevel).toBe(Effort.Low);
	});

	it("syncs a focused child's queued follow-up at delivery, never at enqueue, and gives a steer nothing", async () => {
		const created = await pinnedChild();
		session = created.session;
		registerFocusedChild(Settings.isolated(), session);
		forceStreaming(session);

		await session.prompt("next step", { streamingBehavior: "followUp" });
		await session.prompt("also mind the tests", { streamingBehavior: "steer" });

		// The child's in-flight turn keeps the pin it started with.
		expect(cfgUltracode.get(created.settings)).toBe(true);
		expect(session.thinkingLevel).toBe(Effort.XHigh);
		// The steer joins that running turn: not a boundary, no rider.
		expect(queuedHook(session.agent.peekSteeringQueue().find(m => m.role === "user"))).toBeUndefined();

		deliverQueued(session.agent.peekFollowUpQueue().find(m => m.role === "user"));
		expect(cfgUltracode.get(created.settings)).toBe(false);
		expect(session.thinkingLevel).toBe(Effort.Low);
	});

	it("reports a refused pin at a focused child's queued follow-up delivery and runs the turn unarmed", async () => {
		const created = await createSession({
			agentKind: "sub",
			agentId: FOCUSED_CHILD_ID,
			modelId: NO_XHIGH_MODEL_ID,
			thinkingLevel: Effort.Low,
		});
		session = created.session;
		registerFocusedChild(Settings.isolated({ ultracode: true }), session);
		forceStreaming(session);

		await session.prompt("next step", { streamingBehavior: "followUp" });
		// Delivery cannot fail the prompt, so the refusal surfaces as an error notice.
		deliverQueued(session.agent.peekFollowUpQueue().find(m => m.role === "user"));

		const error = created.notices.find(notice => notice.source === "ultracode");
		expect(error?.level).toBe("error");
		expect(error?.message).toContain("ultracode requires xhigh");
		expect(error?.message).toContain("this turn is not armed");
		expect(cfgUltracode.get(created.settings)).toBe(false);
		expect(session.thinkingLevel).toBe(Effort.Low);
	});

	it("syncs at the focused child's continue shortcut, which is synthetic but typed by the user", async () => {
		const created = await pinnedChild();
		session = created.session;
		registerFocusedChild(Settings.isolated(), session);
		vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);

		await session.prompt("continue", { synthetic: true, userInitiated: true });

		expect(cfgUltracode.get(created.settings)).toBe(false);
		expect(session.thinkingLevel).toBe(Effort.Low);
	});

	it("leaves a focused child alone on an agent-attributed prompt, which its executor syncs itself", async () => {
		const created = await pinnedChild();
		session = created.session;
		registerFocusedChild(Settings.isolated(), session);
		vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);

		await session.prompt("carry on with the brief", { attribution: "agent" });
		await session.prompt("continue", { synthetic: true });

		// Neither is the user's turn: the executor's own resume sync owns them.
		expect(cfgUltracode.get(created.settings)).toBe(true);
		expect(session.thinkingLevel).toBe(Effort.XHigh);
	});

	// --- notice facts: effortPinned is the arm's own predicate ---------------
	//
	// The hidden notice tells the model whether the harness pinned xhigh. That
	// fact must come from exactly the predicate the arm decides on — rung
	// present, not capped by the ceiling, and a root — or the notice promises
	// a floor the spawns will refuse to run under.

	it("does not arm under an effort ceiling below xhigh, and the notice says NOT armed", async () => {
		const created = await createSession({ thinkingLevelCeiling: Effort.High });
		session = created.session;
		session.setThinkingLevel(Effort.Low);
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);
		expect(session.canPinUltracode()).toBe(false);
		expect(session.ultracodePinRefusal()).toBe("ceiling");

		await session.prompt("please ultracode this refactor");

		// The rung exists on this model; the ceiling is what refuses. Nothing is
		// pinned or floored, and the notice must not claim otherwise.
		expect(cfgUltracode.get(created.settings)).toBe(false);
		expect(session.thinkingLevel).toBe(Effort.Low);
		const promptMessages = promptSpy.mock.calls[0]![0] as unknown as Array<{ customType?: string; content?: string }>;
		const notice = promptMessages.find(message => message.customType === "ultracode-notice")?.content ?? "";
		expect(notice).toContain("NOT armed");
		expect(notice).not.toContain("has already pinned");
		const warning = created.notices.find(notice => notice.source === "ultracode");
		expect(warning?.level).toBe("warning");
		expect(warning?.message).toContain("not armed");
	});

	it("arms under a ceiling at xhigh, proving the ceiling check is what withheld it above", async () => {
		// The executor pins ultracode children with ceiling === xhigh: that must
		// still pin, or every child would be refused by its own ceiling.
		const created = await createSession({ thinkingLevelCeiling: Effort.XHigh });
		session = created.session;
		session.setThinkingLevel(Effort.Low);
		vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);
		expect(session.canPinUltracode()).toBe(true);
		expect(session.ultracodePinRefusal()).toBeUndefined();

		await session.prompt("please ultracode this refactor");

		expect(cfgUltracode.get(created.settings)).toBe(true);
		expect(session.thinkingLevel).toBe(Effort.XHigh);
	});

	it("renders a child's plan-approval notice as NOT armed and queues no keyword notice on its turns", async () => {
		const created = await createSession({ agentKind: "sub" });
		session = created.session;
		session.setThinkingLevel(Effort.Low);
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);

		// A child never arms, so the notice would promise a workflow the
		// session cannot run: the plan-approval render says so, and the typed
		// keyword queues no notice at all.
		expect(session.canPinUltracode()).toBe(false);
		expect(session.armUltracodeTurn()).toContain("NOT armed");
		await session.prompt("please ultracode this refactor");

		const promptMessages = promptSpy.mock.calls[0]![0] as unknown as Array<{ customType?: string }>;
		expect(promptMessages.map(message => message.customType).filter(Boolean)).toEqual([]);
		expect(cfgUltracode.get(created.settings)).toBe(false);
		expect(session.thinkingLevel).toBe(Effort.Low);
	});

	// --- a child's spawn-time assignment is not a resume boundary ------------
	//
	// `/tan` and the Agents Hub architect read the parent's flag ONCE at
	// dispatch and build the child pinned (or not) from it. The child's first
	// prompt is that assignment, not a resume: re-mirroring the parent there
	// would let a parent flip between dispatch and the background job's prompt
	// re-arm or disarm the child behind its creator's back (or throw on a model
	// without xhigh although it was dispatched unarmed).

	it("keeps a spawn-assigned child at its dispatch-time pin after the parent disarmed; a later typed prompt still syncs", async () => {
		const created = await pinnedChild();
		session = created.session;
		const target = session;
		// Dispatched armed; the parent's turn has ended since.
		registerFocusedChild(Settings.isolated(), session);
		const atDispatch: Array<{ level: unknown; armed: boolean }> = [];
		vi.spyOn(session.agent, "prompt").mockImplementation(async () => {
			atDispatch.push({ level: target.thinkingLevel, armed: cfgUltracode.get(created.settings) });
		});

		await session.prompt("work the tangent", { attribution: "user", spawnAssignment: true });
		// Control: the same child's next typed prompt IS a resume boundary.
		await session.prompt("hi");

		expect(atDispatch).toEqual([
			{ level: Effort.XHigh, armed: true },
			{ level: Effort.Low, armed: false },
		]);
	});

	it("keeps a spawn-assigned child dispatched unarmed on a model without xhigh unarmed when the parent armed later", async () => {
		const created = await createSession({
			agentKind: "sub",
			agentId: FOCUSED_CHILD_ID,
			modelId: NO_XHIGH_MODEL_ID,
			thinkingLevel: Effort.Low,
		});
		session = created.session;
		registerFocusedChild(Settings.isolated({ ultracode: true }), session);
		const agentPrompt = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);

		// Without the option this prompt throws UltracodeEffortError (see the
		// focused-child refusal case above); the assignment runs as dispatched.
		await session.prompt("work the tangent", { attribution: "user", spawnAssignment: true });

		expect(agentPrompt).toHaveBeenCalledTimes(1);
		expect(cfgUltracode.get(created.settings)).toBe(false);
		expect(session.thinkingLevel).toBe(Effort.Low);
	});

	// --- a refused arm never leaves an earlier turn's flag up ---------------

	it("drops a flag still up from an earlier turn when the keyword's re-arm is refused, so the flag matches 'not armed'", async () => {
		const created = await createSession();
		session = created.session;
		session.setThinkingLevel(Effort.Low);
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);
		await session.prompt("please ultracode this refactor");
		expect(session.thinkingLevel).toBe(Effort.XHigh);

		// An extension swap keeps the armed turn (by design), onto a model that
		// cannot carry the pin.
		const noXhigh = modelRegistry.find("anthropic", NO_XHIGH_MODEL_ID);
		if (!noXhigh) throw new Error(`Expected bundled anthropic/${NO_XHIGH_MODEL_ID}`);
		await session.setModel(noXhigh, "default", undefined, "extension");
		expect(cfgUltracode.get(created.settings)).toBe(true);

		await session.prompt("ultracode the next phase");

		// The warning and the notice both say "not armed": the executor must not
		// keep flooring (or refusing) every spawn on a flag the user was told
		// is down, and the borrowed level goes back.
		expect(cfgUltracode.get(created.settings)).toBe(false);
		expect(session.thinkingLevel).toBe(Effort.Low);
		const messages = promptSpy.mock.calls[1]![0] as unknown as Array<{ customType?: string; content?: string }>;
		expect(messages.find(message => message.customType === "ultracode-notice")?.content).toContain(
			"This turn is NOT armed",
		);
		expect(created.notices.at(-1)).toMatchObject({ level: "warning", source: "ultracode" });
		expect(created.notices.at(-1)?.message).toContain("this turn is not armed");
	});

	it("words a refused arm under an effort ceiling by that ceiling, not as a missing xhigh tier", async () => {
		const created = await createSession({ thinkingLevelCeiling: Effort.High });
		session = created.session;
		session.setThinkingLevel(Effort.Low);
		vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);

		await session.prompt("please ultracode this refactor");

		// The model HAS the rung; telling the user it "exposes [..., xhigh]" and
		// still refused names the wrong fix. The ceiling is what to raise.
		const warning = created.notices.find(notice => notice.source === "ultracode");
		expect(warning?.level).toBe("warning");
		expect(warning?.message).toContain("effort ceiling (high)");
		expect(warning?.message).toContain("this turn is not armed");
		expect(warning?.message).not.toContain("exposes [");
	});

	// --- an IRC wake on a child is a resume boundary, however it was reached --
	//
	// The bus syncs a recipient that is idle at delivery. A record that strands
	// past the child's last aside poll (or a wake that lost the prompt race, or
	// one deferred while pooled) is woken later by the session itself, and that
	// turn must mirror the live parent too, not run on the previous turn's pin.

	/** {@link resumeStranded}, also recording the child's state when the wake dispatches. */
	async function wakeStranded(
		target: AgentSession,
		settings: Settings,
		promptSpy: Mock<AgentSession["agent"]["prompt"]>,
	): Promise<{ records: AgentMessage[]; level: unknown; armed: boolean }> {
		const woke = Promise.withResolvers<{ records: AgentMessage[]; level: unknown; armed: boolean }>();
		promptSpy.mockImplementation(async (records: unknown) => {
			woke.resolve({
				records: records as AgentMessage[],
				level: target.thinkingLevel,
				armed: cfgUltracode.get(settings),
			});
		});
		Object.defineProperty(target, "isStreaming", { configurable: true, get: () => false });
		await target.runModeExitTeardown(async () => {});
		return withTimeout(woke.promise, 2_000, "The stranded wake never dispatched");
	}

	it("syncs a child with its live parent before a stranded wake starts its turn", async () => {
		const created = await pinnedChild();
		session = created.session;
		registerFocusedChild(Settings.isolated(), session);
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);
		session.setIrcWakeTurnObserver(() => undefined);
		forceStreaming(session);
		await session.prompt("a note for the running turn", { streamingBehavior: "aside" });

		const wake = await wakeStranded(session, created.settings, promptSpy);

		// The parent's turn ended while the record was stranded: the wake turn
		// hands the borrowed xhigh back instead of running on it.
		expect(wake.records.some(record => record.role === "user")).toBe(true);
		expect(wake).toMatchObject({ level: Effort.Low, armed: false });
	});

	it("reports a refused pin at a child's stranded wake and still runs the woken turn, unarmed", async () => {
		const created = await createSession({
			agentKind: "sub",
			agentId: FOCUSED_CHILD_ID,
			modelId: NO_XHIGH_MODEL_ID,
			thinkingLevel: Effort.Low,
		});
		session = created.session;
		registerFocusedChild(Settings.isolated({ ultracode: true }), session);
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);
		session.setIrcWakeTurnObserver(() => undefined);
		forceStreaming(session);
		await session.prompt("a note for the running turn", { streamingBehavior: "aside" });

		const wake = await wakeStranded(session, created.settings, promptSpy);

		// The wake cannot fail its own records back to a sender, so the refusal
		// is loud as a notice, the records still land, and nothing is flagged.
		expect(wake.records.some(record => record.role === "user")).toBe(true);
		expect(wake).toMatchObject({ level: Effort.Low, armed: false });
		const error = created.notices.find(notice => notice.source === "ultracode");
		expect(error?.level).toBe("error");
		expect(error?.message).toContain("ultracode requires xhigh");
		expect(error?.message).toContain("this turn is not armed");
	});

	// --- queued-path branches the direct-path cases cannot see -----------------

	it("never arms from a queued steer or follow-up while the ultracode keyword is switched off", async () => {
		const created = await createSession();
		session = created.session;
		session.setThinkingLevel(Effort.Low);
		cfgMagicKeyword.ultracode.set(created.settings, false);
		forceStreaming(session);

		await session.prompt("ultracode the rest of this turn", { streamingBehavior: "steer" });
		await session.prompt("ultracode the next piece", { streamingBehavior: "followUp" });

		// Switched off, the word is plain text: the steer is a keyword-free steer
		// (nothing rides it) and the follow-up a keyword-free follow-up.
		expect(queuedHook(session.agent.peekSteeringQueue().find(m => m.role === "user"))).toBeUndefined();
		deliverQueued(session.agent.peekFollowUpQueue().find(m => m.role === "user"));
		expect(cfgUltracode.get(created.settings)).toBe(false);
		expect(session.thinkingLevel).toBe(Effort.Low);
	});

	it("arms a queued skill prompt that carries ultracode in its args at delivery, not at enqueue", async () => {
		const created = await createSession();
		session = created.session;
		session.setThinkingLevel(Effort.Low);
		forceStreaming(session);

		await session.promptCustomMessage(skillPrompt("ultracode the refactor"), { streamingBehavior: "followUp" });
		expect(cfgUltracode.get(created.settings)).toBe(false);

		deliverQueued(
			session.agent.peekFollowUpQueue().find(m => m.role === "custom" && m.customType === SKILL_PROMPT_MESSAGE_TYPE),
		);
		expect(cfgUltracode.get(created.settings)).toBe(true);
		expect(session.thinkingLevel).toBe(Effort.XHigh);
	});

	it("arms a skill prompt that lost the dispatch race during its image prep at delivery", async () => {
		const created = await createSession();
		session = created.session;
		session.setThinkingLevel(Effort.Low);
		const agentPrompt = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);
		const normalization = holdImageNormalization();

		const dispatch = session.promptCustomMessage(skillPrompt("ultracode the refactor", [IMAGE]), {
			streamingBehavior: "followUp",
		});
		await withTimeout(normalization.started, 2_000, "Skill image normalization never started");
		// Another submission takes the session while the images are prepared.
		forceStreaming(session);
		normalization.release();
		await dispatch;

		expect(agentPrompt).not.toHaveBeenCalled();
		expect(cfgUltracode.get(created.settings)).toBe(false);
		deliverQueued(
			session.agent.peekFollowUpQueue().find(m => m.role === "custom" && m.customType === SKILL_PROMPT_MESSAGE_TYPE),
		);
		expect(cfgUltracode.get(created.settings)).toBe(true);
		expect(session.thinkingLevel).toBe(Effort.XHigh);
	});

	it("prompt(): a keyword prompt that lost the dispatch race during its image prep arms at delivery", async () => {
		const created = await createSession();
		session = created.session;
		session.setThinkingLevel(Effort.Low);
		const agentPrompt = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);
		const normalization = holdImageNormalization();

		const dispatch = session.prompt("ultracode the rest of this turn", {
			images: [IMAGE],
			streamingBehavior: "steer",
		});
		await withTimeout(normalization.started, 2_000, "Normalization never started");
		forceStreaming(session);
		normalization.release();
		await dispatch;

		// The loser queues: nothing flips under the winner's turn at enqueue.
		expect(agentPrompt).not.toHaveBeenCalled();
		expect(cfgUltracode.get(created.settings)).toBe(false);
		deliverQueued(session.agent.peekSteeringQueue().find(m => m.role === "user"));
		expect(cfgUltracode.get(created.settings)).toBe(true);
		expect(session.thinkingLevel).toBe(Effort.XHigh);
	});

	it("prompt(): a keyword-free follow-up that lost the dispatch race disarms at delivery, not at enqueue", async () => {
		const created = await createSession();
		session = created.session;
		session.setThinkingLevel(Effort.Low);
		session.armUltracodeTurn();
		const agentPrompt = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);
		const normalization = holdImageNormalization();

		const dispatch = session.prompt("now the plain next step", { images: [IMAGE], streamingBehavior: "followUp" });
		await withTimeout(normalization.started, 2_000, "Normalization never started");
		forceStreaming(session);
		normalization.release();
		await dispatch;

		expect(agentPrompt).not.toHaveBeenCalled();
		expect(cfgUltracode.get(created.settings)).toBe(true);
		deliverQueued(session.agent.peekFollowUpQueue().find(m => m.role === "user"));
		expect(cfgUltracode.get(created.settings)).toBe(false);
		expect(session.thinkingLevel).toBe(Effort.Low);
	});

	it("sendUserMessage(): a keyword aside joining a running turn arms when the aside poll commits it", async () => {
		const created = await createSession();
		session = created.session;
		session.setThinkingLevel(Effort.Low);
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);
		session.setIrcWakeTurnObserver(() => undefined);
		forceStreaming(session);

		await session.sendUserMessage("ultracode the rest of this", { deliverAs: "aside" });
		expect(cfgUltracode.get(created.settings)).toBe(false);

		const records = await resumeStranded(session, promptSpy);
		deliverQueued(records.find(m => m.role === "user"));
		expect(cfgUltracode.get(created.settings)).toBe(true);
		expect(session.thinkingLevel).toBe(Effort.XHigh);
	});

	it("followUp(): an agent-attributed follow-up neither arms nor disarms a root, keyword or not", async () => {
		const created = await createSession();
		session = created.session;
		session.setThinkingLevel(Effort.Low);
		forceStreaming(session);

		await session.followUp("ultracode the next piece", undefined, { attribution: "agent" });
		expect(queuedHook(session.agent.peekFollowUpQueue().find(m => m.role === "user"))).toBeUndefined();
		expect(cfgUltracode.get(created.settings)).toBe(false);

		session.armUltracodeTurn();
		await session.followUp("carry on with the brief", undefined, { attribution: "agent" });
		const followUps = session.agent.peekFollowUpQueue().filter(m => m.role === "user");
		expect(followUps).toHaveLength(2);
		expect(queuedHook(followUps[1])).toBeUndefined();
		expect(cfgUltracode.get(created.settings)).toBe(true);
		expect(session.thinkingLevel).toBe(Effort.XHigh);
	});

	it("sendUserMessage(): an agent-attributed keyword aside or steer never arms a root", async () => {
		const created = await createSession();
		session = created.session;
		session.setThinkingLevel(Effort.Low);
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);
		session.setIrcWakeTurnObserver(() => undefined);
		forceStreaming(session);

		await session.sendUserMessage("ultracode this too", { deliverAs: "aside", attribution: "agent" });
		const records = await resumeStranded(session, promptSpy);
		expect(queuedHook(records.find(m => m.role === "user"))).toBeUndefined();

		forceStreaming(session);
		await session.sendUserMessage("ultracode the rest of this", { deliverAs: "steer", attribution: "agent" });
		expect(queuedHook(session.agent.peekSteeringQueue().find(m => m.role === "user"))).toBeUndefined();
		expect(cfgUltracode.get(created.settings)).toBe(false);
		expect(session.thinkingLevel).toBe(Effort.Low);
	});
});

// The queue cases above fire riders by hand. These drive the REAL agent loop
// against a mock provider and read the session state INSIDE each model call,
// so they see what a turn actually ran at: including the idle queue drain,
// which starts a turn from queued text with no rider of its own, and what the
// model and the transcript were told about the arm.
describe("ultracode turn state through the real agent loop", () => {
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	beforeAll(() => {
		const authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await session?.dispose();
		session = undefined;
		AgentRegistry.resetGlobalForTests();
	});

	/** One model call, read inside the provider call. */
	interface ModelCall {
		/** Text of the request's last user-role message. */
		userText: string;
		level: unknown;
		armed: boolean;
		/** Every text part the request carried (notices and directives included). */
		texts: string[];
	}

	interface LoopSession {
		session: AgentSession;
		settings: Settings;
		calls: ModelCall[];
		/** Resolves once the provider has been called `count` times. */
		callsReached(count: number): Promise<void>;
		/** Holds the NEXT model call open, so the turn stays streaming, until released. */
		holdNextCall(): { started: Promise<void>; release: () => void };
	}

	function textsOf(message: Context["messages"][number]): string[] {
		if (typeof message.content === "string") return [message.content];
		return message.content.flatMap(part => (part.type === "text" ? [part.text] : []));
	}

	function loopSession(options?: {
		modelId?: string;
		agentKind?: "main" | "sub";
		agentId?: string;
		thinkingLevel?: ConfiguredThinkingLevel;
		thinkingLevelCeiling?: Effort;
		ultracodeRestoreLevel?: ConfiguredThinkingLevel;
		ultracode?: boolean;
	}): LoopSession {
		const model = getBundledModel("anthropic", options?.modelId ?? "claude-sonnet-4-5");
		if (!model) throw new Error(`Expected bundled anthropic/${options?.modelId ?? "claude-sonnet-4-5"}`);
		const settings = Settings.isolated({
			"compaction.enabled": false,
			...(options?.ultracode ? { ultracode: true } : {}),
		});
		const calls: ModelCall[] = [];
		const callWaiters: Array<{ count: number; reached: () => void }> = [];
		let hold: { started: PromiseWithResolvers<void>; release: PromiseWithResolvers<void> } | undefined;
		// oxlint-disable-next-line prefer-const -- read by the model handler before assignment
		let target: AgentSession | undefined;
		const mock = createMockModel({
			handler: async context => {
				const lastUser = context.messages.findLast(message => message.role === "user");
				calls.push({
					userText: lastUser ? textsOf(lastUser).join("") : "",
					level: target?.thinkingLevel,
					armed: cfgUltracode.get(settings),
					texts: context.messages.flatMap(textsOf),
				});
				for (const waiter of callWaiters) if (calls.length >= waiter.count) waiter.reached();
				const held = hold;
				hold = undefined;
				if (held) {
					held.started.resolve();
					await held.release.promise;
				}
				return { content: ["ok"] };
			},
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		target = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			agentKind: options?.agentKind,
			agentId: options?.agentId,
			thinkingLevel: options?.thinkingLevel,
			thinkingLevelCeiling: options?.thinkingLevelCeiling,
			ultracodeRestoreLevel: options?.ultracodeRestoreLevel,
		});
		session = target;
		return {
			session: target,
			settings,
			calls,
			callsReached: count => {
				if (calls.length >= count) return Promise.resolve();
				const reached = Promise.withResolvers<void>();
				callWaiters.push({ count, reached: () => reached.resolve() });
				return reached.promise;
			},
			holdNextCall: () => {
				const started = Promise.withResolvers<void>();
				const release = Promise.withResolvers<void>();
				hold = { started, release };
				return { started: started.promise, release: () => release.resolve() };
			},
		};
	}

	/**
	 * Resolves once `count` model calls ran and the run that made the last one
	 * has settled. The idle queue drain starts its turn on a later task, so the
	 * wait is on the provider call itself, not on the queue call returning.
	 */
	async function idleAfter(loop: LoopSession, count: number): Promise<void> {
		await withTimeout(loop.callsReached(count), 5_000, `The provider never saw call ${count}`);
		await loop.session.waitForIdle();
		expect(loop.calls).toHaveLength(count);
	}

	/** A root whose last turn was an ultracode turn: idle, pinned, flagged, handback low. */
	async function armedIdleRoot(): Promise<LoopSession> {
		const loop = loopSession();
		loop.session.setThinkingLevel(Effort.Low);
		await loop.session.prompt("please ultracode this refactor");
		await idleAfter(loop, 1);
		expect(loop.calls[0]).toMatchObject({ level: Effort.XHigh, armed: true });
		return loop;
	}

	// --- a keyword-free steer queued to an IDLE root starts a turn: it disarms ---

	it("an idle keyword-free steer() starts a fresh turn that ends the previous arm", async () => {
		const loop = await armedIdleRoot();

		await loop.session.steer("now the plain next step");
		await idleAfter(loop, 2);

		expect(loop.calls[1].userText).toContain("now the plain next step");
		expect(loop.calls[1]).toMatchObject({ level: Effort.Low, armed: false });
	});

	it("an idle sendUserMessage({ deliverAs: 'steer' }) starts a fresh turn that ends the previous arm", async () => {
		const loop = await armedIdleRoot();

		await loop.session.sendUserMessage("now the plain next step", { deliverAs: "steer" });
		await idleAfter(loop, 2);

		expect(loop.calls[1].userText).toContain("now the plain next step");
		expect(loop.calls[1]).toMatchObject({ level: Effort.Low, armed: false });
	});

	it("an idle queue-only skill steer without the keyword starts a fresh turn that ends the previous arm", async () => {
		const loop = await armedIdleRoot();

		await loop.session.promptCustomMessage(skillPrompt("now the plain next step"), {
			queueOnly: true,
			streamingBehavior: "steer",
		});
		await idleAfter(loop, 2);

		expect(loop.calls[1].texts.some(text => text.includes("User: now the plain next step"))).toBe(true);
		expect(loop.calls[1]).toMatchObject({ level: Effort.Low, armed: false });
	});

	it("promoting a held keyword-free follow-up on an idle root starts a turn that ends the previous arm", async () => {
		const loop = loopSession();
		loop.session.setThinkingLevel(Effort.Low);
		const held = loop.holdNextCall();
		const first = loop.session.prompt("please ultracode this refactor");
		await withTimeout(held.started, 2_000, "The armed turn never reached the model");
		await loop.session.followUp("now the plain next step");
		// RPC `abort` interrupts without clearing the queue: the follow-up is held.
		const abort = loop.session.abort({ reason: USER_INTERRUPT_LABEL });
		held.release();
		await abort;
		await first.catch(() => {});
		await loop.session.waitForIdle();
		expect(loop.session.agent.peekFollowUpQueue().some(message => message.role === "user")).toBe(true);
		expect(cfgUltracode.get(loop.settings)).toBe(true);

		// Promotion drops the follow-up's disarm (a steer normally JOINS a run),
		// but on an idle session the steer STARTS one.
		expect(loop.session.promoteQueuedMessage("now the plain next step")).toBe(true);
		await idleAfter(loop, 2);

		expect(loop.calls[1].userText).toContain("now the plain next step");
		expect(loop.calls[1]).toMatchObject({ level: Effort.Low, armed: false });
	});

	it("an idle steer on a kept-alive child is a resume boundary: it mirrors the live parent first", async () => {
		const loop = loopSession({
			agentKind: "sub",
			agentId: FOCUSED_CHILD_ID,
			thinkingLevel: Effort.XHigh,
			thinkingLevelCeiling: Effort.XHigh,
			ultracodeRestoreLevel: Effort.Low,
			ultracode: true,
		});
		// The child was spawned armed; the parent's turn has ended since.
		registerFocusedChild(Settings.isolated(), loop.session);

		await loop.session.steer("now the plain next step");
		await idleAfter(loop, 1);

		expect(loop.calls[0]).toMatchObject({ level: Effort.Low, armed: false });
	});

	it("control: an idle steer carrying the keyword still arms the turn it starts", async () => {
		const loop = loopSession();
		loop.session.setThinkingLevel(Effort.Low);

		await loop.session.steer("ultracode the next step");
		await idleAfter(loop, 1);

		expect(loop.calls[0]).toMatchObject({ level: Effort.XHigh, armed: true });
	});

	it("control: a keyword-free steer that JOINS a running armed turn leaves it armed", async () => {
		const loop = loopSession();
		loop.session.setThinkingLevel(Effort.Low);
		const held = loop.holdNextCall();
		const first = loop.session.prompt("please ultracode this refactor");
		await withTimeout(held.started, 2_000, "The armed turn never reached the model");

		await loop.session.steer("also mind the tests");
		held.release();
		await first;
		await idleAfter(loop, 2);

		// Same run, next step: "also do X" mid-turn must not yank the pin.
		expect(loop.calls[1].userText).toContain("also mind the tests");
		expect(loop.calls[1]).toMatchObject({ level: Effort.XHigh, armed: true });
	});

	// --- the notice the model reads matches the arm decided at delivery --------
	//
	// A queued keyword message carries its hidden notice from ENQUEUE, but the
	// arm is decided when the loop delivers it. A model switch in between flips
	// whether xhigh can be pinned; the model must be told what actually happened,
	// and so must the transcript the session records.

	const PINNED = "has already pinned this turn to exactly xhigh";
	const NOT_ARMED = "This turn is NOT armed";

	function transcript(loop: LoopSession): string {
		return JSON.stringify(loop.session.sessionManager.getEntries());
	}

	function bundled(id: string): Model<Api> {
		const model = modelRegistry.find("anthropic", id);
		if (!model) throw new Error(`Expected bundled anthropic/${id}`);
		return model;
	}

	it("tells the model a queued keyword follow-up is NOT armed when its model lost xhigh before delivery", async () => {
		const loop = loopSession();
		loop.session.setThinkingLevel(Effort.Low);
		const held = loop.holdNextCall();
		const first = loop.session.prompt("start the work");
		await withTimeout(held.started, 2_000, "The first turn never reached the model");

		await loop.session.prompt("ultracode the next piece", { streamingBehavior: "followUp" });
		// Rendered at enqueue on an xhigh-capable model.
		const queued = loop.session.agent
			.peekFollowUpQueue()
			.find(m => m.role === "custom" && m.customType === "ultracode-notice");
		expect(JSON.stringify(queued)).toContain(PINNED);
		await loop.session.setModel(bundled(NO_XHIGH_MODEL_ID));
		held.release();
		await first;
		await idleAfter(loop, 2);

		expect(loop.calls[1]).toMatchObject({ armed: false });
		expect(loop.calls[1].texts.some(text => text.includes(NOT_ARMED))).toBe(true);
		expect(loop.calls[1].texts.some(text => text.includes(PINNED))).toBe(false);
		expect(transcript(loop)).toContain(NOT_ARMED);
		expect(transcript(loop)).not.toContain(PINNED);
	});

	it("tells the model a queued keyword follow-up IS pinned when its model gained xhigh before delivery", async () => {
		const loop = loopSession({ modelId: NO_XHIGH_MODEL_ID });
		loop.session.setThinkingLevel(Effort.Low);
		const held = loop.holdNextCall();
		const first = loop.session.prompt("start the work");
		await withTimeout(held.started, 2_000, "The first turn never reached the model");

		await loop.session.prompt("ultracode the next piece", { streamingBehavior: "followUp" });
		const queued = loop.session.agent
			.peekFollowUpQueue()
			.find(m => m.role === "custom" && m.customType === "ultracode-notice");
		expect(JSON.stringify(queued)).toContain(NOT_ARMED);
		await loop.session.setModel(bundled("claude-sonnet-4-5"));
		held.release();
		await first;
		await idleAfter(loop, 2);

		expect(loop.calls[1]).toMatchObject({ level: Effort.XHigh, armed: true });
		expect(loop.calls[1].texts.some(text => text.includes(PINNED))).toBe(true);
		expect(loop.calls[1].texts.some(text => text.includes(NOT_ARMED))).toBe(false);
		expect(transcript(loop)).toContain(PINNED);
		expect(transcript(loop)).not.toContain(NOT_ARMED);
	});

	it("re-renders a queued plan-approval directive's notice from the arm taken at delivery", async () => {
		const loop = loopSession();
		loop.session.setThinkingLevel(Effort.Low);
		const held = loop.holdNextCall();
		const first = loop.session.prompt("start the work");
		await withTimeout(held.started, 2_000, "The first turn never reached the model");

		// The shape interactive-mode queues behind a busy turn.
		const renderDirective = (notice: string) => `${notice}\n\nExecute the approved plan.`;
		await loop.session.followUp(renderDirective(loop.session.ultracodeArmNotice()), undefined, {
			synthetic: true,
			onDeliver: loop.session.armUltracodeTurnDeferred(renderDirective),
		});
		expect(JSON.stringify(loop.session.agent.peekFollowUpQueue())).toContain(PINNED);
		await loop.session.setModel(bundled(NO_XHIGH_MODEL_ID));
		held.release();
		await first;
		await idleAfter(loop, 2);

		expect(loop.calls[1]).toMatchObject({ armed: false });
		const directive = loop.calls[1].texts.find(text => text.includes("Execute the approved plan."));
		expect(directive).toContain(NOT_ARMED);
		expect(directive).not.toContain(PINNED);
		expect(transcript(loop)).toContain(NOT_ARMED);
		expect(transcript(loop)).not.toContain(PINNED);
	});
});

// An `advisor` role selected as `…:auto` follows the primary's live effort: at
// every primary turn end (v18.9.0, f0057a4d0c) the advisor is retuned to the
// primary's level clamped onto the advisor's own ladder. Under an armed turn
// that clamp is exactly the silent substitute ultracode forbids. An auto
// advisor goes to EXACTLY xhigh, whatever the primary is at; one whose ladder
// has no xhigh rung stays where it is (the arm-time resync already warned)
// instead of landing on high or max.
describe("auto advisors under an armed ultracode turn", () => {
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	beforeAll(() => {
		const authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await session?.dispose();
		session = undefined;
	});

	/** A root on claude-sonnet-4-5 advised by `anthropic/<advisorModelId>:auto`; both stream from mocks. */
	function advisedSession(advisorModelId: string): AgentSession {
		const primary = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!primary) throw new Error("Expected bundled anthropic/claude-sonnet-4-5");
		const agent = new Agent({
			initialState: { model: primary, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: createMockModel({ handler: { content: ["primary complete"] } }).stream,
		});
		const settings = Settings.isolated({ "compaction.enabled": false });
		settings.setModelRole("advisor", `anthropic/${advisorModelId}:${AUTO_THINKING}`);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			advisorTools: [],
			advisorStreamFn: createMockModel({ handler: { content: ["advisor ok"] } }).stream,
		});
		return session;
	}

	/**
	 * One primary turn driven through the agent — not `session.prompt`, whose
	 * keyword-free disarm would end the armed turn — then the advisor's review,
	 * whose turn-end boundary runs the retune.
	 */
	async function primaryTurn(target: AgentSession): Promise<void> {
		await target.agent.prompt("do work");
		await target.waitForAdvisorCatchup(2000);
	}

	it("retunes an xhigh-capable auto advisor to exactly xhigh even while the primary sits lower", async () => {
		const s = advisedSession("claude-sonnet-4-5");
		s.setThinkingLevel(Effort.Low);
		expect(s.setAdvisorEnabled(true)).toBe(true);
		const advisor = s.getAdvisorAgent();
		if (!advisor) throw new Error("Expected advisor Agent to be live");
		expect(advisor.state.thinkingLevel).toBe(Effort.Low);
		cfgUltracode.override(s.settings, true);

		await primaryTurn(s);

		// Retuned in place (no rebuild), to the pin rather than the primary's low.
		expect(s.getAdvisorAgent()).toBe(advisor);
		expect(advisor.state.thinkingLevel).toBe(Effort.XHigh);
	});

	it("leaves an auto advisor without an xhigh rung where it is instead of clamping it onto high", async () => {
		// claude-opus-4-6 exposes low, medium, high, max: no xhigh to pin.
		const s = advisedSession("claude-opus-4-6");
		s.setThinkingLevel(Effort.Low);
		expect(s.setAdvisorEnabled(true)).toBe(true);
		const advisor = s.getAdvisorAgent();
		if (!advisor) throw new Error("Expected advisor Agent to be live");
		s.setThinkingLevel(Effort.XHigh);
		cfgUltracode.override(s.settings, true);

		await primaryTurn(s);

		expect(s.getAdvisorAgent()).toBe(advisor);
		expect(advisor.state.thinkingLevel).toBe(Effort.Low);
	});

	it("clamps the primary's xhigh onto a no-xhigh advisor's ladder when unarmed", async () => {
		// Control for the case above: the upstream clamp really does move this
		// advisor to high, so its staying at low there is the armed branch.
		const s = advisedSession("claude-opus-4-6");
		s.setThinkingLevel(Effort.Low);
		expect(s.setAdvisorEnabled(true)).toBe(true);
		const advisor = s.getAdvisorAgent();
		if (!advisor) throw new Error("Expected advisor Agent to be live");
		s.setThinkingLevel(Effort.XHigh);

		await primaryTurn(s);

		expect(advisor.state.thinkingLevel).toBe(Effort.High);
	});
});
