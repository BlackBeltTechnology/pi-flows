// ---------------------------------------------------------------------------
// Flow Engine — Extension Entry Point (Wiring Only)
//
// Slim orchestration hub: discovery, tool registration, event listeners,
// and assembly of FlowManager with appropriate adapters and observers.
// All TUI code lives in flow-tui.ts and flow-io-tui.ts.
// ---------------------------------------------------------------------------

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";
import type { AgentConfig, FlowConfig, FlowResult } from "./types.js";
import { discoverAll, resolvePackageRoot } from "./discovery.js";
import { isAutonomousMode, setAutonomousMode } from "../autonomous-mode.js";
import { registerAskUserTool } from "./tools/ask-user.js";
import {
  registerExtraSkillsDir,
  findSkillDir,
} from "./tools/skill-read.js";
import { registerFlowAgentsTool } from "./tools/flow-agents.js";
import { anthropicMessagesAgentFactory } from "./anthropic-messages-adapter.js";
import { registerFlowWriteTool } from "./tools/flow-write.js";
import { isEditFlowEnabled, setEditFlowFlag, parseEditModeArg } from "./edit-flow-config.js";
import { syncEditFlowSkill } from "./edit-flow-skill.js";
import { makeEditFlowToolReconciler } from "./edit-flow-reconcile.js";

import { FlowManager } from "./flow-manager.js";
import { TuiFlowIOAdapter, HeadlessFlowIOAdapter } from "./flow-io-tui.js";
import { emitPromptAndAwait } from "./flow-prompt.js";
import { TuiFlowObserver, EventEmitObserver, setupFlowTui, getIsOverlayOpen } from "./flow-tui.js";
import { findOrphanedRun } from "./flow-persist.js";
import { listenForPromptBus } from "./prompt-bus-access.js";

// Re-export public API
export type {
  AgentConfig,
  FlowConfig,
  AgentResult,
  FlowResult,
  TemplateContext,
  ArchitectMeta,
  CardConfig,
  CodeNodeContext,
  CodeNodeHandler,
  FailureOutcome,
  FailureInfo,
} from "./types.js";
export { FlowHardError } from "./types.js";
export { classifyThrownError, classifyAgentOutcome, resolveRouteOutcome } from "./failure.js";
export { spawnAgent, expandTemplateVariables } from "./execution.js";
export { runFlow, FlowCancelledError } from "./flow-execution.js";
export type { FlowRunOptions, FlowContext } from "./flow-execution.js";
export { discoverAll, resolvePackageRoot } from "./discovery.js";
export { resolveModel } from "./model-roles.js";
export { parseResult, hasArtifactElement } from "./result-parser.js";
export { parseAgentFile } from "./agent-parser.js";
export { parseFlowYamlFile, parseFlowYamlString } from "./flow-parser-yaml.js";
export type { FlowIOAdapter, FlowObserver, AskUserExtra, AskUserResult } from "./flow-io.js";
export { FlowManager } from "./flow-manager.js";

// ---- Discovery state -------------------------------------------------------

let agents = new Map<string, AgentConfig>();
let flows = new Map<string, FlowConfig>();
let packageRoot = "";
const extraAgentsDirs: string[] = [];
const extraFlowsDirs: string[] = [];
const extraAgentExtensions: any[] = [
  // Delegate anthropic-messages payload transforms to @pi/anthropic-messages
  // (if installed). Propagates the main session's mcp__ prefixing +
  // inbound-response translation to each spawned subagent. See
  // anthropic-messages-adapter.ts for the direction-of-dependency rationale.
  // No-op when the package is not installed.
  anthropicMessagesAgentFactory,
];
const registeredExtensionTools: any[] = [];

export function getDiscoveredAgents(): Map<string, AgentConfig> {
  return agents;
}

export function init(pkgRoot: string, projectRoot: string): void {
  packageRoot = pkgRoot;
  const result = discoverAll(pkgRoot, projectRoot, extraAgentsDirs, extraFlowsDirs);
  agents = result.agents;
  flows = result.flows;
}

// ---- Gate registry ---------------------------------------------------------

interface GateEntry {
  name: string;
  check: () => boolean;
  flows: string[];
  message: string;
}

