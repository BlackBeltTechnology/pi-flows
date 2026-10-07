/**
 * getModelRuntime — reads the providers+keys runtime behind a pi
 * ModelRegistry (design decision 1, change flow-agents-inherit-model-runtime).
 *
 * 3.1 is the CANARY: it uses a REAL pi ModelRegistry, so it fails in CI if pi
 * renames/removes the private field the helper relies on.
 */

import { describe, it, expect } from "vitest";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";

import { getModelRuntime } from "../extensions/flow-engine/model-runtime.js";

describe("getModelRuntime", () => {
  it("3.1 returns the exact runtime wrapped by a real ModelRegistry (canary)", async () => {
    const runtime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false, allowModelNetwork: false } as any);
    const registry = new ModelRegistry(runtime);
    expect(getModelRuntime(registry)).toBe(runtime);
  });

  it("3.2 returns undefined (never throws) for unusable inputs", () => {
    const throwing = Object.defineProperty({}, "runtime", { get() { throw new Error("boom"); } });
    for (const input of [undefined, null, {}, { runtime: {} }, { runtime: { getModel: () => undefined } }, throwing]) {
      expect(getModelRuntime(input as any)).toBeUndefined();
    }
  });
});
