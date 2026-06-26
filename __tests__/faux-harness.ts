/**
 * Faux-model test harness (change: add-faux-model-flow-tests).
 *
 * Drives the REAL `spawnAgent` loop (guard, finish latch, retry stop-gate,
 * tool dispatch, abort wiring) against a scripted `pi-ai` faux provider —
 * zero network, zero credentials, deterministic.
 *
 * All faux-provider knowledge is confined to this file. Suites speak only in
 * harness verbs: `scriptFinish`, `scriptToolThenFinish`, `scriptError`,
 * `scriptSlowText`, and `spawnFaux`.
 */

import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

import {
  fauxAssistantMessage,
  fauxToolCall,
  fauxText,
  type FauxResponseStep,
} from "@earendil-works/pi-ai/providers/faux";
import type { registerFauxProvider as RegisterFauxProviderFn } from "@earendil-works/pi-ai/compat";

type FauxRegistration = ReturnType<typeof RegisterFauxProviderFn>;

// CRITICAL: pi-coding-agent bundles its OWN nested copy of `@earendil-works/pi-ai`
// (node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai).
// The api-provider registry is module-scoped, so the top-level pi-ai copy this
// test would import is a DIFFERENT registry than the one `createAgentSession`
// resolves streams through. We must register the faux api into the EXACT pi-ai
// instance pi-coding-agent uses — resolved relative to its package via
// createRequire — or every session fails with "No API provider registered".
/**
 * Locate the `pi-ai/compat` dist file belonging to the pi-coding-agent install.
 * Walk up from this file to each `node_modules` root, and prefer pi-coding-agent's
 * NESTED pi-ai copy (the one its dist actually imports) over a hoisted one.
 * Both package exports only define an `import` condition, so neither
 * `require.resolve` nor a bare specifier reaches the right instance — we resolve
 * the concrete dist path on disk instead.
 */
function resolveNestedCompatPath(): string {
  const REL = join("@earendil-works", "pi-ai", "dist", "compat.js");
  const PCA = join("@earendil-works", "pi-coding-agent");
  let dir = dirname(fileURLToPath(import.meta.url));
  while (true) {
    const nm = join(dir, "node_modules");
    if (existsSync(nm)) {
      const nested = join(nm, PCA, "node_modules", REL);
      if (existsSync(nested)) return nested;
      const hoisted = join(nm, REL);
      if (existsSync(join(nm, PCA)) && existsSync(hoisted)) return hoisted;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("faux-harness: could not locate pi-coding-agent's pi-ai/compat.js");
}

let cachedRegister: typeof RegisterFauxProviderFn | undefined;
async function getRegisterFauxProvider(): Promise<typeof RegisterFauxProviderFn> {
  if (cachedRegister) return cachedRegister;
  const compatPath = resolveNestedCompatPath();
  const compat = await import(pathToFileURL(compatPath).href);
  cachedRegister = compat.registerFauxProvider as typeof RegisterFauxProviderFn;
  return cachedRegister;
}

import { spawnAgent } from "../extensions/flow-engine/execution.js";
import { runFlow, type FlowRunOptions } from "../extensions/flow-engine/flow-execution.js";
import type { AgentConfig, AgentResult, FlowConfig, FlowResult } from "../extensions/flow-engine/types.js";

/** Args accepted by the guard's `finish` tool. */
export interface FinishArgs {
  status: "complete" | "error" | "blocked";
  summary: string;
  files?: Array<{ path: string; action: "created" | "modified" | "read" }>;
  artifacts?: string;
  /** Decision branch (only when the agent runs under decisionBranches). */
  branch?: string;
  /** Declared typed outputs (string-valued). */
  [key: string]: unknown;
}

/** A schema-valid `finish` tool-call response. */
export function scriptFinish(args: FinishArgs, finishToolName = "finish"): FauxResponseStep {
  const { status, summary, files = [], artifacts, ...rest } = args;
  return fauxAssistantMessage([
    fauxToolCall(finishToolName, { status, summary, files, ...(artifacts !== undefined ? { artifacts } : {}), ...rest }),
  ]);
}

/** A tool call (turn 1) followed by a finish (turn 2). */
export function scriptToolThenFinish(
  toolName: string,
  toolArgs: Record<string, unknown>,
  finishArgs: FinishArgs,
  finishToolName = "finish",
): FauxResponseStep[] {
  return [
    fauxAssistantMessage([fauxToolCall(toolName, toolArgs)]),
    scriptFinish(finishArgs, finishToolName),
  ];
}

/** A provider-level error response (drives soft-fail routing). */
export function scriptError(message: string): FauxResponseStep {
  return fauxAssistantMessage([], { stopReason: "error", errorMessage: message });
}

/** A long text block that streams slowly (for abort-mid-stream tests). */
export function scriptSlowText(text: string): FauxResponseStep {
  return fauxAssistantMessage([fauxText(text)]);
}

/** Minimal AgentConfig with sensible defaults; override via `partial`. */
export function makeAgent(partial: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "faux-agent",
    description: "faux test agent",
    model: "faux/faux-1",
    tools: [],
    systemPrompt: "You are a faux test agent.",
    source: "<faux-harness>",
    ...partial,
  };
}

/**
 * Build a `modelRegistry` stub backed by the faux provider's models, plus a
 * no-op `authStorage`. Shape matches what `spawnAgent` / `createAgentSession`
 * read: `find(provider, id)`, `getAll()`, `authStorage`.
 */
export function makeFauxRegistry(faux: FauxRegistration): any {
  const authStorage = {
    // pi-ai faux auth resolves to an empty auth object — no real key needed.
    load: async () => ({}),
    save: async () => {},
    get: async () => ({}),
  };
  return {
    authStorage,
    find: (_provider: string, id: string) => faux.getModel(id),
    getAll: () => faux.models,
    getAvailable: () => faux.models,
    // Faux needs no real credentials — report auth as configured.
    hasConfiguredAuth: () => true,
    isUsingOAuth: () => false,
    getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "faux", headers: {} }),
    registerProvider: () => {},
    unregisterProvider: () => {},
  };
}

