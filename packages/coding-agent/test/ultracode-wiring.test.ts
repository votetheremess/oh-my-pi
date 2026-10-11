/**
 * Ultracode wiring that only shows up when the REAL pieces are connected.
 *
 * The other ultracode files test the turn state through ModelControls and
 * AgentSession methods directly. Every case here instead drives the seam a
 * production caller uses, because each of these seams was once mutated (the
 * guarded line broken) with the rest of the gate staying green:
 *
 * - the agent loop firing a queued message's delivery rider when it commits the
 *   message (packages/agent agent-loop `ASIDE_MESSAGE_COMMIT`);
 * - the extension runtimes (print/RPC `initializeExtensions`, both interactive
 *   `ExtensionUiController` contexts, `runExtensionSetModel`) attributing their
 *   model and level changes to `"extension"`, so an armed turn re-pins instead
 *   of taking the user-only off-ramp;
 * - `ModelControls.setModel` re-pinning over a target model's own catalog
 *   `thinking.defaultLevel`;
 * - the arm/disarm-time advisor resync for a fixed-level advisor;
 * - `switchSession` reading the pin's borrowed-FROM receipt back;
 * - the user model-pick off-ramp on `cycleModel`, `applyRoleModel` and
 *   `cycleRoleModels`;
 * - the upstream turn-budget rule (`+50k`) the fork moved out of the keyword
 *   notice builder.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { Api, AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import { Effort } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { runExtensionSetModel } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/compact-handler";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type { ExtensionAPI, ExtensionUIContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { AcpAgent } from "@oh-my-pi/pi-coding-agent/modes/acp/acp-agent";
import { ExtensionUiController } from "@oh-my-pi/pi-coding-agent/modes/controllers/extension-ui-controller";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import { cfgUltracode } from "@oh-my-pi/pi-coding-agent/modes/settings";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm, SKILL_PROMPT_MESSAGE_TYPE } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import type { AgentSideConnection } from "@oh-my-pi/pi-utils/acp";

let authRoot: string;
let authStorage: AuthStorage;
let modelRegistry: ModelRegistry;
/** Every session a test built; disposed after each test. */
const sessions: AgentSession[] = [];
/** Temp dirs to remove after each test. */
const roots: string[] = [];

beforeAll(async () => {
	authRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ultracode-wiring-auth-"));
	authStorage = await AuthStorage.create(path.join(authRoot, "auth.db"));
	authStorage.keys.setRuntime("anthropic", "test-key");
	authStorage.keys.setRuntime("openai", "test-key");
	authStorage.keys.setRuntime("openrouter", "test-key");
	modelRegistry = new ModelRegistry(authStorage, path.join(authRoot, "models.yml"));
});

afterAll(async () => {
	authStorage.close();
	await removeWithRetries(authRoot);
});

afterEach(async () => {
	vi.restoreAllMocks();
	for (const session of sessions.splice(0)) await session.dispose();
	for (const root of roots.splice(0)) await removeWithRetries(root);
	AgentRegistry.resetGlobalForTests();
});

async function tempRoot(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ultracode-wiring-"));
	roots.push(root);
	return root;
}

function bundled(provider: string, id: string): Model<Api> {
	const model = modelRegistry.find(provider, id) ?? getBundledModel(provider as "anthropic", id);
	if (!model) throw new Error(`Expected bundled ${provider}/${id}`);
	return model as Model<Api>;
}

/** xhigh-capable, carries no `thinking.defaultLevel` of its own: what lands after a swap is the controls' doing. */
function opus(): Model<Api> {
	const model = bundled("anthropic", "claude-opus-4-5");
	expect(model.thinking?.defaultLevel).toBeUndefined();
	return model;
}

interface SessionOptions {
	settings?: Settings;
	extensionRunner?: ExtensionRunner;
	sessionManager?: SessionManager;
	scopedModels?: Array<{ model: Model<Api> }>;
}

/**
 * A root on anthropic/claude-sonnet-4-5 (xhigh rung) whose own level is `low`.
 * The agent loop is not run: `agent.prompt` is mocked, so `prompt()` exercises
 * the session's own turn-state wiring and returns.
 */
