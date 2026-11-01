// ---------------------------------------------------------------------------
// Flow Engine — Model Reference Resolution
//
// Resolves a frontmatter / flow-YAML `model:` string into a concrete model
// id (and optional thinking level + Model object) via the shared
// `model:resolve` event-bus contract.
//
// Primary path:   pi.events.emit("model:resolve", probe)
//                 Handler (typically pi-agent-dashboard) fills probe.model
//                 + probe.thinkingLevel, OR fills probe.error on miss.
//
// Fallback path:  Used only when the emit returns silent (no handler set
//                 probe.model or probe.error). Handles the two literal
//                 forms via `pi.modelRegistry`:
//                   - `provider/model[:thk]` → registry.find(provider, id)
//                   - bare `model-id[:thk]`  → registry.getAll().find(...)
//                 `@role` is NOT handled by the fallback — role storage
//                 lives in the handler.
// ---------------------------------------------------------------------------

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import type { ModelFallbackInfo } from "./types.js";

type ThinkingLevelString = "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "off";
export const VALID_THINKING_LEVELS: readonly ThinkingLevelString[] = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "off",
];

/**
 * Shape of the cooperative probe payload emitted on the `model:resolve`
 * event. Handlers follow the early-return idiom (`if (probe.model) return`).
 */
interface ModelResolveProbe {
  /** Input — the raw frontmatter string. */
  ref: string;
  /** Output — canonical literal "provider/model-id" (no thinking suffix). */
  resolved?: string;
  /** Output — the resolved Model object. */
  model?: Model<any>;
  /** Output — thinking-level parsed off the suffix, if any. */
  thinkingLevel?: ThinkingLevelString;
  /** Output — optional auth resolution (handler-defined shape). */
  auth?: { ok?: boolean; error?: string; [k: string]: unknown };
  /** Output — human-readable error when resolution fails. */
  error?: string;
  /** Output — diagnostics on failure: known roles / known model ids. */
  available?: {
    roles?: Record<string, string>;
    models?: string[];
  };
}

/**
 * Thrown for an `@`-ref that cannot be resolved (no resolver answered, or the
 * resolver reported an error). `resolveAgentModel` skips these; literals never
 * produce it.
 */
export class UnresolvableRefError extends Error {
  constructor(message: string, public readonly reason: "no-resolver" | "resolver-error", public readonly ref: string) {
    super(message);
    this.name = "UnresolvableRefError";
  }
}

/** Cap on the size of the `available.models` hint baked into error
 *  messages. Twenty ids is plenty for a human to spot a typo without
 *  swamping the error string. */
const AVAILABLE_MODELS_HINT_CAP = 20;

/** Internal: shape of `pi.modelRegistry` we actually use. */
interface ModelRegistryShape {
  find?: (provider: string, id: string) => Model<any> | undefined;
  getAll?: () => Array<Model<any> & { id?: string; provider?: string }>;
}

function getModelRegistry(pi: ExtensionAPI, sessionRegistry?: unknown): ModelRegistryShape | undefined {
  // pi 1.x: the registry lives on the session ctx, not on the ExtensionAPI.
  // Prefer the session registry; `pi.modelRegistry` is a last resort only.
  const reg = (sessionRegistry as ModelRegistryShape | undefined)
    ?? (pi as unknown as { modelRegistry?: ModelRegistryShape }).modelRegistry;
  return reg && (typeof reg.find === "function" || typeof reg.getAll === "function")
    ? reg
    : undefined;
}

/**
 * Split a `"provider/id"` or `"provider/id:level"` reference into its parts.
 * The thinking level suffix is the substring AFTER the LAST `:` only when
 * it matches a known thinking level (case-insensitive).
 */
function splitModelRef(ref: string): {
  provider: string | undefined;
  modelId: string;
  thinkingLevel: ThinkingLevelString | undefined;
} {
  let working = ref;
  let thinkingLevel: ThinkingLevelString | undefined;
  const lastColon = working.lastIndexOf(":");
  if (lastColon > 0) {
    const suffix = working.slice(lastColon + 1).toLowerCase() as ThinkingLevelString;
    if (VALID_THINKING_LEVELS.includes(suffix)) {
      thinkingLevel = suffix;
      working = working.slice(0, lastColon);
    }
  }
  const firstSlash = working.indexOf("/");
  if (firstSlash <= 0) {
    return { provider: undefined, modelId: working, thinkingLevel };
  }
  return {
    provider: working.slice(0, firstSlash),
    modelId: working.slice(firstSlash + 1),
    thinkingLevel,
  };
}