export interface SpawnFauxOptions {
  agent?: Partial<AgentConfig>;
  task?: string;
  responses: FauxResponseStep[];
  signal?: AbortSignal;
  /** Faux model `api` — set "anthropic-messages" to exercise the mcp__flows__ prefix path. */
  modelApi?: string;
  /** Faux model id (default "faux-1"). */
  modelId?: string;
  /** Streaming rate; low values make abort-mid-stream deterministic. */
  tokensPerSecond?: number;
  cwd?: string;
}

export interface SpawnFauxOutcome {
  result: AgentResult;
  faux: FauxRegistration;
  /** Tool name the agent should call to finish (prefixed under anthropic-messages). */
  finishToolName: string;
}

/**
 * Run the real `spawnAgent` loop against a scripted faux provider.
 *
 * Registers a faux api into pi-ai's global registry for the duration of the
 * call and unregisters it afterwards, so tests do not leak provider state.
 */
export async function spawnFaux(options: SpawnFauxOptions): Promise<SpawnFauxOutcome> {
  const modelId = options.modelId ?? "faux-1";
  // `api` is BOTH the global-registry key and the model's `api` field — they
  // must match (compat's wrapStream throws on mismatch). The model's api also
  // drives toolPrefix in spawnAgent ("anthropic-messages" → mcp__flows__).
  const api = options.modelApi ?? "faux";
  const provider = api === "anthropic-messages" ? "anthropic" : "faux";
  const registerFauxProvider = await getRegisterFauxProvider();
  const faux = registerFauxProvider({
    api,
    provider,
    models: [{ id: modelId }],
    tokensPerSecond: options.tokensPerSecond,
  });
  faux.setResponses(options.responses);

  const finishToolName = api === "anthropic-messages" ? "mcp__flows__finish" : "finish";
  const registry = makeFauxRegistry(faux);
  const agent = makeAgent({ model: `${provider}/${modelId}`, ...options.agent });

  try {
    const result = await spawnAgent({
      agent,
      task: options.task ?? "do the thing",
      templateContext: { task: options.task ?? "do the thing", inputs: {}, results: {} },
      pi: {} as any, // unused: resolvedModelId bypasses resolveModel
      cwd: options.cwd ?? process.cwd(),
      modelRegistry: registry,
      resolvedModelId: `${provider}/${modelId}`,
      signal: options.signal,
    });
    return { result, faux, finishToolName };
  } finally {
    faux.unregister();
  }
}

/** Extract the text of the last user message in a faux stream context. */
export function lastUserText(context: any): string {
  const messages = context?.messages ?? [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "user") {
      const content = m.content;
      if (typeof content === "string") return content;
      if (Array.isArray(content)) {
        return content.map((b: any) => (b.type === "text" ? b.text : "")).join("\n");
      }
    }
  }
  return "";
}

export interface RunFauxOptions {
  flow: FlowConfig;
  agents: AgentConfig[];
  /**
   * Per-turn response selector. Receives the dispatched task text (last user
   * message) and the resolving model; returns a faux assistant message
   * (typically `scriptFinish(...)`). Selection is by content/model id — never
   * by queue order — so it is robust under parallel scheduling.
   */
  responder: (taskText: string, model: any) => FauxResponseStep;
  cwd?: string;
  /** Upper bound on faux turns to queue (covers retries). Default 24. */
  maxTurns?: number;
  signal?: AbortSignal;
}

