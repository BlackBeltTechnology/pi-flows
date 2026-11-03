/**
 * End-to-end faux failure scenarios (part 1): how an agent's end state becomes
 * a step outcome, how that outcome routes (on_error / halt), and what the
 * downstream `${{result.<id>.status}}` / `.summary` templates see.
 *
 * Written from the documented behaviour (docs/flows.md → Failure Modes, "How
 * agent failures are classified", "Capped no-finish reminder"; docs/agents.md
 * → "Outputs are required by default"; docs/flows.md → Agent Decision Step,
 * Decider chain). Flows are authored as YAML + markdown agents, validated, then
 * run on the real runFlow with the scripted faux provider. Responders route on
 * the dispatched task text, never on call order.
 */
import { describe, expect, it } from "vitest";
import { runFaux, scriptError, scriptFinish, scriptSlowText } from "./faux-harness.js";
import { parseFlowYamlString } from "../extensions/flow-engine/flow-parser-yaml.js";
import { parseAgentString } from "../extensions/flow-engine/agent-parser.js";
import { validateFlowContent } from "../extensions/flow-engine/tools/flow-validate.js";
import { validateAgentContent } from "../extensions/flow-engine/tools/agent-validate.js";
import type { AgentConfig, AgentResult } from "../extensions/flow-engine/types.js";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";

// ── authored agents ─────────────────────────────────────────────────────────

const agentMd = (name: string, outputs: string[] = []) =>
  `---\nname: ${name}\ndescription: ${name} agent\nmodel: faux/faux-1\ntools: read\n` +
  (outputs.length ? `outputs:\n${outputs.map((o) => `  - name: ${o}\n`).join("")}` : "") +
  `---\n\nYou are ${name}.\n`;

const AGENT_MDS = {
  worker: agentMd("worker"),
  rescuer: agentMd("rescuer"),
  reporter: agentMd("reporter"),
  extractor: agentMd("extractor", ["invoice_id"]),
  judge: agentMd("judge"),
};
const AGENTS: AgentConfig[] = Object.values(AGENT_MDS).map((m) => parseAgentString(m, "<e2e-failures>"));
const agentMap = () => new Map(AGENTS.map((a) => [a.name, a]));

function validated(yaml: string) {
  const diag = validateFlowContent(yaml, agentMap);
  expect(diag.diagnostics.filter((d) => d.severity === "error"), yaml).toEqual([]);
  return parseFlowYamlString(yaml, "<e2e-failures>");
}

const ok = (summary: string, extra: Record<string, unknown> = {}) =>
  scriptFinish({ status: "complete", summary, ...extra });
const textOnly = (t: string) => scriptSlowText(t);

/** Records step starts in order and each step's last AgentResult. */
function tracker() {
  const starts: string[] = [];
  const done: Record<string, AgentResult> = {};
  return {
    starts,
    done,
    onAgentComplete: (_a: string, step: string, r: AgentResult) => { done[step] = r; },
    count: (id: string) => starts.filter((s) => s === id).length,
    ran: (id: string) => starts.includes(id),
    onAgentStarted: (_a: string, step: string) => { starts.push(step); },
  };
}

const REMINDER = /You did not call the `finish` tool/;

// ── shared flows ────────────────────────────────────────────────────────────

/** build (may fail) → publish ; build on_error → rescue (reads build's status/summary). */
const RESCUE_FLOW = `name: rescue-flow
description: build may fail; rescue reads its status and summary
steps:
  - id: build
    type: agent
    agent: worker
    task: "BUILD \${{task}}"
    on_error: rescue
  - id: publish
    type: agent
    agent: reporter
    blockedBy: [build]
    task: "PUBLISH status=\${{result.build.status}} summary=\${{result.build.summary}}"
  - id: rescue
    type: agent
    agent: rescuer
    blockedBy: [build]
    task: "RESCUE status=\${{result.build.status}} summary=\${{result.build.summary}}"
`;

