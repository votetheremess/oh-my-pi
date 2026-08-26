import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentMessage, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { Effort } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import * as autoThinkingClassifier from "@oh-my-pi/pi-coding-agent/auto-thinking/classifier";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import {
	type CustomMessage,
	SKILL_PROMPT_MESSAGE_TYPE,
	type SkillPromptDetails,
} from "@oh-my-pi/pi-coding-agent/session/messages";
import { isHiddenUserCompanion, MAGIC_KEYWORD_NOTICE_TYPES } from "@oh-my-pi/pi-coding-agent/session/queued-messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { AUTO_THINKING } from "@oh-my-pi/pi-coding-agent/thinking";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const mockTaskTool: AgentTool = {
	name: "task",
	label: "Task",
	description: "Mock task tool",
	parameters: type({}),
	execute: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
};

const mockEvalTool: AgentTool = {
	name: "eval",
	label: "Eval",
	description: "Mock eval tool",
	parameters: type({}),
	execute: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
};

async function createMagicKeywordSession(
	modelRegistry: ModelRegistry,
	tools: AgentTool[] = [mockTaskTool, mockEvalTool],
): Promise<{
	session: AgentSession;
	settings: Settings;
}> {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected bundled Claude Sonnet model");
	const agent = new Agent({
		initialState: {
			model,
			systemPrompt: ["Test"],
			tools,
			messages: [],
			thinkingLevel: Effort.High,
		},
	});
	const settings = Settings.isolated();
	const session = new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(),
		settings,
		modelRegistry,
	});
	return { session, settings };
}

