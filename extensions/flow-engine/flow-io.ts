// ---------------------------------------------------------------------------
// Flow I/O Interfaces
//
// Decouples flow orchestration (FlowManager) from user interaction and
// lifecycle observation. Enables TUI, web, headless, and test adapters.
// ---------------------------------------------------------------------------

import type { AgentConfig, AgentResult, FlowConfig, FlowResult, NodeKind } from "./types.js";

// ---- FlowIOAdapter --------------------------------------------------------

/** Extra context passed to askUser for fork prompts. */
export interface AskUserExtra {
  allowCustom?: boolean;
  hasAutoAgent?: boolean;
  multiSelect?: boolean;
  branches?: Record<string, string>;
  signal?: AbortSignal;
}

/** Result from askUser. */
export interface AskUserResult {
  answer: string | string[];
  notes?: string;
}

/**
 * Strategy for user interaction during flow execution.
 * TUI, web, headless, and test modes each implement this.
 */
export interface FlowIOAdapter {
  /**
   * Ask the user a question (fork prompt).
   * Implementations decide HOW to ask (TUI overlay, web dialog, auto-pick, etc.)
   */
  askUser(
    question: string,
    type: "select" | "confirm" | "input" | "multiselect",
    options?: string[],
    extra?: AskUserExtra,
  ): Promise<AskUserResult>;

  /**
   * Handle a subagent extension UI request (ask_user tool, or other extension UI calls).
   * Called when a subagent needs user input during execution.
   */
  handleExtensionUIRequest(
    agentName: string,
    request: { id: string; method: string; [key: string]: any },
    respond: (response: any) => void,
  ): void;

  /** Called when flow starts — adapter can set up resources (e.g., queues) */
  onFlowStart?(): void;

  /** Called when flow ends — adapter can clean up */
  onFlowEnd?(): void;

  /** Show a notification to the user (info level) */
  notify?(message: string): void;
}

// ---- FlowObserver ---------------------------------------------------------

/**
 * Observer for flow lifecycle events.
 * Multiple observers can be registered simultaneously.
 * TUI dashboard, web bridge, disk persistence, tests — all are observers.
 */
export interface FlowObserver {
  onFlowStarted?(flowName: string, flow: FlowConfig, task: string): void;
  onAgentStarted?(agentName: string, stepId: string, config?: AgentConfig, resolvedModel?: string, extra?: { nodeKind?: NodeKind; target?: string }): void;
  onAgentComplete?(agentName: string, stepId: string, result: AgentResult, extra?: { nodeKind?: NodeKind; target?: string }): void;
  onToolCall?(agentName: string, stepId: string, toolName: string, input: any): void;
  onToolResult?(agentName: string, stepId: string, toolName: string, output: any, isError: boolean): void;
  onAssistantText?(agentName: string, stepId: string, text: string): void;
  onThinkingText?(agentName: string, stepId: string, text: string): void;
  onLoopIteration?(stepId: string, iteration: number, maxIterations: number, loopTarget?: string): void;
  onAutoDecision?(forkId: string, agentName: string, chosenBranch: string, targetStepId: string): void;
  // Step-level (message-level) agent failure, distinct from a tool result with
  // isError:true (which travels via onToolResult). Surfaces as a discrete
  // {kind:"error"} timeline entry.
  onError?(agentName: string, stepId: string, text: string): void;
  onFlowComplete?(flowName: string, result: FlowResult): void;
}
