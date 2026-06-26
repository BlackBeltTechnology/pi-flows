/**
 * spawnAgent tool-dispatch tests via the faux provider (task 2.2).
 * Spec: faux-model-testing → "Authorized tool dispatch through guard",
 *                            "Unauthorized tool blocked by guard".
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeAll } from "vitest";

import { spawnFaux, scriptFinish, scriptToolThenFinish } from "./faux-harness.js";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";

let cwd: string;

beforeAll(() => {
  cwd = mkdtempSync(join(tmpdir(), "faux-tools-"));
  writeFileSync(join(cwd, "note.txt"), "hello faux\n", "utf8");
});

describe("faux spawnAgent — guard tool dispatch", () => {
  it("permits and records an authorized tool call, then finishes", async () => {
    const { result } = await spawnFaux({
      agent: { tools: ["read"] },
      cwd,
      responses: scriptToolThenFinish("read", { path: "note.txt" }, { status: "complete", summary: "read it" }),
    });

    expect(result.success).toBe(true);
    const read = result.toolCalls.find((t) => t.toolName === "read");
    expect(read).toBeDefined();
    expect(read!.isError).toBe(false);
    expect(read!.output).toContain("hello faux");
  });

  it("blocks an unauthorized tool not declared in agent.tools", async () => {
    const { result } = await spawnFaux({
      agent: { tools: [] }, // `read` NOT authorized
      cwd,
      responses: [
        fauxAssistantMessage([fauxToolCall("read", { path: "note.txt" })]),
        scriptFinish({ status: "complete", summary: "tried" }),
      ],
    });

    const read = result.toolCalls.find((t) => t.toolName === "read");
    expect(read).toBeDefined();
    expect(read!.isError).toBe(true); // guard rejected → tool not available
  });
});
