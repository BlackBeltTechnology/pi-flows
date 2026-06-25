// ---------------------------------------------------------------------------
// Flow Engine -- Code-node handler generation
//
// Generates the inert `<id>.ts.default` reference template for each
// convention-based code node in a flow, and detects signature drift against an
// existing real `<id>.ts` handler. The template is a copy-once reference: the
// author copies it, drops `.default`, and implements the body. Generation:
//   - ALWAYS rewrites `<id>.ts.default` (keeps it in sync with inputs/outputs)
//   - NEVER writes the real `<id>.ts`
//   - SKIPS code nodes that declare an explicit `target:` (author owns those)
//
// Drift detection is textual (TS types are erased; this runs statically): it
// compares the YAML-derived Input/Output key sets to the `interface Input` /
// `interface Output` blocks extracted from the real handler. A mismatch is a
// non-fatal warning; when the blocks are absent it is skipped silently and
// runtime shape validation is the backstop. See openspec/changes/add-code-node.
// ---------------------------------------------------------------------------

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CodeStep, CodeDecisionStep, FlowConfig, Diagnostic } from "./types.js";

export interface GenerateResult {
  /** Absolute paths of the `.ts.default` templates written. */
  generated: string[];
  /** Non-fatal drift warnings against existing real handlers. */
  diagnostics: Diagnostic[];
}

/**
 * Resolve the handlers directory for a flow. Handlers are co-located with the
 * flow definition: a flow lives at `<flowDir>/flow.yaml` and its handlers are
 * `<flowDir>/<id>.ts`. This is `dirname(yamlPath)` and mirrors the executor's
 * convention path (`dirname(flow.source)/<id>.ts`), keeping generator and
 * runtime in lockstep.
 */
function handlersDirFor(yamlPath: string): string {
  return dirname(yamlPath);
}

/** Render the `.ts.default` scaffold for a single code or code-decision node. */
export function renderScaffold(step: CodeStep | CodeDecisionStep): string {
  const inputKeys = Object.keys(step.inputs ?? {});
  const outputKeys = (step.outputs ?? []).map((o) => o.name);
  const isDecision = step.stepType === "code-decision";
  const branchKeys = isDecision ? Object.keys((step as CodeDecisionStep).branches ?? {}) : [];

  const inputIface = inputKeys.length
    ? `interface Input { ${inputKeys.map((k) => `${k}: string`).join("; ")} }`
    : "interface Input {}";
  const outputIface = outputKeys.length
    ? `interface Output { ${outputKeys.map((k) => `${k}: string`).join("; ")} }`
    : "interface Output {}";

  // code-decision: emit a Branch union from the declared branch labels and type
  // the return as `{ branch: Branch } & Output` so a wrong label is a compile error.
  const branchType = branchKeys.length
    ? `type Branch = ${branchKeys.map((k) => `"${k}"`).join(" | ")};`
    : "type Branch = string;";
  const returnType = isDecision ? "Promise<{ branch: Branch } & Output>" : "Promise<Output>";

  const dataBody = outputKeys.map((k) => `${k}: ""`).join(", ");
  const returnBody = isDecision
    ? `{ branch: ${branchKeys.length ? `"${branchKeys[0]}"` : `""`}${dataBody ? `, ${dataBody}` : ""} }`
    : (outputKeys.length ? `{ ${dataBody} }` : "{}");

  const typeBlock = isDecision ? `${branchType}\n${inputIface}\n${outputIface}` : `${inputIface}\n${outputIface}`;

  return `import type { CodeNodeContext } from "@blackbelt-technology/pi-flows";

${typeBlock}

export default async function (input: Input, ctx: CodeNodeContext): ${returnType} {
  // TODO: implement code node "${step.id}"
  return ${returnBody};
}
`;
}

/**
 * Generate/refresh `.ts.default` templates for every convention code node in a
 * flow and return drift diagnostics for those whose real handler exists.
 */
export function generateCodeHandlers(flow: FlowConfig, yamlPath: string): GenerateResult {
  const dir = handlersDirFor(yamlPath);
  const generated: string[] = [];
  const diagnostics: Diagnostic[] = [];

  for (const step of flow.steps) {
    if (step.stepType !== "code" && step.stepType !== "code-decision") continue;
    const code = step as CodeStep | CodeDecisionStep;
    if (code.target) continue; // custom target: author owns the file, no template

    mkdirSync(dir, { recursive: true });
    const templatePath = join(dir, `${code.id}.ts.default`);
    writeFileSync(templatePath, renderScaffold(code), "utf8");
    generated.push(templatePath);

    const realPath = join(dir, `${code.id}.ts`);
    if (existsSync(realPath)) {
      const drift = detectDrift(code, readFileSync(realPath, "utf8"));
      if (drift) diagnostics.push(drift);
    }
  }

  return { generated, diagnostics };
}

/**
 * Compare the YAML-derived Input/Output key sets to the interface blocks in the
 * real handler. Returns a warning Diagnostic on mismatch, or undefined when the
 * signatures agree or no interface blocks are present (silent skip).
 */
function detectDrift(step: CodeStep | CodeDecisionStep, realSource: string): Diagnostic | undefined {
  const yamlInputs = new Set(Object.keys(step.inputs ?? {}));
  const yamlOutputs = new Set((step.outputs ?? []).map((o) => o.name));
  const realInputs = extractInterfaceKeys(realSource, "Input");
  const realOutputs = extractInterfaceKeys(realSource, "Output");

  const parts: string[] = [];
  if (realInputs && !setsEqual(realInputs, yamlInputs)) {
    parts.push(`Input keys [${[...realInputs].join(", ")}] differ from declared inputs [${[...yamlInputs].join(", ")}]`);
  }
  if (realOutputs && !setsEqual(realOutputs, yamlOutputs)) {
    parts.push(`Output keys [${[...realOutputs].join(", ")}] differ from declared outputs [${[...yamlOutputs].join(", ")}]`);
  }
  if (parts.length === 0) return undefined;

  return {
    line: 0,
    severity: "warning",
    message: `Code node "${step.id}" handler signature drift: ${parts.join("; ")}`,
    suggestion: "Update the handler's Input/Output interfaces to match the flow's inputs/outputs, or copy the regenerated .ts.default.",
  };
}

/**
 * Textually extract the key names from an `interface <name> { ... }` block.
 * Returns null when no such block is found (the silent-skip signal).
 */
function extractInterfaceKeys(source: string, name: "Input" | "Output"): Set<string> | null {
  const match = new RegExp(`interface\\s+${name}\\s*\\{([\\s\\S]*?)\\}`).exec(source);
  if (!match) return null;
  const keys = new Set<string>();
  for (const segment of match[1].split(/[;\n,]/)) {
    const km = /^\s*([A-Za-z_$][\w$]*)\s*[?:]/.exec(segment);
    if (km) keys.add(km[1]);
  }
  return keys;
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}