const gates: GateEntry[] = [];

function checkGate(flowName: string): string | null {
  for (const gate of gates) {
    const matches = gate.flows.some((pattern) => {
      if (pattern.endsWith("*")) {
        return flowName.startsWith(pattern.slice(0, -1));
      }
      return flowName === pattern;
    });
    if (matches && !gate.check()) {
      return gate.message;
    }
  }
  return null;
}

// ---- Dispatch rejection contract (shared by the command + flow:run paths) ---

// The two rejection messages are defined ONCE so the slash-command path
// (flow:notify) and the programmatic flow:run path (terminal flow:complete)
// carry byte-identical text by construction, not by hand-copy. The gate message
// is already shared via checkGate().
export const flowNotFoundMessage = (name: string): string =>
  `Flow "${name}" no longer exists — it may have been deleted`;
export const flowAlreadyRunningMessage = (active: string | null): string =>
  `A flow is already running (${active})`;

// Build the TERMINAL flow:complete payload for a flow:run that does not start a
// flow. Stable, documented contract keyed by the invoice UI and the automation
// runner alike (a consumer that never saw flow_started renders off
// `status === "rejected"` + `reason`):
//   status: "rejected"                    machine-readable (≠ a run "error")
//   reason: <text>                        human-readable cause
//   flowName: <ns:name>
//   lastResult.result.summary = reason    so the automation summarizeFlowResult
//                                          renders `flow <name> rejected: <reason>`
// `results` is OMITTED so the post-flow summary guard (`!fr.results`) skips it
// (no spurious `.pi/flows/results/<name>.md`); no runId (no run existed).
export function buildDispatchRejection(flowName: string, reason: string): Record<string, unknown> {
  return {
    lastResult: {
      success: false,
      output: "",
      stderr: "",
      exitCode: null,
      result: { status: "error", files: [], summary: reason, artifacts: "" },
      toolCalls: [],
      duration: 0,
      tokens: { input: 0, output: 0 },
    },
    forks: {},
    flowName: flowName ?? "",
    stepCount: 0,
    totalDuration: 0,
    status: "rejected",
    reason,
  };
}

// ---- Extension activation --------------------------------------------------

