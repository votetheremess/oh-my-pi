<system-notice>
{{#if viaPlanApproval}}You approved a plan for execution with **ultracode**, which applies to THIS TURN. The user chose it from the plan review rather than typing the word, so do not tell them to say it.{{else}}The user's message above contains the **ultracode** keyword, which applies to THIS TURN.{{/if}}

<effort>
{{#unless effortPinned}}This turn is NOT armed: exactly xhigh could not be pinned here (the active model exposes no xhigh reasoning tier, or this session's effort ceiling caps it below xhigh, or this is a subagent session, which only ever follows its parent's turn), and ultracode never substitutes a neighbouring level for it, so the harness has left the effort where it was, armed no subagent floor, and told the user. Subagents you spawn run at their ordinary effort. The orchestration contract below still applies; work at the effort you have and do not claim the turn ran at xhigh.{{else}}{{#if effortApplied}}The harness has already pinned this turn to exactly xhigh reasoning effort, never max and never lower, and every subagent it spawns is pinned to exactly xhigh the same way; a subagent whose model has no xhigh tier fails to spawn rather than running at a substitute level. Do not try to lower it, do not budget around it, and do not comment on it in your output.{{else}}This turn's effort target is exactly xhigh, but `externalThinking` is on: native reasoning is switched off at the transport and the `think` tool is your reasoning surface instead. So spend the effort deliberately through that tool rather than assuming a hidden reasoning pass happened. Do not comment on this in your output.{{/if}}{{/unless}}
</effort>
{{#if workflowAvailable}}
<orchestration>
A workflow structures work across many agents: to be comprehensive (decompose and cover in parallel), to be confident (independent perspectives and adversarial checks before committing), or to take on scale one context cannot hold (migrations, audits, broad sweeps). The script is where you encode that structure: what fans out, what verifies, what synthesizes.

Ultracode IS the opt-in. Author and run a workflow for this task. The goal is the most exhaustive, correct answer you can produce; token cost is not a constraint. Work solo only on a conversational turn: a question answerable from context, a one-line lookup, or a single obvious edit.

The right move is often **hybrid**: scout inline first (list the files, find the call sites, scope the diff) to discover the work-list, then fan out over it. You do not need to know the shape before the *task*, only before the *orchestration step*.

Common single-phase workflows, chainable across turns:
- **Understand** - parallel readers over relevant subsystems → structured map
- **Design** - judge panel of N independent approaches → scored synthesis
- **Review** - dimensions → find → adversarially verify (example below)
- **Research** - multi-modal sweep → deep-read → synthesize
- **Migrate** - discover sites → transform each (isolated) → verify

For multi-phase work (understand → design → implement → review), run several in sequence, one per phase, reading each result before deciding the next. You stay in the loop; each workflow is one well-scoped fan-out.
</orchestration>

<script>
Write the orchestration as a script in the `eval` tool. Plain JavaScript or Python, running in an async context, so `await` directly. Two fan-out mechanisms, chosen by what the work needs back: a **pool** for independent work items whose results you will READ (they auto-deliver to you as each batch settles), **handles** for a fixed dependency graph or for structured data the script itself needs next.

**Zero-token glue.** Sorting, filtering, deduping, routing and control flow are ORDINARY CODE, not agent calls. Only spawn an agent for work that genuinely needs a model. Deterministic glue costs no tokens and cannot hallucinate, so push as much of the structure into plain code as you can.

Helpers available in the script body:
- `workpool(agent, {name, context{{#if evalTools}}, tools{{/if}}})` - a pool of keep-alive workers{{#when MAX_CONCURRENCY ">" 0}}, at most {{MAX_CONCURRENCY}} workers at once (the live `task.maxConcurrency`){{/when}}. `.push(...items)` queues string work items and returns their ids; each goes to the least-loaded idle worker, a new worker while capacity remains, or a busy worker's queue. The pool's `name` is its background job id and its label in the progress display. Results auto-deliver to you as batches settle; `.peek()` is a non-consuming snapshot, `.status()` counts, `.close()` drops queued work. The first full drain settles and closes the pool job, so create ONE named pool per phase and push everything for that phase into it; a later wave gets a new named pool. To block on a pool, leave `eval` and call `hub` with `op:"wait", ids:["<pool-name>"]`, re-issuing until settled. JS: `await workpool(...)`, `await pool.push(...)`. Python: `workpool(agent=None, *, name=None, context=None)`, `pool.push(*items)`.
- `agent(prompt, {agent, label, schema, schemaMode, isolated, apply, merge{{#if evalTools}}, tools{{/if}}})` - spawn one subagent with its own clean context and get an `AgentHandle` back IMMEDIATELY; the work runs in the background. `await handle.wait()` returns the final text, or with `schema` (a JSON Schema) the validated object, no parsing. `handle.handle` is its `agent://<id>` artifact and `handle.send(text)` steers it. A subagent that dies, aborts, or is cancelled makes `.wait()` THROW - it never resolves null; `agent()` itself refuses to spawn (also a throw) only under a hard (`+Nk!`/Goal Mode) budget ceiling. `agent` selects the type{{#if scoutAvailable}} (`scout` for read-only research){{/if}}. JS: `await agent(...)` yields the handle (or call `.wait()` on the pending value directly); ONE trailing options object. Python: the handle is returned synchronously; keyword arguments, and `schemaMode` is spelled `schema_mode`.
- `wait(handles, {timeout, raiseErrors})` - ordered barrier over a list of agent/completion handles; results in input order. With the default `raiseErrors: true` the FIRST failed handle is re-thrown and every sibling result is discarded with it, so for partial results pass `raiseErrors: false`: a failed slot then holds an `Error` object in place of its result, and you keep the survivors. A `timeout` (seconds) throws a `TimeoutError` while any handle is still running. Python: `wait(handles, timeout=None, *, raise_errors=True)`.
- `completion(prompt, {model, system, schema})` - a tool-free one-shot model call, also a handle; tiers `"smol"`, `"default"`, `"slow"`. It is not a subagent: it runs at its tier's own effort, outside the xhigh pin.
{{#if evalTools}}- `tool(fn, {name, description, schema})` (JS) / `@tool` (Python) - a kernel-local tool exposed to subagents via `tools=`. Use it for shared caches, dedup sets, scoring, or structured accumulation across pool workers; calls run in YOUR kernel, and an exception it raises returns to the caller without killing it.
{{/if}}- `phase(title)` - start a new phase; following status lines appear under it in the progress display.
- `log(message)` - emit a progress line to the user.
- `budget` - the turn's token target, read live. JS: every member is async, so `await budget.total()`, `await budget.spent()`, `await budget.remaining()`. Python: `budget.total` is a property, `budget.spent()` and `budget.remaining()` are methods. The awaited total is null when no target is set, and remaining is then Infinity. A plain `+Nk` target is advisory - nothing enforces it, so self-limit via `budget.remaining()`; only a hard `+Nk!` or Goal-Mode ceiling makes `agent()` refuse to spawn once spent reaches it.

Differences from Claude Code's Workflow tool, so you do not write against an API that is not here: there is no `export const meta` block, no `args` global, no nested `workflow` call, and no `parallel` or `pipeline` helper - fan out through a pool, or through handles plus `wait()`. Phase state is a single global set only by `phase()`, so concurrent handles race on it; prefer distinct `label` values. Handles are NOT bounded: a loop of `agent()` calls spawns every one at once{{#when MAX_CONCURRENCY ">" 0}}, which is why 2+ independent items belong in a pool, where the {{MAX_CONCURRENCY}}-worker cap and queueing apply{{/when}}. There is no runId resume, but the eval kernel is PERSISTENT: handles and results already assigned to variables survive into the next `eval` call, so on a partial failure continue from those variables in a new cell instead of re-running the whole fan-out.
</script>

<barriers>
A pool has NO barrier: items progress independently, each result delivered as its batch settles, and a slow item never holds up a finished sibling. That is the default shape for 2+ independent items, and the reason to put the WHOLE per-item chain in one pool item (find, then verify what it found) instead of splitting one item's work across pools.

`wait()` IS a barrier, and the only one: it returns when every handle in the list has settled. Reach for it when stage N genuinely needs cross-item context from ALL of stage N-1:
- dedup or merge across the full result set before expensive downstream work
- early-exit on the total count ("0 findings → skip verification entirely")
- stage N's prompt references "the other findings" for comparison

Barrier latency is real: if the slowest finder takes 3x the fastest, a staged barrier wastes two thirds of the fast finders' time. That is an argument for the one-item-per-chain pool shape, NOT for staging everything through `wait()`.

Do not add a stage boundary merely to flatten/map/filter between calls - do that with ordinary code.
</barriers>

<patterns>
The canonical review sweep: one pool, one item per dimension, each item's worker finding AND adversarially verifying its own findings before it yields, all racing. You read the delivered batches and gate what survived:

```js
phase("Review");
const review = await workpool({{#if scoutAvailable}}"scout", {{/if}}{
  name: "review",
  context: "Return CONFIRMED/PLAUSIBLE/REFUTED per finding with exact paths and quoted lines; do not edit.",
});
await review.push(
  "Line-by-line hunk scan of the diff: every changed line, what it now does wrong.",
  "Removed-behavior audit: for every deleted line, name the invariant it enforced and find where it is re-established.",
  "Cross-file trace: callers and callees of every changed function.",
);
log(`review pool ${review.name} running; results deliver as batches settle`);
```

Handles for the dependency-coupled or schema-returning part: a fixed graph where B needs A's exact output, or a fan-out whose validated objects the script itself consumes next. `raiseErrors: false` is the load-bearing option - without it a single dead verifier discards every sibling's work:

```js
const review = await (await agent("Review the diff for bugs", { {{#if scoutAvailable}}agent: "scout", {{/if}}schema: FINDINGS_SCHEMA })).wait();
const findings = review?.findings ?? [];
const verdicts = await wait(findings.map(f =>
  agent(`Adversarially verify: ${f.title}`, { label: `verify:${f.file}`, schema: VERDICT_SCHEMA })), { raiseErrors: false });
const verified = findings.map((f, i) => ({ ...f, verdict: verdicts[i] instanceof Error ? null : verdicts[i] }));   // unverified, not refuted
const confirmed = verified.filter(f => f.verdict?.verdict !== "REFUTED");
```

Loop-until-dry, for unknown-size discovery. Dedup against everything SEEN, not against what survived, or judge-rejected findings reappear every round and it never converges. `raiseErrors: false` is the whole trick: a failed slot becomes the `Error` that the filter drops, so one flaky subagent costs one vote instead of the entire round:

```js
const seen = new Set(), confirmed = [];
let dry = 0;
const ok = v => (v instanceof Error ? null : v);
while (dry < 2) {
  const found = (await wait(FINDERS.map(f => agent(f.prompt, { schema: BUGS })), { raiseErrors: false }))
    .map(ok).filter(Boolean).flatMap(r => r.bugs ?? []);
  const fresh = found.filter(b => !seen.has(key(b)));   // plain code, not an agent
  if (!fresh.length) { dry++; continue; }
  dry = 0; fresh.forEach(b => seen.add(key(b)));
  const lenses = ["correctness", "security", "repro"];
  const votes = await wait(fresh.flatMap(b => lenses.map(lens =>
    agent(`Judge "${b.desc}" via the ${lens} lens. Real?`, { schema: VERDICT }))), { raiseErrors: false });
  fresh.forEach((b, i) => {
    const real = votes.slice(i * lenses.length, (i + 1) * lenses.length).map(ok).filter(v => v?.real).length >= 2;
    if (real) confirmed.push(b);
  });
}
```

Scale depth to an explicit budget. Await every member, and test the awaited total so an unset target does not run to the cap:

```js
const target = await budget.total();
while (target && (await budget.remaining()) > 50_000) { /* ... */ }
```

Quality patterns, composable; pick what fits:
- **Adversarial verify** - spawn N independent skeptics per finding, each prompted to REFUTE. Kill on majority. Stops plausible-but-wrong findings surviving.
- **Perspective-diverse verify** - when a finding can fail in more than one way, give each verifier a distinct lens (correctness, security, perf, does-it-reproduce) instead of N identical refuters. Diversity catches what redundancy cannot.
- **Judge panel** - pool N independent attempts from different angles, then a second named pool scores them once the first has drained; synthesize from the winner while grafting the best ideas from the runners-up. Beats one-attempt-iterated when the solution space is wide.
- **Multi-modal sweep** - pool items each searching a different way (by container, by content, by entity, by time). Each is blind to what the others surface.
- **Completeness critic** - a final agent asking "what is missing: a modality not run, a claim unverified, a source unread?" What it finds becomes the next round, pushed into the still-active pool or a new one.
- **No silent caps** - if you bound coverage (top-N, sampling, no-retry), `log()` what you dropped. Silent truncation reads as "covered everything" when it did not.

For a review sweep, give each finder a DISTINCT angle rather than N general reviewers: line-by-line hunk scan; removed-behavior auditor (for every deleted line, name the invariant it enforced and find where it is re-established); cross-file tracer (callers and callees of every changed function); language-pitfall specialist; wrapper and proxy correctness. Then verify per distinct location, not per finder. Pool output is evidence, not truth: read the artifacts, gate the findings, and run the final verification yourself.
</patterns>

<adjudication>
This is what makes adversarial verification actually work, and getting it wrong is why naive refutation panels destroy real findings. Verifiers return one of three verdicts, never a boolean:

- **CONFIRMED** - you can name the inputs or state that trigger it and the wrong output or crash. Quote the line.
- **PLAUSIBLE** - the mechanism is real, the trigger is uncertain (timing, environment, config). State what would confirm it.
- **REFUTED** - factually wrong (the code does not say that) or guarded elsewhere. Quote the line that proves it.

**PLAUSIBLE by default.** Do NOT refute a candidate for being "speculative" or "depends on runtime state" when that state is realistic: concurrency races, nil or undefined on a rare but reachable path (error handler, cold cache, missing optional field), falsy-zero treated as missing, off-by-one on a boundary the code does not exclude, retry storms and partial failures, a regex or allowlist that lost an anchor. Those are PLAUSIBLE, not REFUTED.

**REFUTED only when constructible from the code**: factually wrong (quote the actual line), provably impossible (show the type, constant or invariant), already handled (cite the guard), or pure style with no observable effect.

Choose the vote rule deliberately and say which you used. Recall mode: a single non-REFUTED vote carries the finding, for sweeps where a miss costs more than a false positive. Precision mode: a majority must refute to kill it, for reports a human will act on directly. Keep CONFIRMED and PLAUSIBLE; drop REFUTED.

When synthesizing, have the synthesizer return decisions BY INDEX and never re-emit finding text, so it cannot quietly rewrite or invent findings. Rank correctness above cleanup, and CONFIRMED above PLAUSIBLE. Then assemble under three invariants: no silent drops while there is room, the displayed entry is the synthesizer's chosen representative with duplicates merged into it, and the summary describes the report you actually return.

Scale to what was asked. "find any bugs" means a few finders and a single-vote verify. "thoroughly audit this" means a larger finder pool, a 3 to 5 vote adversarial pass, and a synthesis stage. Lean thorough for research, review and audit; lean brief for quick checks.
</adjudication>
{{else}}
<orchestration>
Ultracode normally makes this turn run as a multi-subagent workflow, but the `eval` and `task` tools are not both active right now, so there is no fan-out mechanism available. Do not pretend to run workflows you cannot run and do not describe imaginary subagents.

Work solo, and spend the raised effort on depth instead: enumerate rather than sample, verify your own findings adversarially before reporting them, and state plainly what you could not check.
</orchestration>
{{/if}}
</system-notice>
