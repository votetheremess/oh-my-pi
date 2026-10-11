import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as vm from "node:vm";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgEvalWorkpoolFreshAgents } from "@oh-my-pi/pi-coding-agent/eval/settings";
import {
	type CfgChangeRequest,
	CfgProtocolHandler,
	setCfgApprovalHost,
} from "@oh-my-pi/pi-coding-agent/internal-urls/cfg-protocol";
import { parseInternalUrl } from "@oh-my-pi/pi-coding-agent/internal-urls/parse";
import { MAGIC_KEYWORDS, renderWorkflowNotice } from "@oh-my-pi/pi-coding-agent/modes/magic-keywords";
import { cfgMagicKeyword, cfgUltracode } from "@oh-my-pi/pi-coding-agent/modes/settings";
import { renderUltracodeNotice, ULTRACODE_NOTICE } from "@oh-my-pi/pi-coding-agent/modes/ultracode";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import {
	containsMagicKeyword,
	hasMagicKeyword,
	highlightMagicKeywords,
	setMagicKeywords,
} from "@oh-my-pi/pi-tui/prompt/magic-keywords";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import javascriptPrelude from "../../src/eval/js/shared/prelude.txt" with { type: "text" };
import pythonPrelude from "../../src/eval/py/prelude.py" with { type: "text" };

beforeAll(async () => {
	// Gradient palettes read the active theme's color mode.
	await initTheme(false);
	// The host registers the table at startup; without it nothing glows.
	setMagicKeywords(MAGIC_KEYWORDS);
});

afterAll(() => {
	setMagicKeywords([]);
});

/** First SGR escape emitted by a gradient highlighter, i.e. its opening color stop. */
function firstEscape(decorated: string): string {
	const start = decorated.indexOf("\x1b");
	if (start < 0) return "";
	return decorated.slice(start, decorated.indexOf("m", start) + 1);
}