describe("AgentSession magic keyword settings", () => {
	let session: AgentSession | undefined;
	let authStorage: AuthStorage;
	let authRoot: string;
	let modelRegistry: ModelRegistry;

	beforeAll(async () => {
		authRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-magic-keywords-auth-"));
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

	it("does not append magic keyword notices when disabled", async () => {
		const created = await createMagicKeywordSession(modelRegistry);
		session = created.session;
		created.settings.set("magicKeywords.enabled", false);
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);

		await session.prompt("please workflowz this and ultrathink through it");

		const promptMessages = promptSpy.mock.calls[0]![0] as unknown as Array<{ customType?: string }>;
		expect(promptMessages.map(message => message.customType).filter(Boolean)).toEqual([]);
	});

	it("honors non-ultrathink per-keyword notice toggles", async () => {
		const created = await createMagicKeywordSession(modelRegistry);
		session = created.session;
		created.settings.set("magicKeywords.orchestrate", false);
		created.settings.set("magicKeywords.workflow", false);
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);

		await session.prompt("please orchestrate and workflowz this");

		const promptMessages = promptSpy.mock.calls[0]![0] as unknown as Array<{ customType?: string }>;
		expect(promptMessages.map(message => message.customType).filter(Boolean)).toEqual([]);
	});

	it("still appends enabled non-ultrathink notices", async () => {
		const created = await createMagicKeywordSession(modelRegistry);
		session = created.session;
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);

		await session.prompt("please orchestrate and workflowz this");

		const promptMessages = promptSpy.mock.calls[0]![0] as unknown as Array<{ customType?: string }>;
		expect(promptMessages.map(message => message.customType).filter(Boolean)).toEqual([
			"orchestrate-notice",
			"workflow-notice",
		]);
	});

	it("renders the eval-specific workflowz notice", async () => {
		const created = await createMagicKeywordSession(modelRegistry);
		session = created.session;
		created.settings.set("task.batch", false);
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);

		await session.prompt("please workflowz this");

		const promptMessages = promptSpy.mock.calls[0]![0] as unknown as Array<{
			content?: string;
			customType?: string;
		}>;
		const notice = promptMessages.find(message => message.customType === "workflow-notice");
		expect(notice?.customType).toBe("workflow-notice");
		expect(notice?.content).toContain("`eval`");
		expect(notice?.content).toContain("`parallel(thunks)`");
		expect(notice?.content).toContain("**Python (`eval`, Python backend):**");
		expect(notice?.content).toContain("**JavaScript (`eval`, JavaScript backend):**");
	});

	it("updates the workflowz notice when scout is disabled during the session", async () => {
		const created = await createMagicKeywordSession(modelRegistry);
		session = created.session;
		created.settings.set("task.disabledAgents", ["scout"]);
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);

		await session.prompt("please workflowz this");

		const promptMessages = promptSpy.mock.calls[0]![0] as unknown as Array<{ content?: string; customType?: string }>;
		const notice = promptMessages.find(message => message.customType === "workflow-notice")?.content ?? "";
		expect(notice.toLowerCase()).not.toContain("scout");
		expect(notice).toContain("Explore inline FIRST");
	});

	it("skips workflowz notice when the task tool is inactive", async () => {
		const created = await createMagicKeywordSession(modelRegistry, []);
		session = created.session;
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);

		await session.prompt("please workflowz this");

		const promptMessages = promptSpy.mock.calls[0]![0] as unknown as Array<{ customType?: string }>;
		expect(promptMessages.map(message => message.customType).filter(Boolean)).toEqual([]);
	});

	it("skips orchestrate notice when the task tool is inactive", async () => {
		const created = await createMagicKeywordSession(modelRegistry, []);
		session = created.session;
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);

		await session.prompt("please orchestrate this");

		const promptMessages = promptSpy.mock.calls[0]![0] as unknown as Array<{ customType?: string }>;
		expect(promptMessages.map(message => message.customType).filter(Boolean)).toEqual([]);
	});

	it("skips workflowz notice when the eval tool is inactive", async () => {
		const created = await createMagicKeywordSession(modelRegistry, [mockTaskTool]);
		session = created.session;
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);

		await session.prompt("please workflowz this");

		const promptMessages = promptSpy.mock.calls[0]![0] as unknown as Array<{ customType?: string }>;
		expect(promptMessages.map(message => message.customType).filter(Boolean)).toEqual([]);
	});

	it("does not use a disabled ultrathink keyword to force auto thinking", async () => {
		const created = await createMagicKeywordSession(modelRegistry);
		session = created.session;
		created.settings.set("magicKeywords.ultrathink", false);
		vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);
		const classifierSpy = vi.spyOn(autoThinkingClassifier, "classifyDifficulty").mockResolvedValue(Effort.Low);
		session.setThinkingLevel(AUTO_THINKING);

		await session.prompt("ultrathink through the unsafe refactor");

		expect(classifierSpy).toHaveBeenCalledTimes(1);
		expect(session.thinkingLevel).toBe(Effort.Low);
		expect(session.autoResolvedThinkingLevel()).toBe(Effort.Low);
	});

	it("queues the magic-keyword notice before the user message", async () => {
		const created = await createMagicKeywordSession(modelRegistry);
		session = created.session;
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);

		await session.prompt("ultrathink do the thing");

		const promptMessages = promptSpy.mock.calls[0]![0] as unknown as Array<{ role?: string; customType?: string }>;
		const noticeIdx = promptMessages.findIndex(m => m.customType === "ultrathink-notice");
		const userIdx = promptMessages.findIndex(m => m.role === "user");
		expect(noticeIdx).toBeGreaterThanOrEqual(0);
		expect(userIdx).toBeGreaterThanOrEqual(0);
		expect(noticeIdx).toBeLessThan(userIdx);
	});

	it("appends the ultracode notice and arms the ultracode turn flag", async () => {
		const created = await createMagicKeywordSession(modelRegistry);
		session = created.session;

		expect(created.settings.get("ultracode")).toBe(false);
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);

		await session.prompt("please ultracode this refactor");

		const promptMessages = promptSpy.mock.calls[0]![0] as unknown as Array<{
			attribution?: string;
			customType?: string;
			display?: boolean;
		}>;
		expect(promptMessages.map(message => message.customType).filter(Boolean)).toEqual(["ultracode-notice"]);
		const notice = promptMessages.find(message => message.customType === "ultracode-notice");
		expect(notice?.display).toBe(false);
		expect(notice?.attribution).toBe("user");
		// The override is turn state, not a session preference: armed by the
		// carrying turn, cleared by the next keyword-free user turn.
		expect(created.settings.get("ultracode")).toBe(true);
	});

	it("ships the orchestration contract in the ultracode notice when the tools are live", async () => {
		const created = await createMagicKeywordSession(modelRegistry);
		session = created.session;

		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);

		await session.prompt("please ultracode this refactor");

		const promptMessages = promptSpy.mock.calls[0]![0] as unknown as Array<{
			content?: string;
			customType?: string;
		}>;
		const notice = promptMessages.find(message => message.customType === "ultracode-notice")?.content ?? "";
		// The keyword promises a dynamic workflow, so the API to author one has to
		// be in the notice; naming it without carrying it is the whole defect.
		expect(notice).toContain("agent(");
		expect(notice).toContain("parallel(");
		expect(notice).toContain("THIS TURN");
	});

	it("keeps ultracode on but drops the fan-out contract when eval is inactive", async () => {
		const created = await createMagicKeywordSession(modelRegistry, [mockTaskTool]);
		session = created.session;

		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);

		await session.prompt("please ultracode this refactor");

		const promptMessages = promptSpy.mock.calls[0]![0] as unknown as Array<{
			content?: string;
			customType?: string;
		}>;
		// Unlike workflowz the notice is NOT skipped: the effort pin still applies.
		expect(promptMessages.map(message => message.customType).filter(Boolean)).toEqual(["ultracode-notice"]);
		const notice = promptMessages.find(message => message.customType === "ultracode-notice")?.content ?? "";
		expect(notice).toContain("xhigh");
		expect(notice).not.toContain("agent(");
		expect(notice).not.toContain("parallel(");
		expect(created.settings.get("ultracode")).toBe(true);
	});

	it("does not carry the ultracode notice into a later keyword-free turn", async () => {
		const created = await createMagicKeywordSession(modelRegistry);
		session = created.session;

		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);

		await session.prompt("please ultracode this refactor");
		await session.prompt("now do the next step");

		// Per-turn: the word steers the message that carries it and nothing after.
		const secondTurn = promptSpy.mock.calls[1]![0] as unknown as Array<{ customType?: string }>;
		expect(secondTurn.map(message => message.customType).filter(Boolean)).toEqual([]);
		expect(created.settings.get("ultracode")).toBe(false);
	});

	it("re-arms whenever the word comes back", async () => {
		const created = await createMagicKeywordSession(modelRegistry);
		session = created.session;

		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);

		await session.prompt("please ultracode this refactor");
		await session.prompt("now do the next step");
		await session.prompt("ultracode the follow-up too");

		const thirdTurn = promptSpy.mock.calls[2]![0] as unknown as Array<{ customType?: string }>;
		expect(thirdTurn.map(message => message.customType).filter(Boolean)).toEqual(["ultracode-notice"]);
		expect(created.settings.get("ultracode")).toBe(true);
	});

	it("refuses to let a persisted ultracode:true arm a keyword-free turn", async () => {
		const created = await createMagicKeywordSession(modelRegistry);
		session = created.session;

		created.settings.set("ultracode", true);
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);

		await session.prompt("just a normal message");

		// The flag is turn state, not a preference. A stale persisted true must not
		// silently run every turn at xhigh with a workflow contract attached.
		const promptMessages = promptSpy.mock.calls[0]![0] as unknown as Array<{ customType?: string }>;
		expect(promptMessages.map(message => message.customType).filter(Boolean)).toEqual([]);
		expect(created.settings.get("ultracode")).toBe(false);
	});

	it("appends a single ultracode notice when the keyword repeats while the flag is set", async () => {
		const created = await createMagicKeywordSession(modelRegistry);
		session = created.session;

		created.settings.override("ultracode", true);
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);

		await session.prompt("ultracode this one too");

		const promptMessages = promptSpy.mock.calls[0]![0] as unknown as Array<{ customType?: string }>;
		expect(promptMessages.map(message => message.customType).filter(Boolean)).toEqual(["ultracode-notice"]);
	});

	it("honors the per-keyword ultracode toggle", async () => {
		const created = await createMagicKeywordSession(modelRegistry);
		session = created.session;

		created.settings.set("magicKeywords.ultracode", false);
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);

		await session.prompt("please ultracode this refactor");

		const promptMessages = promptSpy.mock.calls[0]![0] as unknown as Array<{ customType?: string }>;
		expect(promptMessages.map(message => message.customType).filter(Boolean)).toEqual([]);
		expect(created.settings.get("ultracode")).toBe(false);
	});

	it("does not turn ultracode on when magic keywords are disabled outright", async () => {
		const created = await createMagicKeywordSession(modelRegistry);
		session = created.session;

		created.settings.set("magicKeywords.enabled", false);
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);

		await session.prompt("please ultracode this refactor");

		const promptMessages = promptSpy.mock.calls[0]![0] as unknown as Array<{ customType?: string }>;
		expect(promptMessages.map(message => message.customType).filter(Boolean)).toEqual([]);
		expect(created.settings.get("ultracode")).toBe(false);
	});

	it("never lets a synthetic turn trigger the ultracode keyword", async () => {
		const created = await createMagicKeywordSession(modelRegistry);
		session = created.session;

		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);

		await session.prompt("please ultracode this refactor", { synthetic: true });

		const promptMessages = promptSpy.mock.calls[0]![0] as unknown as Array<{ customType?: string }>;
		expect(promptMessages.map(message => message.customType).filter(Boolean)).toEqual([]);
		expect(created.settings.get("ultracode")).toBe(false);
	});

	// `synthetic` alone is not the gate: three agent-initiated callers reach
	// prompt() with `attribution: "agent"` and no synthetic flag — notably a
	// subagent's own task text in task/executor.ts.
	it("never lets an agent-authored turn trigger the ultracode keyword", async () => {
		const created = await createMagicKeywordSession(modelRegistry);
		session = created.session;

		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);

		await session.prompt("please ultracode this refactor", { attribution: "agent" });

		const promptMessages = promptSpy.mock.calls[0]![0] as unknown as Array<{ customType?: string }>;
		expect(promptMessages.map(message => message.customType).filter(Boolean)).toEqual([]);
		expect(created.settings.get("ultracode")).toBe(false);
	});

	// The depth-2 effort hazard: a subagent inherits `ultracode: true`, and its
	// own task prompt (agent-authored, no keyword in the text) must not hit the
	// disarm branch and clear the flag before the subagent can spawn anything —
	// otherwise grandchild spawns silently drop off the xhigh floor the notice
	// promises.
	it("leaves an inherited ultracode flag alone on an agent-authored turn", async () => {
		const created = await createMagicKeywordSession(modelRegistry);
		session = created.session;

		created.settings.override("ultracode", true);
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);

		await session.prompt("implement the thing described in the task brief", { attribution: "agent" });

		expect(promptSpy).toHaveBeenCalled();
		expect(created.settings.get("ultracode")).toBe(true);
	});

	// A keyword-free USER turn must still disarm, or the keyword would silently
	// become session-scoped again.
	it("still disarms ultracode on a keyword-free user turn", async () => {
		const created = await createMagicKeywordSession(modelRegistry);
		session = created.session;

		created.settings.override("ultracode", true);
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);

		await session.prompt("just a normal follow-up question");

		expect(promptSpy).toHaveBeenCalled();
		expect(created.settings.get("ultracode")).toBe(false);
	});

	// A keyword typed as /skill ARGUMENTS fires through the same notice builder
	// as a plain prompt: promptCustomMessage routes a user-attributed skill
	// prompt's args into the keyword scan. Severing that callsite (or dropping
	// ultracode from it) ships green through every plain-prompt test above —
	// this is the only gated coverage of the skill-args firing path.
	it("arms ultracode from user-attributed skill args", async () => {
		const created = await createMagicKeywordSession(modelRegistry);
		session = created.session;
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);

		const details: SkillPromptDetails = {
			name: "deep-work",
			path: "/skills/deep-work/SKILL.md",
			args: "ultracode the refactor",
			lineCount: 1,
		};
		await session.promptCustomMessage({
			customType: SKILL_PROMPT_MESSAGE_TYPE,
			content: `Skill body\n\nUser: ${details.args}`,
			display: true,
			details,
			attribution: "user",
		});

		const promptMessages = promptSpy.mock.calls[0]![0] as unknown as Array<{ customType?: string }>;
		// The notice precedes the skill body, exactly like a typed keyword's
		// notice precedes the user message.
		expect(promptMessages.map(message => message.customType).filter(Boolean)).toEqual([
			"ultracode-notice",
			SKILL_PROMPT_MESSAGE_TYPE,
		]);
		expect(created.settings.get("ultracode")).toBe(true);
	});

	// Skill prompts the harness injects itself (autoloads, subagent skill
	// injection) carry `attribution: "agent"`. Their args are not user-authored
	// text and must neither arm the keyword...
	it("never lets an agent-attributed skill prompt's args trigger ultracode", async () => {
		const created = await createMagicKeywordSession(modelRegistry);
		session = created.session;
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);

		await session.promptCustomMessage({
			customType: SKILL_PROMPT_MESSAGE_TYPE,
			content: "Skill body",
			display: false,
			details: { name: "autoload", path: "/skills/autoload/SKILL.md", args: "ultracode the refactor" },
			attribution: "agent",
		});

		const promptMessages = promptSpy.mock.calls[0]![0] as unknown as Array<{ customType?: string }>;
		expect(promptMessages.map(message => message.customType).filter(Boolean)).toEqual([SKILL_PROMPT_MESSAGE_TYPE]);
		expect(created.settings.get("ultracode")).toBe(false);
	});

	// ...nor run the keyword builder's disarm `else` against an armed inherited
	// flag — the skill-prompt twin of the depth-2 effort hazard above. Loosening
	// the user-attribution gate fails here.
	it("leaves an inherited ultracode flag alone on an agent-attributed skill steer", async () => {
		const created = await createMagicKeywordSession(modelRegistry);
		session = created.session;

		created.settings.override("ultracode", true);
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);

		await session.promptCustomMessage({
			customType: SKILL_PROMPT_MESSAGE_TYPE,
			content: "Skill body",
			display: false,
			details: { name: "autoload", path: "/skills/autoload/SKILL.md", args: "carry on with the brief" },
			attribution: "agent",
		});

		expect(promptSpy).toHaveBeenCalled();
		expect(created.settings.get("ultracode")).toBe(true);
	});

	// A keyword-free USER-attributed skill turn is still a user turn: it must
	// hand the borrowed effort back, or firing a skill would silently extend an
	// ultracode turn past the message that carried the word.
	it("disarms ultracode on a keyword-free user-attributed skill prompt", async () => {
		const created = await createMagicKeywordSession(modelRegistry);
		session = created.session;

		created.settings.override("ultracode", true);
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);

		await session.promptCustomMessage({
			customType: SKILL_PROMPT_MESSAGE_TYPE,
			content: "Skill body",
			display: true,
			details: { name: "deep-work", path: "/skills/deep-work/SKILL.md", args: "just do the next step" },
			attribution: "user",
		});

		expect(promptSpy).toHaveBeenCalled();
		expect(created.settings.get("ultracode")).toBe(false);
	});

	// Every notice the session queues MUST be a recognized hidden companion, or
	// dequeue/clear walk past it: the user's prompt leaves and the hidden notice
	// stays behind, uncounted, to be delivered ahead of a later unrelated turn.
	// `ultracode-notice` was missing from that table while the other three were
	// registered, so this enumerates from the session rather than hardcoding.
	it("registers every queued keyword notice as a hidden user companion", async () => {
		const created = await createMagicKeywordSession(modelRegistry);
		session = created.session;

		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);

		await session.prompt("ultracode and ultrathink and orchestrate and workflowz this");

		const promptMessages = promptSpy.mock.calls[0]![0] as unknown as AgentMessage[];
		const notices = promptMessages.filter(
			(message): message is CustomMessage => message.role === "custom" && message.display === false,
		);
		expect(notices.map(notice => notice.customType).sort()).toEqual([
			"orchestrate-notice",
			"ultracode-notice",
			"ultrathink-notice",
			"workflow-notice",
		]);
		for (const notice of notices) {
			expect(MAGIC_KEYWORD_NOTICE_TYPES[notice.customType]).toBe(true);
			expect(isHiddenUserCompanion(notice)).toBe(true);
		}
	});
});