/** Same shape without on_error: a soft failure must halt the flow. */
const HALT_FLOW = `name: halt-flow
description: build may fail; nothing handles it
steps:
  - id: build
    type: agent
    agent: worker
    task: "BUILD \${{task}}"
  - id: publish
    type: agent
    agent: reporter
    blockedBy: [build]
    task: "PUBLISH status=\${{result.build.status}}"
  - id: announce
    type: agent
    agent: reporter
    blockedBy: [publish]
    task: "ANNOUNCE"
`;

/** Echo responder for the downstream steps: summary carries the task text. */
function downstream(t: string) {
  if (/RESCUE/.test(t)) return ok(`rescued <${t}>`);
  if (/PUBLISH/.test(t)) return ok(`published <${t}>`);
  if (/ANNOUNCE/.test(t)) return ok("announced");
  return undefined;
}

async function runRescue(build: (t: string) => any, yaml = RESCUE_FLOW, extra: { maxTurns?: number } = {}) {
  const t = tracker();
  const result = await runFaux({
    flow: validated(yaml),
    agents: AGENTS,
    maxTurns: extra.maxTurns ?? 24,
    responder: (task) => downstream(task) ?? build(task),
    onAgentStarted: t.onAgentStarted,
    onAgentComplete: t.onAgentComplete,
  });
  return { result, t };
}

// ────────────────────────────────────────────────────────────────────────────

describe("e2e faux failures: authored files validate", () => {
  it("every agent markdown validates without errors", () => {
    for (const md of Object.values(AGENT_MDS)) {
      expect(validateAgentContent(md).diagnostics.filter((d) => d.severity === "error"), md).toEqual([]);
    }
  });
});

describe("e2e faux failures: finish status → step outcome", () => {
  it("status complete → success; the successor sees status=complete and the summary", async () => {
    const { result, t } = await runRescue(() => ok("built v1.2"));
    expect(result.status).toBe("success");
    expect(result.results.build).toMatchObject({ status: "complete", summary: "built v1.2" });
    expect(result.results.publish.summary).toContain("status=complete summary=built v1.2");
    // Gotcha pinned: an on_error target is not reserved for failures. `rescue` is an
    // ordinary blockedBy dependent in the same DAG segment, so on success it runs too
    // (success "falls through"); on_error only narrows the active set on failure.
    expect(t.ran("rescue")).toBe(true);
    expect(result.results.rescue.summary).toContain("status=complete");
  });

  it("status error with on_error → soft: rescue runs and sees status=error + the agent's summary; publish is skipped", async () => {
    const { result, t } = await runRescue(() => scriptFinish({ status: "error", summary: "linker exploded" }));
    expect(result.status).toBe("success");
    expect(result.results.build.status).toBe("error");
    expect(result.results.rescue.summary).toContain("status=error summary=linker exploded");
    expect(t.ran("publish")).toBe(false);
    expect(result.results.publish.status).toBe("skipped");
  });

  it("status blocked with on_error → soft: rescue sees status=blocked (not rewritten to error)", async () => {
    const { result, t } = await runRescue(() => scriptFinish({ status: "blocked", summary: "waiting on credentials" }));
    expect(result.status).toBe("success");
    expect(result.results.build.status).toBe("blocked");
    expect(result.results.rescue.summary).toContain("status=blocked summary=waiting on credentials");
    expect(t.ran("publish")).toBe(false);
  });

  it("status error without on_error → the flow halts with status error; no later step starts", async () => {
    const { result, t } = await runRescue(() => scriptFinish({ status: "error", summary: "tests red" }), HALT_FLOW);
    expect(result.status).toBe("error");
    expect(result.results.build.status).toBe("error");
    expect(t.starts).toEqual(["build"]);
    expect(result.results.publish?.status ?? "skipped").not.toBe("complete");
    expect(result.results.announce?.status ?? "skipped").not.toBe("complete");
  });

  it("status blocked without on_error → also halts the flow (blocked is a soft failure, not a success)", async () => {
    const { result, t } = await runRescue(() => scriptFinish({ status: "blocked", summary: "need input" }), HALT_FLOW);
    expect(result.status).toBe("error");
    expect(result.results.build.status).toBe("blocked");
    expect(t.starts).toEqual(["build"]);
  });

  it("status \"partial\" is not a valid finish status: rejected up to the cap (3 calls), then soft failure → rescue", async () => {
    let buildCalls = 0;
    const { result, t } = await runRescue((task) => {
      if (/BUILD/.test(task)) buildCalls++;
      return scriptFinish({ status: "partial" as any, summary: "half done" });
    });
    expect(buildCalls).toBe(3);
    expect(result.status).toBe("success");
    expect(result.results.build.status).not.toBe("complete");
    expect(t.ran("rescue")).toBe(true);
    expect(t.ran("publish")).toBe(false);
  });

  it("a rejected finish followed by a valid one recovers: the step succeeds (first correct finish wins)", async () => {
    let buildCalls = 0;
    const { result, t } = await runRescue((task) => {
      if (/BUILD/.test(task)) buildCalls++;
      return buildCalls === 1
        ? scriptFinish({ status: "partial" as any, summary: "half" })
        : ok("fully built");
    });
    expect(buildCalls).toBe(2);
    expect(result.status).toBe("success");
    expect(result.results.build).toMatchObject({ status: "complete", summary: "fully built" });
    expect(t.ran("publish")).toBe(true);
  });
});

