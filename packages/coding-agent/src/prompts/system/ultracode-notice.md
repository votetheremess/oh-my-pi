<system-notice>
The user's message above contains the **ultracode** keyword, which applies to THIS TURN.

<effort>
This turn and every subagent it spawns run at xhigh reasoning effort. The harness has already applied it. Do not try to lower it, do not budget around it, and do not comment on it in your output.
</effort>
{{#if workflowAvailable}}
{{workflowContract}}

<shape>
Treat the orchestration contract above as the shape of THIS request, not as one option among several. Author and run a workflow, using the `eval` helpers exactly as described. Work solo only if the request is genuinely conversational: a question answerable from context, a one-line lookup, or a single obvious edit. Anything larger gets a workflow.

You do not need to ask permission. The keyword IS the opt-in.
</shape>

<goal>
The goal is the most exhaustive, correct answer you can produce. Token cost is not a constraint. Do not trade coverage for brevity, do not sample where you can enumerate, and do not settle for the first finding when another pass would surface more. Depth is the point; you are being asked to spend.

Multi-phase work (understand, design, implement, review) runs as several workflows in sequence, one per phase, never one giant undifferentiated fan-out. Read each phase's results, decide what the next phase should be, then author it. You own the plan between phases; the subagents own the legwork inside them.

Lean toward orchestrating, and toward adversarially verifying what you find. Never silently cap coverage: if you bound a fan-out, say what you dropped.
</goal>
{{else}}
<orchestration>
Ultracode normally makes this turn run as a multi-subagent workflow, but the `eval` and `task` tools are not both active right now, so there is no fan-out mechanism available. Do not pretend to run workflows you cannot run and do not describe imaginary subagents.

Work solo, and spend the raised effort on depth instead: enumerate rather than sample, verify your own findings adversarially before reporting them, and state plainly what you could not check.
</orchestration>
{{/if}}
</system-notice>
