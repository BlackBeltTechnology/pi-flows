# DOX — extensions/flow-engine/tools

Files in this area. Purposes left for the agent to author.

| `agent-validate.ts` | `validateAgentContent(content, knownTools?)`: name/description/tools, allowlist, `${{task}}`; model refs opaque (`@role:bad` thinking suffix errors; literal `:suffix` warns). |
| `ask-user.ts` | `registerAskUserTool(pi)`: `ask_user` tool (select|confirm|input, options, multiSelect, allowCustom, defaultValue) over ctx.ui. |
| `flow-agents.ts` | `registerFlowAgentsTool(..., userRoot?)`: `flow_agents` op list (source_type) / write (scope project|user; name must match `^[a-z0-9][a-z0-9-]*$`); advisory `model:resolve` probes. |
| `flow-validate.ts` | `validateFlowContent`, `unsafeNameError`: parse + line index, agent refs, ids, cycles, `decision_agent`, `decider:` checks, classifier refs (warns `pi too old` if unverifiable). |
| `flow-write.ts` | `registerFlowWriteTool(..., userRoot?)`: `flow_write` (scope project|user; name/ns `^[a-z0-9][a-z0-9-]*$`) validates, writes `<flows>/flows/<ns>/<name>/flow.yaml`, returns `generatedHandlers`. |
| `skill-read.ts` | `registerExtraSkillsDir(dir)`, `findSkillDir(packageRoot, skillName)`: resolve `<skillName>/SKILL.md` dir for `loadSkillsFromDir`. |