export function activate(pi: ExtensionAPI) {
  const pkgRoot = resolvePackageRoot(import.meta.url);
  const projectRoot = process.cwd();
  packageRoot = pkgRoot;

  // Initial discovery
  init(pkgRoot, projectRoot);

  // Track authStorage and modelRegistry from session context
  let sessionAuthStorage: any = undefined;
  let sessionModelRegistry: any = undefined;
  // Captured on session_start; used by EventEmitObserver to append the
  // flow-completion marker that opens pi's persistence flush gate.
  let sessionManager: any = undefined;

  // ── Helpers for FlowManager config ──

  function extractAgentConfigs(flow: FlowConfig): AgentConfig[] {
    const seen = new Set<string>();
    const configs: AgentConfig[] = [];
    for (const step of flow.steps) {
      if (step.stepType === "agent" && !seen.has(step.agent)) {
        seen.add(step.agent);
        const cfg = agents.get(step.agent);
        if (cfg) configs.push(cfg);
      }
    }
    return configs;
  }

  function buildAgentDeps(flow: FlowConfig): Map<string, string[]> {
    const deps = new Map<string, string[]>();
    for (const step of flow.steps) {
      if (step.stepType === "agent" && step.blockedBy && step.blockedBy.length > 0) {
        deps.set(step.agent, step.blockedBy);
      }
    }
    return deps;
  }

  // ── Create FlowManager with headless adapter (upgraded on session_start if hasUI) ──

  const eventEmitObserver = new EventEmitObserver(pi, () => sessionManager);

  // Drive a flow run that was interrupted by parent-session close (or for which
  // abort arrives with no live flow) to a terminal state, so a replayed
  // dashboard card reaches a clearable status instead of hanging "running".
  // Idempotent: findOrphanedRun returns null once the run has a terminal record.
  function reconcileOrphanedFlow(reason: "session-close" | "user-abort"): void {
    let entries: unknown = [];
    try { entries = sessionManager?.getEntries?.() ?? []; } catch { entries = []; }
    const orphan = findOrphanedRun(entries);
    if (orphan) eventEmitObserver.reconcileOrphanedRun(orphan, reason);
  }

  const flowManager = new FlowManager(
    {
      getAgents: () => agents,
      getPi: () => pi,
      getProjectRoot: () => projectRoot,
      getPkgRoot: () => pkgRoot,
      getAuthStorage: () => sessionAuthStorage,
      getModelRegistry: () => sessionModelRegistry,
      getSessionManager: () => sessionManager,
      getExtraAgentExtensions: () => [...extraAgentExtensions],
      getExtensionTools: () => [...registeredExtensionTools],
      getSkill: (skillName) => {
        const dir = findSkillDir(pkgRoot, skillName);
        if (!dir) return undefined;
        // Reuse pi's own loader so the resolved Skill (name/description/
        // filePath/baseDir) matches main-session semantics exactly.
        try {
          const { skills } = loadSkillsFromDir({ dir, source: "pi-flows" });
          return skills.find(s => s.name === skillName) ?? skills[0];
        } catch { return undefined; }
      },
      isAutonomous: () => isAutonomousMode(),
    },
    new HeadlessFlowIOAdapter(), // Default — replaced by TUI adapter on session_start if hasUI
    [eventEmitObserver],         // EventEmitObserver always active; TuiFlowObserver added if hasUI
  );

  // ── Session start: wire TUI or headless ──

  pi.on("session_start", (_event: any, ctx: any) => {
    if (ctx.modelRegistry) {
      sessionModelRegistry = ctx.modelRegistry;
      sessionAuthStorage = (ctx.modelRegistry as any).authStorage;
    }
    if (ctx.sessionManager) {
      sessionManager = ctx.sessionManager;
      // Resume-time reconciliation: a flow interrupted by a prior parent-session
      // close left a non-terminal event stream. Synthesize its terminal event
      // now (before any new flow can launch) so the replayed card clears.
      reconcileOrphanedFlow("session-close");
    }
    if (ctx.hasUI) {
      // Upgrade to TUI adapter
      flowManager.setIOAdapter(new TuiFlowIOAdapter(ctx.ui, getIsOverlayOpen, pi));
      // Add TUI observer (must be before EventEmitObserver for correct ordering)
      // We insert at position 0 so TuiFlowObserver.onFlowComplete runs first
      // (emits flow:set-summary-context before EventEmitObserver emits flow:complete)
      const tuiObserver = new TuiFlowObserver({
        pi,
        flowManager,
        extractAgentConfigs,
        buildAgentDeps,
      });
      // Insert at beginning so TuiFlowObserver.onFlowComplete runs first
      // (emits flow:set-summary-context before EventEmitObserver emits flow:complete)
      flowManager.insertObserver(tuiObserver);
    }
  });

  // ── TUI keyboard/widget wiring ──

  setupFlowTui(pi, flowManager);

  // ── PromptBus setup ──
  // Listen for the bus request function from the dashboard bridge
  listenForPromptBus(pi);

  // ── Event listeners for dependent package registration ──

  pi.events?.on("flow:register-gate", (data) => {
    const entry = data as GateEntry;
    gates.push(entry);
  });

  pi.events?.on("flow:register-agents-dir", (data) => {
    const dir = (data as { dir: string }).dir;
    if (dir && !extraAgentsDirs.includes(dir)) {
      extraAgentsDirs.push(dir);
      init(pkgRoot, projectRoot);
    }
  });

  pi.events?.on("flow:register-flows-dir", (data) => {
    const dir = (data as { dir: string }).dir;
    if (dir && !extraFlowsDirs.includes(dir)) {
      extraFlowsDirs.push(dir);
      const oldFlowNames = new Set(flows.keys());
      init(pkgRoot, projectRoot);
      for (const [name, flow] of flows) {
        if (!oldFlowNames.has(name)) {
          registerFlowCommand(pi, name);
        }
      }
    }
  });

  pi.events?.on("flow:unregister-agents-dir", (data) => {
    const dir = (data as { dir: string }).dir;
    const idx = extraAgentsDirs.indexOf(dir);
    if (idx !== -1) {
      extraAgentsDirs.splice(idx, 1);
      init(pkgRoot, projectRoot);
    }
  });

  pi.events?.on("flow:unregister-flows-dir", (data) => {
    const dir = (data as { dir: string }).dir;
    const idx = extraFlowsDirs.indexOf(dir);
    if (idx !== -1) {
      const oldFlowNames = new Set(flows.keys());
      extraFlowsDirs.splice(idx, 1);
      init(pkgRoot, projectRoot);
      for (const name of oldFlowNames) {
        if (!flows.has(name)) {
          pi.registerCommand(name, { handler: async () => {} });
        }
      }
    }
  });

  pi.events?.on("flow:register-skills-dir", (data) => {
    const dir = (data as { dir: string }).dir;
    if (dir) registerExtraSkillsDir(dir);
  });

  const handleRegisterAgentExtension = (data: unknown) => {
    const entry = data as { factory?: any; path?: string };
    if (entry.factory) {
      // Dedupe by reference: producers (e.g. the dashboard
      // flows-anthropic-bridge plugin) re-announce the SAME stable factory on
      // every session_start so it survives this array being re-seeded. Only
      // push the first time to avoid registering the bridge N times per spawn.
      if (!extraAgentExtensions.includes(entry.factory)) {
        extraAgentExtensions.push(entry.factory);
      }
    } else if (entry.path) {
      const filePath = entry.path;
      const factory = async (piApi: any) => {
        const mod = await import(filePath);
        if (mod.default) mod.default(piApi);
      };
      extraAgentExtensions.push(factory);
    }
  };

  pi.events?.on("flow:register-agent-extension", handleRegisterAgentExtension);

  // ── Register tools ──

  registerAskUserTool(pi);

  // Tool name dedup set — used by the flow:register-tool handler.
  const seenToolNames = new Set<string>();

  // ── Edit-flow tools (gated by the `flows.editFlow` setting) ──
  // Registered on the main session but kept INACTIVE by default so they do not
  // appear in any session's system prompt. Activated per session only when
  // settings enable them (`flows.editFlow: true` in .pi/settings.json —
  // project value, when trusted, overrides the global value). The
  // manage-flows skill stays available as /skill:manage-flows regardless.
  const EDIT_FLOW_TOOLS = ["flow_agents", "flow_write"];
  registerFlowAgentsTool(pi, () => agents, projectRoot, pkgRoot, () => extraAgentsDirs);
  registerFlowWriteTool(pi, () => agents, projectRoot);

  // Activate/deactivate the authoring tools to match the requested edit-mode.
  // Change-gated (see edit-flow-reconcile.ts): applies only when the resolved
  // value changed, so re-checking every turn does not rebuild the system prompt
  // needlessly. One shared instance (and one cache) across session_start,
  // before_agent_start, and the command/event applyEditMode calls — no staleness.
  const reconcileEditFlowTools = makeEditFlowToolReconciler({
    getActiveTools: () => pi.getActiveTools(),
    setActiveTools: (names) => pi.setActiveTools(names),
    editFlowTools: EDIT_FLOW_TOOLS,
  });

  // Shared edit-mode toggle: persist the setting, sync the project-local skill's
  // model-visibility, reconcile the authoring tools, and (when a reload-capable
  // context is available — i.e. the command path) reload so the skill change is
  // live this session. The event path has no `reload()` (base ExtensionContext),
  // so its skill change applies next session; tools update immediately either way.
  const applyEditMode = async (
    enabled: boolean,
    opts: { reload?: () => Promise<void>; notify?: (msg: string, level?: string) => void } = {},
  ): Promise<void> => {
    setEditFlowFlag(projectRoot, enabled);
    try { syncEditFlowSkill(projectRoot, pkgRoot, enabled); } catch { /* non-fatal */ }
    reconcileEditFlowTools(enabled);
    if (opts.reload) {
      await opts.reload();
      opts.notify?.(`Edit-mode ${enabled ? "ON" : "OFF"}.`, "info");
    } else {
      opts.notify?.(
        `Edit-mode ${enabled ? "ON" : "OFF"} — tools updated; skill visibility applies next session.`,
        "info",
      );
    }
  };

  // Reconcile edit-flow tools AND materialize/sync the project-local skill at
  // each session start (idempotent) so the skill is discoverable by default with
  // frontmatter reflecting the current setting.
  pi.on("session_start", (_ev: any, _ctx: any) => {
    const enabled = isEditFlowEnabled(projectRoot);
    reconcileEditFlowTools(enabled);
    try { syncEditFlowSkill(projectRoot, pkgRoot, enabled); } catch { /* non-fatal */ }
  });

  // Re-read `flows.editFlow` at each turn start so an out-of-band settings
  // change (e.g. a direct edit of .pi/settings.json while the session runs) is
  // picked up on the next agent turn without a restart. Change-gated, so
  // unchanged turns are no-ops. Tools only — skill prompt-visibility stays
  // coupled to session_start/reload (turn/event contexts have no reload()).
  pi.on("before_agent_start", (_ev: any, _ctx: any) => {
    reconcileEditFlowTools(isEditFlowEnabled(projectRoot));
  });

  // `/flows:edit-mode <on|off>` — command path has ctx.reload() for live effect.
  pi.registerCommand("flows:edit-mode", {
    description: "Toggle flow/agent authoring (edit-mode): tools + skill visibility, applied live",
    getArgumentCompletions: (prefix: string) => {
      const opts = ["on", "off"].filter((o) => o.startsWith(prefix.toLowerCase()));
      return opts.length ? opts.map((o) => ({ value: o, label: o, description: "edit-mode" })) : null;
    },
    handler: async (args: string, ctx: any) => {
      const enabled = parseEditModeArg(args);
      if (enabled === null) {
        ctx.ui?.notify?.("Usage: /flows:edit-mode <on|off>", "warning");
        return;
      }
      await applyEditMode(enabled, {
        reload: ctx.reload ? () => ctx.reload() : undefined,
        notify: (m, l) => ctx.ui?.notify?.(m, l),
      });
    },
  });

  // Inbound `flow:set-edit-mode` event (dashboard). Base ExtensionContext has no
  // reload(); tools update immediately, skill visibility applies next session.
  pi.events.on("flow:set-edit-mode", (data: any) => {
    if (typeof data?.enabled !== "boolean") return;
    void applyEditMode(data.enabled);
  });

  // ── Register flow commands ──

  function registerFlowCommand(piApi: ExtensionAPI, name: string) {
    const currentFlow = flows.get(name);
    piApi.registerCommand(name, {
      description: currentFlow?.description || `Run ${name} flow`,
      handler: async (args) => {
        const flow = flows.get(name);
        if (!flow) {
          pi.events.emit("flow:notify", { message: flowNotFoundMessage(name), level: "error" });
          return;
        }

        if (flowManager.isRunning) {
          pi.events.emit("flow:notify", { message: flowAlreadyRunningMessage(flowManager.activeFlowName), level: "error" });
          return;
        }

        const gateMsg = checkGate(name);
        if (gateMsg) {
          pi.events.emit("flow:notify", { message: gateMsg, level: "error" });
          return;
        }

        let task = args || "";
        if (flow.task_required && !task.trim()) {
          const prompt = flow.task_prompt || `Describe what you want ${name} to do:`;
          const result = await emitPromptAndAwait(pi, {
            pipeline: "flow-run",
            type: "input",
            question: prompt,
          });
          if (result.cancelled || !result.answer?.trim()) return;
          task = result.answer.trim();
        }

        await flowManager.start({ flow, flowName: name, task });
      },
    });
  }

  for (const [name] of flows) {
    registerFlowCommand(pi, name);
  }

  // ── Programmatic flow execution ──

  // Emit a TERMINAL `flow:complete` for a dispatch that does not start a flow, so
  // the outcome is observable on the SAME channel a real run finalizes on.
  //
  // Contract (stable, documented — keyed by the invoice UI and the automation
  // runner alike):
  //   status: "rejected"     — machine-readable; distinct from a run "error"
  //   reason: <text>         — human-readable cause, byte-identical to the
  //                            slash-command path's flow:notify strings
  //   flowName: <ns:name>
  //   lastResult.result.summary = reason  — so the automation runner's
  //     summarizeFlowResult renders `flow <name> rejected: <reason>` unchanged,
  //     finalizing an event-dispatched run in seconds instead of wedging until a
  //     stale-run reaper fires.
  //
  // Emit the terminal rejection payload (buildDispatchRejection) directly on
  // flow:complete — the SAME channel a real run finalizes on — so the outcome is
  // observable (invoice UI) and finalizes an event-dispatched automation run in
  // seconds instead of wedging until a stale-run reaper fires.
  function emitDispatchRejection(flowName: string, reason: string): void {
    pi.events.emit("flow:complete", buildDispatchRejection(flowName, reason));
  }

  async function runFlowByName(flowName: string, opts?: { task?: string; flowInput?: Record<string, unknown> }) {
    const flowConfig = flows.get(flowName);
    if (!flowConfig) {
      emitDispatchRejection(flowName, flowNotFoundMessage(flowName));
      return;
    }
    if (flowManager.isRunning) {
      emitDispatchRejection(flowName, flowAlreadyRunningMessage(flowManager.activeFlowName));
      return;
    }
    const gateMsg = checkGate(flowName);
    if (gateMsg) {
      emitDispatchRejection(flowName, gateMsg);
      return;
    }
    try {
      await flowManager.start({ flow: flowConfig, flowName, task: opts?.task ?? "", flowInput: opts?.flowInput });
    } catch (err) {
      // The atomic single-run guard in FlowManager.start() can throw "already
      // running" when a second dispatch races the first before assignment. Convert
      // it to the same observable rejection instead of an unhandled promise rejection.
      emitDispatchRejection(flowName, err instanceof Error ? err.message : String(err));
    }
  }

  // Single choke point: the duplicate `isRunning` guard that used to live here has
  // been removed so every non-start outcome flows through runFlowByName's
  // observable rejection path (and the atomic guard in start()).
  pi.events?.on("flow:run", async (data: any) => {
    await runFlowByName(data?.flowName, { task: data?.task, flowInput: data?.inputs });
  });

  pi.events.on("flow:rediscover", () => {
    init(pkgRoot, projectRoot);
    for (const [name] of flows) {
      registerFlowCommand(pi, name);
    }
  });

  // ── Expose state to other extensions ──

  pi.events.on("flow:get-agents", (data: any) => {
    data.agents = agents;
  });

  pi.events.on("flow:get-session-entries", (data: any) => {
    try {
      data.entries = sessionManager?.getEntries?.() ?? [];
    } catch {
      data.entries = [];
    }
  });

  pi.events.on("flow:list-flows", (data: any) => {
    data.flows = Array.from(flows.entries()).map(([name, flow]) => ({
      name,
      description: flow.description || "",
      source: flow.source || "",
      taskRequired: flow.task_required ?? false,
    }));
  });

  // External packages emit flow:register-tool with full ToolDefinition objects (with .execute())
  // to make their tools available to flow agent sessions. Canonical path for external packages.
  pi.events.on("flow:register-tool", (data: any) => {
    if (data?.tool) {
      const name = data.tool.name;
      if (!seenToolNames.has(name)) {
        seenToolNames.add(name);
        registeredExtensionTools.push(data.tool);
      }
    }
  });

  // External abort (e.g., from dashboard bridge)
  pi.events.on("flow:abort", () => {
    if (flowManager.isRunning) flowManager.abort();
    // No live flow (e.g. abort on a resumed session): clear the stuck card by
    // reconciling the latest orphaned run instead of silently no-opping.
    else reconcileOrphanedFlow("user-abort");
  });

  // External autonomous mode toggle (e.g., from dashboard bridge)
  pi.events.on("flow:toggle-autonomous", () => {
    setAutonomousMode(!isAutonomousMode());
    pi.events.emit("flow:autonomous-mode-changed", { enabled: isAutonomousMode() });
  });

  // Provide spawn context for subagent sessions
  pi.events.on("flow:get-spawn-context", (data: any) => {
    data.authStorage = sessionAuthStorage;
    data.modelRegistry = sessionModelRegistry;
    data.extraAgentExtensions = [...extraAgentExtensions];
    data.extensionTools = [...registeredExtensionTools];
  });
}