/**
 * Run the real `runFlow` DAG executor against a scripted faux provider. One
 * faux api/model backs every agent; the `responder` selects each turn's
 * response by inspecting the dispatched task, so concurrent steps stay
 * deterministic without relying on queue ordering.
 */
export async function runFaux(options: RunFauxOptions): Promise<FlowResult> {
  const registerFauxProvider = await getRegisterFauxProvider();
  const faux = registerFauxProvider({ api: "faux", provider: "faux", models: [{ id: "faux-1" }] });

  // Queue N copies of a content-routing factory. Each stream call shifts one;
  // every copy delegates to the user responder, so order is irrelevant.
  const factory = (context: any, _opts: any, _state: any, model: any): any =>
    options.responder(lastUserText(context), model);
  faux.setResponses(Array.from({ length: options.maxTurns ?? 24 }, () => factory));

  const registry = makeFauxRegistry(faux);
  const agentMap = new Map(options.agents.map((a) => [a.name, a]));

  // pi stub: `events.emit` is silent (no model:resolve handler) so resolveModel
  // falls through to the in-process registry fallback using `pi.modelRegistry`.
  const pi: any = {
    events: { emit: () => undefined, on: () => undefined },
    modelRegistry: registry,
  };

  const runOptions: FlowRunOptions = {
    flow: options.flow,
    task: "flow task",
    cwd: options.cwd ?? process.cwd(),
    modelRegistry: registry,
    pi,
    getAgent: (name: string) => agentMap.get(name),
    askUser: async () => ({ answer: "" }),
    signal: options.signal,
  };

  try {
    return await runFlow(runOptions);
  } finally {
    faux.unregister();
  }
}

export interface RunFauxFlowOptions extends RunFauxOptions {
  /**
   * Source for `code` / `code-decision` handlers, keyed by step id. Each entry
   * is written to a temp `.mjs` file and wired into the step's `target:`. The
   * source must `export default async function handler(input, ctx)`.
   */
  codeHandlers?: Record<string, string>;
  /** Answers for interactive `fork` steps, keyed by fork step id → chosen option. */
  forkAnswers?: Record<string, string>;
  /** Observe step lifecycle (e.g. to tally loop re-entries). */
  onAgentStarted?: FlowRunOptions["onAgentStarted"];
  onAgentComplete?: FlowRunOptions["onAgentComplete"];
}

/**
 * Full-integration variant of {@link runFaux}: materializes code-node handlers
 * to temp files, answers fork prompts, and surfaces lifecycle callbacks — so a
 * single large flow can exercise agents, code/code-decision nodes, forks,
 * agent-decision loops, and on_error routing against one scripted faux model.
 */
export async function runFauxFlow(options: RunFauxFlowOptions): Promise<FlowResult> {
  // Materialize code handlers into a temp dir and point each step's target at it.
  const handlerDir = mkdtempSync(join(tmpdir(), "faux-handlers-"));
  if (options.codeHandlers) {
    for (const step of options.flow.steps) {
      const src = options.codeHandlers[step.id];
      if (src && (step.stepType === "code" || step.stepType === "code-decision")) {
        const file = join(handlerDir, `${step.id}.mjs`);
        writeFileSync(file, src, "utf8");
        (step as { target?: string }).target = file;
      }
    }
  }

  const registerFauxProvider = await getRegisterFauxProvider();
  const faux = registerFauxProvider({ api: "faux", provider: "faux", models: [{ id: "faux-1" }] });
  const factory = (context: any, _o: any, _s: any, model: any): any => options.responder(lastUserText(context), model);
  faux.setResponses(Array.from({ length: options.maxTurns ?? 48 }, () => factory));

  const registry = makeFauxRegistry(faux);
  const agentMap = new Map(options.agents.map((a) => [a.name, a]));
  const pi: any = { events: { emit: () => undefined, on: () => undefined }, modelRegistry: registry };

  const runOptions: FlowRunOptions = {
    flow: options.flow,
    task: "flow task",
    cwd: options.cwd ?? process.cwd(),
    modelRegistry: registry,
    pi,
    getAgent: (name: string) => agentMap.get(name),
    askUser: async (_q, _t, opts) => {
      // Fork answer resolution: the engine passes the fork's option list; we
      // return the configured answer (or the first option as a safe default).
      const answer = options.forkAnswers && Object.values(options.forkAnswers)[0];
      return { answer: answer ?? (opts?.[0] ?? "") };
    },
    onAgentStarted: options.onAgentStarted,
    onAgentComplete: options.onAgentComplete,
    signal: options.signal,
  };

  try {
    return await runFlow(runOptions);
  } finally {
    faux.unregister();
  }
}