describe("e2e faux failures: agent never calls finish", () => {
  it("gets at most 2 reminders (3 turns total), then soft-fails → on_error rescue runs", async () => {
    const seen: string[] = [];
    const { result, t } = await runRescue((task) => {
      seen.push(task);
      return textOnly("I think I am done, no finish though.");
    });
    // The initial task + 2 reminders; the reminders carry the finish call format.
    expect(seen).toHaveLength(3);
    expect(seen[0]).toMatch(/BUILD/);
    expect(seen.slice(1).every((s) => REMINDER.test(s))).toBe(true);
    expect(seen[1]).toMatch(/status: "complete", "error", or "blocked"/);

    expect(result.status).toBe("success");
    expect(t.ran("rescue")).toBe(true);
    expect(t.ran("publish")).toBe(false);
    expect(t.done.build.outcome).toBe("soft");
    expect(t.done.build.failureInfo?.source).toBe("agent_no_finish");
    expect(result.results.build.status).not.toBe("complete");
  });

  // ENGINE BUG: a no-finish soft failure stores status "unknown" (parsed from free text), so
  // downstream ${{result.build.status}} reads "unknown"; docs say never status:"unknown" and
  // that status is one of complete/error/blocked.
  it.fails("the no-finish soft failure is never status \"unknown\" downstream", async () => {
    const { result } = await runRescue(() => textOnly("no finish here"));
    expect(result.results.build.status).not.toBe("unknown");
    expect(result.results.rescue.summary).not.toContain("status=unknown");
  });

  it("finishing on the 2nd reminder counts: the step succeeds", async () => {
    let n = 0;
    const { result, t } = await runRescue((task) => {
      if (/BUILD/.test(task) || REMINDER.test(task)) n++;
      return n < 3 ? textOnly("still thinking") : ok("finished after nudges");
    });
    expect(n).toBe(3);
    expect(result.status).toBe("success");
    expect(result.results.build.summary).toBe("finished after nudges");
    expect(t.ran("publish")).toBe(true);
  });

  it("without on_error, a never-finishing agent halts the flow (no infinite loop)", async () => {
    let calls = 0;
    const { result, t } = await runRescue((task) => {
      if (/BUILD/.test(task) || REMINDER.test(task)) calls++;
      return textOnly("chatting");
    }, HALT_FLOW);
    expect(calls).toBe(3);
    expect(result.status).toBe("error");
    expect(t.starts).toEqual(["build"]);
  });
});

