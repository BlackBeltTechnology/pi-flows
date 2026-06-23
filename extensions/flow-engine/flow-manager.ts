// ---------------------------------------------------------------------------
// Flow Manager
//
// Pure orchestration — no TUI imports. Takes FlowIOAdapter for user
// interaction and FlowObserver[] for lifecycle event dispatch.
// ---------------------------------------------------------------------------

import type { AgentConfig, FlowConfig, FlowResult } from "./types.js";
import type { FlowIOAdapter, FlowObserver } from "./flow-io.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";


// ---- Configuration (non-TUI deps) -----------------------------------------

export interface FlowManagerConfig {
  getAgents: () => Map<string, AgentConfig>;
  getPi: () => ExtensionAPI;
  getProjectRoot: () => string;
  getPkgRoot: () => string;
  getAuthStorage: () => any;
  getModelRegistry: () => any;
  getExtraAgentExtensions: () => any[];
  getExtensionTools: () => any[];
  getSkillContent: (name: string) => string | undefined;
  isAutonomous: () => boolean;
}

// ---- Flow Manager ----------------------------------------------------------

export class FlowManager {
  private _activeFlow: {
    promise: Promise<FlowResult>;
    abortController: AbortController;
    flowName: string;
  } | null = null;

  constructor(
    private config: FlowManagerConfig,
    private ioAdapter: FlowIOAdapter,
    private observers: FlowObserver[],
  ) {}

  get isRunning(): boolean {
    return this._activeFlow !== null;
  }

  get activeFlowName(): string | null {
    return this._activeFlow?.flowName ?? null;
  }

  /** Replace the I/O adapter (e.g., when switching from headless to TUI after session_start). */
  setIOAdapter(adapter: FlowIOAdapter): void {
    this.ioAdapter = adapter;
  }

  /** Add an observer at the end. */
  addObserver(observer: FlowObserver): void {
    this.observers.push(observer);
  }

  /** Insert an observer at the beginning (runs before existing observers). */
  insertObserver(observer: FlowObserver): void {
    this.observers.unshift(observer);
  }

  abort(): void {
    this.ioAdapter.onFlowEnd?.();
    this._activeFlow?.abortController.abort();
  }

  async start(options: {
    flow: FlowConfig;
    flowName: string;
    task: string;
  }): Promise<void> {
    if (this._activeFlow) {
      throw new Error("A flow is already running");
    }

    const { flow, flowName, task } = options;
    const abortController = new AbortController();
    const { config, ioAdapter, observers } = this;

    // Notify adapter
    ioAdapter.onFlowStart?.();

    // Notify observers
    for (const obs of observers) obs.onFlowStarted?.(flowName, flow, task);

    // Dynamic import to avoid circular deps
    const { runFlow: runFlowFn } = await import("./flow-execution.js");

    const promise = runFlowFn({
      flow,
      task,
      cwd: config.getProjectRoot(),
      authStorage: config.getAuthStorage(),
      modelRegistry: config.getModelRegistry(),
      extraAgentExtensions: config.getExtraAgentExtensions(),
      extraCustomTools: config.getExtensionTools(),
      signal: abortController.signal,
      isAutonomous: () => config.isAutonomous(),
      onAutoDecision: (forkId, agentName, chosenBranch, targetStepId) => {
        for (const obs of observers) obs.onAutoDecision?.(forkId, agentName, chosenBranch, targetStepId);
      },
      onNotify: (message: string) => {
        ioAdapter.notify?.(message);
      },
      pi: config.getPi(),
      getAgent: (agentName) => config.getAgents().get(agentName),
      getSkillContent: (skillName) => config.getSkillContent(skillName),
      askUser: async (question, type, askOptions, extra) => {
        const r = await ioAdapter.askUser(question, type as any, askOptions, { ...extra, signal: abortController.signal });
        return {
          answer: Array.isArray(r.answer) ? r.answer.join(', ') : r.answer,
          notes: r.notes,
        };
      },
      onAgentStarted: (agentName: string, stepId: string, resolvedModel?: string) => {
        const agentConfig = config.getAgents().get(agentName);
        for (const obs of observers) obs.onAgentStarted?.(agentName, stepId, agentConfig, resolvedModel);
      },
      onAgentComplete: (agentName: string, stepId: string, result: any) => {
        // Step-level (message-level) agent failure: surface as a discrete
        // timeline error entry BEFORE the status flip, so observers (and the
        // persisted stream) capture it. Tool errors travel via onToolResult.
        if (result && result.success === false) {
          const text = String(
            result.result?.summary || result.output || result.stderr || "Agent failed",
          );
          for (const obs of observers) obs.onError?.(agentName, stepId, text);
        }
        for (const obs of observers) obs.onAgentComplete?.(agentName, stepId, result);
      },
      onExtensionUIRequest: (agentName: string, request: any, respond: (response: any) => void) => {
        ioAdapter.handleExtensionUIRequest(agentName, request, respond);
      },
      onToolCall: (agentName: string, stepId: string, toolName: string, input: any) => {
        for (const obs of observers) obs.onToolCall?.(agentName, stepId, toolName, input);
      },
      onToolResult: (agentName: string, stepId: string, toolName: string, output: any, isError?: boolean) => {
        for (const obs of observers) obs.onToolResult?.(agentName, stepId, toolName, output, !!isError);
      },
      onAssistantText: (agentName: string, stepId: string, text: string) => {
        for (const obs of observers) obs.onAssistantText?.(agentName, stepId, text);
      },
      onThinkingText: (agentName: string, stepId: string, text: string) => {
        for (const obs of observers) obs.onThinkingText?.(agentName, stepId, text);
      },
      onLoopIteration: (stepId: string, iteration: number, maxIterations: number, loopTarget?: string) => {
        for (const obs of observers) obs.onLoopIteration?.(stepId, iteration, maxIterations, loopTarget);
      },
    });

    this._activeFlow = { promise, abortController, flowName };

    // Fire-and-forget with lifecycle cleanup
    promise
      .then((flowResult: FlowResult) => {
        this._activeFlow = null;
        ioAdapter.onFlowEnd?.();
        for (const obs of observers) obs.onFlowComplete?.(flowName, flowResult);
      })
      .catch((err: any) => {
        const wasAborted = abortController.signal.aborted;
        this._activeFlow = null;
        ioAdapter.onFlowEnd?.();

        const errMsg = err instanceof Error ? err.message : String(err);
        const summaryMsg = wasAborted ? "Aborted by user" : errMsg;
        const errorResult: FlowResult = {
          lastResult: {
            success: false,
            output: "",
            stderr: "",
            exitCode: null,
            result: { status: "error", files: [], summary: summaryMsg, artifacts: "" },
            toolCalls: [],
            duration: 0,
            tokens: { input: 0, output: 0 },
          },
          results: {},
          forks: {},
          flowName,
          stepCount: 0,
          totalDuration: 0,
          status: wasAborted ? "aborted" : "error",
        };
        for (const obs of observers) obs.onFlowComplete?.(flowName, errorResult);
      });
  }
}
