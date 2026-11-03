/**
 * End-to-end faux scenarios for: reserved output names, typed-output wiring,
 * fresh definitions per run, and validation of authored flow files.
 *
 * Flows/agents are authored as YAML/markdown strings, validated, parsed, then
 * run on the real runFlow with the faux provider.
 *
 * NOTE: sequential agent steps need `blockedBy` — steps without it run in
 * parallel inside one DAG segment.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getCurrentSystemPrompt } from "@earendil-works/pi-ai/utils/transcript";
import {
  runFaux, runFauxFlow, scriptFinish, lastUserText, registerFauxOnRuntime, makeFauxRegistry,
} from "./faux-harness.js";
import { parseFlowYamlString } from "../extensions/flow-engine/flow-parser-yaml.js";
import { parseAgentString } from "../extensions/flow-engine/agent-parser.js";
import { validateFlowContent } from "../extensions/flow-engine/tools/flow-validate.js";
import { validateAgentContent } from "../extensions/flow-engine/tools/agent-validate.js";
import { discoverAll } from "../extensions/flow-engine/discovery.js";
import { runFlow } from "../extensions/flow-engine/flow-execution.js";
import type { AgentConfig } from "../extensions/flow-engine/types.js";

const agentMd = (name: string, outputs: string[] = [], extraFm = "", body = `You are ${name}.`) =>
  `---\nname: ${name}\ndescription: ${name} agent\nmodel: faux/faux-1\ntools: read\n${extraFm}${
    outputs.length ? `outputs:\n${outputs.map((o) => `  - name: ${o}\n`).join("")}` : ""
  }---\n\n${body}\n`;

const catalog = (mds: string[]) => {
  const agents = mds.map((m) => parseAgentString(m, "<e2e>"));
  return { agents, byName: new Map(agents.map((a) => [a.name, a])) };
};

const errorsOf = (r: { diagnostics: Array<{ severity: string }> }) => r.diagnostics.filter((d) => d.severity === "error") as Array<{ message: string; suggestion?: string; severity: string }>;

/** Counts spawned LLM turns and answers every worker with a plain complete finish. */
function countingResponder(extra?: (t: string) => ReturnType<typeof scriptFinish> | undefined) {
  const turns: string[] = [];
  return {
    turns,
    responder: (t: string) => {
      turns.push(t);
      return extra?.(t) ?? scriptFinish({ status: "complete", summary: `done: ${t}` });
    },
  };
}

// ── 1. Reserved output names ──────────────────────────────────────────────

const ONE_AGENT_FLOW = `name: one
description: a single agent step
steps:
  - id: apply
    type: agent
    agent: applier
    task: "APPLY the change"
  - id: report
    type: agent
    agent: reporter
    task: "REPORT"
    blockedBy: [apply]
`;

