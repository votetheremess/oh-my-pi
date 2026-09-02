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
import { syncChildUltracodeAtResume } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session-events";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SKILL_PROMPT_MESSAGE_TYPE, type SkillPromptDetails } from "@oh-my-pi/pi-coding-agent/session/messages";
import { ModelControls, type ModelControlsHost } from "@oh-my-pi/pi-coding-agent/session/model-controls";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	AUTO_THINKING,
	type ConfiguredThinkingLevel,
	UltracodeEffortError,
	ultracodeEffortFor,
} from "@oh-my-pi/pi-coding-agent/thinking";
import { removeWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

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
	/** Every setting path read through the host, in order. */
	settingReads: string[];
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
		settingReads,
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
		h.settings.set("defaultThinkingLevel", Effort.Medium);

		h.controls.beginUltracodeTurn();

		expect(h.controls.thinkingLevel).toBe(Effort.XHigh);
		expect(h.settings.get("defaultThinkingLevel")).toBe(Effort.Medium);
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

		expect(h.settings.get("ultracode")).toBe(false);
		expect(h.controls.configuredThinkingLevel()).toBe(picked);
		expect(h.controls.thinkingLevel).not.toBe(Effort.XHigh);
		expect(h.controls.hasPendingUltracodeRestore()).toBe(false);
	});

	it("leaves the flag alone when cycling on a turn that never used the keyword", () => {
		const h = createHarness({ model: HAS_XHIGH, thinkingLevel: Effort.Low });
		h.controls.cycleThinkingLevel();
		expect(h.settings.get("ultracode")).toBe(false);
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
	it("resolves straight to exactly xhigh without invoking the classifier", async () => {
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

	it("leaves a model without an xhigh rung alone instead of clamping the bypass", async () => {
		const h = createHarness({ model: TOPS_AT_HIGH, thinkingLevel: AUTO_THINKING, ultracode: true });
		const agentCallsBefore = h.agentEfforts.length;

		await h.controls.applyAutoThinkingLevel("rename a local variable", GENERATION);

		// Neither the clamp (high) nor the classifier may substitute for xhigh:
		// the turn is armed but this model cannot honour it, so nothing moves.
		expect(h.controls.autoResolvedThinkingLevel).toBeUndefined();
		expect(h.controls.configuredThinkingLevel()).toBe(AUTO_THINKING);
		expect(h.agentEfforts.length).toBe(agentCallsBefore);
		expect(h.settingReads).not.toContain("providers.autoThinkingModel");
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
		expect(h.settingReads).not.toContain("providers.autoThinkingModel");
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
		if (sessionRoot) await removeWithRetries(sessionRoot);
		sessionRoot = undefined;
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
			thinkingLevel: options?.thinkingLevel,
			thinkingLevelCeiling: options?.thinkingLevelCeiling,
			ultracodeRestoreLevel: options?.ultracodeRestoreLevel,
		});
		const notices: CreatedSession["notices"] = [];
		created.subscribe(event => {
			if (event.type === "notice") notices.push({ level: event.level, message: event.message, source: event.source });
		});
		return { session: created, settings, notices };
	}

	/** Bundled ladder without xhigh (low/medium/high), for the fail-loud cases. */
	const NO_XHIGH_MODEL_ID = "claude-sonnet-4-6";

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

		expect(created.settings.get("ultracode")).toBe(true);
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
		expect(created.settings.get("ultracode")).toBe(false);
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
		expect(created.settings.get("ultracode")).toBe(true);
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
		expect(created.settings.get("ultracode")).toBe(false);
		expect(session.thinkingLevel).toBe(Effort.Low);

		deliverQueued(session.agent.peekSteeringQueue().find(m => m.role === "user"));
		expect(created.settings.get("ultracode")).toBe(true);
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
		expect(created.settings.get("ultracode")).toBe(true);
		expect(session.thinkingLevel).toBe(Effort.XHigh);

		// The flip fires only when the loop delivers the queued message.
		deliverQueued(session.agent.peekFollowUpQueue().find(m => m.role === "user"));
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
		expect(created.settings.get("ultracode")).toBe(false);
		deliverQueued(session.agent.peekSteeringQueue().find(m => m.role === "user"));
		expect(created.settings.get("ultracode")).toBe(true);
		expect(session.thinkingLevel).toBe(Effort.XHigh);

		await session.steer("and mind the tests");
		const steers = session.agent.peekSteeringQueue().filter(m => m.role === "user");
		expect(steers).toHaveLength(2);
		expect(queuedHook(steers[1])).toBeUndefined();
		expect(created.settings.get("ultracode")).toBe(true);
		expect(session.thinkingLevel).toBe(Effort.XHigh);
	});

	it("followUp(): arms at delivery with the keyword, disarms at delivery without it", async () => {
		const created = await createSession();
		session = created.session;
		session.setThinkingLevel(Effort.Low);
		forceStreaming(session);

		await session.followUp("ultracode the next piece");
		expect(created.settings.get("ultracode")).toBe(false);
		deliverQueued(session.agent.peekFollowUpQueue().find(m => m.role === "user"));
		expect(created.settings.get("ultracode")).toBe(true);
		expect(session.thinkingLevel).toBe(Effort.XHigh);

		await session.followUp("now the plain next step");
		const followUps = session.agent.peekFollowUpQueue().filter(m => m.role === "user");
		expect(followUps).toHaveLength(2);
		expect(created.settings.get("ultracode")).toBe(true);
		deliverQueued(followUps[1]);
		expect(created.settings.get("ultracode")).toBe(false);
		expect(session.thinkingLevel).toBe(Effort.Low);
	});

	it("never attaches an arm or disarm rider to a child's steer() or followUp()", async () => {
		const created = await createSession({ agentKind: "sub" });
		session = created.session;
		session.setThinkingLevel(Effort.Low);
		forceStreaming(session);

		await session.steer("ultracode this");
		await session.followUp("ultracode that");
		await session.followUp("plain follow-up");

		expect(queuedHook(session.agent.peekSteeringQueue().find(m => m.role === "user"))).toBeUndefined();
		for (const message of session.agent.peekFollowUpQueue().filter(m => m.role === "user")) {
			expect(queuedHook(message)).toBeUndefined();
		}
		expect(created.settings.get("ultracode")).toBe(false);
		expect(session.thinkingLevel).toBe(Effort.Low);
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
		expect(created.settings.get("ultracode")).toBe(true);
		expect(session.thinkingLevel).toBe(Effort.XHigh);
		// And the handback is still the ORIGINAL borrowed level.
		vi.restoreAllMocks();
		vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);
		Object.defineProperty(session, "isStreaming", { configurable: true, get: () => false });
		await session.prompt("keyword-free follow-up");
		expect(created.settings.get("ultracode")).toBe(false);
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
		expect(created.settings.get("ultracode")).toBe(false);

		const queue = session.agent.peekFollowUpQueue();
		deliverQueued(queue.find(m => m.role === "developer"));
		expect(created.settings.get("ultracode")).toBe(true);
		deliverQueued(queue.find(m => m.role === "user"));

		// Same synchronous commit batch as the arm: the turn carries the
		// keyword, so the older keyword-free rider stands down and the batch
		// runs armed.
		expect(created.settings.get("ultracode")).toBe(true);
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
		expect(created.settings.get("ultracode")).toBe(true);
		// The agent loop's batch boundary: the arm's microtask has run.
		await Promise.resolve();
		deliverQueued(queue.find(m => m.role === "user"));

		expect(created.settings.get("ultracode")).toBe(false);
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

		expect(created.settings.get("ultracode")).toBe(false);
		expect(session.thinkingLevel).toBe(Effort.Low);
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
		expect(created.settings.get("ultracode")).toBe(false);
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

		expect(created.settings.get("ultracode")).toBe(true);
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

		expect(created.settings.get("ultracode")).toBe(false);
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
		expect(created.settings.get("ultracode")).toBe(false);
		expect(session.thinkingLevel).toBe(Effort.Low);

		deliver();
		expect(created.settings.get("ultracode")).toBe(true);
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

		expect(created.settings.get("ultracode")).toBe(false);
		expect(session.thinkingLevel).toBe(Effort.Low);
	});

	it("disarmUltracodeTurn() is a no-op on an unarmed session", async () => {
		const created = await createSession();
		session = created.session;
		session.setThinkingLevel(Effort.Medium);

		session.disarmUltracodeTurn();

		expect(created.settings.get("ultracode")).toBe(false);
		expect(session.thinkingLevel).toBe(Effort.Medium);
	});

	it("newSession() disarms an armed turn, so a fresh session never starts at xhigh", async () => {
		const created = await createSession();
		session = created.session;
		session.setThinkingLevel(Effort.Low);
		vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);
		await session.prompt("please ultracode this refactor");
		expect(created.settings.get("ultracode")).toBe(true);

		expect(await session.newSession()).toBe(true);

		// Both halves: the executor's flag AND the borrowed level. Leaking either
		// makes the next session's first turn (and its spawns) run armed.
		expect(created.settings.get("ultracode")).toBe(false);
		expect(session.thinkingLevel).toBe(Effort.Low);
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
		expect(created.settings.get("ultracode")).toBe(false);
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
		expect(created.settings.get("ultracode")).toBe(false);
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
		expect(created.settings.get("ultracode")).toBe(false);
		expect(session.thinkingLevel).toBe(Effort.Low);

		// And the handback is spent, not pending: a later plain level set is not
		// overwritten by a stale restore on the next keyword-free turn.
		session.setThinkingLevel(Effort.Medium, false, "extension");
		await session.prompt("keyword-free follow-up");
		expect(created.settings.get("ultracode")).toBe(false);
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

		expect(created.settings.get("ultracode")).toBe(false);
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
		expect(created.settings.get("ultracode")).toBe(true);
		expect(session.thinkingLevel).toBe(Effort.XHigh);
		expect(created.notices.filter(notice => notice.source === "ultracode")).toEqual([]);

		await session.prompt("keyword-free follow-up");
		expect(created.settings.get("ultracode")).toBe(false);
		expect(session.thinkingLevel).toBe(Effort.Low);
	});

	it("re-pins over the level an internal temporary swap brings with it", async () => {
		const created = await createSession();
		session = created.session;
		session.setThinkingLevel(Effort.Low);
		vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);
		await session.prompt("please ultracode this refactor");
		expect(session.thinkingLevel).toBe(Effort.XHigh);

		// The prewalk / compaction-promotion shape: an internal swap that names
		// its own level. The keyword outranks it for this turn.
		await session.setModelTemporary(pickedModel(), Effort.Medium, undefined, "internal");

		expect(created.settings.get("ultracode")).toBe(true);
		expect(session.thinkingLevel).toBe(Effort.XHigh);

		await session.prompt("keyword-free follow-up");
		expect(session.thinkingLevel).toBe(Effort.Low);
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
		expect(created.settings.get("ultracode")).toBe(true);
		expect(session.thinkingLevel).not.toBe(Effort.XHigh);
		const warning = created.notices.find(notice => notice.source === "ultracode");
		expect(warning?.level).toBe("warning");
		expect(warning?.message).toContain("cannot re-pin xhigh");
		expect(warning?.message).toContain(NO_XHIGH_MODEL_ID);
	});

	it("swaps plainly on an extension-sourced pick when no turn is armed", async () => {
		// Control for the two above: outside an armed turn the extension's swap
		// is just a swap — no re-pin, no warning, no flag.
		const created = await createSession();
		session = created.session;
		session.setThinkingLevel(Effort.Low);

		await session.setModelTemporary(pickedModel(), Effort.Medium, undefined, "extension");

		expect(created.settings.get("ultracode")).toBe(false);
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
		expect(created.settings.get("ultracode")).toBe(true);
		expect(session.thinkingLevel).toBe(Effort.XHigh);

		// The pending handback is intact: the next keyword-free turn restores the
		// ORIGINAL borrowed level, not the extension's interim one.
		await session.prompt("keyword-free follow-up");
		expect(created.settings.get("ultracode")).toBe(false);
		expect(session.thinkingLevel).toBe(Effort.Low);
	});

	it("applies an extension-sourced setThinkingLevel plainly when no turn is armed", async () => {
		// Control for the re-pin above: outside an armed turn the extension's
		// level lands as-is, proving the re-pin came from the armed flag.
		const created = await createSession();
		session = created.session;
		session.setThinkingLevel(Effort.Low);

		session.setThinkingLevel(Effort.Medium, false, "extension");

		expect(created.settings.get("ultracode")).toBe(false);
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
		expect(created.settings.get("ultracode")).toBe(false);
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

		expect(created.settings.get("ultracode")).toBe(false);
		expect(session.thinkingLevel).toBe(Effort.Low);
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

		expect(created.settings.get("ultracode")).toBe(true);
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

		expect(created.settings.get("ultracode")).toBe(false);
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
		expect(created.settings.get("ultracode")).toBe(false);
		expect(session.thinkingLevel).toBe(Effort.Low);
	});

	it("never disarms an inherited flag on a task-spawned child's keyword-free turn", async () => {
		const created = await createSession({ agentKind: "sub" });
		session = created.session;
		session.setThinkingLevel(Effort.Low);
		// Exactly how a child receives the flag: baked into its settings by the
		// parent's snapshot, with the pin re-applied on resume. (Set AFTER the
		// level above: a user-sourced setThinkingLevel is itself an off-ramp.)
		created.settings.override("ultracode", true);
		expect(session.repinUltracodeIfArmed()).toBe(true);
		expect(session.thinkingLevel).toBe(Effort.XHigh);
		vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);

		await session.prompt("just a normal message");

		// The root's keyword-free `else` would have cleared this and handed the
		// level back; on a child it must not run, or every grandchild spawn
		// drops off the xhigh floor.
		expect(created.settings.get("ultracode")).toBe(true);
		expect(session.thinkingLevel).toBe(Effort.XHigh);
	});

	it("still arms on a root session, proving the child guard is what withheld it", async () => {
		const created = await createSession({ agentKind: "main" });
		session = created.session;
		session.setThinkingLevel(Effort.Low);
		vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);

		await session.prompt("please ultracode this refactor");

		expect(created.settings.get("ultracode")).toBe(true);
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
		// Only `settings.get("ultracode")` is read off the parent; a real
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
		expect(created.settings.get("ultracode")).toBe(false);
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

		expect(created.settings.get("ultracode")).toBe(true);
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
		expect(created.settings.get("ultracode")).toBe(false);
		expect(session.thinkingLevel).toBe(Effort.Low);
	});

	it("refuses to flag a child whose effort ceiling caps the pin below xhigh, and says so", async () => {
		// The rung exists; the ceiling is what refuses. The message has to name
		// the ceiling, or the operator goes looking for a missing tier.
		const created = await createSession({ agentKind: "sub", thinkingLevel: Effort.Low, thinkingLevelCeiling: Effort.High });
		session = created.session;
		expect(session.ultracodePinRefusal()).toBe("ceiling");
		const { registry, childId } = registryWith(Settings.isolated({ ultracode: true }), session);

		expect(() => syncChildUltracodeAtResume(childId, session!, registry)).toThrow(/ceiling/);

		expect(created.settings.get("ultracode")).toBe(false);
		expect(session.thinkingLevel).toBe(Effort.Low);
	});

	it("never leaves a child flagged-but-unpinned: a stale flag is dropped before a refused re-pin throws", async () => {
		// A cold revive seeds the flag from the persisted session_init; if the
		// child's model cannot take the pin now, throwing with the flag still up
		// would floor its own spawns at a level it is not running at.
		const created = await createSession({ agentKind: "sub", modelId: NO_XHIGH_MODEL_ID, thinkingLevel: Effort.Low });
		session = created.session;
		created.settings.override("ultracode", true);
		const { registry, childId } = registryWith(Settings.isolated({ ultracode: true }), session);

		expect(() => syncChildUltracodeAtResume(childId, session!, registry)).toThrow(UltracodeEffortError);

		expect(created.settings.get("ultracode")).toBe(false);
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

		expect(created.settings.get("ultracode")).toBe(true);
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
		expect(created.settings.get("ultracode")).toBe(false);
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

		expect(created.settings.get("ultracode")).toBe(true);
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
		expect(created.settings.get("ultracode")).toBe(false);
		expect(session.thinkingLevel).toBe(Effort.Low);
	});
});
