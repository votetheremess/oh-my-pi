/**
 * Ultracode contract on the spawn surfaces outside the task tool, and on the
 * IRC wake that resumes a spawned child.
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
 * reach the parent), and a child identity linked to the live session. A model
 * with no xhigh rung must be refused loudly with no session left running.
 * Unarmed, none of that may leak in. The `/tan` work prompt and the architect
 * request are SPAWN ASSIGNMENTS, not resume boundaries: a root flip between
 * dispatch and the child's first turn must not reach that turn. Only the
 * child's own prompt path can re-mirror its parent, so those cases drive REAL
 * child AgentSessions (only the LLM call is stubbed).
 *
 * An IRC message that wakes an IDLE child is a resume boundary: the child
 * mirrors its nearest live ancestor before the wake turn starts, or the
 * delivery fails loudly (message kept) when it cannot hold the pin. A
 * streaming child is joined mid-turn and keeps the pin it started with.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, type Mock, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { type AssistantMessage, Effort, type Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import type { EffectiveExtensionRoots } from "@oh-my-pi/pi-coding-agent/capability/types";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession as legacyCreateAgentSession } from "@oh-my-pi/pi-coding-agent/extensibility/legacy-pi-coding-agent-shim";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { createAgentsHubDeps } from "@oh-my-pi/pi-coding-agent/modes/agents-hub-deps";
import { TanCommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/tan-command-controller";
import { cfgUltracode } from "@oh-my-pi/pi-coding-agent/modes/settings";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentLifecycleManager, syncChildUltracodeAtResume } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { CreateAgentSessionOptions, CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
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
const liveSessions: AgentSession[] = [];
let authDir: TempDir;
let authStorage: AuthStorage;
let modelRegistry: ModelRegistry;

beforeAll(async () => {
	authDir = TempDir.createSync("@omp-ultracode-surfaces-auth-");
	authStorage = await AuthStorage.create(authDir.join("auth.db"));
	authStorage.keys.setRuntime("anthropic", "test-key");
	modelRegistry = new ModelRegistry(authStorage, authDir.join("models.yml"));
});

afterAll(() => {
	authStorage.close();
	authDir.removeSync();
});

afterEach(async () => {
	vi.restoreAllMocks();
	for (const session of liveSessions.splice(0)) await session.dispose();
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
	for (const dir of tempDirs.splice(0)) dir.removeSync();
});

/** What a turn dispatched at: the session's live level and its ultracode flag. */
interface TurnState {
	level: unknown;
	flag: boolean;
}

/**
 * A REAL AgentSession with only the LLM call stubbed: every turn records the
 * level and flag it dispatched at (and optionally appends `reply`).
 */
function realSession(
	options: { settings: Settings; model?: Model; agentKind?: "main" | "sub"; agentId?: string; reply?: string } & Pick<
		CreateAgentSessionOptions,
		"thinkingLevel" | "thinkingLevelCeiling" | "ultracodeRestoreLevel" | "ultracodeRestoreCeiling"
	>,
): { session: AgentSession; turns: TurnState[] } {
	const dir = TempDir.createSync("@omp-ultracode-surfaces-");
	tempDirs.push(dir);
	const model = options.model ?? xhighModel;
	const session = new AgentSession({
		agent: new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [], thinkingLevel: Effort.High },
		}),
		sessionManager: SessionManager.inMemory(dir.path()),
		settings: options.settings,
		modelRegistry,
		agentKind: options.agentKind,
		agentId: options.agentId,
		thinkingLevel: options.thinkingLevel,
		thinkingLevelCeiling: options.thinkingLevelCeiling,
		ultracodeRestoreLevel: options.ultracodeRestoreLevel,
		ultracodeRestoreCeiling: options.ultracodeRestoreCeiling,
	});
	liveSessions.push(session);
	const turns: TurnState[] = [];
	vi.spyOn(session.agent, "prompt").mockImplementation(async () => {
		turns.push({ level: session.thinkingLevel, flag: cfgUltracode.get(session.settings) });
		if (options.reply !== undefined) session.agent.appendMessage(assistantText(options.reply));
	});
	return { session, turns };
}

