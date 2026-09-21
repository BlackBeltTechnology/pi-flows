# DOX — extensions/flow-engine/tools

Files in this area. Purposes left for the agent to author.

| `agent-validate.ts` | export validateAgentContent(content, knownTools?) → {valid, diagnostics}; agent .md field checks — name/description/tools required, BASE_TOOLS allowlist, KNOWN_MODEL_ROLES, ${{task}} placeholder. |
| `ask-user.ts` | export registerAskUserTool(pi) registers ask_user tool — params question, type select\|confirm\|input, options, multiSelect, allowCustom, defaultValue; drives ctx.ui.confirm/input/select. |
| `flow-agents.ts` | export registerFlowAgentsTool(pi, getDiscoveredAgents, projectRoot, packageRoot, getExtraAgentsDirs) registers flow_agents — op list catalog, op write validates then writes .pi/flows/agents/<name>.md. |
| `flow-validate.ts` | export validateFlowContent(content, getDiscoveredAgents?) → {valid, diagnostics}; parseFlowYamlString + line index; agent catalog refs, blockedBy/on_error IDs, code input/output names, Kahn cycles. |
| `flow-write.ts` | export registerFlowWriteTool(pi, getDiscoveredAgents, projectRoot) registers flow_write — validates flow YAML, writes .pi/flows/flows/<namespace>/<name>/flow.yaml, returns generatedHandlers. |
| `skill-read.ts` | exports registerExtraSkillsDir(dir) + findSkillDir(packageRoot, skillName); resolves <skillName>/SKILL.md dir for pi loadSkillsFromDir. No skill_read tool. |
