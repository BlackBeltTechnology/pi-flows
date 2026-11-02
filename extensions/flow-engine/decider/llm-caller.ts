// ---------------------------------------------------------------------------
// In-process System One `llm` caller: one structured completion, no agent
// session, no tools. See change: classifier-decisions (D6).
// ---------------------------------------------------------------------------

import type { LlmCaller } from "@blackbelt-technology/pi-system-one";
import { resolveAgentModel, type ParentModelSnapshot } from "../model-roles.js";

export interface LlmCallerOptions {
  pi: any;
  registry: any;
  parentModel?: ParentModelSnapshot;
  modelFallback?: "session" | "error";
  /** One completion; defaults to `registry.complete`. */
  /** Per-completion timeout (default 15 s, design D9). */
  timeoutMs?: number;
  complete?: (model: any, context: any, options?: any) => Promise<{ content: Array<{ type: string; text?: string }> }>;
}

const LLM_TIMEOUT_MS = 15_000;
const LOCAL_PROVIDER = /^(ollama|lm-?studio|llama[-._]?cpp)$/i;
const LOOPBACK = /^(localhost|\[::1\]|127(\.\d{1,3}){3})$/i;

function resolveRole(o: LlmCallerOptions, role: string) {
  return resolveAgentModel(o.pi, { name: "system-one-llm", modelRefs: [role] }, {
    registry: o.registry,
    parentModel: o.parentModel,
    modelFallback: o.modelFallback,
  });
}

/** Pull the first JSON object out of a model reply (tolerates code fences). */
function parseJsonObject(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("the model reply contained no JSON object");
  return JSON.parse(body.slice(start, end + 1));
}

export function createLlmCaller(o: LlmCallerOptions): LlmCaller {
  return {
    async call({ role, state, questions, signal }) {
      const resolved = resolveRole(o, role);
      const complete = o.complete ?? ((m, c, opts) => o.registry.complete(m, c, opts));
      const q = Object.entries(questions)
        .map(([name, question]) => `${name}: ${JSON.stringify(question)}`)
        .join("\n");
      const systemPrompt =
        "You are a classifier. Answer each question by picking exactly one label from its criteria. " +
        'Reply with ONLY a JSON object: {"<question name>": {"choice": "<label>", "probabilities": {"<label>": <0..1>, ...}}}. ' +
        "Probabilities must sum to 1. No prose.";
      const prompt = `State:\n${state}\n\nQuestions:\n${q}`;
      const timeoutMs = o.timeoutMs ?? LLM_TIMEOUT_MS;
      const timeoutCtl = new AbortController();
      const anySignal = signal ? AbortSignal.any([signal, timeoutCtl.signal]) : timeoutCtl.signal;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let reply: Awaited<ReturnType<typeof complete>>;
      try {
        reply = await Promise.race([
          complete(
            resolved.model,
            { systemPrompt, messages: [{ role: "user", content: prompt, timestamp: Date.now() }] },
            { signal: anySignal },
          ),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              timeoutCtl.abort();
              reject(new Error(`no answer within ${timeoutMs} ms`));
            }, timeoutMs);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
      const text = (reply.content ?? []).map((b: { type: string; text?: string }) => (b.type === "text" ? b.text ?? "" : "")).join("");
      return { answers: parseJsonObject(text), model: resolved.modelId };
    },
    isLocal(role) {
      try {
        const m: any = resolveRole(o, role).model;
        if (!LOCAL_PROVIDER.test(String(m.provider))) return false;
        return LOOPBACK.test(new URL(String(m.baseUrl)).hostname);
      } catch {
        return false;
      }
    },
  };
}
