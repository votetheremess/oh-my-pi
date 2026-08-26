# Magic keywords

Magic keywords are standalone prose words in a user prompt that can add hidden, user-attributed instructions. Each one steers only the turn that carries it. Notice injection is enabled by default. The TUI highlights recognized words with animated gradients while editing and static gradients in sent messages; highlighting is a visual affordance and currently remains even when notice injection is disabled in settings.

## Keywords

| Keyword       | Effect                                                                                                                                                                                                                                                                                                                    |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ultrathink`  | Adds a careful multi-step reasoning notice. When automatic thinking is active, it also selects the highest reasoning effort supported by the current model for that turn.                                                                                                                                                 |
| `orchestrate` | Adds the multi-agent orchestration contract: scope the full task, delegate substantial independent work in parallel, verify each phase, and continue until the request is complete.                                                                                                                                       |
| `workflowz`   | Adds a deterministic multi-subagent workflow contract centered on the persistent `eval` kernel's `agent()`, `parallel()`, `pipeline()`, and `completion()` helpers. It is intended for broad research, reviews, migrations, and adversarial coverage. The notice is injected only when both `eval` and `task` are active. |
| `ultracode`   | Runs that turn at `xhigh` reasoning effort, for the turn and every subagent it spawns (overriding an agent's own pinned effort), and carries its own orchestration contract so the turn runs as a multi-subagent workflow. The effort is borrowed for the turn and handed back afterwards; nothing is persisted to disk.                                                  |

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

- Reasoning effort is set to `xhigh`, clamped to the ladder the active model actually exposes. Automatic thinking is switched off for the turn, and if anything re-enables it the level resolves straight back to `xhigh` instead of letting the difficulty classifier walk it down mid-turn.
- Every subagent that turn spawns is pinned the same way, clamped to the ladder that subagent's own model exposes, so a smaller model lands on its own highest supported level instead. The pin outranks a caller-supplied effort, an agent definition's own pinned level (the built-in `scout` pins `medium`), and a `task.maxEffort` ceiling below `xhigh`. It caps as well as raises: a `hi` spawn that would otherwise reach `max` lands on `xhigh`. A model with no controllable effort surface has nothing to pin, so the spawn falls back to the normal selectors, taking an explicit `:level` suffix on the resolved model pattern before the agent definition's own level. The pin rides with each spawn for that subagent's whole lifetime, even when the subagent outlives the turn.
- The hidden `ultracode-notice` carries its own fuller orchestration contract, spelled out rather than referred to: the `eval` helper signatures, the workflow structure, the fan-out patterns, and the adjudication rules for adversarial verification. It is a separate notice, deliberately not the shorter one `workflowz` injects. Naming the contract without carrying it would tell the model to orchestrate while withholding the API it must orchestrate with.
- That contract is gated on tool availability, because there is no way to fan out without it. When `eval` and `task` are both active the full API ships. When either is missing the notice is still injected, unlike `workflowz` which is skipped outright, because the effort still applies; it drops the fan-out API and states plainly that orchestration is unavailable, so the model does not describe subagents it cannot run.

The borrowed effort is handed back on the next user turn that does not carry the word, restoring `auto` when that is what was running before. Repeat the word on any later message that wants the same treatment. Two things end the turn early: reaching for the effort control yourself (cycling the thinking level keeps your choice and drops the pending restore, rather than silently overwriting it), and a new session, which always starts clean.

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