describe("e2e faux: reserved output names refuse the flow before any agent runs", () => {
  for (const reserved of ["status", "summary", "files", "artifacts"]) {
    it(`step agent declaring \`${reserved}\`: authoring validator errors, flow start is refused with 0 spawns naming agent, field and \`outcome\``, async () => {
      const applier = agentMd("applier", [reserved, "outcome"]);
      const { agents } = catalog([applier, agentMd("reporter")]);
      // the authoring validator already rejects it …
      const diag = errorsOf(validateAgentContent(applier));
      expect(diag.some((d) => d.message.includes(`"${reserved}"`) && /reserved/i.test(d.message))).toBe(true);
      // … and the runtime refuses a hand-edited copy that skipped it
      const { turns, responder } = countingResponder();
      const flow = parseFlowYamlString(ONE_AGENT_FLOW, "<e2e>");
      const result = await runFaux({ flow, agents, responder });

      expect(result.status).toBe("error");
      expect(turns).toEqual([]);
      expect(result.results).toEqual({});
      const msg = result.lastResult.result.summary;
      expect(msg).toContain("applier");
      expect(msg).toContain(`"${reserved}"`);
      expect(msg).toContain("outcome");
      // only the offending agent is named
      expect(msg).not.toContain("reporter");
    });
  }

  it("`branch` on a flow-level decision_agent is refused (and the message names it)", async () => {
    const yaml = `name: judged
description: decision agent declares branch
decision_agent: judge
steps:
  - id: work
    type: agent
    agent: worker
    task: "WORK"
  - id: gate
    type: agent-decision
    task: "DECIDE"
    branches:
      yes: ship
      no: stop
  - id: ship
    type: agent
    agent: worker
    task: "SHIP"
  - id: stop
    type: agent
    agent: worker
    task: "STOP"
`;
    const { agents, byName } = catalog([agentMd("worker"), agentMd("judge", ["branch"])]);
    // the authoring-time flow validator (with a catalog) already flags it …
    const flowErrs = errorsOf(validateFlowContent(yaml, () => byName, () => true));
    expect(flowErrs).toHaveLength(1);
    expect(flowErrs[0].message).toMatch(/judge.*branch.*reserved/i);
    // … and the runtime refuses it for flows that never went through the validator
    const { turns, responder } = countingResponder();
    const result = await runFaux({ flow: parseFlowYamlString(yaml, "<e2e>"), agents, responder });
    expect(result.status).toBe("error");
    expect(turns).toEqual([]);
    const msg = result.lastResult.result.summary;
    expect(msg).toContain("judge");
    expect(msg).toContain(`"branch"`);
    expect(msg).toContain("outcome");
  });

  it("`branch` on a fork's agent is refused", async () => {
    const yaml = `name: forked
description: fork agent declares branch
steps:
  - id: choose
    type: fork
    question: "Which?"
    options: [a, b]
    branches:
      a: pick-a
      b: pick-b
    agent: router
  - id: pick-a
    type: agent
    agent: worker
    task: "A"
  - id: pick-b
    type: agent
    agent: worker
    task: "B"
`;
    const { agents } = catalog([agentMd("worker"), agentMd("router", ["branch"])]);
    const { turns, responder } = countingResponder();
    const result = await runFaux({
      flow: parseFlowYamlString(yaml, "<e2e>"), agents, responder,
      isAutonomous: () => true,
    });
    expect(result.status).toBe("error");
    expect(turns).toEqual([]);
    expect(result.lastResult.result.summary).toMatch(/router.*"branch"/);
  });

  it("an agent that is a plain step in one place and a decision agent in another is refused for `branch`", async () => {
    const yaml = `name: dual
description: same agent used plain and as step-level decision agent
steps:
  - id: classify
    type: agent
    agent: dual
    task: "CLASSIFY"
  - id: gate
    type: agent-decision
    agent: dual
    task: "DECIDE"
    branches:
      yes: ship
      no: stop
  - id: ship
    type: agent
    agent: dual
    task: "SHIP"
  - id: stop
    type: agent
    agent: dual
    task: "STOP"
`;
    const { agents } = catalog([agentMd("dual", ["branch"])]);
    const { turns, responder } = countingResponder();
    const result = await runFaux({ flow: parseFlowYamlString(yaml, "<e2e>"), agents, responder });
    expect(result.status).toBe("error");
    expect(turns).toEqual([]);
    expect(result.lastResult.result.summary).toMatch(/dual.*"branch"/);
  });

  it("`branch` on a plain agent is a normal output and is delivered to a later step via ${{result.<id>.branch}}", async () => {
    const yaml = `name: plain-branch
description: branch is just an output on a plain agent
steps:
  - id: classify
    type: agent
    agent: classifier
    task: "CLASSIFY \${{task}}"
  - id: report
    type: agent
    agent: reporter
    task: "REPORT the class: \${{result.classify.branch}}"
    blockedBy: [classify]
`;
    const classifier = agentMd("classifier", ["branch"]);
    const { agents, byName } = catalog([classifier, agentMd("reporter")]);
    expect(errorsOf(validateAgentContent(classifier))).toEqual([]);
    expect(errorsOf(validateFlowContent(yaml, () => byName, () => true))).toEqual([]);

    const { turns, responder } = countingResponder((t) =>
      /CLASSIFY/.test(t) ? scriptFinish({ status: "complete", summary: "classified", branch: "feature-request" }) : undefined);
    const result = await runFaux({ flow: parseFlowYamlString(yaml, "<e2e>"), agents, responder });

    expect(result.status).toBe("success");
    expect(result.results.classify.outputs.branch).toBe("feature-request");
    expect(turns).toHaveLength(2);
    expect(turns[1]).toBe("Task: REPORT the class: feature-request");
    expect(result.results.report.summary).toContain("feature-request");
  });
});

