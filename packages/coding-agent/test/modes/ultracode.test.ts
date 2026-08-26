import { beforeAll, describe, expect, it } from "bun:test";
import { containsOrchestrate, highlightOrchestrate } from "@oh-my-pi/pi-coding-agent/modes/orchestrate";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import {
	containsUltracode,
	highlightUltracode,
	renderUltracodeNotice,
	ULTRACODE_NOTICE,
} from "@oh-my-pi/pi-coding-agent/modes/ultracode";
import { WORKFLOW_NOTICE } from "@oh-my-pi/pi-coding-agent/modes/workflow";

beforeAll(() => {
	// highlightUltracode/highlightOrchestrate read the global theme's color mode.
	initTheme();
});

/** First SGR escape emitted by a gradient highlighter, i.e. its opening color stop. */
function firstEscape(decorated: string): string {
	const start = decorated.indexOf("\x1b");
	if (start < 0) return "";
	return decorated.slice(start, decorated.indexOf("m", start) + 1);
}

describe("ultracode keyword detection", () => {
	it("matches the lowercase word delimited by whitespace or a string edge", () => {
		expect(containsUltracode("ultracode")).toBe(true);
		expect(containsUltracode("please ultracode this refactor")).toBe(true);
		expect(containsUltracode("ultracode the migration")).toBe(true);
		// A newline is whitespace, and end-of-string is a valid right boundary.
		expect(containsUltracode("do it now\nultracode")).toBe(true);
	});

	it("matches the lowercase word beside prose punctuation and quotes", () => {
		for (const text of ["do it. ultracode.", "please ultracode, then report", 'say "ultracode" now']) {
			expect(containsUltracode(text)).toBe(true);
		}
	});

	it("ignores casing, inflections, and path-embedded forms", () => {
		expect(containsUltracode("Ultracode")).toBe(false);
		expect(containsUltracode("ULTRACODE")).toBe(false);
		expect(containsUltracode("ultracoded the build")).toBe(false);
		// A path/extension must not trigger even though sentence punctuation does.
		expect(containsUltracode("packages/coding-agent/src/modes/ultracode.ts")).toBe(false);
		expect(containsUltracode("nothing to see here")).toBe(false);
	});

	it("ignores the word bound into an identifier, symbol reference, or call", () => {
		for (const text of ["foo::ultracode", "ultracode()", "my-ultracode", "ultracode_x"]) {
			expect(containsUltracode(text)).toBe(false);
		}
	});

	it("ignores keywords inside code spans, fenced blocks, and XML sections", () => {
		expect(containsUltracode("use `ultracode` here")).toBe(false);
		expect(containsUltracode("```\nultracode\n```")).toBe(false);
		expect(containsUltracode("<note>ultracode</note>")).toBe(false);
		expect(containsUltracode("<!-- ultracode -->")).toBe(false);
		// A real prose request alongside code still triggers.
		expect(containsUltracode("run `setup` then ultracode the migration")).toBe(true);
	});
});

describe("ultracode keyword highlighting", () => {
	it("decorates the keyword with zero-width escapes, preserving visible text", () => {
		const input = "please ultracode this";
		const decorated = highlightUltracode(input);
		expect(decorated).not.toBe(input);
		expect(decorated).toContain("\x1b");
		expect(Bun.stripANSI(decorated)).toBe(input);
	});

	it("decorates punctuation-adjacent prose while preserving visible text", () => {
		const input = 'please "ultracode," then continue';
		const decorated = highlightUltracode(input);
		expect(decorated).not.toBe(input);
		expect(Bun.stripANSI(decorated)).toBe(input);
	});

	it("leaves text without the standalone keyword untouched", () => {
		expect(highlightUltracode("nothing here")).toBe("nothing here");
		// The probe hits the substring but token/path boundaries fail, so no decoration.
		expect(highlightUltracode("ultracoded builds")).toBe("ultracoded builds");
		expect(highlightUltracode("Ultracode this")).toBe("Ultracode this");
		expect(highlightUltracode("ultracode_x")).toBe("ultracode_x");
		const filePath = "packages/coding-agent/src/modes/ultracode.ts";
		expect(highlightUltracode(filePath)).toBe(filePath);
		// Code spans, fences, and XML sections stay literal.
		expect(highlightUltracode("`ultracode`")).toBe("`ultracode`");
		expect(highlightUltracode("```\nultracode\n```")).toBe("```\nultracode\n```");
		expect(highlightUltracode("<note>ultracode</note>")).toBe("<note>ultracode</note>");
	});

	it("paints a gradient distinct from the orchestrate one", () => {
		const ultracode = highlightUltracode("ultracode");
		const orchestrate = highlightOrchestrate("orchestrate");
		expect(firstEscape(ultracode)).not.toBe("");
		expect(firstEscape(orchestrate)).not.toBe("");
		// Both ripples open on their own hue, so the first color stop differs.
		expect(firstEscape(ultracode)).not.toBe(firstEscape(orchestrate));
	});

	it("does not cross-trigger with the orchestrate highlighter", () => {
		expect(highlightUltracode("orchestrate")).toBe("orchestrate");
		expect(highlightOrchestrate("ultracode")).toBe("ultracode");
		expect(containsOrchestrate("ultracode")).toBe(false);
		expect(containsUltracode("orchestrate")).toBe(false);
	});
});