async function createSession(options: SessionOptions = {}): Promise<AgentSession> {
	const settings = options.settings ?? Settings.isolated({ "compaction.enabled": false });
	const session = new AgentSession({
		agent: new Agent({
			initialState: {
				model: bundled("anthropic", "claude-sonnet-4-5"),
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
				thinkingLevel: Effort.High,
			},
		}),
		sessionManager: options.sessionManager ?? SessionManager.inMemory(await tempRoot()),
		settings,
		modelRegistry,
		extensionRunner: options.extensionRunner,
		scopedModels: options.scopedModels,
	});
	sessions.push(session);
	session.setThinkingLevel(Effort.Low);
	vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);
	return session;
}

/** Arms the turn the way a user does: the keyword in a prompt. */
async function armThroughPrompt(session: AgentSession): Promise<void> {
	await session.prompt("please ultracode this refactor");
	expect(cfgUltracode.get(session.settings)).toBe(true);
	expect(session.thinkingLevel).toBe(Effort.XHigh);
}

// --- 1. delivery riders through a REAL agent loop ---------------------------
//
// The queued-path tests in ultracode-turn-effort fire the delivery rider by
// hand. These run the real Agent loop with a mock provider: the first request
// calls a tool that blocks until released, so a steer or follow-up can be queued
// while the turn is genuinely streaming, and each provider request records the
// reasoning effort it was sent with.

