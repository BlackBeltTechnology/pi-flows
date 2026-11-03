/** flow:agent-started config carries the whole `model:` list, not just its first entry. */
import { describe, expect, it } from "vitest";
import { EventEmitObserver } from "../extensions/flow-engine/flow-tui.js";
import { parseAgentString } from "../extensions/flow-engine/agent-parser.js";

describe("flow:agent-started config.modelRefs", () => {
  const emitOf = (md: string) => {
    const emitted: any[] = [];
    const obs = new EventEmitObserver({ events: { emit: (ch: string, d: any) => ch === "flow:agent-started" && emitted.push(d) } } as any);
    obs.onAgentStarted("w", "s", parseAgentString(md, "<t>"), "proxy/glm/glm-5.3-flash");
    return emitted[0].config;
  };
  it("a list keeps every entry in order", () => {
    const cfg = emitOf("---\nname: w\ndescription: d\nmodel: \"[@no-such-role, proxy/glm/glm-5.3-flash]\"\n---\nx\n");
    expect(cfg.modelRefs).toEqual(["@no-such-role", "proxy/glm/glm-5.3-flash"]);
    expect(cfg.model).toBe("@no-such-role");
  });
  it("a single ref is a one-entry list", () => {
    expect(emitOf("---\nname: w\ndescription: d\nmodel: \"@fast\"\n---\nx\n").modelRefs).toEqual(["@fast"]);
  });
});
