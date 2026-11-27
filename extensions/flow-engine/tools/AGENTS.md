# DOX — extensions/flow-engine/tools

Files in this area. Purposes left for the agent to author.

| `agent-validate.ts` | `validateAgentContent(content, knownTools?)`: name/description/tools, allowlist, `${{task}}`; model refs opaque; errors on reserved outputs (status/summary/files/artifacts). `ask_parent` is a base tool. See change: add-flow-parent-mailbox. |
| `ask-parent.ts` | `makeAskParentTool(ask, where)`: per-spawn `ask_parent` for parent-attached worker agents; `askParentArgsProblem` (timeout 1..86400, default needs timeout, default ∈ options); `noAnswerText`; signal race → closed. See change: add-flow-parent-mailbox. |
| `ask-user.ts` | `registerAskUserTool(pi)`: `ask_user` tool (select|confirm|input, options, multiSelect, allowCustom, defaultValue) over ctx.ui. |
| `flow-agents.ts` | `registerFlowAgentsTool(..., userRoot?)`: `flow_agents` list (source_type) / write (scope project|user; name `^[a-z0-9][a-z0-9-]*$`); advisory `model:resolve` probes. |
| `flow-control.ts` | `registerFlowControlTool`: main-session `flow_control` wait/reply/status/cancel on the parent-attached run only; status reads `projectRuns`. See change: add-flow-parent-mailbox. |
| `flow-run.ts` | `registerFlowRunTool`: main-session `flow_run {flow, task?, inputs?}` → runId or decline reason via shared dispatch (`notifyParent: true`); `task_required` argument check. See change: add-flow-parent-mailbox. |
| `flow-validate.ts` | `validateFlowContent`, `unsafeNameError`: parse, line index, agent refs, ids, cycles, `decision_agent`, `decider:`/classifier refs; decision agents can't declare `branch`. |
| `flow-write.ts` | `registerFlowWriteTool(..., userRoot?)`: `flow_write` (scope project|user; name/ns `^[a-z0-9][a-z0-9-]*$`); validates, writes `flows/<ns>/<name>/flow.yaml`; warns `pi too old`. |
| `skill-read.ts` | `registerExtraSkillsDir(dir)`, `findSkillDir(packageRoot, skillName)`: resolve `<skillName>/SKILL.md` dir for `loadSkillsFromDir`. |