describe("queued ultracode riders through the real agent loop", () => {
	const zeroUsage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	} satisfies AssistantMessage["usage"];

	interface Call {
		reasoning: unknown;
		flag: boolean;
		level: unknown;
	}

	interface LoopHarness {
		session: AgentSession;
		calls: Call[];
		/** Resolves once the first request's tool call is executing (the turn is mid-stream). */
		toolStarted: Promise<void>;
		releaseTool: () => void;
	}

	async function createLoopSession(): Promise<LoopHarness> {
		const mock = createMockModel({ provider: "openai", id: "gpt-test", reasoning: true });
		const model = mock.model as Model<Api>;
		model.thinking = {
			mode: "effort",
			efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
			defaultLevel: Effort.High,
		};
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const slowTool: AgentTool = {
			name: "slow",
			label: "Slow",
			description: "Blocks until released",
			parameters: type({}),
			execute: async () => {
				started.resolve();
				await release.promise;
				return { content: [{ type: "text", text: "SLOW_DONE" }] };
			},
		};
		const calls: Call[] = [];
		const settings = Settings.isolated({ "compaction.enabled": false, "todo.enabled": false });
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		// oxlint-disable-next-line prefer-const -- read by the stream closure before assignment
		let session!: AgentSession;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [slowTool], messages: [], thinkingLevel: Effort.Low },
			convertToLlm,
			streamFn: (_model, _context, streamOptions) => {
				const n = calls.length;
				calls.push({
					reasoning: streamOptions?.reasoning,
					flag: cfgUltracode.get(settings),
					level: session.thinkingLevel,
				});
				const message: AssistantMessage = {
					role: "assistant",
					content:
						n === 0
							? [{ type: "toolCall", id: "tc-0", name: "slow", arguments: {} }]
							: [{ type: "text", text: "Done." }],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: zeroUsage,
					stopReason: n === 0 ? "toolUse" : "stop",
					timestamp: Date.now(),
				};
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason: n === 0 ? "toolUse" : "stop", message });
				});
				return stream;
			},
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(await tempRoot()),
			settings,
			modelRegistry,
			toolRegistry: new Map([[slowTool.name, slowTool]]),
			thinkingLevel: Effort.Low,
		});
		sessions.push(session);
		return { session, calls, toolStarted: started.promise, releaseTool: () => release.resolve() };
	}

	it("arms a queued `ultracode` follow-up when the loop commits it, not when it is queued", async () => {
		const h = await createLoopSession();
		const run = h.session.prompt("first plain turn");
		await h.toolStarted;

		await h.session.prompt("now ultracode the rest", { streamingBehavior: "followUp" });
		// Queuing must not touch the turn that is running.
		expect(cfgUltracode.get(h.session.settings)).toBe(false);
		expect(h.session.thinkingLevel).toBe(Effort.Low);

		h.releaseTool();
		await run;
		await h.session.waitForIdle();

		// Request 0 opened the plain turn, request 1 continued it after the tool;
		// the follow-up's own request comes after both and must go out at xhigh.
		expect(h.calls.length).toBeGreaterThanOrEqual(3);
		expect(h.calls[0]).toEqual({ reasoning: Effort.Low, flag: false, level: Effort.Low });
		expect(h.calls[1]).toEqual({ reasoning: Effort.Low, flag: false, level: Effort.Low });
		expect(h.calls.at(-1)).toEqual({ reasoning: Effort.XHigh, flag: true, level: Effort.XHigh });
		expect(cfgUltracode.get(h.session.settings)).toBe(true);
	});

	it("disarms when the loop commits a keyword-free follow-up queued during an armed turn", async () => {
		const h = await createLoopSession();
		const run = h.session.prompt("ultracode go");
		await h.toolStarted;
		expect(cfgUltracode.get(h.session.settings)).toBe(true);

		await h.session.prompt("plain follow up", { streamingBehavior: "followUp" });
		// Still armed while queued: the running turn keeps its pin.
		expect(cfgUltracode.get(h.session.settings)).toBe(true);
		expect(h.session.thinkingLevel).toBe(Effort.XHigh);

		h.releaseTool();
		await run;
		await h.session.waitForIdle();

		expect(h.calls.length).toBeGreaterThanOrEqual(3);
		expect(h.calls[0]).toEqual({ reasoning: Effort.XHigh, flag: true, level: Effort.XHigh });
		expect(h.calls[1]).toEqual({ reasoning: Effort.XHigh, flag: true, level: Effort.XHigh });
		expect(h.calls.at(-1)).toEqual({ reasoning: Effort.Low, flag: false, level: Effort.Low });
		expect(cfgUltracode.get(h.session.settings)).toBe(false);
	});

	it("arms the running turn when the loop commits an `ultracode` steer", async () => {
		const h = await createLoopSession();
		const run = h.session.prompt("first plain turn");
		await h.toolStarted;

		await h.session.prompt("actually ultracode this", { streamingBehavior: "steer" });
		expect(cfgUltracode.get(h.session.settings)).toBe(false);

		h.releaseTool();
		await run;
		await h.session.waitForIdle();

		// The steer joins the running turn after the tool result: the very next
		// request is the first one at xhigh.
		expect(h.calls[0]).toEqual({ reasoning: Effort.Low, flag: false, level: Effort.Low });
		expect(h.calls[1]).toEqual({ reasoning: Effort.XHigh, flag: true, level: Effort.XHigh });
		expect(cfgUltracode.get(h.session.settings)).toBe(true);
	});
});

// --- 2. extension runtimes are never a user surface --------------------------
//
// A level or model change from an extension keeps an armed turn armed: the
// change lands, then the turn re-pins xhigh. Reverting any call site to the
// one-argument upstream form makes it a "user" pick, which ends the turn.

