/**
 * pi-flows does not own Anthropic-specific prompt or wire handling.
 *
 * The dashboard (or any other host) registers an agent extension through
 * `flow:register-agent-extension`; that extension replaces system-prompt
 * sections in `before_agent_start`. pi-flows only forwards the factory into
 * every spawned agent.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { getCurrentSystemPrompt } from "@earendil-works/pi-ai/utils/transcript";

import { spawnFaux, scriptFinish, type FauxResponseStep } from "./faux-harness.js";

function captureSystemPrompt(sink: { prompt: string }): FauxResponseStep {
  return ((context: any) => {
    sink.prompt = getCurrentSystemPrompt(context?.messages ?? []);
    return scriptFinish({ status: "complete", summary: "done" });
  }) as FauxResponseStep;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sourceFiles(p);
    return p.endsWith(".ts") ? [p] : [];
  });
}

describe("agent system prompt — host-registered extension", () => {
  it("an agent extension can replace the docs section of a flow agent's system prompt", async () => {
    const seen = { prompt: "" };
    const replaceDocs = (pi: any) => {
      pi.on("before_agent_start", (event: any) => {
        event.systemPromptOptions.sections ??= {};
        event.systemPromptOptions.sections.docs = "REPLACED_DOCS_SECTION";
      });
    };

    const { result } = await spawnFaux({
      modelApi: "anthropic-messages",
      extraAgentExtensions: [replaceDocs],
      responses: [captureSystemPrompt(seen)],
    });

    expect(result.success).toBe(true);
    expect(seen.prompt).toContain("REPLACED_DOCS_SECTION");
    expect(seen.prompt).not.toContain("pi itself");
    expect(seen.prompt).not.toContain("pi packages");
  });

  it("pi-flows ships no anthropic-messages bridge of its own", () => {
    const offenders = sourceFiles(join(__dirname, "..", "extensions")).filter((f) =>
      /pi-anthropic-messages|@pi\/anthropic-messages/.test(readFileSync(f, "utf8")),
    );
    expect(offenders).toEqual([]);
  });
});
