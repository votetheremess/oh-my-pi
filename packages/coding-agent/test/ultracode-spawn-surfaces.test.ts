/**
 * Ultracode contract on the three spawn surfaces outside the task tool.
 *
 * An armed ultracode turn pins its root at exactly xhigh and every agent it
 * spawns inherits that pin. Three surfaces spawn sessions without going through
 * the task executor, and each re-implements the contract by hand, so each can
 * drift on its own:
 *
 * - `/tan` (TanCommandController) forks a background clone of the root;
 * - the agents hub's `generateAgent` runs a creation-architect session;
 * - the legacy pi shim's `createAgentSession` spawns for legacy extensions.
 *
 * For each, an armed root must hand its child exactly xhigh as both level and
 * ceiling (never clamped), settings whose `ultracode` flag is stamped BY VALUE
 * (a later parent flip must not reach the child, and a child write must not
 * reach the parent), and a child identity. A model with no xhigh rung must be
 * refused loudly with no spawn. Unarmed, none of that may leak in. `/tan` also
 * records the user's own pre-pin level as the restore level (never the
 * borrowed xhigh) and reads the flag once at dispatch, so a disarm before the
 * background job runs cannot split the clone's pin from its session_init.
 */
import { afterEach, describe, expect, it, type Mock, vi } from "bun:test";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { type AssistantMessage, Effort, type Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { EffectiveExtensionRoots } from "@oh-my-pi/pi-coding-agent/capability/types";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession as legacyCreateAgentSession } from "@oh-my-pi/pi-coding-agent/extensibility/legacy-pi-coding-agent-shim";
import { createAgentsHubDeps } from "@oh-my-pi/pi-coding-agent/modes/agents-hub-deps";
import { TanCommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/tan-command-controller";
import { cfgUltracode } from "@oh-my-pi/pi-coding-agent/modes/settings";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { CreateAgentSessionOptions, CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { UltracodeEffortError } from "@oh-my-pi/pi-tui/thinking";
import { TempDir } from "@oh-my-pi/pi-utils";

function bundledModel(id: string): Model {
	const model = getBundledModel("anthropic", id);
	if (!model) throw new Error(`Expected bundled anthropic/${id}`);
	return model;
}

/** Ladder ends at xhigh: the pin is honorable. */
const xhighModel = bundledModel("claude-sonnet-4-5");
/** Ladder [low, medium, high]: no xhigh rung, so ultracode must refuse it. */
const noXhighModel = bundledModel("claude-sonnet-4-6");

function assistantText(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: xhighModel.provider,
		model: xhighModel.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

function armedSettings(): Settings {
	const settings = Settings.isolated();
	cfgUltracode.override(settings, true);
	return settings;
}

/** The by-value stamp, both directions: parent flips stay out, child writes stay in. */
function expectStampedByValue(parent: Settings, child: Settings | undefined): void {
	if (!child) throw new Error("child settings were not forwarded");
	expect(child).not.toBe(parent);
	expect(cfgUltracode.get(child)).toBe(true);
	cfgUltracode.override(parent, false);
	expect(cfgUltracode.get(child)).toBe(true);
	cfgUltracode.override(parent, true);
	cfgUltracode.override(child, false);
	expect(cfgUltracode.get(parent)).toBe(true);
}

const tempDirs: TempDir[] = [];

afterEach(() => {
	vi.restoreAllMocks();
	for (const dir of tempDirs.splice(0)) dir.removeSync();
});

type TanJobRun = (ctx: {
	jobId: string;
	signal: AbortSignal;
	reportProgress: (text: string, details?: Record<string, unknown>) => Promise<void>;
}) => Promise<string>;

/** Root session + interactive context covering what `/tan` reads at dispatch. */
function createTanHarness(options: {
	settings: Settings;
	model: Model;
	configuredLevel: Effort;
	userConfiguredLevel: Effort;
}) {
	const tempDir = TempDir.createSync("@omp-ultracode-tan-");
	tempDirs.push(tempDir);
	const parentFile = path.join(tempDir.path(), "parent.jsonl");
	let capturedRun: TanJobRun | undefined;
	const register = vi.fn((_type: "bash" | "task", _label: string, run: TanJobRun): string => {
		capturedRun = run;
		return "job-ultra";
	});
	const session = {
		isStreaming: false,
		agent: { promptCacheKey: undefined },
		model: options.model,
		asyncJobManager: { register },
		sessionId: "root-session",
		// The root's live level is the borrowed pin while armed; the user's own
		// pre-pin choice is only visible through userConfiguredThinkingLevel().
		configuredThinkingLevel: vi.fn(() => options.configuredLevel),
		userConfiguredThinkingLevel: vi.fn(() => options.userConfiguredLevel),
		systemPrompt: ["root system prompt"],
		getEnabledToolNames: vi.fn(() => ["read", "bash"]),
		modelRegistry: { authStorage: { marker: "auth" } },
		preparedExtensions: undefined,
		effectiveExtensionRoots: undefined,
		extensionPaths: undefined,
		getAgentId: vi.fn(() => undefined),
		sendCustomMessage: vi.fn(async () => {}),
	} as unknown as InteractiveModeContext["session"];
	const sessionManager = {
		getSessionFile: vi.fn(() => parentFile),
		getCwd: vi.fn(() => tempDir.path()),
		getArtifactsDir: vi.fn(() => parentFile.slice(0, -6)),
		getSessionId: vi.fn(() => "root-local-session"),
		ensureOnDisk: vi.fn(async () => {}),
		flush: vi.fn(async () => {}),
	} as unknown as InteractiveModeContext["sessionManager"];
	const ctx = {
		session,
		sessionManager,
		settings: options.settings,
		showStatus: vi.fn(),
		showWarning: vi.fn(),
		showError: vi.fn(),
		rebuildChatFromMessages: vi.fn(),
	} as unknown as InteractiveModeContext;
	const cloneManager = {
		getSessionFile: vi.fn(() => path.join(parentFile.slice(0, -6), "clone.jsonl")),
		appendCustomEntry: vi.fn(),
	} as unknown as SessionManager;
	const forkFrom = vi.spyOn(SessionManager, "forkFrom").mockResolvedValue(cloneManager);
	return {
		ctx,
		register,
		forkFrom,
		get capturedRun() {
			return capturedRun;
		},
	};
}

/** The clone session surface the `/tan` background job drives after creation. */
function createTanClone() {
	const messages: AgentMessage[] = [];
	const appendSessionInit = vi.fn((_init: Record<string, unknown>) => {});
	const clone = {
		agent: { appendMessage: vi.fn((message: AgentMessage) => messages.push(message)), state: { messages } },
		sessionManager: { appendSessionInit },
		setTodoPhases: vi.fn(),
		getEnabledToolNames: vi.fn(() => ["read", "bash"]),
		subscribe: vi.fn(() => () => {}),
		prompt: vi.fn(async () => {}),
		waitForIdle: vi.fn(async () => {}),
		hasPendingAsyncWork: vi.fn(() => false),
		settleAsyncWork: vi.fn(async () => {}),
		getLastAssistantMessage: vi.fn(() => assistantText("tan done")),
		abort: vi.fn(async () => {}),
		dispose: vi.fn(async () => {}),
	};
	return { clone, appendSessionInit };
}

function spyCreateAgentSession(session: unknown) {
	return vi
		.spyOn(sdkModule, "createAgentSession")
		.mockResolvedValue({ session } as unknown as CreateAgentSessionResult);
}

function onlyCallOptions(spy: Mock<typeof sdkModule.createAgentSession>): CreateAgentSessionOptions {
	expect(spy).toHaveBeenCalledTimes(1);
	const options = spy.mock.calls[0]?.[0];
	if (!options) throw new Error("createAgentSession was called without options");
	return options;
}

async function runTanJob(run: TanJobRun | undefined): Promise<string> {
	if (!run) throw new Error("/tan did not register a background job");
	return run({ jobId: "job-ultra", signal: new AbortController().signal, reportProgress: async () => {} });
}

describe("/tan under ultracode", () => {
	it("pins an armed clone at xhigh, stamps the flag by value, and keeps the user's level from dispatch", async () => {
		// Guards: clone clamped/unpinned (no ceiling), restore level recorded as
		// the borrowed xhigh, clone sharing the root's live settings, and the
		// flag re-read when the background job runs instead of at dispatch.
		const rootSettings = armedSettings();
		const harness = createTanHarness({
			settings: rootSettings,
			model: xhighModel,
			configuredLevel: Effort.XHigh,
			userConfiguredLevel: Effort.Low,
		});
		const { clone, appendSessionInit } = createTanClone();
		const createSpy = spyCreateAgentSession(clone);

		await new TanCommandController(harness.ctx).start("chase the tangent");
		// Disarm between dispatch and the background job: the job must keep the
		// dispatch-time decision for both the clone's pin and its persisted record.
		cfgUltracode.override(rootSettings, false);
		expect(await runTanJob(harness.capturedRun)).toBe("tan done");

		const options = onlyCallOptions(createSpy);
		expect(options.thinkingLevel).toBe(Effort.XHigh);
		expect(options.thinkingLevelCeiling).toBe(Effort.XHigh);
		expect(options.ultracodeRestoreLevel).toBe(Effort.Low);
		// The root is already disarmed here; the clone's flag must still read true.
		expectStampedByValue(rootSettings, options.settings);
		expect(appendSessionInit).toHaveBeenCalledTimes(1);
		expect(appendSessionInit.mock.calls[0]?.[0]).toEqual(
			expect.objectContaining({ task: "chase the tangent", ultracode: true, ultracodeRestoreLevel: Effort.Low }),
		);
	});

	it("refuses an armed /tan on a model without xhigh before forking", async () => {
		// Guards: an armed clone silently clamped onto the model's top rung (high)
		// instead of failing loud with the UltracodeEffortError message.
		const harness = createTanHarness({
			settings: armedSettings(),
			model: noXhighModel,
			configuredLevel: Effort.High,
			userConfiguredLevel: Effort.Low,
		});
		const createSpy = spyCreateAgentSession(createTanClone().clone);

		await new TanCommandController(harness.ctx).start("chase the tangent");

		expect(harness.ctx.showError).toHaveBeenCalledTimes(1);
		expect(harness.ctx.showError).toHaveBeenCalledWith(expect.stringContaining("ultracode requires xhigh"));
		expect(harness.forkFrom).not.toHaveBeenCalled();
		expect(harness.register).not.toHaveBeenCalled();
		expect(createSpy).not.toHaveBeenCalled();
	});

	it("carries an unarmed root's configured level over with no ultracode pin, ceiling, or record", async () => {
		// Guards: the pin leaking outside ultracode (forced xhigh / ceiling /
		// restore level / persisted flag) and an unarmed clone that later turns
		// armed because it shares the root's live settings.
		const rootSettings = Settings.isolated();
		const harness = createTanHarness({
			settings: rootSettings,
			model: xhighModel,
			configuredLevel: Effort.Medium,
			userConfiguredLevel: Effort.Low,
		});
		const { clone, appendSessionInit } = createTanClone();
		const createSpy = spyCreateAgentSession(clone);

		await new TanCommandController(harness.ctx).start("chase the tangent");
		await runTanJob(harness.capturedRun);

		const options = onlyCallOptions(createSpy);
		expect(options.thinkingLevel).toBe(Effort.Medium);
		expect(options.thinkingLevelCeiling).toBeUndefined();
		expect(options.ultracodeRestoreLevel).toBeUndefined();
		const childSettings = options.settings;
		if (!childSettings) throw new Error("clone settings were not forwarded");
		expect(cfgUltracode.get(childSettings)).toBe(false);
		cfgUltracode.override(rootSettings, true);
		expect(cfgUltracode.get(childSettings)).toBe(false);
		const init = appendSessionInit.mock.calls[0]?.[0];
		if (!init) throw new Error("session_init was not appended");
		expect(init.ultracode).toBeUndefined();
		expect(init.ultracodeRestoreLevel).toBeUndefined();
	});
});

describe("agents hub generateAgent under ultracode", () => {
	const extensionRoots = (): EffectiveExtensionRoots => ({
		explicit: [],
		configured: [],
		configuredLevel: "user",
		mode: "explicit-only",
	});

	function hubRegistry(model: Model): ModelRegistry {
		return {
			refresh: async () => {},
			getAvailable: () => [model],
			authStorage: { marker: "auth" },
		} as unknown as ModelRegistry;
	}

	function architectSession() {
		return {
			subscribe: vi.fn(() => () => {}),
			prompt: vi.fn(async () => {}),
			state: { messages: [assistantText("name: reviewer")] },
			dispose: vi.fn(async () => {}),
		};
	}

	it("runs an armed architect at exactly xhigh on a by-value overlay as the owner's child", async () => {
		// Guards: architect sharing the live Settings (its writes landing on the
		// interactive session, a parent disarm reaching it), an unpinned/unceilinged
		// architect, and registering it as a second root instead of the owner's child.
		const rootSettings = armedSettings();
		const createSpy = spyCreateAgentSession(architectSession());
		const deps = createAgentsHubDeps(
			"/tmp",
			rootSettings,
			hubRegistry(xhighModel),
			extensionRoots,
			undefined,
			undefined,
			undefined,
			"HubOwner",
		);

		expect(await deps.generateAgent("a code reviewer", () => {})).toBe("name: reviewer");

		const options = onlyCallOptions(createSpy);
		expect(options.model).toBe(xhighModel);
		expect(options.thinkingLevel).toBe(Effort.XHigh);
		expect(options.thinkingLevelCeiling).toBe(Effort.XHigh);
		expect(options.parentAgentId).toBe("HubOwner");
		expect(options.agentId).toMatch(/^Architect-/);
		expect(options.parentTaskPrefix).toBe(options.agentId);
		expectStampedByValue(rootSettings, options.settings);
	});

	it("rejects an armed architect on a model without xhigh without creating a session", async () => {
		// Guards: the architect silently clamped onto high under an armed turn.
		const createSpy = spyCreateAgentSession(architectSession());
		const deps = createAgentsHubDeps("/tmp", armedSettings(), hubRegistry(noXhighModel), extensionRoots);

		const outcome = deps.generateAgent("a code reviewer", () => {});

		await expect(outcome).rejects.toBeInstanceOf(UltracodeEffortError);
		await expect(outcome).rejects.toThrow("ultracode requires xhigh");
		expect(createSpy).not.toHaveBeenCalled();
	});

	it("leaves an unarmed architect's thinking level to the SDK", async () => {
		// Guards: the xhigh pin/ceiling leaking onto the architect outside ultracode.
		const createSpy = spyCreateAgentSession(architectSession());
		const deps = createAgentsHubDeps("/tmp", Settings.isolated(), hubRegistry(xhighModel), extensionRoots);

		await deps.generateAgent("a code reviewer", () => {});

		const options = onlyCallOptions(createSpy);
		expect(options.thinkingLevel).toBeUndefined();
		expect(options.thinkingLevelCeiling).toBeUndefined();
	});
});

describe("legacy pi shim createAgentSession under ultracode", () => {
	it("forwards an armed live-settings spawn at exactly xhigh on a by-value overlay as a child", async () => {
		// Guards: the legacy spawn sharing the live Settings, a caller-supplied
		// lower thinkingLevel winning over the pin, no ceiling, and the spawn
		// registering as a root (which disarms on its first keyword-free prompt).
		const rootSettings = armedSettings();
		const spawned = { model: xhighModel, dispose: vi.fn(async () => {}) };
		const createSpy = spyCreateAgentSession(spawned);

		const result = await legacyCreateAgentSession({
			settings: rootSettings,
			model: xhighModel,
			thinkingLevel: Effort.Low,
		});

		expect(result.session).toBe(spawned as unknown as CreateAgentSessionResult["session"]);
		const options = onlyCallOptions(createSpy);
		expect(options.thinkingLevel).toBe(Effort.XHigh);
		expect(options.thinkingLevelCeiling).toBe(Effort.XHigh);
		expect(options.agentId).toMatch(/^Legacy-/);
		expect(options.parentTaskPrefix).toBe(options.agentId);
		expectStampedByValue(rootSettings, options.settings);
		expect(spawned.dispose).not.toHaveBeenCalled();
	});

	it("refuses an armed spawn on an explicit model without xhigh before calling the SDK", async () => {
		// Guards: dropping the up-front refusal, which would build (and only then
		// tear down) a session clamped onto high under the ultracode name.
		const createSpy = spyCreateAgentSession({ model: noXhighModel, dispose: vi.fn(async () => {}) });

		const outcome = legacyCreateAgentSession({ settings: armedSettings(), model: noXhighModel });

		await expect(outcome).rejects.toBeInstanceOf(UltracodeEffortError);
		await expect(outcome).rejects.toThrow("ultracode requires xhigh");
		expect(createSpy).not.toHaveBeenCalled();
	});
});