/** A live session the registry resolves by id; only what the code under test reads. */
function registerLiveSession(id: string, settings: Settings, asyncJobManager?: AsyncJobManager): void {
	AgentRegistry.global().register({
		id,
		displayName: id,
		kind: "main",
		session: { settings, asyncJobManager } as unknown as AgentSession,
	});
}

/**
 * Replaces the SDK with a REAL child AgentSession built from the options the
 * surface hands it, registered the way sdk.ts registers a parentTaskPrefix
 * child (kind "sub", linked to `parentAgentId`). `duringCreate` runs inside
 * the SDK await, the window in which a root can flip under a spawn.
 */
function spyCreateRealChild(options: { reply?: string; duringCreate?: () => void } = {}) {
	const children: Array<{ session: AgentSession; turns: TurnState[] }> = [];
	const spy = vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async spawn => {
		if (!spawn?.settings || !spawn.agentId) throw new Error("child spawned without settings or identity");
		options.duringCreate?.();
		const child = realSession({
			settings: spawn.settings,
			model: spawn.model,
			agentKind: "sub",
			agentId: spawn.agentId,
			thinkingLevel: spawn.thinkingLevel,
			thinkingLevelCeiling: spawn.thinkingLevelCeiling,
			ultracodeRestoreLevel: spawn.ultracodeRestoreLevel,
			ultracodeRestoreCeiling: spawn.ultracodeRestoreCeiling,
			reply: options.reply,
		});
		AgentRegistry.global().register({
			id: spawn.agentId,
			displayName: spawn.agentDisplayName ?? "sub",
			kind: "sub",
			parentId: spawn.parentAgentId,
			session: child.session,
		});
		children.push(child);
		return { session: child.session } as unknown as CreateAgentSessionResult;
	});
	return { spy, children };
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

type TanJobRun = (ctx: {
	jobId: string;
	signal: AbortSignal;
	reportProgress: (text: string, details?: Record<string, unknown>) => Promise<void>;
}) => Promise<string>;

/**
 * Root session + interactive context covering what `/tan` reads at dispatch.
 * The root is registered as Main, the parent the clone's resume sync walks to.
 */
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
		settings: options.settings,
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
	AgentRegistry.global().register({ id: MAIN_AGENT_ID, displayName: MAIN_AGENT_ID, kind: "main", session });
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

async function runTanJob(run: TanJobRun | undefined): Promise<string> {
	if (!run) throw new Error("/tan did not register a background job");
	return run({ jobId: "job-ultra", signal: new AbortController().signal, reportProgress: async () => {} });
}