describe("extension runtimes keep an armed ultracode turn armed", () => {
	/** A real extension whose factory hands back its `pi` API, plus a real runner around it. */
	async function extensionHarness(): Promise<{ pi: ExtensionAPI; runner: ExtensionRunner; manager: SessionManager }> {
		const cwd = await tempRoot();
		const runtime = new ExtensionRuntime();
		let captured: ExtensionAPI | undefined;
		const extension = await loadExtensionFromFactory(
			pi => {
				captured = pi;
			},
			cwd,
			new EventBus(),
			runtime,
			"ultracode-wiring-probe",
		);
		if (!captured) throw new Error("extension factory did not run");
		const manager = SessionManager.inMemory(cwd);
		const runner = new ExtensionRunner([extension], runtime, cwd, manager, modelRegistry);
		return { pi: captured, runner, manager };
	}

	/** Lowers the level and swaps the model through `pi`, asserting the turn stays armed and hands back `low`. */
	async function expectExtensionChangesKeepTurn(session: AgentSession, pi: ExtensionAPI): Promise<void> {
		pi.setThinkingLevel(Effort.Medium);
		expect(cfgUltracode.get(session.settings)).toBe(true);
		expect(session.thinkingLevel).toBe(Effort.XHigh);

		expect(await pi.setModel(opus())).toBe(true);
		expect(session.model?.id).toBe("claude-opus-4-5");
		expect(cfgUltracode.get(session.settings)).toBe(true);
		expect(session.thinkingLevel).toBe(Effort.XHigh);

		// The handback still points at the level the user owned before the keyword.
		await session.prompt("keyword-free follow-up");
		expect(cfgUltracode.get(session.settings)).toBe(false);
		expect(session.thinkingLevel).toBe(Effort.Low);
	}

	it("runExtensionSetModel re-pins on the new model instead of ending the turn", async () => {
		const session = await createSession();
		await armThroughPrompt(session);

		expect(await runExtensionSetModel(session, opus())).toBe(true);

		expect(session.model?.id).toBe("claude-opus-4-5");
		expect(cfgUltracode.get(session.settings)).toBe(true);
		expect(session.thinkingLevel).toBe(Effort.XHigh);
	});

	it("print/RPC extension context (initializeExtensions) attributes level changes to the extension", async () => {
		const { pi, runner, manager } = await extensionHarness();
		const session = await createSession({ extensionRunner: runner, sessionManager: manager });
		await initializeExtensions(session, { reportSendError: () => {}, reportRuntimeError: () => {} });
		await armThroughPrompt(session);

		await expectExtensionChangesKeepTurn(session, pi);
	});

	/** The slice of the interactive host the controller touches while wiring the runner. */
	function interactiveHost(session: AgentSession): InteractiveModeContext {
		return {
			session,
			sessionManager: session.sessionManager,
			syncComposerShape: () => {},
			setToolUIContext: () => {},
		} as unknown as InteractiveModeContext;
	}

	it("interactive command context (initHooksAndCustomTools) attributes level changes to the extension", async () => {
		const { pi, runner, manager } = await extensionHarness();
		const session = await createSession({ extensionRunner: runner, sessionManager: manager });
		await new ExtensionUiController(interactiveHost(session)).initHooksAndCustomTools();
		await armThroughPrompt(session);

		await expectExtensionChangesKeepTurn(session, pi);
	});

	it("interactive hook-runner context (initializeHookRunner) attributes level changes to the extension", async () => {
		const { pi, runner, manager } = await extensionHarness();
		const session = await createSession({ extensionRunner: runner, sessionManager: manager });
		new ExtensionUiController(interactiveHost(session)).initializeHookRunner({} as ExtensionUIContext, false);
		await armThroughPrompt(session);

		await expectExtensionChangesKeepTurn(session, pi);
	});

	it("ACP extension context attributes level changes to the extension", async () => {
		const { pi, runner, manager } = await extensionHarness();
		const session = await createSession({ extensionRunner: runner, sessionManager: manager });
		const connection = {
			sessionUpdate: async () => {},
			signal: new AbortController().signal,
			closed: Promise.withResolvers<void>().promise,
		} as unknown as AgentSideConnection;
		const acp = new AcpAgent(connection, async () => ({ session, setToolUIContext: () => {} }));
		const created = await acp.newSession({ cwd: manager.getCwd(), mcpServers: [] });
		expect(created.sessionId).toBe(session.sessionId);
		await armThroughPrompt(session);

		await expectExtensionChangesKeepTurn(session, pi);
	});
});

