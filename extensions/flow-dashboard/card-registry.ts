import type { AgentCardRenderer } from "./types.js";
import type { AgentConfig } from "../flow-engine/types.js";
import { DefaultCard } from "./default-card.js";
import { FilesCard } from "./files-card.js";
import { TestsCard } from "./tests-card.js";

/** Metric renderer factory: returns a new AgentCardRenderer for a given metric name. */
type MetricFactory = () => AgentCardRenderer;

// Module-level registry shared across all extensions via the single entry point.
const registry = new Map<string, MetricFactory>();

// ---- Built-in metric renderers ------------------------------------------------

/** Register a metric renderer factory by name. */
export function registerMetric(name: string, factory: MetricFactory): void {
  registry.set(name, factory);
}

/** Initialize built-in metric renderers. */
export function initCardTypes(): void {
  if (!registry.has("default")) registry.set("default", () => new DefaultCard());
  if (!registry.has("files"))   registry.set("files",   () => new FilesCard());
  if (!registry.has("tests"))   registry.set("tests",   () => new TestsCard());
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
  const factory = registry.get(metricName);
  if (factory) return factory();

  // Fallback to default
  return new DefaultCard();
}
