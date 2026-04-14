// ---------------------------------------------------------------------------
// Flow Engine — Extension Entry Point (Wiring Only)
//
// Slim orchestration hub: discovery, tool registration, event listeners,
// and assembly of FlowManager with appropriate adapters and observers.
// All TUI code lives in flow-tui.ts and flow-io-tui.ts.
// ---------------------------------------------------------------------------

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { AgentConfig, FlowConfig, FlowResult } from "./types.js";
import { discoverAll, resolvePackageRoot } from "./discovery.js";
import { getModelRole, isAutonomousMode, setAutonomousMode } from "../role-manager.js";
import { registerSubagentTool } from "./tool.js";
import { registerAskUserTool } from "./tools/ask-user.js";
import {
  registerSkillReadTool,
  registerExtraSkillsDir,
  findSkillDir,
} from "./tools/skill-read.js";
import { registerAgentCatalogTool } from "./tools/agent-catalog.js";
import { registerAgentWriteTool } from "./tools/agent-write.js";
import { registerFlowWriteTool } from "./tools/flow-write.js";
import { existsSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { FlowManager } from "./flow-manager.js";
import { TuiFlowIOAdapter, HeadlessFlowIOAdapter } from "./flow-io-tui.js";
import { emitPromptAndAwait } from "./flow-prompt.js";
import { TuiFlowObserver, EventEmitObserver, setupFlowTui, getIsOverlayOpen } from "./flow-tui.js";
import { registerArchitectUIAdapter } from "./architect-ui-adapter.js";
import { listenForPromptBus } from "./prompt-bus-access.js";

// Re-export public API
export type {
  AgentConfig,
  FlowConfig,
  AgentResult,
  FlowResult,
  TemplateContext,
  SubagentEvent,
  ArchitectMeta,
  CardConfig,
} from "./types.js";
export { spawnAgent, expandTemplateVariables } from "./execution.js";
export { runFlow, FlowCancelledError } from "./flow-execution.js";
export type { FlowRunOptions, FlowContext } from "./flow-execution.js";
export { discoverAll, resolvePackageRoot } from "./discovery.js";
export { resolveModel } from "./model-roles.js";
export { parseResult, hasArtifactElement } from "./result-parser.js";
export { parseAgentFile, parseAgentString } from "./agent-parser.js";
export { parseFlowYamlFile, parseFlowYamlString } from "./flow-parser-yaml.js";
export type { FlowIOAdapter, FlowObserver, AskUserExtra, AskUserResult } from "./flow-io.js";
export { FlowManager } from "./flow-manager.js";

// ---- Discovery state -------------------------------------------------------

let agents = new Map<string, AgentConfig>();
let flows = new Map<string, FlowConfig>();
let packageRoot = "";
const extraAgentsDirs: string[] = [];
const extraFlowsDirs: string[] = [];
const extraGuardFactories: any[] = [];
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

// ---- Extension activation --------------------------------------------------

export function activate(pi: ExtensionAPI) {
  const pkgRoot = resolvePackageRoot(import.meta.url);
  const projectRoot = process.cwd();
  packageRoot = pkgRoot;

  // Initial discovery
  init(pkgRoot, projectRoot);

  // Crash recovery: clean up orphaned staging directory
  {
    const stagingDir = join(projectRoot, ".pi", "flows", ".staging");
    if (existsSync(stagingDir)) {
      try { rmSync(stagingDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }

  // Track authStorage and modelRegistry from session context
  let sessionAuthStorage: any = undefined;
  let sessionModelRegistry: any = undefined;

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

  const eventEmitObserver = new EventEmitObserver(pi);

  const flowManager = new FlowManager(
    {
      getAgents: () => agents,
      getModelRole: () => getModelRole,
      getProjectRoot: () => projectRoot,
      getPkgRoot: () => pkgRoot,
      getAuthStorage: () => sessionAuthStorage,
      getModelRegistry: () => sessionModelRegistry,
      getExtraGuardFactories: () => [...extraGuardFactories],
      getExtensionTools: () => [...registeredExtensionTools],
      getSkillContent: (skillName) => {
        const dir = findSkillDir(pkgRoot, skillName);
        if (!dir) return undefined;
        try { return readFileSync(join(dir, "SKILL.md"), "utf-8"); } catch { return undefined; }
      },
      isAutonomous: () => isAutonomousMode(),
    },
    new HeadlessFlowIOAdapter(), // Default — replaced by TUI adapter on session_start if hasUI
    [eventEmitObserver],         // EventEmitObserver always active; TuiFlowObserver added if hasUI
  );

  // ── Session start: wire TUI or headless ──

  let sessionManager: any = undefined;

  pi.on("session_start", (_event: any, ctx: any) => {
    if (ctx.modelRegistry) {
      sessionModelRegistry = ctx.modelRegistry;
      sessionAuthStorage = (ctx.modelRegistry as any).authStorage;
    }
    if (ctx.sessionManager) {
      sessionManager = ctx.sessionManager;
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

  // ── PromptBus TUI + Architect adapter registration ──
  // Register the prompt:ctx-originals listener early (during activate) so it
  // exists before the dashboard bridge's session_start handler emits the event.
  // The actual adapter registration + bus wiring happens on session_start when
  // ctx.hasUI is true, but the event listener must be in place before that.
  //
  // NOTE: registerArchitectUIAdapter MUST happen in session_start (not activate)
  // because it emits "prompt:register-adapter" which the bridge's session_start
  // handler listens for. The event bus is fire-and-forget — emitting during
  // activate would fire before the listener exists.
  {
    let architectAdapterRegistered = false;

    pi.on("session_start", (_ev: any, _ctx: any) => {
      // Architect adapter: claims architect-* prompts with widget-bar component.
      // Registered for ALL sessions (including headless) — it doesn't need ctx.ui,
      // it just tells the dashboard how to render the prompt.
      if (!architectAdapterRegistered) {
        architectAdapterRegistered = true;
        registerArchitectUIAdapter(pi);
      }
    });
  }

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
          registerFlowCommand(pi, name, flow);
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

  pi.events?.on("flow:register-guard-extension", (data) => {
    const entry = data as { factory?: any; path?: string };
    if (entry.factory) {
      extraGuardFactories.push(entry.factory);
    } else if (entry.path) {
      const filePath = entry.path;
      const factory = async (piApi: any) => {
        const mod = await import(filePath);
        if (mod.default) mod.default(piApi);
      };
      extraGuardFactories.push(factory);
    }
  });

  // ── Register tools ──

  registerSubagentTool(
    pi,
    () => agents,
    (role) => getModelRole(role),
    projectRoot,
    () => sessionAuthStorage,
    () => sessionModelRegistry,
    () => [...extraGuardFactories],
  );

  registerAskUserTool(pi);
  registerSkillReadTool(pi, pkgRoot);

  // Tool name dedup set — shared between subagentOnlyPi and flow:register-tool handler.
  const seenToolNames = new Set<string>();

  // Capture full ToolDefinition objects (with .execute()) for subagent sessions.
  // These tools are NOT registered on the main session — they are only available
  // to subagents (e.g., flow-architect) via extraCustomTools.
  const subagentOnlyPi = {
    ...pi,
    registerTool: (tool: any) => {
      if (!seenToolNames.has(tool.name)) {
        seenToolNames.add(tool.name);
        registeredExtensionTools.push(tool);
      }
      // Intentionally NOT calling pi.registerTool() — these tools should not
      // appear in the main session's system prompt or be callable by the main LLM.
    },
  };
  registerAgentCatalogTool(subagentOnlyPi as any, () => agents, projectRoot, pkgRoot, () => extraAgentsDirs);
  registerAgentWriteTool(subagentOnlyPi as any);
  registerFlowWriteTool(subagentOnlyPi as any, () => agents);

  // ── Register flow commands ──

  function registerFlowCommand(piApi: ExtensionAPI, name: string) {
    const currentFlow = flows.get(name);
    piApi.registerCommand(name, {
      description: currentFlow?.description || `Run ${name} flow`,
      handler: async (args) => {
        const flow = flows.get(name);
        if (!flow) {
          pi.events.emit("flow:notify", { message: `Flow "${name}" no longer exists — it may have been deleted`, level: "error" });
          return;
        }

        if (flowManager.isRunning) {
          pi.events.emit("flow:notify", { message: `A flow is already running (${flowManager.activeFlowName})`, level: "error" });
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

  async function runFlowByName(flowName: string) {
    if (flowManager.isRunning) return;
    const flowConfig = flows.get(flowName);
    if (!flowConfig) return;
    const gateMsg = checkGate(flowName);
    if (gateMsg) return;
    await flowManager.start({ flow: flowConfig, flowName, task: "" });
  }

  pi.events?.on("flow:run", async (data: any) => {
    if (flowManager.isRunning) return;
    await runFlowByName(data?.flowName);
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
  });

  // External autonomous mode toggle (e.g., from dashboard bridge)
  pi.events.on("flow:toggle-autonomous", () => {
    setAutonomousMode(!isAutonomousMode());
    pi.events.emit("flow:autonomous-mode-changed", { enabled: isAutonomousMode() });
  });

  // Provide spawn context for subagent sessions (flow-workspace, architect)
  pi.events.on("flow:get-spawn-context", (data: any) => {
    data.authStorage = sessionAuthStorage;
    data.modelRegistry = sessionModelRegistry;
    data.extraGuardFactories = [...extraGuardFactories];
    data.extensionTools = [...registeredExtensionTools];
  });
}