// Entering plan mode is the user's choice and ends an armed turn on every
// surface. ACP's mode switch sets plan state without touching the model, so no
// model-pick off-ramp runs there: the pin and the subagent floor would carry
// into planning unless the mode change itself disarms.
describe("ACP plan-mode entry", () => {
	it("ends an armed turn, while re-selecting plan from inside plan mode does not", async () => {
		const session = await createSession();
		const connection = {
			sessionUpdate: async () => {},
			signal: new AbortController().signal,
			closed: Promise.withResolvers<void>().promise,
		} as unknown as AgentSideConnection;
		const acp = new AcpAgent(connection, async () => ({ session, setToolUIContext: () => {} }));
		const { sessionId } = await acp.newSession({ cwd: session.sessionManager.getCwd(), mcpServers: [] });
		await armThroughPrompt(session);

		await acp.setSessionMode({ sessionId, modeId: "plan" });
		expect(session.getPlanModeState()?.enabled).toBe(true);
		expect(cfgUltracode.get(session.settings)).toBe(false);
		expect(session.thinkingLevel).toBe(Effort.Low);

		// A keyword typed while planning arms the planning turn; the client
		// re-sending the mode it is already in is not an entry and keeps it.
		await armThroughPrompt(session);
		await acp.setSessionMode({ sessionId, modeId: "plan" });
		expect(cfgUltracode.get(session.settings)).toBe(true);
		expect(session.thinkingLevel).toBe(Effort.XHigh);
	});
});

// --- 3. ModelControls.setModel re-pins over the target's own default ---------

describe("an internal model swap during an armed turn", () => {
	it("re-pins xhigh over a target model whose catalog default level is not xhigh", async () => {
		const session = await createSession();
		await armThroughPrompt(session);
		const target = bundled("openrouter", "anthropic/claude-fable-5");
		// The fixture only proves the re-pin if the target brings its own lower level.
		expect(target.thinking?.defaultLevel).toBeDefined();
		expect(target.thinking?.defaultLevel).not.toBe(Effort.XHigh);
		expect(target.thinking?.efforts).toContain(Effort.XHigh);

		await session.setModel(target, "default", undefined, "extension");

		expect(session.model?.id).toBe("anthropic/claude-fable-5");
		expect(cfgUltracode.get(session.settings)).toBe(true);
		expect(session.thinkingLevel).toBe(Effort.XHigh);
	});
});

// --- 4. fixed-level advisor follows the turn ---------------------------------

describe("a fixed-level advisor under a keyword-armed turn", () => {
	it("pins the live advisor to xhigh at the arm and hands it back at the disarm", async () => {
		const settings = Settings.isolated({ "compaction.enabled": false });
		settings.setModelRole("advisor", "anthropic/claude-sonnet-4-5:medium");
		const session = new AgentSession({
			agent: new Agent({
				initialState: {
					model: bundled("anthropic", "claude-sonnet-4-5"),
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
				},
				streamFn: createMockModel({ handler: { content: ["primary"] } }).stream,
			}),
			sessionManager: SessionManager.inMemory(await tempRoot()),
			settings,
			modelRegistry,
			advisorTools: [],
			advisorStreamFn: createMockModel({ handler: { content: ["advice"] } }).stream,
		});
		sessions.push(session);
		session.setThinkingLevel(Effort.Low);
		expect(session.setAdvisorEnabled(true)).toBe(true);
		const advisor = session.getAdvisorAgent();
		if (!advisor) throw new Error("advisor did not start");
		expect(advisor.state.thinkingLevel).toBe(Effort.Medium);
		vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);

		await session.prompt("please ultracode this");
		// Re-pinned in place: the same live advisor, not a rebuilt one.
		expect(session.getAdvisorAgent()).toBe(advisor);
		expect(advisor.state.thinkingLevel).toBe(Effort.XHigh);

		await session.prompt("keyword-free follow-up");
		expect(cfgUltracode.get(settings)).toBe(false);
		expect(session.getAdvisorAgent()).toBe(advisor);
		expect(advisor.state.thinkingLevel).toBe(Effort.Medium);
	});
});

// --- 5. switchSession reads the pin receipt back ------------------------------