// ── 2. Typed outputs wiring ───────────────────────────────────────────────

describe("e2e faux: typed outputs flow into agent tasks and code steps", () => {
  const WIRING = `name: typed-wiring
description: outcome/handoff outputs reach an agent task and a code step
steps:
  - id: produce
    type: agent
    agent: producer
    task: "PRODUCE for \${{task}}"
  - id: consume
    type: agent
    agent: consumer
    task: "CONSUME outcome=\${{result.produce.outcome}} handoff=\${{result.produce.handoff}} attempts=\${{result.produce.attempts}}"
    blockedBy: [produce]
  - id: archive
    type: code
    blockedBy: [produce]
    inputs:
      outcome: "\${{result.produce.outcome}}"
      handoff: "\${{result.produce.handoff}}"
      attempts: "\${{result.produce.attempts}}"
    outputs:
      - name: digest
      - name: attempts_type
  - id: finalize
    type: agent
    agent: consumer
    task: "FINALIZE digest=\${{result.archive.digest}} kind=\${{result.archive.attempts_type}}"
    blockedBy: [archive]
`;
  const PRODUCER = `---
name: producer
description: produces typed outputs
model: faux/faux-1
tools: read
outputs:
  - name: outcome
  - name: handoff
  - name: attempts
    type: number
---

You are producer.
`;
  const ARCHIVE_HANDLER = `
export default async function handler(input) {
  return {
    digest: input.outcome + "|" + String(input.handoff).toUpperCase() + "|" + (input.attempts + 1),
    attempts_type: typeof input.attempts,
  };
}
`;

  it("agent `outcome`/`handoff` outputs reach a later agent's task, and typed values reach a code step input", async () => {
    const { agents, byName } = catalog([PRODUCER, agentMd("consumer")]);
    expect(errorsOf(validateFlowContent(WIRING, () => byName, () => true))).toEqual([]);
    const flow = parseFlowYamlString(WIRING, "<e2e>");

    const tasks: Record<string, string> = {};
    const completed: string[] = [];
    const result = await runFauxFlow({
      flow, agents,
      codeHandlers: { archive: ARCHIVE_HANDLER },
      responder: (t) => {
        if (/PRODUCE/.test(t)) {
          return scriptFinish({ status: "complete", summary: "produced", outcome: "shipped", handoff: "see ticket 42", attempts: "3" });
        }
        const marker = /(CONSUME|FINALIZE)/.exec(t)?.[1] ?? "?";
        tasks[marker] = t;
        return scriptFinish({ status: "complete", summary: `${marker} ok` });
      },
      onAgentComplete: (_a, step) => completed.push(step),
    });

    expect(result.status).toBe("success");
    // Typed outputs are stored under `outputs` with real types (number stays a number).
    expect(result.results.produce.outputs).toEqual({ outcome: "shipped", handoff: "see ticket 42", attempts: 3 });
    // Agent task text carries the outputs (serialized at the text boundary).
    expect(tasks.CONSUME).toBe("Task: CONSUME outcome=shipped handoff=see ticket 42 attempts=3");
    // Code step got the same values; the whole-value number arrived as a number.
    expect(result.results.archive.outputs.digest).toBe("shipped|SEE TICKET 42|4");
    expect(result.results.archive.outputs.attempts_type).toBe("number");
    // … and the code step's outputs flow on into a later agent task.
    expect(tasks.FINALIZE).toBe("Task: FINALIZE digest=shipped|SEE TICKET 42|4 kind=number");
    // Ordering: the producer ran first, finalize last.
    expect(completed[0]).toBe("produce");
    expect(completed[completed.length - 1]).toBe("finalize");
  });

  it("a code-step handler failure without on_error halts the flow; later agents never run", async () => {
    const { agents } = catalog([PRODUCER, agentMd("consumer")]);
    const flow = parseFlowYamlString(WIRING, "<e2e>");
    const started: string[] = [];
    const result = await runFauxFlow({
      flow, agents,
      codeHandlers: { archive: `export default async function () { throw new Error("archive exploded"); }` },
      responder: (t) => /PRODUCE/.test(t)
        ? scriptFinish({ status: "complete", summary: "p", outcome: "shipped", handoff: "h", attempts: "1" })
        : scriptFinish({ status: "complete", summary: "ok" }),
      onAgentStarted: (_n, step) => started.push(step),
    });
    expect(result.status).toBe("error");
    expect(result.lastResult.result.summary).toContain("archive exploded");
    expect(started).not.toContain("finalize");
  });

  it("a finish that omits a declared output is rejected and corrected on retry; the corrected value is what flows downstream", async () => {
    const { agents } = catalog([PRODUCER, agentMd("consumer")]);
    const flow = parseFlowYamlString(WIRING, "<e2e>");
    let produceTurns = 0;
    const tasks: string[] = [];
    const result = await runFauxFlow({
      flow, agents,
      codeHandlers: { archive: ARCHIVE_HANDLER },
      responder: (t) => {
        if (/PRODUCE/.test(t)) {
          produceTurns++;
          // 1st finish lacks `handoff` (required output) → schema-rejected → agent retries
          return produceTurns === 1
            ? scriptFinish({ status: "complete", summary: "p", outcome: "shipped", attempts: "2" })
            : scriptFinish({ status: "complete", summary: "p", outcome: "shipped", handoff: "fixed", attempts: "2" });
        }
        tasks.push(t);
        return scriptFinish({ status: "complete", summary: "ok" });
      },
    });
    expect(produceTurns).toBeGreaterThanOrEqual(2);
    expect(result.status).toBe("success");
    expect(result.results.produce.outputs.handoff).toBe("fixed");
    expect(tasks.find((t) => t.includes("CONSUME"))).toContain("handoff=fixed");
  });
});