describe("/tan under ultracode", () => {
	it("keeps an armed clone's dispatch-time pin through its first turn when the root disarms before the job", async () => {
		// Guards: clone clamped/unpinned (no ceiling), restore level recorded as
		// the borrowed xhigh, clone sharing the root's live settings, and the
		// work prompt treated as a resume boundary, which would re-mirror the
		// root disarmed by the user's next prompt and run the whole assignment
		// at the hand-back level while session_init still says ultracode.
		const rootSettings = armedSettings();
		const harness = createTanHarness({
			settings: rootSettings,
			model: xhighModel,
			configuredLevel: Effort.XHigh,
			userConfiguredLevel: Effort.Low,
		});
		const real = spyCreateRealChild({ reply: "tan done" });
		const appendSessionInit = vi.spyOn(SessionManager.prototype, "appendSessionInit");

		await new TanCommandController(harness.ctx).start("chase the tangent");
		cfgUltracode.override(rootSettings, false);
		expect(await runTanJob(harness.capturedRun)).toBe("tan done");

		const options = onlyCallOptions(real.spy);
		expect(options.thinkingLevel).toBe(Effort.XHigh);
		expect(options.thinkingLevelCeiling).toBe(Effort.XHigh);
		expect(options.ultracodeRestoreLevel).toBe(Effort.Low);
		expect(options.ultracodeRestoreCeiling).toBeNull();
		expect(options.parentAgentId).toBe(MAIN_AGENT_ID);
		expect(real.children[0]?.turns).toEqual([{ level: Effort.XHigh, flag: true }]);
		expect(appendSessionInit).toHaveBeenCalledTimes(1);
		expect(appendSessionInit.mock.calls[0]?.[0]).toEqual(
			expect.objectContaining({
				task: "chase the tangent",
				ultracode: true,
				ultracodeRestoreLevel: Effort.Low,
				ultracodeRestoreCeiling: null,
			}),
		);
		// The root is already disarmed here; the clone's flag must still read true.
		expectStampedByValue(rootSettings, options.settings);
	});

	it("keeps an unarmed clone unpinned through its first turn when the root arms before the job", async () => {
		// Guards: the pin leaking outside ultracode (forced xhigh / ceiling /
		// restore level / persisted flag), an unarmed clone sharing the root's
		// live settings, and the work prompt re-mirroring a root the user armed
		// after dispatch (an unarmed tangent suddenly at xhigh, or refused
		// outright on a model without the rung).
		const rootSettings = Settings.isolated();
		const harness = createTanHarness({
			settings: rootSettings,
			model: xhighModel,
			configuredLevel: Effort.Medium,
			userConfiguredLevel: Effort.Medium,
		});
		const real = spyCreateRealChild();
		const appendSessionInit = vi.spyOn(SessionManager.prototype, "appendSessionInit");

		await new TanCommandController(harness.ctx).start("chase the tangent");
		cfgUltracode.override(rootSettings, true);
		await runTanJob(harness.capturedRun);

		const options = onlyCallOptions(real.spy);
		expect(options.thinkingLevel).toBe(Effort.Medium);
		expect(options.thinkingLevelCeiling).toBeUndefined();
		expect(options.ultracodeRestoreLevel).toBeUndefined();
		expect(options.ultracodeRestoreCeiling).toBeUndefined();
		expect(real.children[0]?.turns).toEqual([{ level: Effort.Medium, flag: false }]);
		const init = appendSessionInit.mock.calls[0]?.[0];
		if (!init) throw new Error("session_init was not appended");
		expect(init.ultracode).toBeUndefined();
		expect(init.ultracodeRestoreLevel).toBeUndefined();
		expect(init.ultracodeRestoreCeiling).toBeUndefined();
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
		const real = spyCreateRealChild();

		await new TanCommandController(harness.ctx).start("chase the tangent");

		expect(harness.ctx.showError).toHaveBeenCalledTimes(1);
		expect(harness.ctx.showError).toHaveBeenCalledWith(expect.stringContaining("ultracode requires xhigh"));
		expect(harness.forkFrom).not.toHaveBeenCalled();
		expect(harness.register).not.toHaveBeenCalled();
		expect(real.spy).not.toHaveBeenCalled();
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

	it("runs an armed architect at exactly xhigh as the owner's child, even when the owner disarms during its creation", async () => {
		// Guards: architect sharing the live Settings (its writes landing on the
		// interactive session, a parent disarm reaching it), an unpinned or
		// unceilinged architect, registering it as a second root instead of the
		// owner's child, and its request re-mirroring an owner that flipped while
		// the session was being created.
		const rootSettings = armedSettings();
		registerLiveSession("HubOwner", rootSettings);
		const real = spyCreateRealChild({
			reply: "name: reviewer",
			duringCreate: () => cfgUltracode.override(rootSettings, false),
		});
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

		const options = onlyCallOptions(real.spy);
		expect(options.model).toBe(xhighModel);
		expect(options.thinkingLevel).toBe(Effort.XHigh);
		expect(options.thinkingLevelCeiling).toBe(Effort.XHigh);
		expect(options.parentAgentId).toBe("HubOwner");
		expect(options.agentId).toMatch(/^Architect-/);
		expect(options.parentTaskPrefix).toBe(options.agentId);
		expect(real.children[0]?.turns).toEqual([{ level: Effort.XHigh, flag: true }]);
		cfgUltracode.override(rootSettings, true);
		expectStampedByValue(rootSettings, options.settings);
	});

	it("rejects an armed architect on a model without xhigh without creating a session", async () => {
		// Guards: the architect silently clamped onto high under an armed turn.
		const real = spyCreateRealChild();
		const deps = createAgentsHubDeps("/tmp", armedSettings(), hubRegistry(noXhighModel), extensionRoots);

		const outcome = deps.generateAgent("a code reviewer", () => {});

		await expect(outcome).rejects.toBeInstanceOf(UltracodeEffortError);
		await expect(outcome).rejects.toThrow("ultracode requires xhigh");
		expect(real.spy).not.toHaveBeenCalled();
	});

	it("leaves an unarmed architect at the SDK's level, even when the owner arms during its creation", async () => {
		// Guards: the xhigh pin/ceiling leaking onto the architect outside
		// ultracode, and its request arming it after the owner armed mid-create.
		const rootSettings = Settings.isolated();
		registerLiveSession("HubOwner", rootSettings);
		const real = spyCreateRealChild({
			reply: "name: reviewer",
			duringCreate: () => cfgUltracode.override(rootSettings, true),
		});
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

		await deps.generateAgent("a code reviewer", () => {});

		const options = onlyCallOptions(real.spy);
		expect(options.thinkingLevel).toBeUndefined();
		expect(options.thinkingLevelCeiling).toBeUndefined();
		const turns = real.children[0]?.turns ?? [];
		expect(turns.map(turn => turn.flag)).toEqual([false]);
		expect(turns[0]?.level).not.toBe(Effort.XHigh);
	});
});

describe("legacy pi shim createAgentSession under ultracode", () => {
	/** The SDK options a pi-era spawner (pi-schedule-prompt) passes, minus the live settings. */
	function realSdkSpawn(dir: TempDir): CreateAgentSessionOptions {
		return {
			cwd: dir.path(),
			agentDir: dir.path(),
			sessionManager: SessionManager.inMemory(dir.path()),
			modelRegistry,
			authStorage,
			model: xhighModel,
			disableExtensionDiscovery: true,
			skills: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			hasUI: false,
		};
	}

	it("forwards an armed live-settings spawn at exactly xhigh on a by-value overlay as the live session's child", async () => {
		// Guards: the legacy spawn sharing the live Settings, a caller-supplied
		// lower thinkingLevel winning over the pin, no ceiling, registering as a
		// root (which disarms on its first keyword-free prompt) or under the
		// wrong parent, a hand-back other than the caller's own level, and no
		// job manager for a child kind (agent()/workpool()/async task broken).
		const rootSettings = armedSettings();
		const liveJobs = new AsyncJobManager({ maxRunningJobs: 1 });
		registerLiveSession(MAIN_AGENT_ID, Settings.isolated());
		registerLiveSession("Secondary", rootSettings, liveJobs);
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
		expect(options.ultracodeRestoreLevel).toBe(Effort.Low);
		expect(options.ultracodeRestoreCeiling).toBeNull();
		expect(options.agentId).toMatch(/^Legacy-/);
		expect(options.parentTaskPrefix).toBe(options.agentId);
		expect(options.parentAgentId).toBe("Secondary");
		expect(options.asyncJobManager).toBe(liveJobs);
		expectStampedByValue(rootSettings, options.settings);
		expect(spawned.dispose).not.toHaveBeenCalled();
	});

	it("arms a pi-era settingsManager spawn as Main's child that keeps async jobs and hands back at the resume boundary", async () => {
		// Real SDK, pi-schedule-prompt's shape: the live Settings arrives as
		// `settingsManager` (SettingsManager.create(cwd) inside extension scope).
		// Guards: that spawn bypassing the whole armed contract (sharing the live
		// object as a flagged-but-unpinned root), an armed child with no
		// AsyncJobManager, and one the resume sync cannot reach (no parent link)
		// or that keeps the borrowed xhigh as its own level after the hand-back.
		using dir = TempDir.createSync("@omp-ultracode-legacy-");
		const rootSettings = Settings.isolated({ defaultThinkingLevel: Effort.Medium });
		cfgUltracode.override(rootSettings, true);
		const liveJobs = new AsyncJobManager({ maxRunningJobs: 1 });
		registerLiveSession(MAIN_AGENT_ID, rootSettings, liveJobs);

		const { session } = await legacyCreateAgentSession({ ...realSdkSpawn(dir), settingsManager: rootSettings });
		liveSessions.push(session);

		const id = session.getAgentId();
		if (!id) throw new Error("legacy child has no agent id");
		expect(AgentRegistry.global().get(id)?.parentId).toBe(MAIN_AGENT_ID);
		expect(session.settings).not.toBe(rootSettings);
		expect(cfgUltracode.get(session.settings)).toBe(true);
		expect(session.thinkingLevel).toBe(Effort.XHigh);
		expect(session.asyncJobManager).toBe(liveJobs);

		cfgUltracode.override(rootSettings, false);
		syncChildUltracodeAtResume(id, session, AgentRegistry.global());

		expect(cfgUltracode.get(session.settings)).toBe(false);
		// Unpinned, the SDK would have picked the settings default here (no
		// caller level, and the model carries no default of its own).
		expect(xhighModel.thinking?.defaultLevel).toBeUndefined();
		expect(session.thinkingLevel).toBe(Effort.Medium);
	});

	it("gives an armed child whose live session is unknown its own job manager, released with it", async () => {
		// Guards: an armed legacy child with no AsyncJobManager when no
		// registered session owns the Settings it was handed, and that manager
		// outliving the child.
		using dir = TempDir.createSync("@omp-ultracode-legacy-");
		const { session } = await legacyCreateAgentSession({ ...realSdkSpawn(dir), settings: armedSettings() });
		const jobs = session.asyncJobManager;
		expect(jobs).toBeInstanceOf(AsyncJobManager);
		expect(jobs?.atCapacity).toBe(false);
		expect(AgentRegistry.global().get(session.getAgentId() ?? "")?.parentId).toBe(MAIN_AGENT_ID);

		await session.dispose();

		expect(jobs?.atCapacity).toBe(true);
	});

	it("forwards an unarmed settingsManager spawn to the SDK untouched", async () => {
		// Guards: the ultracode contract leaking onto an unarmed legacy spawn
		// (upstream forwards the request object itself, live Settings shared).
		const live = Settings.isolated();
		const createSpy = spyCreateAgentSession({ model: xhighModel, dispose: vi.fn(async () => {}) });
		const request = { settingsManager: live, model: xhighModel };

		await legacyCreateAgentSession(request);

		expect(onlyCallOptions(createSpy)).toBe(request);
		expect(request).toEqual({ settingsManager: live, model: xhighModel });
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

	it("tears down an armed spawn whose SDK-resolved model has no xhigh rung", async () => {
		// Guards: the backstop for a model only the SDK could resolve (no model or
		// registry on the request); without it the session runs clamped under
		// the ultracode name.
		const dispose = vi.fn(async () => {});
		const createSpy = spyCreateAgentSession({ model: noXhighModel, dispose });

		const outcome = legacyCreateAgentSession({ settings: armedSettings() });

		await expect(outcome).rejects.toBeInstanceOf(UltracodeEffortError);
		await expect(outcome).rejects.toThrow("ultracode requires xhigh");
		expect(createSpy).toHaveBeenCalledTimes(1);
		expect(dispose).toHaveBeenCalledTimes(1);
	});
});

describe("IRC wake of an idle child (a resume boundary)", () => {
	const CHILD = `${MAIN_AGENT_ID}.Child`;

	function registerChild(session: AgentSession): void {
		AgentRegistry.global().register({
			id: CHILD,
			displayName: CHILD,
			kind: "sub",
			parentId: MAIN_AGENT_ID,
			session,
			status: "idle",
		});
	}

	it("re-pins an unarmed idle child to xhigh before the wake turn when the parent is armed", async () => {
		// Guards: the bus sync dropped, so a child woken inside an armed turn
		// runs that turn at its own level, unflagged (its spawns unfloored).
		registerLiveSession(MAIN_AGENT_ID, armedSettings());
		const child = realSession({
			settings: Settings.isolated(),
			agentKind: "sub",
			agentId: CHILD,
			thinkingLevel: Effort.Low,
		});
		registerChild(child.session);

		const receipt = await IrcBus.global().send({ from: MAIN_AGENT_ID, to: CHILD, body: "please continue" });

		expect(receipt.outcome).toBe("woken");
		expect(child.turns).toEqual([{ level: Effort.XHigh, flag: true }]);
	});

	it("hands a flagged idle child back to its restore level before the wake turn once the parent disarmed", async () => {
		// Guards: the bus sync dropped, so a child spawned by an earlier armed
		// turn keeps xhigh and its spawn floor long after that turn ended.
		registerLiveSession(MAIN_AGENT_ID, Settings.isolated());
		const child = realSession({
			settings: armedSettings(),
			agentKind: "sub",
			agentId: CHILD,
			thinkingLevel: Effort.XHigh,
			thinkingLevelCeiling: Effort.XHigh,
			ultracodeRestoreLevel: Effort.Low,
		});
		registerChild(child.session);

		const receipt = await IrcBus.global().send({ from: MAIN_AGENT_ID, to: CHILD, body: "next" });

		expect(receipt.outcome).toBe("woken");
		expect(child.turns).toEqual([{ level: Effort.Low, flag: false }]);
	});

	it("fails the wake loudly and keeps the message when the child cannot hold the pin", async () => {
		// Guards: a child without an xhigh rung woken into an armed turn running
		// clamped under the ultracode name, or the refused message being lost.
		registerLiveSession(MAIN_AGENT_ID, armedSettings());
		const child = realSession({
			settings: Settings.isolated(),
			model: noXhighModel,
			agentKind: "sub",
			agentId: CHILD,
			thinkingLevel: Effort.Low,
		});
		registerChild(child.session);
		const bus = IrcBus.global();

		const receipt = await bus.send({ from: MAIN_AGENT_ID, to: CHILD, body: "please continue" });

		expect(receipt.outcome).toBe("failed");
		expect(receipt.error).toContain("ultracode requires xhigh");
		expect(child.turns).toEqual([]);
		expect(cfgUltracode.get(child.session.settings)).toBe(false);
		expect(bus.take(CHILD)?.body).toBe("please continue");
	});

	it("leaves a streaming child's running turn at the pin it started with", async () => {
		// Guards: the sync running on a recipient that is mid-turn, flipping the
		// pin and floor under a turn it only joins as an aside.
		registerLiveSession(MAIN_AGENT_ID, armedSettings());
		const child = realSession({
			settings: Settings.isolated(),
			agentKind: "sub",
			agentId: CHILD,
			thinkingLevel: Effort.Low,
		});
		Object.defineProperty(child.session, "isStreaming", { configurable: true, get: () => true });
		registerChild(child.session);
		const delivered: TurnState[] = [];
		vi.spyOn(child.session, "deliverIrcMessage").mockImplementation(async () => {
			delivered.push({ level: child.session.thinkingLevel, flag: cfgUltracode.get(child.session.settings) });
			return "injected";
		});

		const receipt = await IrcBus.global().send({ from: MAIN_AGENT_ID, to: CHILD, body: "also this" });

		expect(receipt.outcome).toBe("injected");
		expect(delivered).toEqual([{ level: Effort.Low, flag: false }]);
	});
});