describe("switchSession into a transcript left armed", () => {
	it("resumes at the pre-ultracode level the pin's receipt recorded, not at xhigh", async () => {
		const root = await tempRoot();
		const sessionDir = path.join(root, "sessions");
		const armed = await createSession({ sessionManager: SessionManager.create(root, sessionDir) });
		await armThroughPrompt(armed);
		// The transcript a killed process leaves behind: its last thinking entry is the pin.
		const levels = armed.sessionManager
			.getEntries()
			.filter(entry => entry.type === "thinking_level_change")
			.map(entry => [entry.thinkingLevel, entry.configured]);
		expect(levels.at(-1)).toEqual([Effort.XHigh, Effort.Low]);
		await armed.sessionManager.ensureOnDisk();
		await armed.sessionManager.flush();
		const file = armed.sessionManager.getSessionFile();
		if (!file) throw new Error("armed session has no file");

		const resumed = await createSession({ sessionManager: SessionManager.create(root, sessionDir) });
		resumed.setThinkingLevel(Effort.High);
		expect(await resumed.switchSession(file)).toBe(true);

		expect(cfgUltracode.get(resumed.settings)).toBe(false);
		expect(resumed.thinkingLevel).toBe(Effort.Low);
		expect(resumed.configuredThinkingLevel()).toBe(Effort.Low);
	});
});

// --- 6. user model picks end the turn first ----------------------------------
//
// Without the off-ramp, ModelControls sees the flag still up after the swap and
// re-pins xhigh: the user would keep the borrowed effort and the spawn floor on
// a model they just chose.

describe("user model picks end an armed turn", () => {
	it("cycleModel (Ctrl+P) disarms before cycling", async () => {
		const sonnet = bundled("anthropic", "claude-sonnet-4-5");
		const session = await createSession({ scopedModels: [{ model: sonnet }, { model: opus() }] });
		await armThroughPrompt(session);

		const result = await session.cycleModel("forward");

		expect(result?.model.id).toBe("claude-opus-4-5");
		expect(cfgUltracode.get(session.settings)).toBe(false);
		expect(session.thinkingLevel).not.toBe(Effort.XHigh);
	});

	function settingsWithSlowRole(): Settings {
		const settings = Settings.isolated({ "compaction.enabled": false });
		settings.setModelRole("slow", "anthropic/claude-opus-4-5:medium");
		return settings;
	}

	it("applyRoleModel disarms before applying the role", async () => {
		const session = await createSession({ settings: settingsWithSlowRole() });
		await armThroughPrompt(session);
		const entry = session.getRoleModelCycle(["slow"])?.models[0];
		if (!entry) throw new Error("slow role did not resolve");

		await session.applyRoleModel(entry);

		expect(session.model?.id).toBe("claude-opus-4-5");
		expect(cfgUltracode.get(session.settings)).toBe(false);
		expect(session.thinkingLevel).toBe(Effort.Medium);
	});

	it("cycleRoleModels disarms before cycling roles", async () => {
		const session = await createSession({ settings: settingsWithSlowRole() });
		await armThroughPrompt(session);

		const result = await session.cycleRoleModels(["default", "slow"], "forward");

		expect(result?.role).toBe("slow");
		expect(session.model?.id).toBe("claude-opus-4-5");
		expect(cfgUltracode.get(session.settings)).toBe(false);
		expect(session.thinkingLevel).toBe(Effort.Medium);
	});
});

// --- 7. turn budgets ----------------------------------------------------------

describe("turn budget directives through AgentSession", () => {
	it("applies `+50k` typed into a user prompt", async () => {
		const session = await createSession();
		await session.prompt("be thorough +50k!");
		expect(session.sessionManager.getTurnBudget()).toMatchObject({ total: 50_000, hard: true });
	});

	it("applies a budget typed into user skill args", async () => {
		const session = await createSession();
		await session.promptCustomMessage({
			customType: SKILL_PROMPT_MESSAGE_TYPE,
			content: "Skill body",
			display: true,
			details: { name: "x", path: "/x/SKILL.md", args: "go +20k", lineCount: 1 },
			attribution: "user",
		});
		expect(session.sessionManager.getTurnBudget()).toMatchObject({ total: 20_000, hard: false });
	});

	it("ignores a budget in a synthetic prompt", async () => {
		const session = await createSession();
		await session.prompt("be thorough +50k!");
		await session.prompt("internal continuation +20k", { synthetic: true });
		expect(session.sessionManager.getTurnBudget()).toMatchObject({ total: 50_000, hard: true });
	});
});