describe("ultracode notice", () => {
	it("is a self-contained system notice scoped to the turn that carries it", () => {
		expect(ULTRACODE_NOTICE.startsWith("<system-notice>")).toBe(true);
		expect(ULTRACODE_NOTICE.endsWith("</system-notice>")).toBe(true);
		expect(ULTRACODE_NOTICE).toContain("xhigh");
		// Turn-scoped, not a session opt-in: the word steers this message only.
		expect(ULTRACODE_NOTICE).toContain("THIS TURN");
		// The contract must not retain the slash-command input placeholder.
		expect(ULTRACODE_NOTICE).not.toContain("$@");
	});
});

describe("ultracode orchestration contract", () => {
	// The whole point of the keyword is that the turn runs as a dynamic workflow.
	// A notice that only NAMES the helpers tells the model to orchestrate while
	// withholding the API it must orchestrate with, so these assert the contract
	// travels with the instruction rather than being referred to.
	const withTooling = renderUltracodeNotice({ workflowAvailable: true });
	const withoutTooling = renderUltracodeNotice({ workflowAvailable: false });

	it("carries the executable helper API, not a pointer to it", () => {
		for (const helper of ["agent(", "parallel(", "pipeline(", "phase(", "log(", "budget.total"]) {
			expect(withTooling).toContain(helper);
		}
		// Worked scripts, not a list of names: the model has to see the shape.
		expect(withTooling).toContain("await parallel(");
		expect(withTooling).toContain("```js");
	});

	it("describes both helpers as barriers, because both are", () => {
		// Guards against the notice claiming pipeline() streams items
		// independently. In THIS runtime pipeline() runs one bounded pool per
		// stage (src/eval/js/shared/prelude.txt), and prelude.py says so outright:
		// "Every item clears stage N before any item enters stage N+1". Telling the
		// model to reach for pipeline() to AVOID a barrier buys the barrier.
		expect(withTooling).toContain("BARRIER PER STAGE");
		expect(withTooling).not.toContain("DEFAULT TO pipeline()");
		expect(withTooling).not.toContain("NO barrier between stages");
		// The shape that does give independent per-item progress.
		expect(withTooling).toContain("put the WHOLE per-item chain in one thunk");
	});

	it("tells the truth about failure propagation, which decides whether a fan-out survives", () => {
		// agent() throws a ToolError on every failure path (src/eval/agent-bridge.ts)
		// and parallel() re-raises the lowest-index error, discarding every result
		// that succeeded (prelude.txt __pool). A notice promising null returns plus
		// `.filter(Boolean)` would describe a defence that can never fire.
		expect(withTooling).toContain("it never returns null");
		expect(withTooling).toContain("discards the entire results array");
		expect(withTooling).toContain("put the try/catch INSIDE each risky thunk");
		// The budget throw is gated on `turnBudget?.hard` (agent-bridge.ts): only a
		// `+Nk!`/Goal-Mode ceiling refuses the spawn. Claiming ANY exhausted
		// budget throws would invite the model to skip its own
		// budget.remaining() gate under a soft +Nk that enforces nothing.
		expect(withTooling).toContain("hits a hard (`+Nk!`/Goal Mode) budget ceiling THROWS");
		expect(withTooling).not.toContain("exhausts the turn budget");
	});

	it("documents the budget members in their real, awaitable form", () => {
		// Every JS budget member is async: `budget.total` is a function object
		// (always truthy) and remaining() returns a Promise, so a guard like
		// `while (budget.total && budget.remaining() > 50_000)` never loops once.
		expect(withTooling).toContain("await budget.total()");
		expect(withTooling).toContain("await budget.remaining()");
		expect(withTooling).not.toContain("while (budget.total && budget.remaining()");
		// The advisory/hard split must travel with the API: a plain +Nk is enforced
		// by nobody, so the notice has to say self-limit rather than letting the
		// model believe agent() polices it.
		expect(withTooling).toContain("A plain `+Nk` target is advisory");
		expect(withTooling).toContain("refuse to spawn");
	});

	it("describes phase() as a status line, not an agent-row grouper", () => {
		// The renderer never nests agent rows under phases: eval-render.ts draws
		// "phase" as one standalone line in a flat status list and EXCLUDES agent
		// events from that stream entirely (they get their own flat tree).
		// Promising that `agent()` calls group under the phase would describe a
		// display behavior nothing implements.
		expect(withTooling).toContain("following status lines appear under it");
		expect(withTooling).not.toContain("`agent()` calls group under it");
	});

	it("spells the option name Python actually accepts", () => {
		// prelude.py's agent() is keyword-only with no **kwargs, so schemaMode=...
		// raises TypeError; the wire name is translated from schema_mode.
		expect(withTooling).toContain("schema_mode");
	});

	it("carries the three-verdict adjudication, not a refute boolean", () => {
		for (const verdict of ["CONFIRMED", "PLAUSIBLE", "REFUTED"]) {
			expect(withTooling).toContain(verdict);
		}
		// The calibration IS the mechanism: a panel that refutes anything
		// speculative deletes the real findings and reports a clean bill.
		expect(withTooling).toContain("PLAUSIBLE by default");
		expect(withTooling).toContain("REFUTED only when constructible from the code");
	});

	it("keeps deterministic glue out of the model", () => {
		expect(withTooling).toContain("Zero-token glue");
	});

	it("is one notice block that names the keyword the user actually typed", () => {
		expect(withTooling.split("<system-notice>")).toHaveLength(2);
		expect(withTooling).toContain("**ultracode**");
		expect(withTooling).not.toContain("**workflowz**");
	});

	it("scopes the contract to this turn and never claims the session", () => {
		expect(withTooling).toContain("THIS TURN");
		// The keyword is per-turn, so nothing in the notice may promise the
		// contract outlives the turn as a session-wide standing default.
		expect(withTooling).not.toContain("standing default for the session");
		expect(withTooling).not.toContain("for the rest of the session");
	});

	it("prescribes no fan-out API when the tools to run it are inactive", () => {
		for (const helper of ["agent(", "parallel(", "pipeline(", "phase("]) {
			expect(withoutTooling).not.toContain(helper);
		}
		// Silence would read as "orchestrate anyway"; the notice must say why not.
		expect(withoutTooling).toContain("not both active");
		expect(withoutTooling).toContain("xhigh");
	});

	it("leaves the standalone workflowz notice unchanged", () => {
		expect(WORKFLOW_NOTICE.startsWith("<system-notice>")).toBe(true);
		expect(WORKFLOW_NOTICE.endsWith("</system-notice>")).toBe(true);
		expect(WORKFLOW_NOTICE).toContain("**workflowz**");
		// ultracode ships its own fuller contract. It must never splice in or
		// re-render the workflowz notice: that announces a keyword the user did
		// not type, and splicing would couple the ultracode contract to every
		// future edit of workflow-notice.md.
		expect(ULTRACODE_NOTICE).not.toContain(WORKFLOW_NOTICE);
		expect(ULTRACODE_NOTICE).not.toContain("**workflowz**");
	});

	it("renders every template branch, leaving no handlebars behind", () => {
		for (const notice of [withTooling, withoutTooling, ULTRACODE_NOTICE]) {
			expect(notice).not.toContain("{{");
		}
	});
});

