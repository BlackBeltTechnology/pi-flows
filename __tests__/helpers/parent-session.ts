/**
 * Production-path fixtures for flow runtime-inheritance tests.
 *
 * Unlike `spawnFaux`/`runFaux` (which hand `modelRuntime` to the engine
 * directly and therefore cannot catch wiring bugs), these fixtures drive the
 * REAL extension entry: `activate(pi)` -> `session_start(ctx)` -> `flow:run`.
 *
 * The only double is a real pi `ModelRuntime` carrying a scripted faux
 * provider registered IN MEMORY ONLY (never on disk), wrapped in a REAL
 * `ModelRegistry` - exactly what a provider registered via
 * `pi.registerProvider()` looks like inside a live parent session.
 */

import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRegistry } from "@earendil-works/pi-coding-agent";

import { registerFauxOnRuntime } from "../faux-harness.js";

export interface ParentSession {
  ctx: { modelRegistry: any; hasUI: false };
  runtime: any;
  registry: any;
  faux: any;
  provider: string;
}

/** A parent session whose registry holds an in-memory-only provider. */
export async function makeParentSession(provider = "rtprov", models = [{ id: "m1" }]): Promise<ParentSession> {
  const { faux, runtime } = await registerFauxOnRuntime({ api: `${provider}-api`, provider, models });
  const registry = new ModelRegistry(runtime);
  return { ctx: { modelRegistry: registry, hasUI: false }, runtime, registry, faux, provider };
}

type Handler = (...args: any[]) => any;

/**
 * Minimal pi `ExtensionAPI` host: real handler maps for `pi.on` and
 * `pi.events`, inert no-ops for every registration method.
 */
export function fakeExtensionHost() {
  const lifecycle = new Map<string, Handler[]>();
  const bus = new Map<string, Handler[]>();
  const add = (m: Map<string, Handler[]>, k: string, h: Handler) => m.set(k, [...(m.get(k) ?? []), h]);

  const events = {
    on: (name: string, h: Handler) => { add(bus, name, h); return () => undefined; },
    emit: (name: string, data?: any) => { for (const h of bus.get(name) ?? []) h(data); },
  };
  const base: Record<string, unknown> = {
    on: (name: string, h: Handler) => add(lifecycle, name, h),
    events,
    getActiveTools: () => [],
    getAllTools: () => [],
  };
  const pi = new Proxy(base, {
    get: (t, p: string) => (p in t ? t[p] : () => undefined),
  }) as any;

  return {
    pi,
    /** Fire a pi lifecycle event (e.g. session_start) and await all handlers. */
    async fire(name: string, ctx: any) {
      for (const h of lifecycle.get(name) ?? []) await h({ type: name }, ctx);
    },
    /** Emit on the shared event bus and await every handler. */
    async emit(name: string, data: any = {}) {
      await Promise.all((bus.get(name) ?? []).map((h) => h(data)));
      return data;
    },
    /** Resolve with the payload of the next `name` bus event. */
    next(name: string): Promise<any> {
      return new Promise((resolve) => events.on(name, resolve));
    },
  };
}

/**
 * Write a self-contained flows dir + agents dir to a temp location and return
 * them. `flows` maps "<ns>/<name>" to flow.yaml text; `agents` maps agent name
 * to its markdown file text.
 */
export function writeFlowFixture(flows: Record<string, string>, agents: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "pi-flows-rt-"));
  const flowsDir = join(root, "flows");
  const agentsDir = join(root, "agents");
  mkdirSync(agentsDir, { recursive: true });
  for (const [key, yaml] of Object.entries(flows)) {
    const dir = join(flowsDir, key);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "flow.yaml"), yaml, "utf8");
  }
  for (const [name, md] of Object.entries(agents)) writeFileSync(join(agentsDir, `${name}.md`), md, "utf8");
  return { flowsDir, agentsDir };
}

/** Agent markdown with a given model ref (and optional thinking level). */
export function agentMd(name: string, model: string, thinking?: string): string {
  return [
    "---",
    `name: ${name}`,
    "description: runtime inheritance test agent",
    `model: ${model}`,
    ...(thinking ? [`thinking: ${thinking}`] : []),
    "tools: read",
    "---",
    "You are a test agent.",
    "",
  ].join("\n");
}