describe("e2e faux failures: missing required declared output", () => {
  const FLOW = `name: extract-flow
description: extractor must return invoice_id
steps:
  - id: extract
    type: agent
    agent: extractor
    task: "EXTRACT the invoice"
    on_error: rescue
  - id: book
    type: agent
    agent: reporter
    blockedBy: [extract]
    task: "BOOK \${{result.extract.invoice_id}}"
  - id: rescue
    type: agent
    agent: rescuer
    blockedBy: [extract]
    task: "RESCUE status=\${{result.extract.status}} summary=\${{result.extract.summary}}"
`;

  it("rejected 3 times, then a soft failure whose message names the missing output", async () => {
    let calls = 0;
    const t = tracker();
    const result = await runFaux({
      flow: validated(FLOW),
      agents: AGENTS,
      onAgentStarted: t.onAgentStarted,
      onAgentComplete: t.onAgentComplete,
      responder: (task) => {
        if (/RESCUE/.test(task)) return ok(`rescued <${task}>`);
        if (/BOOK/.test(task)) return ok("booked");
        calls++;
        return scriptFinish({ status: "complete", summary: "extracted, forgot the id" });
      },
    });
    expect(calls).toBe(3);
    expect(result.status).toBe("success");
    expect(result.results.extract.status).not.toBe("complete");
    expect(t.ran("book")).toBe(false);
    expect(t.ran("rescue")).toBe(true);
    // The failure is explained in terms of the declared output.
    expect(t.done.extract.outcome).toBe("soft");
    expect(t.done.extract.failureInfo?.source).toBe("agent_finish_invalid");
    expect(t.done.extract.failureInfo?.message).toMatch(/rejected 3 time.*invoice_id/);
  });

  it("supplying the output on the retry succeeds and the value flows downstream", async () => {
    let calls = 0;
    const result = await runFaux({
      flow: validated(FLOW),
      agents: AGENTS,
      responder: (task) => {
        if (/BOOK/.test(task)) return ok(`booked <${task}>`);
        if (/RESCUE/.test(task)) return ok("rescued");
        return ++calls === 1
          ? scriptFinish({ status: "complete", summary: "forgot" })
          : scriptFinish({ status: "complete", summary: "extracted", invoice_id: "INV-77" });
      },
    });
    expect(calls).toBe(2);
    expect(result.status).toBe("success");
    expect(result.results.extract.outputs.invoice_id).toBe("INV-77");
    expect(result.results.book.summary).toContain("BOOK INV-77");
  });

  // ENGINE BUG: declared outputs are required even on finish(status:"error"), so an agent that
  // reports a logical failure is rejected 3x and its error summary is lost (status/summary
  // downstream read "unknown"/""), contradicting flows.md "finish(status:error) → soft".
  it.fails("an error finish does not need the declared outputs: one call, the error summary reaches on_error", async () => {
    let calls = 0;
    const result = await runFaux({
      flow: validated(FLOW),
      agents: AGENTS,
      responder: (task) => {
        if (/RESCUE/.test(task)) return ok(`rescued <${task}>`);
        if (/BOOK/.test(task)) return ok("booked");
        calls++;
        return scriptFinish({ status: "error", summary: "pdf unreadable" });
      },
    });
    expect(calls).toBe(1);
    expect(result.results.extract.status).toBe("error");
    expect(result.results.rescue.summary).toContain("status=error summary=pdf unreadable");
  });
});

