/**
 * Tests for `resolveModel` — covers the primary-then-fallback algorithm
 * defined in spec `flow-model-resolution` (change: consume-model-resolve-event).
 *
 * The resolver has two paths:
 *   PRIMARY   pi.events.emit("model:resolve", probe)
 *             Handler fills probe.model (success) or probe.error (handler-
 *             reported miss). If neither is set the emit is silent and the
 *             extension falls through to:
 *   FALLBACK  In-process resolution via pi.modelRegistry — handles literal
 *             "provider/id" and bare "id" forms only; "@role" fails cleanly.
 *
 * The tests stub pi.events and pi.modelRegistry — no real SDK is loaded.
 *
 * Mirrors the structure of
 * `pi-dashboard-subagents/extensions/__tests__/model-resolve.test.ts`.
 */

import { describe, expect, it } from "vitest";

import { resolveModel } from "../extensions/flow-engine/model-roles.js";

// ── Tiny pi-handle factory ─────────────────────────────────────────────

type AnyModel = { id: string; provider?: string };

type RegistryStub = {
  find?: (provider: string, id: string) => AnyModel | undefined;
  getAll?: () => AnyModel[];
};

interface MkPiOpts {
  /** Handler installed on `model:resolve`. Omit → silent emit. */
  resolveHandler?: (probe: any) => void;
  /** Stub for `pi.modelRegistry`. Omit → no registry. */
  modelRegistry?: RegistryStub;
  /** When true, the emit() handler call throws — exercises the try/catch. */
  emitThrows?: boolean;
}

function mkPi(opts: MkPiOpts): any {
  return {
    events: {
      emit(channel: string, data: unknown) {
        if (channel !== "model:resolve") return;
        if (opts.emitThrows) throw new Error("boom from handler");
        if (opts.resolveHandler) opts.resolveHandler(data);
      },
      on() { /* unused */ },
    },
    modelRegistry: opts.modelRegistry,
  };
}

// ── PRIMARY path ────────────────────────────────────────────────────────

describe("resolveModel — PRIMARY (handler answers)", () => {
  it("handler resolves @role → returns modelId, thinking level, Model", () => {
    const fakeModel: AnyModel = { id: "claude-sonnet-4-6", provider: "anthropic" };
    let registryFindCalls = 0;
    const pi = mkPi({
      resolveHandler: (probe) => {
        expect(probe.ref).toBe("@coding");
        probe.model = fakeModel;
        probe.resolved = "anthropic/claude-sonnet-4-6";
        probe.thinkingLevel = "medium";
      },
      modelRegistry: { find: () => { registryFindCalls++; return undefined; } },
    });
    const out = resolveModel(pi, "@coding");
    expect(out.modelId).toBe("anthropic/claude-sonnet-4-6");
    expect(out.model).toBe(fakeModel);
    expect(out.thinking).toBe("medium");
    expect(registryFindCalls).toBe(0); // fallback never ran
  });

  it("handler resolves provider/model → returns Model", () => {
    const fakeModel: AnyModel = { id: "claude-opus-4", provider: "anthropic" };
    const pi = mkPi({
      resolveHandler: (probe) => {
        if (probe.ref === "anthropic/claude-opus-4") {
          probe.model = fakeModel;
          probe.resolved = "anthropic/claude-opus-4";
        }
      },
    });
    const out = resolveModel(pi, "anthropic/claude-opus-4");
    expect(out.model).toBe(fakeModel);
    expect(out.modelId).toBe("anthropic/claude-opus-4");
  });

  it("handler resolves bare model id → returns Model", () => {
    const fakeModel: AnyModel = { id: "claude-haiku-4-5", provider: "anthropic" };
    const pi = mkPi({
      resolveHandler: (probe) => {
        if (probe.ref === "claude-haiku-4-5") {
          probe.model = fakeModel;
          probe.resolved = "anthropic/claude-haiku-4-5";
        }
      },
    });
    const out = resolveModel(pi, "claude-haiku-4-5");
    expect(out.model).toBe(fakeModel);
    expect(out.modelId).toBe("anthropic/claude-haiku-4-5");
  });

  it("handler reports error → resolveModel throws with that message + available hint", () => {
    const pi = mkPi({
      resolveHandler: (probe) => {
        probe.error = `Role "@unknownrole" not in providers.json#roles.`;
        probe.available = { roles: { fast: "x/y", research: "x/z" } };
      },
    });
    expect(() => resolveModel(pi, "@unknownrole")).toThrow(
      /Role "@unknownrole" not in providers\.json/,
    );
    try {
      resolveModel(pi, "@unknownrole");
    } catch (err) {
      expect(String((err as Error).message)).toMatch(/Available roles: @fast, @research/);
    }
  });

  it("handler thinking level surfaces through to resolveModel return", () => {
    const fakeModel: AnyModel = { id: "claude-opus-4", provider: "anthropic" };
    const pi = mkPi({
      resolveHandler: (probe) => {
        probe.model = fakeModel;
        probe.thinkingLevel = "high";
        probe.resolved = "anthropic/claude-opus-4";
      },
    });
    const out = resolveModel(pi, "anthropic/claude-opus-4:high");
    expect(out.model).toBe(fakeModel);
    expect(out.thinking).toBe("high");
  });

  it("handler that throws → resolveModel throws with the handler message", () => {
    const pi = mkPi({ emitThrows: true });
    expect(() => resolveModel(pi, "@coding")).toThrow(
      /"model:resolve" handler threw while resolving "@coding"/,
    );
  });

  it("explicit thinking parameter overrides handler-supplied level", () => {
    const fakeModel: AnyModel = { id: "claude-opus-4", provider: "anthropic" };
    const pi = mkPi({
      resolveHandler: (probe) => {
        probe.model = fakeModel;
        probe.thinkingLevel = "low";
        probe.resolved = "anthropic/claude-opus-4";
      },
    });
    const out = resolveModel(pi, "anthropic/claude-opus-4", "high");
    expect(out.thinking).toBe("high");
  });
});

