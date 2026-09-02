# Magic keywords

Magic keywords are standalone prose words in a user prompt that can add hidden, user-attributed instructions. Each one steers only the turn that carries it. Notice injection is enabled by default. The TUI highlights recognized words with animated gradients while editing and static gradients in sent messages; highlighting is a visual affordance and currently remains even when notice injection is disabled in settings.

## Keywords

| Keyword       | Effect                                                                                                                                                                                                                                                                                                                    |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ultrathink`  | Adds a careful multi-step reasoning notice. When automatic thinking is active, it also selects the highest reasoning effort supported by the current model for that turn.                                                                                                                                                 |
| `orchestrate` | Adds the multi-agent orchestration contract: scope the full task, delegate substantial independent work in parallel, verify each phase, and continue until the request is complete.                                                                                                                                       |
| `workflowz`   | Adds a deterministic multi-subagent workflow contract centered on the persistent `eval` kernel's `agent()`, `parallel()`, `pipeline()`, and `completion()` helpers. It is intended for broad research, reviews, migrations, and adversarial coverage. The notice is injected only when both `eval` and `task` are active. |
| `ultracode`   | Runs that turn at exactly `xhigh` reasoning effort, for the turn and every subagent it spawns (overriding an agent's own pinned effort), and carries its own orchestration contract so the turn runs as a multi-subagent workflow. The effort is borrowed for the turn and handed back afterwards; nothing is persisted to disk. A model with no `xhigh` tier cannot be armed: the turn runs unarmed and says so, and a subagent on such a model refuses to spawn.                                                  |

Use the keyword anywhere in the prose of the prompt:

```text
ultrathink about the failure modes before changing this API

orchestrate the migration described in docs/plan.md

workflowz an adversarial review of the authentication changes