/** Internal: render `probe.available` as a multi-line hint block. */
function formatAvailable(av: ModelResolveProbe["available"]): string {
  if (!av) return "";
  const parts: string[] = [];
  if (av.roles && typeof av.roles === "object") {
    const roleNames = Object.keys(av.roles).sort();
    if (roleNames.length > 0) {
      parts.push(`Available roles: ${roleNames.map((r) => `@${r}`).join(", ")}`);
    }
  }
  if (Array.isArray(av.models) && av.models.length > 0) {
    const ids = av.models.slice(0, AVAILABLE_MODELS_HINT_CAP);
    parts.push(`Available model ids: ${ids.join(", ")}`);
  }
  return parts.length > 0 ? `\n${parts.join("\n")}` : "";
}

/**
 * Resolve a model reference string into a concrete model id (and optional
 * thinking level + Model object).
 *
 * @param pi          ExtensionAPI handle (events + modelRegistry).
 * @param modelRef    The raw model reference from agent/flow config
 *                    (`@role` | `provider/model[:thk]` | bare `model-id[:thk]`).
 * @param thinking    Optional explicit thinking level override. Wins over any
 *                    suffix-parsed value.
 * @param registry    Session model registry (`ctx.modelRegistry`) for the
 *                    in-process fallback. Falls back to `pi.modelRegistry`.
 *
 * @returns `{ modelId, thinkingLevel, model? }` on success; throws on failure
 *          (handler-reported error, unknown role with no handler, or
 *          unresolved literal in the fallback path).
 */
export function resolveModel(
  pi: ExtensionAPI,
  modelRef: string,
  thinking?: string,
  registry?: unknown,
): { modelId: string; thinking?: string; model?: Model<any> } {
  // Strip surrounding quotes (YAML may preserve them: "@coding" → @coding)
  let ref = modelRef.trim();
  if ((ref.startsWith('"') && ref.endsWith('"')) || (ref.startsWith("'") && ref.endsWith("'"))) {
    ref = ref.slice(1, -1);
  }

  if (!ref) {
    throw new Error("Empty model reference.");
  }

  // ============== PRIMARY: model:resolve event bus ==============
  if (pi.events) {
    const probe: ModelResolveProbe = { ref };
    try {
      pi.events.emit("model:resolve", probe);
    } catch (err) {
      throw new Error(
        `"model:resolve" handler threw while resolving "${modelRef}": ` +
          `${err instanceof Error ? err.message : String(err)}.`,
        { cause: err },
      );
    }
    if (probe.model) {
      const resolvedId =
        probe.resolved
        || ((probe.model as any).provider && (probe.model as any).id
          ? `${(probe.model as any).provider}/${(probe.model as any).id}`
          : (probe.model as any).id || ref);
      return {
        modelId: resolvedId,
        thinking: thinking || probe.thinkingLevel,
        model: probe.model,
      };
    }
    if (typeof probe.error === "string" && probe.error.length > 0) {
      const msg = probe.error + formatAvailable(probe.available);
      throw ref.startsWith("@") ? new UnresolvableRefError(msg, "resolver-error", ref) : new Error(msg);
    }
    // Silent emit — fall through to in-process fallback.
  }

  // ============== FALLBACK: in-process registry =================
  // The fallback intentionally does NOT read `~/.pi/agent/providers.json`
  // — role storage policy belongs to the handler. `@role` fails here.
  if (ref.startsWith("@")) {
    throw new UnresolvableRefError(
      `Cannot resolve role "${ref}": no "model:resolve" handler is registered.\n` +
        `\`@\`-refs need a model:resolve resolver (e.g. pi-agent-dashboard) to be loaded.\n` +
        `Fix: install/enable a resolver, use a literal "provider/model-id" or bare model id, ` +
        `or leave flows.modelFallback at "session" to run on the session model.`,
      "no-resolver",
      ref,
    );
  }

  const reg = getModelRegistry(pi, registry);
  if (!reg) {
    throw new Error(
      `Model registry unavailable (no pi session registry) — cannot resolve "${modelRef}".`,
    );
  }

  const { provider, modelId, thinkingLevel } = splitModelRef(ref);

  let model: Model<any> | undefined;
  if (provider) {
    if (typeof reg.find === "function") {
      model = reg.find(provider, modelId);
    }
    if (!model) {
      throw new Error(
        `Model "${provider}/${modelId}" is not registered or not authenticated.\n` +
          `Resolved from "${modelRef}".\n` +
          `Run \`/provider\` or check ~/.pi/agent/auth.json.`,
      );
    }
    return {
      modelId: `${provider}/${modelId}`,
      thinking: thinking || thinkingLevel,
      model,
    };
  }

  // Bare-id "like" query. First match in registry.getAll() iteration order wins.
  const all = typeof reg.getAll === "function" ? reg.getAll() : [];
  model = all.find((m) => m && (m as any).id === modelId);
  if (!model) {
    const hint = all
      .map((m) => m && (m as any).id)
      .filter((s): s is string => typeof s === "string" && s.length > 0)
      .slice(0, AVAILABLE_MODELS_HINT_CAP);
    throw new Error(
      `No model matched "${modelRef}" via bare-id lookup.\n` +
        `Try the explicit "provider/model-id" form, or pick from the registered models.` +
        (hint.length > 0 ? `\nAvailable model ids: ${hint.join(", ")}` : ""),
    );
  }
  return {
    modelId,
    thinking: thinking || thinkingLevel,
    model,
  };
}

