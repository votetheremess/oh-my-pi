# Magic keywords

Magic keywords are standalone prose words in a user prompt that can add hidden, user-attributed instructions. Three of them steer only the turn that carries them; `ultracode` stays on for the rest of the session. Notice injection is enabled by default. The TUI highlights recognized words with animated gradients while editing and static gradients in sent messages; highlighting is a visual affordance and currently remains even when notice injection is disabled in settings.

## Keywords

| Keyword       | Effect                                                                                                                                                                                                                                                                                                                    |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ultrathink`  | Adds a careful multi-step reasoning notice. When automatic thinking is active, it also selects the highest reasoning effort supported by the current model for that turn.                                                                                                                                                 |
| `orchestrate` | Adds the multi-agent orchestration contract: scope the full task, delegate substantial independent work in parallel, verify each phase, and continue until the request is complete.                                                                                                                                       |
| `workflowz`   | Adds a deterministic multi-subagent workflow contract centered on the persistent `eval` kernel's `agent()`, `parallel()`, `pipeline()`, and `completion()` helpers. It is intended for broad research, reviews, migrations, and adversarial coverage. The notice is injected only when both `eval` and `task` are active. |
| `ultracode`   | Turns ultracode ON for the rest of the session: pins reasoning effort to `xhigh` for every turn and every subagent it spawns (overriding an agent's own pinned effort), and makes multi-subagent workflow orchestration a standing default. Session-scoped and never persisted to disk.                                   |

Use the keyword anywhere in the prose of the prompt:

```text
ultrathink about the failure modes before changing this API

orchestrate the migration described in docs/plan.md

workflowz an adversarial review of the authentication changes

ultracode the rest of this session, starting with the scheduler rewrite
```

## Ultracode sessions

`ultracode` and `ultrathink` differ in reach: ultrathink only selects the highest supported effort while automatic thinking is active, whereas ultracode pins `xhigh` for the whole session and for every subagent regardless of the auto-thinking setting. Stronger is not the same as higher. `xhigh` sits one tier below `max`, and while ultracode is on it also takes over the auto-thinking path, so `ultrathink` no longer reaches `max` on a model that exposes it.

Saying it once flips the top-level `ultracode` boolean setting, which defaults to `false`, through the runtime override layer. While it is on:

- Reasoning effort is pinned to `xhigh`, clamped to the ladder the active model actually exposes, and re-pinned on every later user turn, so a model switch cannot quietly move the session off it. Automatic thinking is switched off, and if anything re-enables it the level resolves straight back to `xhigh` instead of letting the difficulty classifier walk it down.
- Every subagent the session spawns is pinned the same way, clamped to the ladder that subagent's own model exposes, so a smaller model lands on its own highest supported level instead. The pin outranks a caller-supplied effort, an agent definition's own pinned level (the built-in `scout` pins `medium`), and a `task.maxEffort` ceiling below `xhigh`. It caps as well as raises: a `hi` spawn that would otherwise reach `max` lands on `xhigh`. A model with no controllable effort surface has nothing to pin, so the spawn falls back to the normal selectors, taking an explicit `:level` suffix on the resolved model pattern before the agent definition's own level.
- The hidden `ultracode-notice` is re-injected on every user turn, so workflow orchestration stays a standing default. Unlike `workflowz`, it is not gated on tool availability and is injected even when `eval` or `task` is inactive. Synthetic, agent-initiated turns never re-inject it; the pinned effort simply stays where the last user turn set it.

The keyword writes only to the runtime override layer, which is merged last and never saved. That layer outranks the persisted one, so `omp config set ultracode false` and the **Ultracode** toggle under **Interaction → Magic Keywords** cannot end a session that is already armed; they only decide whether later sessions start armed. The one deliberate way out is the effort control itself: cycling the thinking level clears the override, because reaching for that control is an unambiguous request for a different effort and it would otherwise be silently overruled on the next turn. A new session starts with an empty override layer and `ultracode` back at `false`, unless the setting was persisted as `true`, which arms every later session. Disabling `magicKeywords.ultracode` stops the keyword from arming a session; it does not turn off a session that is already on.

## Matching rules

Matching is deliberate so source code and paths do not accidentally change agent behavior:

- Use the exact lowercase spelling. `Ultrathink`, `Orchestrate`, `Workflowz`, and `Ultracode` do not trigger.
- The keyword must be standalone prose. Sentence punctuation and quotes may touch it, but letters, digits, underscores, slashes, backslashes, hyphens, file extensions, symbol references, and call syntax do not match. For example, `orchestrate,` matches; `orchestrated`, `orchestrate.ts`, `foo::orchestrate`, `orchestrate()`, `ultracoded`, and `ultracode.ts` do not.
- Fenced code blocks (backticks or tildes), inline code spans, HTML/XML comments/tags/elements, and their contents are ignored.
- All enabled keywords in one prompt may add their own notice. The visible word remains in the user message; hidden notices are non-displayed custom messages attributed to the user.
- The instruction applies only to the turn containing the keyword. `ultracode` is the exception: it opts the whole session in, so its notice and its pinned effort are re-applied on every later user turn without the user repeating the word.

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

The global switch and four per-keyword switches default to `true`. `workflowz` is gated by `magicKeywords.workflow`; every other switch is named after its keyword, including `magicKeywords.ultracode`. The global switch gates every hidden notice at the point a keyword arms it; a per-keyword switch gates only that notice and the effort behavior attached to it (ultrathink's maximum-auto-thinking override, ultracode's `xhigh` pinning). Neither switch turns off a session `ultracode` has already armed. These settings do not currently disable the editor/message gradient. Run `omp config list` to inspect every setting and its current value. See [Settings](./settings.md) for configuration scopes, precedence, and project-local overrides.
