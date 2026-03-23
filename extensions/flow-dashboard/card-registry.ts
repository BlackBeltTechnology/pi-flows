import type { AgentCardRenderer } from "./types.js";
import type { AgentConfig } from "../flow-engine/types.js";
import { DefaultCard } from "./default-card.js";
import { FilesCard } from "./files-card.js";
import { TestsCard } from "./tests-card.js";

// Use a global symbol to share the card registry across jiti module instances.
// Without this, dynamic imports from different extensions get separate module copies.
const REGISTRY_KEY = Symbol.for("pi-flow-dashboard-cards");

/** Metric renderer factory: returns a new AgentCardRenderer for a given metric name. */
type MetricFactory = () => AgentCardRenderer;

function getRegistry(): Map<string, MetricFactory> {
  const g = globalThis as any;
  if (!g[REGISTRY_KEY]) {
    g[REGISTRY_KEY] = new Map<string, MetricFactory>();
  }
  return g[REGISTRY_KEY];
}

// ---- Built-in metric renderers ------------------------------------------------

/** Register a metric renderer factory by name. */
export function registerMetric(name: string, factory: MetricFactory): void {
  getRegistry().set(name, factory);
}

/** Initialize built-in metric renderers. */
export function initCardTypes(): void {
  const reg = getRegistry();
  if (!reg.has("default")) reg.set("default", () => new DefaultCard());
  if (!reg.has("files"))   reg.set("files",   () => new FilesCard());
  if (!reg.has("tests"))   reg.set("tests",   () => new TestsCard());
}

/**
 * Get a card renderer for an agent config.
 * Resolves metric renderer from `card.metric` frontmatter field.
 * Falls back to DefaultCard for unknown metric names.
 */
export function getCardRenderer(agentConfig?: AgentConfig): AgentCardRenderer {
  if (!agentConfig) {
    return new DefaultCard();
  }

  const metricName = agentConfig.card?.metric || "default";

  // Look up from registry by metric name
  const factory = getRegistry().get(metricName);
  if (factory) return factory();

  // Fallback to default
  return new DefaultCard();
}