// ── 3. Fresh definitions per run (discovery level) ────────────────────────

describe("e2e faux: fresh definitions per run (edit on disk → rediscover → next run uses it)", () => {
  /** A temp project with .pi/flows/{agents,flows}. */
  function project() {
    const root = mkdtempSync(join(tmpdir(), "e2e-fresh-"));
    const pkg = mkdtempSync(join(tmpdir(), "e2e-fresh-pkg-"));
    const agentsDir = join(root, ".pi", "flows", "agents");
    const flowDir = join(root, ".pi", "flows", "flows", "demo", "ship");
    mkdirSync(agentsDir, { recursive: true });
    mkdirSync(flowDir, { recursive: true });
    return {
      root, pkg,
      writeAgent: (name: string, md: string) => writeFileSync(join(agentsDir, `${name}.md`), md),
      writeFlow: (yaml: string) => writeFileSync(join(flowDir, "flow.yaml"), yaml),
      discover: () => discoverAll(pkg, root),
    };
  }

  const flowYaml = (task: string) =>
    `name: ignored-the-dir-names-the-flow\ndescription: ship it\nsteps:\n  - id: work\n    type: agent\n    agent: worker\n    task: "${task} \${{task}}"\n`;

  /** Run the discovered flow; record every request's system prompt + task. */
  async function runDiscovered(p: ReturnType<typeof project>) {
    const found = p.discover();
    const flow = found.flows.get("demo:ship");
    expect(flow, "flow discovered as demo:ship").toBeDefined();
    const seen: Array<{ system: string; user: string }> = [];
    const { faux, runtime } = await registerFauxOnRuntime({ api: "faux", provider: "faux", models: [{ id: "faux-1" }] });
    faux.setResponses(Array.from({ length: 8 }, () => ((ctx: any) => {
      seen.push({ system: getCurrentSystemPrompt(ctx?.messages ?? []), user: lastUserText(ctx) });
      // finish with `outcome` — only delivered when the agent declares that output
      return scriptFinish({ status: "complete", summary: "ok", outcome: "yes" });
    }) as any));
    const registry = makeFauxRegistry(faux);
    const pi: any = { events: { emit: () => undefined, on: () => undefined }, modelRegistry: registry };
    try {
      const result = await runFlow({
        flow: flow!, task: "go", cwd: p.root, modelRegistry: registry, modelRuntime: runtime, pi,
        getAgent: (n: string) => found.agents.get(n) as AgentConfig | undefined,
        askUser: async () => ({ answer: "" }),
        parentModel: { model: faux.getModel("faux-1") as any },
      });
      return { result, seen };
    } finally {
      faux.unregister();
    }
  }

  it("a second run after editing the agent body, its outputs and the flow task sees all three changes", async () => {
    const p = project();
    p.writeAgent("worker", agentMd("worker", [], "", "BODY-ONE"));
    p.writeFlow(flowYaml("first-task"));

    const run1 = await runDiscovered(p);
    expect(run1.result.status).toBe("success");
    expect(run1.seen[0].system).toContain("BODY-ONE");
    expect(run1.seen[0].user).toContain("first-task");
    expect(run1.result.results.work.outputs).toEqual({}); // no declared outputs yet

    // edit on disk, rediscover (what flow:rediscover does before each run), run again
    p.writeAgent("worker", agentMd("worker", ["outcome"], "", "BODY-TWO"));
    p.writeFlow(flowYaml("second-task"));

    const run2 = await runDiscovered(p);
    expect(run2.result.status).toBe("success");
    expect(run2.seen[0].system).toContain("BODY-TWO");
    expect(run2.seen[0].system).not.toContain("BODY-ONE");
    expect(run2.seen[0].user).toContain("second-task");
    expect(run2.result.results.work.outputs).toEqual({ outcome: "yes" });
  });

  it("a stale discovery result keeps the old definition until rediscovered", async () => {
    const p = project();
    p.writeAgent("worker", agentMd("worker", [], "", "BODY-ONE"));
    p.writeFlow(flowYaml("first-task"));
    const stale = p.discover();

    p.writeAgent("worker", agentMd("worker", [], "", "BODY-TWO"));
    const fresh = p.discover();

    expect(stale.agents.get("worker")!.systemPrompt).toContain("BODY-ONE");
    expect(fresh.agents.get("worker")!.systemPrompt).toContain("BODY-TWO");
  });

  it("an edit that introduces a reserved output name is caught on the next run: discovery warns and the flow is refused", async () => {
    const p = project();
    p.writeAgent("worker", agentMd("worker", [], "", "BODY-ONE"));
    p.writeFlow(flowYaml("first-task"));
    expect((await runDiscovered(p)).result.status).toBe("success");
    expect(p.discover().warnings).toEqual([]);

    p.writeAgent("worker", agentMd("worker", ["status"], "", "BODY-ONE"));
    const found = p.discover();
    const warning = found.warnings.find((w) => w.includes("worker"));
    expect(warning, JSON.stringify(found.warnings)).toBeDefined();
    expect(warning).toContain("status");

    const run = await runDiscovered(p);
    expect(run.result.status).toBe("error");
    expect(run.seen).toEqual([]);
    expect(run.result.lastResult.result.summary).toMatch(/worker.*"status".*outcome/);
  });

  it("deleting the agent file makes the next run fail with a clear not-found error instead of reusing the old agent", async () => {
    const p = project();
    p.writeAgent("worker", agentMd("worker", [], "", "BODY-ONE"));
    p.writeFlow(flowYaml("first-task"));
    expect((await runDiscovered(p)).result.status).toBe("success");

    const { rmSync } = await import("node:fs");
    rmSync(join(p.root, ".pi", "flows", "agents", "worker.md"));
    const run = await runDiscovered(p);
    expect(run.result.status).toBe("error");
    expect(run.seen).toEqual([]);
    expect(run.result.lastResult.output).toContain("worker");
  });
});

