/**
 * Tests for `parseAgentString` — covers the agent frontmatter contract from
 * spec `agent-node` (change: enhance-agent-node-contract): existing fields plus
 * `fork_session`, `context_files`, and typed/pattern outputs.
 */

import { describe, expect, it } from "vitest";
import { parseAgentString } from "../extensions/flow-engine/agent-parser.js";

const SRC = "test://agent.md";

function agent(frontmatter: string, body = "Body."): string {
  return `---\n${frontmatter}\n---\n${body}\n`;
}

describe("parseAgentString — required fields", () => {
  it("parses name/description/model and trims body", () => {
    const cfg = parseAgentString(
      agent("name: a\ndescription: d\nmodel: \"@coding\""),
      SRC,
    );
    expect(cfg.name).toBe("a");
    expect(cfg.description).toBe("d");
    expect(cfg.model).toBe("@coding");
    expect(cfg.systemPrompt).toBe("Body.");
    expect(cfg.source).toBe(SRC);
  });

  it("throws when a required field is missing", () => {
    expect(() => parseAgentString(agent("name: a\nmodel: x"), SRC)).toThrow(
      /missing required field "description"/,
    );
  });

  it("throws when frontmatter is absent", () => {
    expect(() => parseAgentString("no frontmatter here", SRC)).toThrow(
      /no YAML frontmatter/,
    );
  });
});

describe("parseAgentString — tools / skills / inputs", () => {
  it("splits CSV tools and skills, parses inputs array", () => {
    const cfg = parseAgentString(
      agent(
        [
          "name: a",
          "description: d",
          "model: x",
          "tools: read, write, bash",
          "skills: docs-a, docs-b",
          "inputs:",
          "  - prior",
          "  - task_desc",
        ].join("\n"),
      ),
      SRC,
    );
    expect(cfg.tools).toEqual(["read", "write", "bash"]);
    expect(cfg.skills).toEqual(["docs-a", "docs-b"]);
    expect(cfg.inputs).toEqual(["prior", "task_desc"]);
  });
});

describe("parseAgentString — fork_session", () => {
  it("absent → undefined", () => {
    const cfg = parseAgentString(agent("name: a\ndescription: d\nmodel: x"), SRC);
    expect(cfg.fork_session).toBeUndefined();
  });

  it("true / false parse to booleans", () => {
    const on = parseAgentString(agent("name: a\ndescription: d\nmodel: x\nfork_session: true"), SRC);
    const off = parseAgentString(agent("name: a\ndescription: d\nmodel: x\nfork_session: false"), SRC);
    expect(on.fork_session).toBe(true);
    expect(off.fork_session).toBe(false);
  });
});

describe("parseAgentString — context_files", () => {
  it("parses a YAML array of paths", () => {
    const cfg = parseAgentString(
      agent(
        [
          "name: a",
          "description: d",
          "model: x",
          "context_files:",
          "  - AGENTS.md",
          "  - docs/conventions.md",
        ].join("\n"),
      ),
      SRC,
    );
    expect(cfg.context_files).toEqual(["AGENTS.md", "docs/conventions.md"]);
  });

  it("absent → undefined", () => {
    const cfg = parseAgentString(agent("name: a\ndescription: d\nmodel: x"), SRC);
    expect(cfg.context_files).toBeUndefined();
  });
});

describe("parseAgentString — outputs (simple and expanded)", () => {
  it("simple (multiline) array form → bare names, no type/pattern", () => {
    const cfg = parseAgentString(
      agent("name: a\ndescription: d\nmodel: x\noutputs:\n  - findings\n  - verdict"),
      SRC,
    );
    expect(cfg.outputs).toEqual([{ name: "findings" }, { name: "verdict" }]);
  });

  it("expanded form parses description, type, and pattern", () => {
    const cfg = parseAgentString(
      agent(
        [
          "name: a",
          "description: d",
          "model: x",
          "outputs:",
          "  - name: file_path",
          "    description: Path to the generated file",
          "    pattern: \"^/.+\"",
          "  - name: count",
          "    type: number",
          "  - name: ok",
          "    type: boolean",
        ].join("\n"),
      ),
      SRC,
    );
    expect(cfg.outputs).toEqual([
      { name: "file_path", description: "Path to the generated file", pattern: "^/.+" },
      { name: "count", type: "number" },
      { name: "ok", type: "boolean" },
    ]);
  });

  it("ignores an unrecognised type value", () => {
    const cfg = parseAgentString(
      agent(
        ["name: a", "description: d", "model: x", "outputs:", "  - name: weird", "    type: blob"].join("\n"),
      ),
      SRC,
    );
    expect(cfg.outputs).toEqual([{ name: "weird" }]);
  });
});