// A notice that misdescribes the runtime is worse than no notice: the model
// writes code against it and the code fails. Everything the notice asserts
// about this session has to come from this session.
describe("ultracode notice renders live session facts", () => {
	it("names scout only when scout can actually be spawned", () => {
		expect(renderUltracodeNotice({ workflowAvailable: true, scoutAvailable: true })).toContain("`scout`");
		// With task.disabledAgents: ["scout"] or a spawn policy that excludes it,
		// naming scout hands the model an agent type that throws at preflight
		// (src/task/structured-subagent.ts). Every sibling prompt gates it.
		expect(renderUltracodeNotice({ workflowAvailable: true, scoutAvailable: false })).not.toContain("`scout`");
	});

	it("states the live concurrency cap instead of a hardcoded default", () => {
		expect(renderUltracodeNotice({ workflowAvailable: true, maxConcurrency: 8 })).toContain(
			"at most 8 thunks at once",
		);
		expect(renderUltracodeNotice({ workflowAvailable: true, maxConcurrency: 32 })).toContain(
			"at most 32 thunks at once",
		);
		// 0 is "unlimited" for task.maxConcurrency, so any stated cap would be a
		// lie — and the system prompt in the same context window omits it too.
		expect(renderUltracodeNotice({ workflowAvailable: true, maxConcurrency: 0 })).not.toContain("at most");
	});

	it("stops asserting the effort pin when the transport will discard it", () => {
		const applied = renderUltracodeNotice({ workflowAvailable: true, effortApplied: true });
		expect(applied).toContain("The harness has already pinned");
		// beginUltracodeTurn no-ops on non-reasoning models and reasoning models
		// with no controllable effort surface, and on ladders without xhigh it pins
		// the clamped level instead (model-controls.ts). The renderer cannot see
		// which case it is, so the applied branch must carry the hedge in its own
		// text rather than assert an unconditional, unclamped xhigh pin.
		expect(applied).toContain("clamped to each model's own ladder");
		expect(applied).toContain("one with no effort control runs unchanged");
		// With externalThinking on, the transport's forceReasoningOff strips
		// reasoning before the request leaves, so the pin never reaches the wire.
		// Asserting it anyway makes the failure unobservable from inside the
		// turn — the notice also forbids commenting on effort.
		const suppressed = renderUltracodeNotice({ workflowAvailable: true, effortApplied: false });
		expect(suppressed).not.toContain("The harness has already pinned");
		expect(suppressed).toContain("externalThinking");
		expect(suppressed).toContain("`think`");
	});

	it("leaves no handlebars behind in any combination of live facts", () => {
		for (const scoutAvailable of [true, false])
			for (const effortApplied of [true, false])
				for (const maxConcurrency of [0, 8, 32])
					for (const workflowAvailable of [true, false]) {
						const notice = renderUltracodeNotice({
							workflowAvailable,
							scoutAvailable,
							effortApplied,
							maxConcurrency,
						});
						expect(notice).not.toContain("{{");
						expect(notice).not.toContain("}}");
					}
	});
});