describe("e2e faux failures: agent-decision with an invalid branch", () => {
  const FLOW = (onError: boolean) => `name: gate-flow
description: decision agent routes ship/hold
steps:
  - id: review
    type: agent
    agent: worker
    task: "REVIEW the change"
  - id: gate
    type: agent-decision
    agent: judge
    blockedBy: [review]
    task: "GATE: ship or hold?"
    branches:
      ship: deploy
      hold: park
${onError ? "    on_error: triage\n" : ""}  - id: deploy
    type: agent
    agent: reporter
    task: "DEPLOY"
  - id: park
    type: agent
    agent: reporter
    task: "PARK"
${onError ? `  - id: triage
    type: agent
    agent: rescuer
    task: "TRIAGE gate=\${{result.gate.status}} summary=\${{result.gate.summary}}"
` : ""}`;

  const base = (task: string) => {
    if (/REVIEW/.test(task)) return ok("reviewed");
    if (/DEPLOY/.test(task)) return ok("deployed");
    if (/PARK/.test(task)) return ok("parked");
    if (/TRIAGE/.test(task)) return ok(`triaged <${task}>`);
    return undefined;
  };

  it("an unknown branch is rejected and retried (3 attempts), then the step soft-fails naming the branch → on_error", async () => {
    let gateCalls = 0;
    const t = tracker();
    const result = await runFaux({
      flow: validated(FLOW(true)),
      agents: AGENTS,
      onAgentStarted: t.onAgentStarted,
      responder: (task) => base(task) ?? (gateCalls++, scriptFinish({ status: "complete", summary: "yolo", branch: "launch" })),
    });
    expect(gateCalls).toBe(3);
    expect(t.ran("deploy")).toBe(false);
    expect(t.ran("park")).toBe(false);
    expect(t.ran("triage")).toBe(true);
    expect(result.status).toBe("success");
    expect(result.results.gate.status).not.toBe("complete");
    expect(result.results.triage.summary).toMatch(/launch/);
  });

  it("without on_error an unknown branch halts the flow and no branch target runs", async () => {
    const t = tracker();
    const result = await runFaux({
      flow: validated(FLOW(false)),
      agents: AGENTS,
      onAgentStarted: t.onAgentStarted,
      responder: (task) => base(task) ?? scriptFinish({ status: "complete", summary: "?", branch: "launch" }),
    });
    expect(result.status).toBe("error");
    expect(t.ran("deploy")).toBe(false);
    expect(t.ran("park")).toBe(false);
  });

  it("a missing branch, corrected on the retry, routes normally", async () => {
    let gateCalls = 0;
    const t = tracker();
    const result = await runFaux({
      flow: validated(FLOW(true)),
      agents: AGENTS,
      onAgentStarted: t.onAgentStarted,
      responder: (task) => base(task) ?? (++gateCalls === 1
        ? scriptFinish({ status: "complete", summary: "forgot branch" })
        : scriptFinish({ status: "complete", summary: "hold it", branch: "hold" })),
    });
    expect(gateCalls).toBe(2);
    expect(result.status).toBe("success");
    expect(t.ran("park")).toBe(true);
    expect(t.ran("deploy")).toBe(false);
    expect(t.ran("triage")).toBe(false);
  });
});

describe("e2e faux failures: provider API errors are hard", () => {
  const API_ERR = "401 invalid x-api-key";
  /** A dead provider errors on every turn, including the engine's finish reminders. */
  const dead = (task: string) => /BUILD/.test(task) || REMINDER.test(task);

  it("a terminal API error is hard: the flow halts even though on_error is declared; rescue never runs", async () => {
    const { result, t } = await runRescue((task) => (dead(task) ? scriptError(API_ERR) : ok("x")));
    expect(result.status).toBe("error");
    expect(t.ran("rescue")).toBe(false);
    expect(t.ran("publish")).toBe(false);
    expect(result.lastResult.result.summary).toContain("invalid x-api-key");
  });

  it("an upstream success is preserved when a later step hits an API error", async () => {
    const yaml = `name: two-stage
description: prep ok, build hits provider error
steps:
  - id: prep
    type: agent
    agent: worker
    task: "PREP"
  - id: build
    type: agent
    agent: worker
    blockedBy: [prep]
    task: "BUILD"
    on_error: rescue
  - id: rescue
    type: agent
    agent: rescuer
    blockedBy: [build]
    task: "RESCUE"
`;
    const t = tracker();
    const result = await runFaux({
      flow: validated(yaml),
      agents: AGENTS,
      onAgentStarted: t.onAgentStarted,
      responder: (task) => (dead(task) ? scriptError(API_ERR) : ok(`done ${task}`)),
    });
    expect(result.status).toBe("error");
    expect(result.results.prep.status).toBe("complete");
    expect(t.starts).toEqual(["prep", "build"]);
  });

  it("an API error after the agent already made a tool call is still hard (no finish → hard)", async () => {
    let buildTurns = 0;
    const t = tracker();
    const result = await runFaux({
      flow: validated(RESCUE_FLOW),
      agents: AGENTS,
      onAgentStarted: t.onAgentStarted,
      responder: (task) => {
        const d = downstream(task);
        if (d) return d;
        buildTurns++;
        return buildTurns === 1
          ? fauxAssistantMessage([fauxToolCall("read", { path: "package.json" })])
          : scriptError(API_ERR);
      },
    });
    expect(result.status).toBe("error");
    expect(t.ran("rescue")).toBe(false);
  });
});
