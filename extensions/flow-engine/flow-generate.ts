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
import type { CodeStep, FlowConfig, Diagnostic } from "./types.js";

export interface GenerateResult {
  /** Absolute paths of the `.ts.default` templates written. */
  generated: string[];
  /** Non-fatal drift warnings against existing real handlers. */
  diagnostics: Diagnostic[];
}

/**
 * Resolve the handlers directory for a flow from its persisted YAML path.
 * The yaml lives at `<root>/.pi/flows/flows/<name>.yaml`; handlers live at
 * `<root>/.pi/flows/handlers/<name>/`, which is `../handlers/<name>` relative
 * to the yaml's directory. This mirrors the executor's convention path
 * (`<cwd>/.pi/flows/handlers/<flow>/<id>.ts`).
 */
function handlersDirFor(flowName: string, yamlPath: string): string {
  return join(dirname(yamlPath), "..", "handlers", flowName);
}

/** Render the `.ts.default` scaffold for a single code node. */
export function renderScaffold(step: CodeStep): string {
  const inputKeys = Object.keys(step.inputs ?? {});
  const outputKeys = (step.outputs ?? []).map((o) => o.name);

  const inputIface = inputKeys.length
    ? `interface Input { ${inputKeys.map((k) => `${k}: string`).join("; ")} }`
    : "interface Input {}";
  const outputIface = outputKeys.length
    ? `interface Output { ${outputKeys.map((k) => `${k}: string`).join("; ")} }`
    : "interface Output {}";
  const returnBody = outputKeys.length
    ? `{ ${outputKeys.map((k) => `${k}: ""`).join(", ")} }`
    : "{}";

  return `import type { CodeNodeContext } from "@blackbelt-technology/pi-flows";

${inputIface}
${outputIface}

export default async function (input: Input, ctx: CodeNodeContext): Promise<Output> {
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
  const dir = handlersDirFor(flow.name, yamlPath);
  const generated: string[] = [];
  const diagnostics: Diagnostic[] = [];

  for (const step of flow.steps) {
    if (step.stepType !== "code") continue;
    const code = step as CodeStep;
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
function detectDrift(step: CodeStep, realSource: string): Diagnostic | undefined {
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