function containsUltracode(text: string): boolean {
	return containsMagicKeyword(text, "ultracode");
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
		const decorated = highlightMagicKeywords(input);
		expect(decorated).not.toBe(input);
		expect(decorated).toContain("\x1b");
		expect(Bun.stripANSI(decorated)).toBe(input);
		// The editor's shimmer gate fires for the registered row.
		expect(hasMagicKeyword(input)).toBe(true);
	});

	it("decorates punctuation-adjacent prose while preserving visible text", () => {
		const input = 'please "ultracode," then continue';
		const decorated = highlightMagicKeywords(input);
		expect(decorated).not.toBe(input);
		expect(Bun.stripANSI(decorated)).toBe(input);
	});

	it("leaves text without the standalone keyword untouched", () => {
		expect(highlightMagicKeywords("nothing here")).toBe("nothing here");
		// The probe hits the substring but token/path boundaries fail, so no decoration.
		expect(highlightMagicKeywords("ultracoded builds")).toBe("ultracoded builds");
		expect(hasMagicKeyword("ultracoded builds")).toBe(false);
		expect(highlightMagicKeywords("Ultracode this")).toBe("Ultracode this");
		expect(highlightMagicKeywords("ultracode_x")).toBe("ultracode_x");
		const filePath = "packages/coding-agent/src/modes/ultracode.ts";
		expect(highlightMagicKeywords(filePath)).toBe(filePath);
		// Code spans, fences, and XML sections stay literal.
		expect(highlightMagicKeywords("`ultracode`")).toBe("`ultracode`");
		expect(highlightMagicKeywords("```\nultracode\n```")).toBe("```\nultracode\n```");
		expect(highlightMagicKeywords("<note>ultracode</note>")).toBe("<note>ultracode</note>");
	});

	it("paints a gradient distinct from the orchestrate one", () => {
		const ultracode = highlightMagicKeywords("ultracode");
		const orchestrate = highlightMagicKeywords("orchestrate");
		expect(firstEscape(ultracode)).not.toBe("");
		expect(firstEscape(orchestrate)).not.toBe("");
		// Both ripples open on their own hue, so the first color stop differs.
		expect(firstEscape(ultracode)).not.toBe(firstEscape(orchestrate));
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
		for (const helper of ["workpool(", "agent(", "wait(", "phase(", "log(", "budget.total"]) {
			expect(withTooling).toContain(helper);
		}
		// Worked scripts, not a list of names: the model has to see the shape.
		expect(withTooling).toContain("await workpool(");
		expect(withTooling).toContain("await wait(");
		expect(withTooling).toContain("```js");
	});

	it("names only helpers the eval kernels actually export, in the kernel that spells them", () => {
		// v18.1.16 (05bb0c1989) replaced parallel()/pipeline() with handles and
		// workpool(). A notice teaching a helper the prelude no longer installs
		// sends the model into a ReferenceError; tie every backticked call the
		// notice makes to the kernel that must provide it, so the next rename
		// goes red here instead of in a live turn. An either-kernel check is not
		// enough: every plain name exists in both, so a JS-only rename passed.
		// - camelCase (`judgeBatch`) is the JS spelling: a `globalThis.<name> =`
		//   export of the real JS prelude.
		// - snake_case (`judge_batch`) is the Python spelling: a top-level def or
		//   binding of the real Python prelude.
		// - a plain lowercase name is spelled the same in both, and the notice
		//   offers "Plain JavaScript or Python", so it must exist in BOTH.
		const exported = new Set([...javascriptPrelude.matchAll(/globalThis\.(\w+) = /g)].map(m => m[1]));
		// Top-level defs plus bindings (`tool = _ToolProxy()`, `budget = _Budget()`).
		const defined = new Set(
			[...pythonPrelude.matchAll(/^ {4}(?:(?:async )?def (\w+)\(|(\w+) = )/gm)].map(m => m[1] ?? m[2]),
		);
		const notice = renderUltracodeNotice({ workflowAvailable: true, evalTools: true });
		const named = new Set([...notice.matchAll(/`(\w+)\(/g)].map(m => m[1] ?? ""));
		for (const name of ["workpool", "agent", "wait", "completion", "judge", "judgeBatch", "judge_batch", "tool"]) {
			expect(named.has(name)).toBe(true);
		}
		const missing: { js: string[]; python: string[] } = { js: [], python: [] };
		for (const name of named) {
			const pythonSpelling = name.includes("_");
			const jsSpelling = /[A-Z]/.test(name);
			if (!pythonSpelling && !exported.has(name)) missing.js.push(name);
			if (!jsSpelling && !defined.has(name)) missing.python.push(name);
		}
		expect(missing).toEqual({ js: [], python: [] });
		expect(notice).not.toContain("parallel(");
		expect(notice).not.toContain("pipeline(");
	});

	it("teaches Python's handle.wait() and wait() as synchronous, because they are", () => {
		// prelude.py: `_Handle.wait` and the module-level `wait` are plain defs
		// that block and return the value; only `await h` (`__await__`) is
		// awaitable. `await h.wait()` blocks, then raises TypeError on the
		// returned str/list, losing the result. If the prelude turns either
		// into a coroutine, this goes red and the notice must change with it.
		expect(pythonPrelude).toMatch(/^ {8}def wait\(self, timeout=None\):/m);
		expect(pythonPrelude).toMatch(/^ {4}def wait\(handles, timeout=None, \*, raise_errors=True\):/m);
		expect(pythonPrelude).toMatch(/^ {8}def __await__\(self\):/m);
		expect(withTooling).toContain("and so is `h.wait()`: call it without `await`");
		expect(withTooling).toContain("or `await h` itself for the same result");
		expect(withTooling).toContain("`wait(handles, timeout=None, *, raise_errors=True)`, synchronous like `h.wait()`");
	});

	it("tells the truth about spawn-time throws, which raiseErrors:false does not catch", async () => {
		// Run the REAL JS prelude in its own realm with a stubbed host bridge
		// whose third spawn is refused the way agent-bridge refuses a spent hard
		// `+Nk!` ceiling. wait() awaits every pending handle before it applies
		// raiseErrors, so one spawn-time throw rejects the whole round; the guard
		// the notice teaches keeps one slot per input instead.
		let spawned = 0;
		const results = new Map<string, { status: string; text: string }>();
		const sandbox: Record<string, unknown> = {
			__omp_helpers__: { hasRoot: () => false },
			__omp_emit_status__: () => {},
			__omp_log__: () => {},
			__omp_display__: () => {},
			__omp_call_tool__: async (name: string, args: { items?: { id: string }[] }) => {
				if (name === "__agent__") {
					spawned++;
					if (spawned === 3) throw new Error("agent() blocked: turn token budget exhausted");
					const id = `a${spawned}`;
					results.set(id, { status: "completed", text: `done ${spawned}` });
					return { id, agent: "task" };
				}
				if (name === "__wait__") return { items: (args.items ?? []).map(item => results.get(item.id)) };
				return {};
			},
		};
		vm.runInContext(javascriptPrelude, vm.createContext(sandbox));
		type Pending = PromiseLike<unknown> & { wait(): Promise<unknown> };
		const agent = sandbox.agent as (prompt: string) => Pending;
		const wait = sandbox.wait as (handles: Pending[], opts: { raiseErrors: boolean }) => Promise<unknown[]>;

		await expect(
			wait(
				[1, 2, 3, 4].map(i => agent(`vote ${i}`)),
				{ raiseErrors: false },
			),
		).rejects.toThrow("turn token budget exhausted");
		spawned = 0;
		const guarded = await Promise.all(
			[1, 2, 3, 4].map(i =>
				agent(`vote ${i}`)
					.wait()
					.catch((error: unknown) => error),
			),
		);
		expect(guarded.map(value => (value instanceof Error ? value.message : value))).toEqual([
			"done 1",
			"done 2",
			"agent() blocked: turn token budget exhausted",
			"done 4",
		]);

		expect(withTooling).toContain("`raiseErrors: false` only isolates subagents that fail AFTER spawning");
		expect(withTooling).toContain("`await Promise.all(xs.map(x => agent(...).wait().catch(e => e)))`");
		expect(withTooling).toContain("a spawn-time throw still rejects the round");
		expect(withTooling).not.toContain("a failed slot becomes the `Error` that the filter drops");
	});

	it("teaches judge() as a direct answer and judgeBatch as the bulk path", () => {
		// prelude.txt `judge` returns `result.answers` (no handle), and `wait()`
		// rejects anything that is not an agent/completion handle. jevify's
		// notice still describes a JudgmentHandle; ultracode must not copy it.
		expect(withTooling).toContain("`await judge(state, questions)`");
		expect(withTooling).toContain("{id: answer}");
		expect(withTooling).toContain("NOT a handle");
		expect(withTooling).not.toContain("JudgmentHandle");
		expect(withTooling).toContain("`judgeBatch(states, questions, {intent, concurrency, retries, minOk})`");
		// Python defaults are `None` so the host's own defaults apply; the notice
		// names those defaults instead of pinning a stale literal signature.
		expect(withTooling).toContain("min_ok=None");
		expect(withTooling).toContain("host defaults: concurrency 32");
		expect(withTooling).not.toContain("min_ok=1");
		// Item failures stay per-item; only a wholesale failure raises from the
		// batch's `.drain()` — a method, so spelled with its leading dot (a bare
		// `drain(` would read as a kernel global, which it is not).
		expect(withTooling).toContain("makes `.drain()` raise");
		expect(withTooling).toContain("`JudgmentBatch`");
		expect(withTooling).toContain("Never loop `judge()` over a list");
		// Like completion(), judge calls are tool-free one-shots outside the pin.
		expect(withTooling).toContain("Like `completion()` it is a tool-free one-shot that runs outside the xhigh pin");
	});

	it("points at the wait tool, never the retired hub tool, and only when wait is enabled", () => {
		// The `hub` tool is gone: peer messaging is `write agent://<id>` and the
		// argument-less `wait` tool blocks on the next background result. A notice
		// naming `hub` sends the model to a tool that does not exist, and naming
		// `wait` in a session that has it disabled does the same.
		const withWait = renderUltracodeNotice({ workflowAvailable: true, waitTool: true });
		const withoutWait = renderUltracodeNotice({ workflowAvailable: true, waitTool: false });
		for (const notice of [withWait, withoutWait, withoutTooling]) {
			expect(notice).not.toContain("hub");
			expect(notice).not.toContain('op:"wait"');
		}
		expect(withWait).toContain("Leave `eval` and call `wait`");
		expect(withoutWait).not.toContain("call `wait`");
		expect(withoutWait).not.toContain("Leave `eval`");
		// Both still forbid blocking the kernel on the pool.
		expect(withWait).toContain("`pool.wait()`");
		expect(withoutWait).toContain("`pool.wait()`");
		// The default matches the common session shape, where `wait` is enabled.
		expect(renderUltracodeNotice({ workflowAvailable: true })).toBe(withWait);
	});

	it("describes the pool as barrier-free and wait() as the only barrier, because that is the runtime", () => {
		// A pool delivers each batch as it settles (workpool.ts: per-batch jobs,
		// results auto-deliver); wait() blocks until every listed handle settles
		// (prelude.txt `wait`). Telling the model to stage a pool to AVOID a
		// barrier, or that wait() streams, misdescribes both.
		expect(withTooling).toContain("A pool has NO barrier");
		expect(withTooling).toContain("`wait()` IS a barrier");
		expect(withTooling).not.toContain("BARRIER PER STAGE");
		// The shape that does give independent per-item progress.
		expect(withTooling).toContain("put the WHOLE per-item chain in one pool item");
		// Keep-alive workers are the default; the notice names the real setting
		// that swaps them for a fresh worker per item, so a renamed key goes red.
		expect(withTooling).toContain(`with \`${cfgEvalWorkpoolFreshAgents.id}\` on, a fresh worker per item instead`);
	});

	it("tells the truth about failure propagation, which decides whether a fan-out survives", () => {
		// A failed handle makes .wait() throw (prelude.txt resolveHandleSnapshot),
		// and wait() with the default raiseErrors re-throws the first failure and
		// discards the rest of the results array; only raiseErrors:false keeps an
		// Error in the failed slot. A notice promising null returns plus
		// `.filter(Boolean)` would describe a defence that can never fire.
		expect(withTooling).toContain("it never resolves null");
		expect(withTooling).toContain("every sibling result is discarded with it");
		expect(withTooling).toContain("`raiseErrors: false`");
		expect(withTooling).toContain("raise_errors");
		// The budget throw is gated on `getTurnBudget().hard` (agent-bridge.ts):
		// only a hard `+Nk!` ceiling refuses the spawn. A Goal-Mode budget is
		// reported to the kernel (budget-bridge.ts) but never enforced on
		// agent(). Claiming ANY exhausted budget throws would invite the model to
		// skip its own budget.remaining() gate under a soft +Nk that enforces nothing.
		expect(withTooling).toContain("or a spent hard `+Nk!` budget ceiling");
		expect(withTooling).not.toContain("Goal Mode) budget");
		expect(withTooling).not.toContain("exhausts the turn budget");
		// The other pre-spawn throws are listed, and kernel `tools` only where
		// eval-defined tools exist at all.
		expect(withTooling).toContain("`agent()` itself also throws before spawning");
		expect(renderUltracodeNotice({ workflowAvailable: true, evalTools: true })).toContain(
			"or kernel `tools` in plan mode",
		);
		expect(renderUltracodeNotice({ workflowAvailable: true, evalTools: false })).not.toContain("kernel `tools`");
		// A failed slot under raiseErrors:false is an Error in JS, a RuntimeError in Python.
		expect(withTooling).toContain("(Python: the `RuntimeError`) in place");
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
		// Goal Mode is read live but gates nothing; only `+Nk!` refuses a spawn.
		expect(withTooling).toContain("else an active Goal-Mode budget, read live");
		expect(withTooling).toContain("a Goal-Mode budget does not gate `agent()` either");
		expect(withTooling).not.toContain("or Goal-Mode ceiling makes `agent()` refuse");
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
		for (const helper of ["agent(", "workpool(", "wait(", "phase("]) {
			expect(withoutTooling).not.toContain(helper);
		}
		// Silence would read as "orchestrate anyway"; the notice must say why not.
		expect(withoutTooling).toContain("not both active");
		expect(withoutTooling).toContain("xhigh");
	});

	it("leaves the standalone workflowz notice unchanged", () => {
		const workflowNotice = renderWorkflowNotice({ taskBatch: true, scoutAvailable: true, evalTools: true });
		expect(workflowNotice.startsWith("<system-notice>")).toBe(true);
		expect(workflowNotice.endsWith("</system-notice>")).toBe(true);
		expect(workflowNotice).toContain("**workflowz**");
		// ultracode ships its own fuller contract. It must never splice in or
		// re-render the workflowz notice: that announces a keyword the user did
		// not type, and splicing would couple the ultracode contract to every
		// future edit of workflow-notice.md.
		expect(ULTRACODE_NOTICE).not.toContain(workflowNotice);
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
		// The cap is the pool's worker ceiling (workpool.ts limit() reads the
		// live task.maxConcurrency); handles are unbounded, and the notice must
		// say which is which or the model fans out through the wrong one.
		expect(renderUltracodeNotice({ workflowAvailable: true, maxConcurrency: 8 })).toContain(
			"at most 8 workers at once",
		);
		expect(renderUltracodeNotice({ workflowAvailable: true, maxConcurrency: 32 })).toContain(
			"at most 32 workers at once",
		);
		expect(renderUltracodeNotice({ workflowAvailable: true, maxConcurrency: 8 })).toContain(
			"Handles are NOT bounded",
		);
		// 0 is "unlimited" for task.maxConcurrency, so any stated cap would be a
		// lie — and the system prompt in the same context window omits it too.
		expect(renderUltracodeNotice({ workflowAvailable: true, maxConcurrency: 0 })).not.toContain("at most");
	});

	it("names tool()/tools= only when eval-defined tools are enabled", () => {
		// eval.tools.enabled off: the kernel rejects `tools=`, so naming it hands
		// the model an option that throws. Mirrors upstream's workflowz gate.
		const withTools = renderUltracodeNotice({ workflowAvailable: true, evalTools: true });
		const withoutTools = renderUltracodeNotice({ workflowAvailable: true, evalTools: false });
		// The JS option is `parameters` (prelude.txt registerTool reads
		// opts.parameters); a notice saying `schema` would register a tool with
		// no argument shape.
		expect(withTools).toContain("`tool(fn, {name, description, parameters})`");
		expect(withTools).toContain(", tools}");
		expect(withTools).toContain(", tools=None)");
		expect(withoutTools).not.toContain("`tool(");
		expect(withoutTools).not.toContain("tools}");
		expect(withoutTools).not.toContain("tools=");
	});

	it("states the pin as exactly xhigh, never a clamp, when the harness applied it", () => {
		const applied = renderUltracodeNotice({ workflowAvailable: true, effortApplied: true });
		expect(applied).toContain("The harness has already pinned");
		// The contract is strict: beginUltracodeTurn and the executor pin xhigh or
		// refuse (ultracodeEffortFor in src/thinking.ts). The notice must not
		// hedge with the old clamp language, which promised a neighbouring level
		// the harness now never substitutes.
		expect(applied).toContain("exactly xhigh");
		expect(applied).toContain("never max and never lower");
		expect(applied).toContain("fails to spawn rather than running at a substitute level");
		expect(applied).not.toContain("clamped to each model's own ladder");
		expect(applied).not.toContain("pins to high");
	});

	it("stops asserting the effort pin when the transport will discard it", () => {
		// With externalThinking on, the transport's forceReasoningOff strips
		// reasoning before the request leaves, so the pin never reaches the wire.
		// Asserting it anyway makes the failure unobservable from inside the
		// turn — the notice also forbids commenting on effort.
		const suppressed = renderUltracodeNotice({ workflowAvailable: true, effortApplied: false });
		expect(suppressed).not.toContain("The harness has already pinned");
		expect(suppressed).toContain("externalThinking");
		expect(suppressed).toContain("`think`");
	});

	it("says the turn is NOT armed when the model has no xhigh rung", () => {
		// Fail loud, not clamp: AgentSession passes effortPinned=false when
		// ultracodeEffortFor(model) is undefined, having set no override and no
		// pin. A notice claiming "already pinned" there would have the model
		// believe in an effort the harness refused to substitute for.
		const unarmed = renderUltracodeNotice({ workflowAvailable: true, effortPinned: false });
		expect(unarmed).toContain("NOT armed");
		expect(unarmed).toContain("no xhigh reasoning tier");
		expect(unarmed).not.toContain("The harness has already pinned");
		expect(unarmed).not.toContain("externalThinking");
		// The orchestration contract still ships: the keyword fired, only the
		// effort could not be honoured.
		expect(unarmed).toContain("agent(");
		expect(unarmed).toContain("THIS TURN");
		// The not-armed branch outranks the externalThinking branch: with no pin
		// there is no effort target to spend through the think tool either.
		expect(renderUltracodeNotice({ workflowAvailable: true, effortPinned: false, effortApplied: false })).toBe(
			unarmed,
		);
	});

	it("never promises an orchestration contract or a raised effort the render does not have", () => {
		// Unpinned AND no eval/task: the effort block used to say "the
		// orchestration contract below still applies" right above the block that
		// says no fan-out exists, and told the model to spend a "raised effort"
		// it had just been told was not raised.
		const neither = renderUltracodeNotice({ workflowAvailable: false, effortPinned: false });
		expect(neither).toContain("NOT armed");
		expect(neither).toContain("not both active");
		expect(neither).not.toContain("orchestration contract below");
		expect(neither).not.toContain("raised effort");
		expect(neither).toContain("spend the effort you have on depth instead");
		// Each half keeps its sentence where it is true.
		expect(renderUltracodeNotice({ workflowAvailable: true, effortPinned: false })).toContain(
			"The orchestration contract below still applies",
		);
		expect(renderUltracodeNotice({ workflowAvailable: false, effortPinned: true })).toContain(
			"spend the raised effort on depth instead",
		);
	});

	it("defaults effortPinned to true, so existing render call sites are byte-identical", () => {
		expect(renderUltracodeNotice({ workflowAvailable: true, effortPinned: true })).toBe(
			renderUltracodeNotice({ workflowAvailable: true }),
		);
		expect(renderUltracodeNotice({ workflowAvailable: false, effortPinned: true })).toBe(
			renderUltracodeNotice({ workflowAvailable: false }),
		);
	});

	it("leaves no handlebars behind in any combination of live facts", () => {
		for (const scoutAvailable of [true, false])
			for (const effortApplied of [true, false])
				for (const effortPinned of [true, false])
					for (const maxConcurrency of [0, 8, 32])
						for (const waitTool of [true, false])
							for (const workflowAvailable of [true, false]) {
								const notice = renderUltracodeNotice({
									workflowAvailable,
									scoutAvailable,
									effortApplied,
									effortPinned,
									maxConcurrency,
									waitTool,
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

// The turn flag is a registered setting (so `Settings.isolated({ ultracode })`
// and overlay stamps validate), but it is turn state owned by the keyword, not
// a preference. cfg:// enumerates every registered setting and, with the user's
// approval, writes a session override or SAVES to the global config: either
// would arm a turn with no xhigh pin behind it, and a save would persist the
// flag to disk across sessions.
describe("the ultracode turn flag stays off cfg://", () => {
	const handler = new CfgProtocolHandler();

	afterEach(() => setCfgApprovalHost(null));

	it("does not offer the flag, while still offering the keyword's own user toggle", async () => {
		const completions = (await handler.complete()).map(completion => completion.value);
		expect(completions).not.toContain(cfgUltracode.id);
		// Control: the exclusion is that one id, not every ultracode-named
		// setting — the per-keyword toggle is a real preference and stays listed.
		expect(completions).toContain(cfgMagicKeyword.ultracode.id.replaceAll(".", "/"));
	});

	it("refuses to read, write or save the flag even with an approving host, leaving it unarmed", async () => {
		const settings = Settings.isolated();
		const asked: CfgChangeRequest[] = [];
		setCfgApprovalHost({
			approve: async request => (asked.push(request), "once"),
			applied: () => {},
			persistentSettings: settings,
		});
		const context = {
			session: { settings, hasUI: true, settingsApproval: true, taskDepth: 0 } as unknown as ToolSession,
		};

		await expect(handler.resolve(parseInternalUrl("cfg://ultracode"), context)).rejects.toThrow(
			"Unknown setting: ultracode",
		);
		for (const url of ["cfg://ultracode", "cfg://Ultracode", "cfg://ultracode/save"]) {
			await expect(handler.write(parseInternalUrl(url), "true", context)).rejects.toThrow("Unknown setting");
		}
		// Refused before the approval prompt, not declined at it.
		expect(asked).toEqual([]);
		expect(cfgUltracode.get(settings)).toBe(false);
		expect(cfgUltracode.isConfigured(settings)).toBe(false);
	});
});