ultracode the scheduler rewrite, it needs a proper pass
```

## Ultracode turns

`ultracode` and `ultrathink` differ in reach, not just in height. Ultrathink only biases the difficulty classifier, so it does nothing at all when automatic thinking is off, and it leaves the level alone otherwise. Ultracode sets a concrete level for the turn, so it lands either way, and it covers every subagent the turn spawns. Stronger is not the same as higher: `xhigh` sits one tier below `max`, and on an ultracode turn the auto-thinking path resolves to `xhigh`, so a same-turn `ultrathink` no longer reaches `max` on a model that exposes it.

On a turn carrying the keyword:

- Reasoning effort is set to exactly `xhigh`: never `max`, never a lower tier. Automatic thinking is switched off for the turn, and if anything re-enables it the level resolves straight back to `xhigh` instead of letting the difficulty classifier walk it down mid-turn. An internal model change during the turn (retry fallback, the prewalk hand-off, context promotion on overflow, an extension swapping models) re-applies the pin on the incoming model and warns if the new model cannot carry it; retry fallback skips candidate models that have no `xhigh` tier. A model or role you pick yourself is not internal: see "Your own effort or model pick ends it" below.
- Every subagent that turn spawns is pinned to exactly `xhigh` the same way, and so is a `/tan` clone forked during the turn. The pin outranks a caller-supplied effort, an explicit `:level` suffix on the model pattern, an agent definition's own pinned level (the built-in `scout` pins `medium`), and a `task.maxEffort` ceiling below `xhigh`. It caps as well as raises: a `hi` spawn that would otherwise reach `max` lands on `xhigh`, and so does a `:max` suffix. The `xhigh` pin also rides in as the spawn's effort ceiling, so retry fallback inside the subagent can neither climb above it nor drop below it, and the prewalk hand-off (which exists to cheapen a run mid-way) is not armed. The pin is borrowed, not owned: it rides with each spawn until the subagent's next resume boundary (a follow-up turn, a hub wake, a revive) after the parent's turn has ended, at which point the subagent hands back to the level it would have run at without the keyword. A subagent woken inside a later ultracode turn is re-pinned the same way, or refused loudly if its model cannot carry the pin.
- **Fail loud, never clamp.** A model whose ladder has no `xhigh` tier (one that tops out at `high`, one that exposes only `max`, a reasoning model with no controllable effort, or a non-reasoning model) cannot satisfy the keyword, and neither can a session whose hard effort ceiling sits below `xhigh`; the harness never substitutes a neighbouring level under the ultracode name. In the main session the turn is simply not armed: no pin, no subagent floor, and a visible warning naming the model and the tiers it does expose (`ultracode requires xhigh; <model> exposes [low, medium, high]`). The hidden notice tells the model the turn is not armed. A subagent spawn whose resolved model has no `xhigh` tier refuses to spawn with the same message, before any session is created; auxiliary agents (advisors, coordinators) on such a model are skipped with a notice rather than run at the wrong effort.
- The hidden `ultracode-notice` carries its own fuller orchestration contract, spelled out rather than referred to: the `eval` helper signatures, the workflow structure, the fan-out patterns, and the adjudication rules for adversarial verification. It is a separate notice, deliberately not the shorter one `workflowz` injects. Naming the contract without carrying it would tell the model to orchestrate while withholding the API it must orchestrate with.
- That contract is gated on tool availability, because there is no way to fan out without it. When `eval` and `task` are both active the full API ships. When either is missing the notice is still injected, unlike `workflowz` which is skipped outright, because the effort still applies; it drops the fan-out API and states plainly that orchestration is unavailable, so the model does not describe subagents it cannot run.

The borrowed effort is handed back on the next user turn that does not carry the word, restoring `auto` when that is what was running before. Repeat the word on any later message that wants the same treatment. The armed state never outlives its turn by another route either:

- **Your own effort or model pick ends it.** Cycling or setting the thinking level, choosing a model from the selector or `/model`, switching a role, or entering plan mode are your choices and end the turn: the borrowed effort is handed back first, so a pick that names no level lands on the level you had before the keyword (never on the borrowed `xhigh`), and a pick that names a level keeps that level. Level or model changes made by an extension runtime or by the harness itself are not your pick: they leave the turn armed and the pin re-applies over them.
- **A new or switched session starts clean.** `/new`, `/switch`, and every other session transition disarm the turn and hand the effort back.
- **A turn that never runs arms nothing.** If a keyword turn's dispatch is dropped or fails before the turn starts, the arm is undone: the flag and the level go back to exactly what they were, so the next turn cannot inherit a pin it never asked for.
- **Only the message that starts a turn arms or disarms it.** A queued follow-up carrying the word, and the plan review's "Approve and execute with ultracode", arm when the queued message is actually delivered, never when it is enqueued behind a turn still in flight; a queued keyword-free follow-up hands the effort back at delivery the same way. Approving a plan without the ultracode option is your effort decision for the execution turn: it disarms whatever the planning turn carried.
- **A steer only ever arms.** A message that joins the running turn (a steer typed while the model is working, or sent as one) arms the turn if it carries the word and does nothing to the effort if it does not. Only a message that starts a turn hands the effort back, so a mid-turn "also do X" cannot pull the pin and the subagent floor out from under the workflow it joins.
- **A turn that carries the word runs armed.** A dropped turn's rollback acts only if nothing armed or disarmed after it. A queued keyword-free follow-up hands the effort back when it is delivered — unless it is committed in the same batch as an arm (a plan approved with ultracode followed by a plain follow-up, or several follow-ups delivered together): those run as one turn, and that turn carries the word. Delivered as its own later turn, the same follow-up ends ultracode like any keyword-free turn.
- **Only a root session arms or disarms from text.** The word has the same effect however a user message reaches the root: typed, or relayed by an extension's `sendUserMessage` (which is a user message by contract). Messages the harness or another agent authors (synthetic prompts, hub steering between agents) never flip it. A task-spawned subagent, a `/tan` clone, and any other child session never arm or disarm from text at all: their flag follows the parent's turn through the resume boundary described above.

The `ultracode` boolean is turn state rather than a preference, so it is deliberately absent from the settings UI. It is written only to the runtime override layer, which never reaches disk, and a keyword-free turn writes it back to `false` so a stale persisted `true` cannot quietly run every turn at `xhigh`.

## Matching rules

Matching is deliberate so source code and paths do not accidentally change agent behavior:

- Use the exact lowercase spelling. `Ultrathink`, `Orchestrate`, `Workflowz`, and `Ultracode` do not trigger.
- The keyword must be standalone prose. Sentence punctuation and quotes may touch it, but letters, digits, underscores, slashes, backslashes, hyphens, file extensions, symbol references, and call syntax do not match. For example, `orchestrate,` matches; `orchestrated`, `orchestrate.ts`, `foo::orchestrate`, `orchestrate()`, `ultracoded`, and `ultracode.ts` do not.
- Fenced code blocks (backticks or tildes), inline code spans, HTML/XML comments/tags/elements, and their contents are ignored.
- Keywords are scanned after slash-command and prompt-template expansion, so a command or template body — and skill arguments — can deliberately carry a keyword the user did not type that turn. Backticking the word in such a body keeps an innocent mention inert.
- All enabled keywords in one prompt may add their own notice. The visible word remains in the user message; hidden notices are non-displayed custom messages attributed to the user.
- The instruction applies only to the turn containing the keyword. That includes `ultracode`: it steers the message that carries it and nothing after it.

## Configuration

Open `/settings` and use **Interaction → Magic Keywords**, or change the settings from a shell:

```bash
# Disable every magic keyword
omp config set magicKeywords.enabled false

# Disable one keyword while leaving the others enabled
omp config set magicKeywords.ultrathink false
omp config set magicKeywords.orchestrate false
omp config set magicKeywords.workflow false
omp config set magicKeywords.ultracode false
```

The global switch and four per-keyword switches default to `true`. `workflowz` is gated by `magicKeywords.workflow`; every other switch is named after its keyword, including `magicKeywords.ultracode`. The global switch gates every hidden notice at the point a keyword fires; a per-keyword switch gates only that notice and the effort behavior attached to it (ultrathink's maximum-auto-thinking override, ultracode's `xhigh` level). Because both are read on the turn the keyword fires, switching one off takes effect on the very next message. These settings do not currently disable the editor/message gradient. Run `omp config list` to inspect every setting and its current value. See [Settings](./settings.md) for configuration scopes, precedence, and project-local overrides.