// Plan approval dispatches a SYNTHETIC prompt, and synthetic turns never scan for
// keywords — so an `ultracode` typed into the planning turn cannot reach the
// execution turn, which is the phase that actually spawns subagents. The plan
// review's "Approve and execute with ultracode" carries it across that boundary.
describe("ultracode notice for an approved plan", () => {
	const typed = renderUltracodeNotice({ workflowAvailable: true });
	const approved = renderUltracodeNotice({ workflowAvailable: true, viaPlanApproval: true });

	it("does not claim the user typed a word they picked from a menu", () => {
		expect(typed).toContain("contains the **ultracode** keyword");
		expect(approved).not.toContain("contains the **ultracode** keyword");
		expect(approved).toContain("approved a plan");
	});

	it("still scopes itself to this turn, and still names the keyword", () => {
		// Both paths are per-turn. Neither may imply the session is armed.
		for (const notice of [typed, approved]) {
			expect(notice).toContain("THIS TURN");
			expect(notice).toContain("**ultracode**");
			expect(notice).not.toContain("for the rest of the session");
		}
	});

	it("tells the model not to ask the user to type the word", () => {
		// The operator already opted in; "say ultracode" advice would be nonsense.
		expect(approved).toContain("do not tell them to say it");
	});

	it("carries the identical contract on both paths, differing only in the trigger line", () => {
		// The orchestration contract must not silently diverge between entry points.
		const body = (notice: string): string => notice.split("\n").slice(2).join("\n");
		expect(body(approved)).toBe(body(typed));
	});

	it("leaves no handlebars behind on the approval path", () => {
		for (const workflowAvailable of [true, false]) {
			const notice = renderUltracodeNotice({ workflowAvailable, viaPlanApproval: true });
			expect(notice).not.toContain("{{");
			expect(notice).not.toContain("}}");
		}
	});
});
