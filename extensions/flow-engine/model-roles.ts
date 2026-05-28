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

type ThinkingLevelString = "minimal" | "low" | "medium" | "high" | "xhigh" | "off";
const VALID_THINKING_LEVELS: readonly ThinkingLevelString[] = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
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

/** Cap on the size of the `available.models` hint baked into error
 *  messages. Twenty ids is plenty for a human to spot a typo without
 *  swamping the error string. */
const AVAILABLE_MODELS_HINT_CAP = 20;

/** Internal: shape of `pi.modelRegistry` we actually use. */
interface ModelRegistryShape {
  find?: (provider: string, id: string) => Model<any> | undefined;
  getAll?: () => Array<Model<any> & { id?: string; provider?: string }>;
}

function getModelRegistry(pi: ExtensionAPI): ModelRegistryShape | undefined {
  const reg = (pi as unknown as { modelRegistry?: ModelRegistryShape }).modelRegistry;
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
 *
 * @returns `{ modelId, thinkingLevel, model? }` on success; throws on failure
 *          (handler-reported error, unknown role with no handler, or
 *          unresolved literal in the fallback path).
 */
export function resolveModel(
  pi: ExtensionAPI,
  modelRef: string,
  thinking?: string,
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
      throw new Error(probe.error + formatAvailable(probe.available));
    }
    // Silent emit — fall through to in-process fallback.
  }

  // ============== FALLBACK: in-process registry =================
  // The fallback intentionally does NOT read `~/.pi/agent/providers.json`
  // — role storage policy belongs to the handler. `@role` fails here.
  if (ref.startsWith("@")) {
    throw new Error(
      `Cannot resolve role "${ref}": no "model:resolve" handler is registered.\n` +
        `Role aliasing requires pi-agent-dashboard (or a package that registers a ` +
        `model:resolve handler) to be loaded.\n` +
        `Fix: install/enable pi-agent-dashboard, or replace the "@role" reference ` +
        `with a literal "provider/model-id" or bare model id.`,
    );
  }

  const registry = getModelRegistry(pi);
  if (!registry) {
    throw new Error(
      `Model registry unavailable on pi.modelRegistry — cannot resolve "${modelRef}".`,
    );
  }

  const { provider, modelId, thinkingLevel } = splitModelRef(ref);

  let model: Model<any> | undefined;
  if (provider) {
    if (typeof registry.find === "function") {
      model = registry.find(provider, modelId);
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
  const all = typeof registry.getAll === "function" ? registry.getAll() : [];
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