// ── FALLBACK path ───────────────────────────────────────────────────────

describe("resolveModel — FALLBACK (silent emit, in-process registry)", () => {
  it("silent emit + provider/model → fallback uses registry.find", () => {
    const fakeModel: AnyModel = { id: "claude-opus-4", provider: "anthropic" };
    let findArgs: [string, string] | undefined;
    const pi = mkPi({
      modelRegistry: {
        find: (p, m) => {
          findArgs = [p, m];
          return p === "anthropic" && m === "claude-opus-4" ? fakeModel : undefined;
        },
      },
    });
    const out = resolveModel(pi, "anthropic/claude-opus-4");
    expect(out.model).toBe(fakeModel);
    expect(out.modelId).toBe("anthropic/claude-opus-4");
    expect(findArgs).toEqual(["anthropic", "claude-opus-4"]);
  });

  it("silent emit + bare id → fallback uses registry.getAll", () => {
    const m1: AnyModel = { id: "claude-haiku-4-5", provider: "anthropic" };
    const m2: AnyModel = { id: "claude-haiku-4-5", provider: "bedrock" };
    const pi = mkPi({
      modelRegistry: { find: () => undefined, getAll: () => [m1, m2] },
    });
    const out = resolveModel(pi, "claude-haiku-4-5");
    expect(out.model).toBe(m1); // first hit
  });

  it("silent emit + @role → fallback throws with install hint", () => {
    const pi = mkPi({ modelRegistry: { find: () => undefined, getAll: () => [] } });
    expect(() => resolveModel(pi, "@coding")).toThrow(
      /Cannot resolve role "@coding"/,
    );
    try {
      resolveModel(pi, "@coding");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toMatch(/no "model:resolve" handler is registered/);
      expect(msg).toMatch(/pi-agent-dashboard/);
    }
  });

  it("silent emit + unknown bare id → fallback throws with available models hint", () => {
    const pi = mkPi({
      modelRegistry: {
        find: () => undefined,
        getAll: () => [
          { id: "claude-haiku-4-5", provider: "anthropic" },
          { id: "gpt-5", provider: "openai" },
        ],
      },
    });
    expect(() => resolveModel(pi, "made-up-model")).toThrow(
      /No model matched "made-up-model"/,
    );
    try {
      resolveModel(pi, "made-up-model");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toMatch(/Available model ids:.*claude-haiku-4-5.*gpt-5/s);
    }
  });

  it("silent emit + unknown provider/model → fallback throws with auth hint", () => {
    const pi = mkPi({ modelRegistry: { find: () => undefined, getAll: () => [] } });
    expect(() => resolveModel(pi, "anthropic/made-up")).toThrow(
      /Model "anthropic\/made-up" is not registered or not authenticated/,
    );
  });

  it("fallback parses :thinking suffix off bare id before registry lookup", () => {
    const fakeModel: AnyModel = { id: "claude-haiku-4-5", provider: "anthropic" };
    const pi = mkPi({
      modelRegistry: { find: () => undefined, getAll: () => [fakeModel] },
    });
    const out = resolveModel(pi, "claude-haiku-4-5:high");
    expect(out.model).toBe(fakeModel);
    expect(out.thinking).toBe("high");
  });

  it("fallback parses :thinking suffix off provider/model before registry lookup", () => {
    const fakeModel: AnyModel = { id: "claude-opus-4", provider: "anthropic" };
    let findArgs: [string, string] | undefined;
    const pi = mkPi({
      modelRegistry: {
        find: (p, m) => { findArgs = [p, m]; return fakeModel; },
      },
    });
    const out = resolveModel(pi, "anthropic/claude-opus-4:high");
    expect(out.thinking).toBe("high");
    expect(findArgs).toEqual(["anthropic", "claude-opus-4"]); // suffix stripped
  });

  it("handler fills neither probe.model nor probe.error → fallback runs", () => {
    const fakeModel: AnyModel = { id: "x", provider: "p" };
    const pi = mkPi({
      resolveHandler: () => { /* no-op */ },
      modelRegistry: { find: (p, m) => (p === "p" && m === "x" ? fakeModel : undefined) },
    });
    const out = resolveModel(pi, "p/x");
    expect(out.model).toBe(fakeModel);
  });

  it("empty ref throws Empty model reference", () => {
    const pi = mkPi({});
    expect(() => resolveModel(pi, "   ")).toThrow(/Empty model reference/);
  });
});