// ── 4. Validation of authored flow files ──────────────────────────────────

describe("e2e faux: validation of authored flow files", () => {
  const agents = () => catalog([agentMd("worker"), agentMd("judge")]).byName;
  const validate = (yaml: string) => validateFlowContent(yaml, agents, () => true);
  const GOOD = `name: good
description: a clean flow
steps:
  - id: build
    type: agent
    agent: worker
    task: "BUILD"
    on_error: wrap
  - id: gate
    type: agent-decision
    agent: judge
    task: "DECIDE"
    branches:
      rework: build
      done: wrap
    max_iterations: 2
  - id: wrap
    type: agent
    agent: worker
    task: "WRAP"
`;

  it("control: the clean flow has no errors", () => {
    const r = validate(GOOD);
    expect(errorsOf(r)).toEqual([]);
    expect(r.valid).toBe(true);
  });

  it("an unknown on_error target is an error naming the target", () => {
    const r = validate(GOOD.replace("on_error: wrap", "on_error: recovery-step"));
    const errs = errorsOf(r);
    expect(r.valid).toBe(false);
    expect(errs.some((e) => e.message.includes("recovery-step"))).toBe(true);
  });

  it("an unknown on_error target is also caught on decision steps", () => {
    const r = validate(GOOD.replace("    max_iterations: 2\n", "    max_iterations: 2\n    on_error: nowhere\n"));
    expect(r.valid).toBe(false);
    expect(errorsOf(r).some((e) => e.message.includes("nowhere"))).toBe(true);
  });

  it("a fork branch pointing to a missing step is an error naming the step", () => {
    const yaml = `name: bad-fork
description: fork with a dangling branch
steps:
  - id: choose
    type: fork
    question: "Which?"
    options: [left, right]
    branches:
      left: left-step
      right: ghost-step
  - id: left-step
    type: agent
    agent: worker
    task: "LEFT"
`;
    const r = validate(yaml);
    expect(r.valid).toBe(false);
    const errs = errorsOf(r);
    expect(errs.some((e) => e.message.includes("ghost-step"))).toBe(true);
    expect(errs.some((e) => e.message.includes("left-step"))).toBe(false);
  });

  it("a backward edge without max_iterations is an error on the deciding node", () => {
    const r = validate(GOOD.replace("    max_iterations: 2\n", ""));
    expect(r.valid).toBe(false);
    expect(errorsOf(r).some((e) => /max_iterations/.test(e.message) && /gate/.test(e.message))).toBe(true);
  });

  it("a result reference to a step that is not ordered before it is reported, and the suggested blockedBy fixes it", () => {
    const yaml = `name: sloppy
description: two problems
steps:
  - id: a
    type: agent
    agent: worker
    task: "A"
  - id: b
    type: agent
    agent: worker
    task: "B uses \${{result.a.summary}}"
`;
    const r = validate(yaml);
    expect(r.valid).toBe(false);
    expect(errorsOf(r).some((e) => /ordered before/.test(e.message) && e.message.includes('"a"'))).toBe(true);
    // the fix the validator suggests actually makes it valid
    const fixed = validate(yaml.replace('task: "B uses', 'blockedBy: [a]\n    task: "B uses'));
    expect(errorsOf(fixed)).toEqual([]);
  });

  it("validation is a gate separate from the parser: a dangling on_error parses but does not validate", () => {
    const bad = GOOD.replace("on_error: wrap", "on_error: recovery-step");
    expect(() => parseFlowYamlString(bad, "<e2e>")).not.toThrow();
    expect(validate(bad).valid).toBe(false);
  });
});