// ---------------------------------------------------------------------------
// Agent-level resolution chain: ordered refs → session-model fallback.
// ---------------------------------------------------------------------------

export interface ResolvedAgentModel {
  model: Model<any>;
  modelId: string;
  thinking?: string;
  fallback?: ModelFallbackInfo;
}

/** Session model snapshot taken at flow start. */
export interface ParentModelSnapshot {
  model: Model<any>;
  thinking?: string;
}

export interface ResolveAgentModelOptions {
  registry?: unknown;
  parentModel?: ParentModelSnapshot;
  /** `flows.modelFallback`; default "session". */
  modelFallback?: "session" | "error";
}

function modelIdOf(m: Model<any>): string {
  const mm = m as { provider?: string; id?: string };
  return mm.provider && mm.id ? `${mm.provider}/${mm.id}` : mm.id ?? "unknown";
}

/**
 * Resolve an agent's `model:` entries in order. The first entry that resolves
 * wins. An unresolvable `@`-ref is skipped; a literal that is not found throws
 * (never skipped). When nothing resolves (or no model is declared) the session
 * model is used unless `modelFallback` is "error".
 */
export function resolveAgentModel(
  pi: ExtensionAPI,
  agent: { name: string; source?: string; model?: string; modelRefs?: string[]; thinking?: string },
  options: ResolveAgentModelOptions = {},
): ResolvedAgentModel {
  const refs = agent.modelRefs ?? (agent.model ? [agent.model] : []);
  const skipped: UnresolvableRefError[] = [];

  for (const ref of refs) {
    try {
      const r = resolveModel(pi, ref, agent.thinking, options.registry);
      return { model: r.model as Model<any>, modelId: r.modelId, thinking: r.thinking };
    } catch (err) {
      if (err instanceof UnresolvableRefError) {
        skipped.push(err);
        continue;
      }
      throw new Error(
        `${(err as Error).message}\n(agent "${agent.name}"${agent.source ? `, defined in ${agent.source}` : ""})`,
        { cause: err },
      );
    }
  }

  const where = `agent "${agent.name}"${agent.source ? ` (${agent.source})` : ""}`;
  const reason: ModelFallbackInfo["reason"] =
    refs.length === 0 ? "no-model-declared" : skipped[0]?.reason ?? "no-resolver";
  const requestedText = refs.length > 0 ? refs.join(", ") : "(no model declared)";

  if (options.modelFallback === "error") {
    const detail = skipped.map((s) => s.message).join("\n");
    throw new Error(
      `No model entry resolved for ${where}: ${requestedText}, and flows.modelFallback is "error".` +
        (detail ? `\n${detail}` : ""),
    );
  }
  const parent = options.parentModel;
  if (!parent?.model) {
    throw new Error(
      `Cannot run ${where}: no model entry resolved (${requestedText}) and no session model was captured to fall back on.`,
    );
  }
  const used = modelIdOf(parent.model);
  return {
    model: parent.model,
    modelId: used,
    thinking: agent.thinking ?? parent.thinking,
    fallback: { requested: refs, used, reason },
  };
}
